from datetime import UTC, datetime, timedelta

import psycopg
import pytest
from fakes import FakeConn, FakeCursor

from analytics.db import (
    HEATMAP_BUCKET_MS,
    KPI_COLUMNS,
    EventStore,
    Migration,
    ReadRepository,
    apply_migrations,
    load_migrations,
)
from analytics.kpis import KPI_TYPES
from analytics.sanitize import InvalidEvent

NOW = datetime(2026, 10, 11, 12, 0, tzinfo=UTC)


def event(**extra):
    return {
        "event_id": "e1",
        "type": "reaction",
        "source": "social-core",
        "room_id": "r1",
        "user_id": "guest:1",
        "emoji": "👏",
        "occurred_at": "2026-10-11T10:00:00.000Z",
        "received_at": "2026-10-11T10:00:00.050Z",
        **extra,
    }


# --- migraciones -------------------------------------------------------------------------


def test_load_migrations_reads_versioned_sql_files_in_order(tmp_path):
    (tmp_path / "002_more.sql").write_text("SELECT 2;")
    (tmp_path / "001_init.sql").write_text("SELECT 1;")
    (tmp_path / "notes.txt").write_text("ignorar")
    assert load_migrations(tmp_path) == [
        Migration("001_init", "SELECT 1;"),
        Migration("002_more", "SELECT 2;"),
    ]


def test_packaged_migrations_create_the_tables_indexes_and_kpi_columns():
    first, second = load_migrations()
    assert (first.version, second.version) == ("001_init", "002_business_kpis")
    sql = first.sql
    assert "CREATE TABLE IF NOT EXISTS telemetry_events" in sql
    assert "event_id TEXT PRIMARY KEY" in sql
    assert "payload JSONB NOT NULL" in sql
    assert "(room_id, type)" in sql
    assert "(occurred_at)" in sql
    assert "CREATE TABLE IF NOT EXISTS room_kpis" in sql
    assert "CREATE TABLE IF NOT EXISTS room_heatmap" in second.sql
    assert "CREATE TABLE IF NOT EXISTS daily_active_users" in second.sql
    assert "(type, occurred_at)" in second.sql
    for column in KPI_COLUMNS:
        assert column in first.sql + second.sql


def test_apply_migrations_runs_only_pending_versions_under_a_lock():
    def responder(sql, params):
        if sql.startswith("SELECT version FROM schema_migrations"):
            return [("001_init",)]
        return []

    conn = FakeConn(responder)
    migrations = [Migration("001_init", "SELECT 1;"), Migration("002_more", "SELECT 2;")]
    assert apply_migrations(conn, migrations) == ["002_more"]
    sqls = [sql for sql, _ in conn.executed]
    assert sqls[0].startswith("SELECT pg_advisory_xact_lock")
    assert sqls[1].startswith("CREATE TABLE IF NOT EXISTS schema_migrations")
    assert "SELECT 1;" not in sqls
    assert "SELECT 2;" in sqls
    assert conn.statements("INSERT INTO schema_migrations") == [
        ("INSERT INTO schema_migrations (version) VALUES (%s)", ("002_more",))
    ]
    assert conn.committed == 1


def test_apply_migrations_defaults_to_packaged_files():
    conn = FakeConn()
    assert apply_migrations(conn) == [m.version for m in load_migrations()]


# --- EventStore ----------------------------------------------------------------------------


def store_with(responder=None):
    conns = []

    def connect():
        conns.append(FakeConn(responder))
        return conns[-1]

    return EventStore(connect, clock=lambda: NOW), conns


def inserted(sql, params):
    return [("e1",)] if sql.startswith("INSERT INTO telemetry_events") else []


def test_save_inserts_event_idempotently_inside_a_transaction():
    store, conns = store_with(inserted)
    assert store.save(event()) is True
    ((sql, params),) = conns[0].statements("INSERT INTO telemetry_events")
    assert "ON CONFLICT (event_id) DO NOTHING" in sql
    assert params[:5] == ("e1", "reaction", "r1", "guest:1", "social-core")
    assert params[5] == datetime(2026, 10, 11, 10, tzinfo=UTC)
    assert params[6] == datetime(2026, 10, 11, 10, 0, 0, 50000, tzinfo=UTC)
    assert params[7].obj == event()
    assert conns[0].committed == 1


def test_save_many_inserts_the_batch_in_a_single_transaction_and_counts_new_events():
    def responder(sql, params):
        new = sql.startswith("INSERT INTO telemetry_events") and params[0] != "dup"
        return [(params[0],)] if new else []

    store, conns = store_with(responder)
    batch = [event(event_id="a"), event(event_id="dup"), event(event_id="b")]
    assert store.save_many(batch) == 2
    conn = conns[0]
    assert [params[0] for _sql, params in conn.statements("INSERT INTO telemetry_events")] == [
        "a",
        "dup",
        "b",
    ]
    assert conn.transactions == conn.committed == 1


def test_save_many_of_an_empty_batch_inserts_nothing():
    store, conns = store_with()
    assert store.save_many([]) == 0
    assert conns[0].statements("INSERT INTO telemetry_events") == []


def test_room_closed_in_a_batch_consolidates_inside_the_batch_transaction():
    store, conns = store_with(inserted)
    store.save_many([event(event_id="a"), event(event_id="z", type="room_closed")])
    conn = conns[0]
    sqls = [sql for sql, _ in conn.executed]
    first_insert = sqls.index(conn.statements("INSERT INTO telemetry_events")[0][0])
    assert first_insert < sqls.index(conn.statements("SELECT payload FROM telemetry_events")[0][0])
    assert len(conn.statements("INSERT INTO room_kpis")) == 1
    assert conn.transactions == conn.committed == 1


def test_save_many_turns_data_errors_into_invalid_events_without_committing():
    def responder(sql, params):
        if sql.startswith("INSERT INTO telemetry_events") and params[0] == "bad":
            raise psycopg.DataError("valor fuera de rango")
        return inserted(sql, params)

    store, conns = store_with(responder)
    with pytest.raises(InvalidEvent):
        store.save_many([event(event_id="a"), event(event_id="bad")])
    assert conns[0].committed == 0
    assert not conns[0].closed


def test_save_reports_duplicates_and_reuses_the_connection():
    store, conns = store_with()
    assert store.save(event()) is False
    assert store.save(event(event_id="e2")) is False
    assert len(conns) == 1


def test_save_stores_null_room_and_user_when_absent():
    store, conns = store_with(inserted)
    login = event(type="user_login", source="identity-api")
    del login["room_id"], login["user_id"]
    store.save(login)
    ((_sql, params),) = conns[0].statements("INSERT INTO telemetry_events")
    assert params[2] is None and params[3] is None


def test_room_closed_computes_and_upserts_room_kpis_in_the_same_transaction():
    def responder(sql, params):
        if sql.startswith("SELECT payload FROM telemetry_events"):
            return [
                ({"type": "presence", "connected_users": "4"},),
                ({"type": "reaction", "emoji": "👏"},),
                ({"type": "drift_correction", "drift_ms": "640", "rtt_ms": "30"},),
            ]
        return inserted(sql, params)

    store, conns = store_with(responder)
    store.save(event(type="room_closed", source="identity-api", reason="deleted"))
    conn = conns[0]
    ((select_sql, select_params),) = conn.statements("SELECT payload FROM telemetry_events")
    assert select_params == ("r1", list(KPI_TYPES))
    assert "ORDER BY occurred_at" in select_sql
    ((upsert_sql, params),) = conn.statements("INSERT INTO room_kpis")
    assert "ON CONFLICT (room_id) DO UPDATE" in upsert_sql
    values = dict(zip(("room_id", *KPI_COLUMNS), params, strict=True))
    assert values["room_id"] == "r1"
    assert values["peak_users"] == 4
    assert values["reactions"] == 1
    assert (values["avg_rtt_ms"], values["p95_drift_ms"]) == (30.0, 640.0)
    assert values["close_reason"] == "deleted"
    assert values["closed_at"] == datetime(2026, 10, 11, 10, tzinfo=UTC)
    assert values["computed_at"] == NOW
    assert conn.transactions == conn.committed == 1


def reactions_at(*positions):
    def responder(sql, params):
        if sql.startswith("SELECT payload FROM telemetry_events"):
            return [({"type": "reaction", "emoji": "👏", "position_ms": p},) for p in positions]
        return inserted(sql, params)

    return responder


def test_room_closed_replaces_the_normalized_heatmap_of_the_room():
    store, conns = store_with(reactions_at("100", "200", "6000"))
    store.save(event(type="room_closed", source="identity-api", reason="deleted"))
    conn = conns[0]
    assert conn.statements("DELETE FROM room_heatmap") == [
        ("DELETE FROM room_heatmap WHERE room_id = %s", ("r1",))
    ]
    ((_sql, params),) = conn.statements("INSERT INTO room_heatmap")
    assert params == ("r1", [0, HEATMAP_BUCKET_MS], [2, 1], [1.0, 0.5])
    sqls = [sql for sql, _ in conn.executed]
    assert sqls.index("DELETE FROM room_heatmap WHERE room_id = %s") < len(sqls) - 1
    assert conn.transactions == conn.committed == 1


def test_room_closed_without_reactions_only_clears_the_heatmap():
    store, conns = store_with(inserted)
    reasonless = event(type="room_closed", source="identity-api")
    store.save(reasonless)
    conn = conns[0]
    assert len(conn.statements("DELETE FROM room_heatmap")) == 1
    assert conn.statements("INSERT INTO room_heatmap") == []
    ((_sql, params),) = conn.statements("INSERT INTO room_kpis")
    assert dict(zip(("room_id", *KPI_COLUMNS), params, strict=True))["close_reason"] is None


def test_room_closed_redelivery_recomputes_kpis():
    store, conns = store_with()
    store.save(event(type="room_closed"))
    assert len(conns[0].statements("INSERT INTO room_kpis")) == 1


def test_save_turns_data_errors_into_invalid_events_and_keeps_the_connection():
    def responder(sql, params):
        raise psycopg.DataError("valor fuera de rango")

    store, conns = store_with(responder)
    with pytest.raises(InvalidEvent):
        store.save(event())
    assert not conns[0].closed


def test_save_drops_the_connection_on_infrastructure_errors_and_reconnects():
    calls = {"n": 0}

    def responder(sql, params):
        calls["n"] += 1
        if calls["n"] == 1:
            raise psycopg.OperationalError("conexión perdida")
        return inserted(sql, params)

    store, conns = store_with(responder)
    with pytest.raises(psycopg.OperationalError):
        store.save(event())
    assert conns[0].closed
    assert store.save(event()) is True
    assert len(conns) == 2


def test_purge_expired_deletes_events_older_than_retention():
    store, conns = store_with(lambda sql, params: FakeCursor(rowcount=7))
    assert store.purge_expired() == 7
    ((sql, params),) = conns[0].statements("DELETE FROM telemetry_events")
    assert "occurred_at < %s" in sql
    assert params == (NOW - timedelta(days=90),)


def test_close_idle_rooms_consolidates_each_room_past_the_grace_period():
    last_r1 = datetime(2026, 10, 10, 20, tzinfo=UTC)
    last_r2 = datetime(2026, 10, 10, 23, tzinfo=UTC)

    def responder(sql, params):
        if sql.startswith("SELECT e.room_id"):
            return [("r1", last_r1), ("r2", last_r2)]
        if sql.startswith("SELECT payload FROM telemetry_events"):
            return [({"type": "presence", "connected_users": "2"},)]
        return []

    store, conns = store_with(responder)
    assert store.close_idle_rooms(timedelta(hours=12)) == 2
    conn = conns[0]
    ((idle_sql, idle_params),) = conn.statements("SELECT e.room_id")
    assert idle_params == (NOW - timedelta(hours=12),)
    assert "HAVING max(e.occurred_at) < %s" in idle_sql
    assert "k.room_id IS NULL" in idle_sql
    # Un `room_closed` explícito nunca se pisa: solo se rehace un cierre por gracia viejo.
    assert "k.close_reason = 'grace_expired' AND max(e.occurred_at) > k.closed_at" in idle_sql
    upserts = [
        dict(zip(("room_id", *KPI_COLUMNS), params, strict=True))
        for _sql, params in conn.statements("INSERT INTO room_kpis")
    ]
    assert [(u["room_id"], u["closed_at"], u["close_reason"]) for u in upserts] == [
        ("r1", last_r1, "grace_expired"),
        ("r2", last_r2, "grace_expired"),
    ]
    assert all(u["peak_users"] == 2 and u["computed_at"] == NOW for u in upserts)
    assert conn.transactions == conn.committed == 2, "una transacción por sala"


def test_close_idle_rooms_with_nothing_to_close():
    store, conns = store_with()
    assert store.close_idle_rooms(timedelta(hours=12)) == 0
    assert conns[0].statements("INSERT INTO room_kpis") == []


def test_refresh_daily_active_users_upserts_dau_and_mau_per_local_day():
    store, conns = store_with()
    assert store.refresh_daily_active_users("America/Bogota", 2) == 2
    ((sql, params),) = conns[0].statements("INSERT INTO daily_active_users")
    assert params == {"tz": "America/Bogota", "now": NOW, "days": 2}
    assert "count(DISTINCT user_id)" in sql
    assert "type = 'user_login'" in sql
    assert "BETWEEN d.day - 29 AND d.day" in sql
    assert "ON CONFLICT (day) DO UPDATE" in sql
    assert conns[0].committed == 1


@pytest.mark.parametrize(
    "call",
    [
        lambda store: store.close_idle_rooms(timedelta(hours=12)),
        lambda store: store.refresh_daily_active_users("UTC", 2),
        lambda store: store.purge_expired(),
    ],
)
def test_maintenance_queries_drop_the_connection_on_errors(call):
    def responder(sql, params):
        raise psycopg.OperationalError("conexión perdida")

    store, conns = store_with(responder)
    with pytest.raises(psycopg.OperationalError):
        call(store)
    assert conns[0].closed


def test_close_closes_the_open_connection():
    store, conns = store_with()
    store.close()  # sin conexión abierta no hace nada
    store.save(event())
    store.close()
    assert conns[0].closed


# --- ReadRepository ------------------------------------------------------------------------


def test_room_kpis_returns_named_columns_or_none():
    row = ("r1", 3, 2.5, 120.0, 50.0, 4, 5, 6, 1, 800.0, 40.0, 900.0, 800, "deleted", NOW, NOW)

    def responder(sql, params):
        return [row] if params == ("r1",) else []

    conns = []

    def connect():
        conns.append(FakeConn(responder))
        return conns[-1]

    repo = ReadRepository(connect)
    kpis = repo.room_kpis("r1")
    assert kpis["room_id"] == "r1"
    assert kpis["avg_users"] == 2.5
    assert kpis["closed_at"] == NOW
    assert kpis["close_reason"] == "deleted"
    assert set(kpis) == {"room_id", *KPI_COLUMNS}
    # Un cierre por gracia con actividad posterior no cuenta: la sala vuelve a estar abierta.
    (sql, _params) = conns[0].executed[0]
    assert "IS NOT DISTINCT FROM 'grace_expired'" in sql
    assert "e.occurred_at > k.closed_at" in sql
    assert repo.room_kpis("otra") is None
    assert all(conn.closed for conn in conns), "cada consulta abre y cierra su conexión"


def test_room_events_filters_by_room_and_types():
    conn = FakeConn(lambda sql, params: [({"type": "reaction"},)])
    repo = ReadRepository(lambda: conn)
    assert repo.room_events("r1", ("reaction",)) == [{"type": "reaction"}]
    ((sql, params),) = conn.executed
    assert "WHERE room_id = %s AND type = ANY(%s)" in sql
    assert params == ("r1", ["reaction"])


def test_business_overview_reads_every_aggregate_in_one_connection():
    kpi_row = ("r1", 3, 2.5, 120.0, 50.0, 4, 5, 6, 1, 800.0, 40.0, 900.0, 800, "deleted", NOW, NOW)

    def responder(sql, params):
        if sql.startswith("SELECT day, dau, mau"):
            return [("2026-10-12", 3, 4)]
        if sql.startswith("SELECT type, source, count(*)"):
            return [("presence", "social-core", 16)]
        if sql.startswith("SELECT count(DISTINCT room_id)"):
            return [(5,)]
        if sql.startswith("SELECT room_id, peak_users"):
            return [kpi_row]
        return [("r1", 0, 2, 0.4), ("r1", 5000, 5, 1.0)]

    conn = FakeConn(responder)
    overview = ReadRepository(lambda: conn).business_overview(30, 50)
    assert overview["daily"] == [("2026-10-12", 3, 4)]
    assert overview["events"] == [("presence", "social-core", 16)]
    assert overview["active_rooms"] == 5
    (room,) = overview["rooms"]
    assert (room["room_id"], room["close_reason"], room["avg_rtt_ms"]) == ("r1", "deleted", 40.0)
    assert overview["heatmaps"] == {"r1": [(0, 2, 0.4), (5000, 5, 1.0)]}
    params = [params for _sql, params in conn.executed]
    assert params == [(30,), None, None, (50,), (["r1"],)]
    assert all(sql.startswith("SELECT") for sql, _ in conn.executed)
    assert "user_id" not in " ".join(sql for sql, _ in conn.executed)
    assert conn.closed


def test_business_overview_without_closed_rooms_skips_the_heatmap_query():
    def responder(sql, params):
        return [(0,)] if sql.startswith("SELECT count(DISTINCT room_id)") else []

    conn = FakeConn(responder)
    overview = ReadRepository(lambda: conn).business_overview(30, 50)
    assert overview == {"daily": [], "events": [], "active_rooms": 0, "rooms": [], "heatmaps": {}}
    assert len(conn.executed) == 4
