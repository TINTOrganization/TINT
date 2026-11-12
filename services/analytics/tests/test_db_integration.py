"""Integración con PostgreSQL real (opcional).

Se ejecuta solo si `ANALYTICS_TEST_DATABASE_URL` apunta a una base; trabaja en un esquema
temporal que se borra al terminar, así que no toca las tablas reales.
"""

import os
import uuid
from datetime import UTC, date, datetime, timedelta

import psycopg
import pytest

from analytics.db import EventStore, ReadRepository, apply_migrations
from analytics.kpis import HEATMAP_TYPES, KPI_TYPES

DSN = os.environ.get("ANALYTICS_TEST_DATABASE_URL")
pytestmark = pytest.mark.skipif(not DSN, reason="ANALYTICS_TEST_DATABASE_URL no definida")
NOW = datetime(2026, 10, 11, 12, tzinfo=UTC)


@pytest.fixture
def connect():
    schema = f"analytics_test_{uuid.uuid4().hex[:8]}"
    with psycopg.connect(DSN, autocommit=True) as admin:
        admin.execute(f"CREATE SCHEMA {schema}")
        try:
            yield lambda: psycopg.connect(DSN, autocommit=True, options=f"-c search_path={schema}")
        finally:
            admin.execute(f"DROP SCHEMA {schema} CASCADE")


def ev(event_id, kind, occurred_at="2026-10-11T10:00:00.000Z", **extra):
    return {
        "event_id": event_id,
        "type": kind,
        "source": "social-core",
        "room_id": "r1",
        "occurred_at": occurred_at,
        "received_at": occurred_at,
        **extra,
    }


def test_migrations_ingest_kpis_reads_and_purge(connect):
    with connect() as conn:
        assert apply_migrations(conn) == ["001_init", "002_business_kpis"]
        assert apply_migrations(conn) == [], "aplicar dos veces no repite nada"

    store = EventStore(connect, clock=lambda: NOW)
    assert store.save(ev("a", "presence", connected_users="3")) is True
    assert store.save(ev("a", "presence", connected_users="3")) is False
    store.save(ev("b", "reaction", emoji="👏", position_ms="1500"))
    store.save(ev("c", "user_login", source="identity-api", room_id="", user_id="uid"))
    store.save(ev("old", "chat_message", occurred_at="2026-01-01T00:00:00.000Z"))
    store.save(ev("z", "room_closed", source="identity-api", reason="deleted"))

    repo = ReadRepository(connect)
    kpis = repo.room_kpis("r1")
    assert kpis["peak_users"] == 3
    assert kpis["reactions"] == 1
    assert kpis["messages"] == 1
    assert kpis["closed_at"] == datetime(2026, 10, 11, 10, tzinfo=UTC)
    assert kpis["close_reason"] == "deleted"
    assert kpis["computed_at"] == NOW
    with connect() as conn:
        heatmap = conn.execute(
            "SELECT bucket_start_ms, reactions, density FROM room_heatmap WHERE room_id = 'r1'"
        ).fetchall()
    assert heatmap == [(0, 1, 1.0)]
    assert repo.room_events("r1", HEATMAP_TYPES) == [
        ev("b", "reaction", emoji="👏", position_ms="1500")
    ]
    assert len(repo.room_events("r1", KPI_TYPES)) == 3

    assert store.purge_expired() == 1
    assert repo.room_events("r1", ("chat_message",)) == []
    store.close()


def test_grace_period_close_and_reopening(connect):
    with connect() as conn:
        apply_migrations(conn)
    now = [NOW]
    store = EventStore(connect, clock=lambda: now[0])
    repo = ReadRepository(connect)
    grace = timedelta(hours=12)

    # r1 se cerró de forma explícita y sin razón; r2 quedó inactiva; r3 sigue activa.
    store.save(ev("r1-a", "presence", "2026-10-10T20:00:00.000Z", connected_users="2"))
    store.save(ev("r1-z", "room_closed", "2026-10-10T21:00:00.000Z"))
    store.save(ev("r1-late", "reaction", "2026-10-10T21:00:05.000Z", emoji="👏", position_ms="0"))
    for i, position in enumerate(("1000", "2000", "7000")):
        store.save(
            ev(
                f"r2-{i}",
                "reaction",
                "2026-10-10T22:00:00.000Z",
                room_id="r2",
                emoji="👏",
                position_ms=position,
            )
        )
    store.save(
        ev("r3-a", "presence", "2026-10-11T11:30:00.000Z", room_id="r3", connected_users="5")
    )
    store.save(ev("login", "user_login", source="identity-api", room_id="", user_id="uid"))

    assert repo.room_kpis("r2") is None
    assert store.close_idle_rooms(grace) == 1
    closed = repo.room_kpis("r2")
    assert closed["close_reason"] == "grace_expired"
    assert closed["closed_at"] == datetime(2026, 10, 10, 22, tzinfo=UTC)
    assert closed["reactions"] == 3
    with connect() as conn:
        heatmap = conn.execute(
            "SELECT bucket_start_ms, reactions, density FROM room_heatmap "
            "WHERE room_id = 'r2' ORDER BY bucket_start_ms"
        ).fetchall()
    assert heatmap == [(0, 2, 1.0), (5000, 1, 0.5)]
    assert repo.room_kpis("r3") is None, "una sala con actividad reciente no se cierra"
    assert repo.room_kpis("r1")["close_reason"] is None, "el cierre explícito no se pisa"
    assert store.close_idle_rooms(grace) == 0, "ya consolidadas: no se repite"

    # La sala r2 se vuelve a usar: su cierre por gracia deja de valer hasta el siguiente ciclo.
    store.save(
        ev(
            "r2-new",
            "reaction",
            "2026-10-11T11:00:00.000Z",
            room_id="r2",
            emoji="😂",
            position_ms="7500",
        )
    )
    assert repo.room_kpis("r2") is None
    assert store.close_idle_rooms(grace) == 0, "aún dentro del periodo de gracia"
    now[0] = NOW + timedelta(days=1)
    assert store.close_idle_rooms(grace) == 2, "r2 de nuevo y r3 por primera vez"
    reclosed = repo.room_kpis("r2")
    assert reclosed["reactions"] == 4
    assert reclosed["closed_at"] == datetime(2026, 10, 11, 11, tzinfo=UTC)
    with connect() as conn:
        heatmap = conn.execute(
            "SELECT bucket_start_ms, reactions, density FROM room_heatmap "
            "WHERE room_id = 'r2' ORDER BY bucket_start_ms"
        ).fetchall()
    assert heatmap == [(0, 2, 1.0), (5000, 2, 1.0)]
    store.close()


def test_daily_active_users(connect):
    with connect() as conn:
        apply_migrations(conn)
    store = EventStore(connect, clock=lambda: NOW)

    def login(event_id, user_id, occurred_at):
        store.save(
            ev(
                event_id,
                "user_login",
                occurred_at,
                source="identity-api",
                room_id="",
                user_id=user_id,
            )
        )

    # 2026-10-11T03:00Z todavía es 10 de octubre en Bogotá (UTC-5).
    login("l1", "ana", "2026-10-11T03:00:00.000Z")
    login("l2", "ana", "2026-10-11T08:00:00.000Z")
    login("l3", "ana", "2026-10-11T09:00:00.000Z")
    login("l4", "beto", "2026-10-11T10:00:00.000Z")
    login("l5", "caro", "2026-09-20T15:00:00.000Z")
    login("l6", "dani", "2026-08-01T15:00:00.000Z")
    store.save(ev("c1", "chat_message", "2026-10-11T10:00:00.000Z", user_id="eva"))

    assert store.refresh_daily_active_users("America/Bogota", 2) == 2
    assert store.refresh_daily_active_users("America/Bogota", 2) == 2, "es idempotente"
    with connect() as conn:
        rows = conn.execute(
            "SELECT day, dau, mau, computed_at FROM daily_active_users ORDER BY day"
        ).fetchall()
    assert rows == [(date(2026, 10, 10), 1, 2, NOW), (date(2026, 10, 11), 2, 3, NOW)]

    store.refresh_daily_active_users("UTC", 1)
    with connect() as conn:
        rows = conn.execute("SELECT day, dau FROM daily_active_users ORDER BY day").fetchall()
    assert rows == [(date(2026, 10, 10), 1), (date(2026, 10, 11), 2)]
    store.close()


def test_business_overview(connect):
    with connect() as conn:
        apply_migrations(conn)
    store = EventStore(connect, clock=lambda: NOW)
    repo = ReadRepository(connect)
    assert repo.business_overview(30, 50) == {
        "daily": [],
        "events": [],
        "active_rooms": 0,
        "rooms": [],
        "heatmaps": {},
    }

    store.save(ev("a", "presence", connected_users="3"))
    store.save(ev("b", "reaction", emoji="👏", position_ms="1500"))
    store.save(ev("c", "reaction", emoji="👏", position_ms="7500", room_id="r2"))
    store.save(ev("l", "user_login", source="identity-api", room_id="", user_id="uid"))
    store.save(ev("z", "room_closed", source="identity-api", reason="deleted"))
    store.refresh_daily_active_users("UTC", 3)

    overview = repo.business_overview(2, 50)
    assert overview["daily"] == [(date(2026, 10, 10), 0, 0), (date(2026, 10, 11), 1, 1)]
    assert overview["events"] == [
        ("reaction", "social-core", 2),
        ("presence", "social-core", 1),
        ("room_closed", "identity-api", 1),
        ("user_login", "identity-api", 1),
    ]
    assert overview["active_rooms"] == 2
    (room,) = overview["rooms"]
    assert (room["room_id"], room["peak_users"], room["close_reason"]) == ("r1", 3, "deleted")
    assert overview["heatmaps"] == {"r1": [(0, 1, 1.0)]}
    store.close()
