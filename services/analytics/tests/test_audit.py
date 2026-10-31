import os
import uuid

import psycopg
import pytest
from fakes import FakeConn
from psycopg.types.json import Jsonb

from analytics.audit import (
    ALLOWED_TEXT_COLUMNS,
    CHAT_ALLOWED_KEYS,
    AuditReport,
    main,
    run_audit,
)
from analytics.db import EventStore, apply_migrations
from analytics.sanitize import FORBIDDEN_FIELDS

DSN = os.environ.get("ANALYTICS_TEST_DATABASE_URL")
KNOWN_COLUMNS = [
    (table, column) for table, columns in ALLOWED_TEXT_COLUMNS.items() for column in sorted(columns)
]


def responder(forbidden=(), bad_chat=0, columns=KNOWN_COLUMNS, counts=(120, 12)):
    def respond(sql, params):
        if sql.startswith("SELECT count(*), count(*) FILTER"):
            return [counts]
        if sql.startswith("SELECT type, count(*)"):
            return list(forbidden)
        if sql.startswith("SELECT count(*) FROM telemetry_events WHERE type = 'chat_message'"):
            return [(bad_chat,)]
        return list(columns)

    return respond


def test_clean_database_passes_and_only_reads():
    conn = FakeConn(responder())
    report = run_audit(conn)
    assert report == AuditReport(events=120, chat_messages=12, violations=[])
    assert report.ok
    assert all(sql.startswith("SELECT") for sql, _ in conn.executed)
    assert conn.transactions == 0


def test_queries_use_the_sanitizer_fields_and_the_chat_allowlist():
    conn = FakeConn(responder())
    run_audit(conn)
    (_counts, forbidden, chat, columns) = conn.executed
    assert "payload ?| %s" in forbidden[0]
    assert forbidden[1] == (sorted(FORBIDDEN_FIELDS),)
    assert "'^[0-9]+$'" in chat[0] and "jsonb_object_keys(payload)" in chat[0]
    assert chat[1] == (list(CHAT_ALLOWED_KEYS),)
    assert set(CHAT_ALLOWED_KEYS).isdisjoint(FORBIDDEN_FIELDS)
    assert columns[1][0] == list(ALLOWED_TEXT_COLUMNS)
    assert "jsonb" in columns[1][1] and "text" in columns[1][1]


def test_each_kind_of_violation_is_reported():
    conn = FakeConn(
        responder(
            forbidden=[("chat_message", 2), ("presence", 1)],
            bad_chat=3,
            columns=[*KNOWN_COLUMNS, ("room_kpis", "host_name"), ("telemetry_events", "raw_text")],
        )
    )
    report = run_audit(conn)
    assert not report.ok
    assert report.violations == [
        "2 eventos `chat_message` con campos de texto libre o PII en el payload",
        "1 eventos `presence` con campos de texto libre o PII en el payload",
        "3 `chat_message` con algo más que metadatos numéricos (message_length)",
        "columna de texto no prevista: room_kpis.host_name",
        "columna de texto no prevista: telemetry_events.raw_text",
    ]


def run_main(respond, env=None):
    conns, lines = [], []

    def connect(dsn, **kwargs):
        assert (dsn, kwargs) == ("postgresql://db/tint", {"autocommit": True})
        conns.append(FakeConn(respond))
        return conns[-1]

    env = {"DATABASE_URL": "postgresql://db/tint"} if env is None else env
    return main(env, connect=connect, out=lines.append), lines, conns


def test_main_prints_the_summary_and_exits_0_when_clean():
    code, lines, conns = run_main(responder())
    assert code == 0
    assert lines == [
        "auditoría de privacidad: 120 eventos, 12 de chat revisados",
        "resultado: CUMPLE",
    ]
    assert conns[0].closed


def test_main_lists_violations_and_exits_1():
    code, lines, _conns = run_main(responder(bad_chat=1))
    assert code == 1
    assert lines[1].startswith("VIOLACIÓN: 1 `chat_message`")
    assert lines[-1] == "resultado: 1 violaciones"


def test_main_exits_2_without_database_url(capsys):
    code, lines, conns = run_main(responder(), env={})
    assert (code, lines, conns) == (2, [], [])
    assert "DATABASE_URL" in capsys.readouterr().err


def test_main_reads_os_environ_by_default(monkeypatch):
    monkeypatch.delenv("DATABASE_URL", raising=False)
    assert main() == 2


@pytest.mark.skipif(not DSN, reason="ANALYTICS_TEST_DATABASE_URL no definida")
def test_audit_against_real_postgres():
    schema = f"analytics_audit_{uuid.uuid4().hex[:8]}"
    options = f"-c search_path={schema}"
    stamp = "2026-10-11T10:00:00.000Z"
    with psycopg.connect(DSN, autocommit=True) as admin:
        admin.execute(f"CREATE SCHEMA {schema}")
        try:
            with psycopg.connect(DSN, autocommit=True, options=options) as conn:
                apply_migrations(conn)
                store = EventStore(lambda: conn)
                common = {"source": "social-core", "room_id": "r1", "user_id": "guest:1"}
                times = {"occurred_at": stamp, "received_at": stamp}
                store.save(
                    {"event_id": "c1", "type": "chat_message", "message_length": 7} | common | times
                )
                store.save(
                    {"event_id": "c2", "type": "chat_message", "message_length": "12"}
                    | common
                    | times
                )
                store.save(
                    {"event_id": "p1", "type": "presence", "kind": "joined"} | common | times
                )
                assert run_audit(conn) == AuditReport(events=3, chat_messages=2, violations=[])

                # Filas que el sanitizador nunca dejaría pasar, escritas a mano en la tabla.
                insert = (
                    "INSERT INTO telemetry_events "
                    "VALUES (%s, %s, 'r1', NULL, 'x', now(), now(), %s)"
                )
                conn.execute(insert, ("b1", "chat_message", Jsonb({"text": "hola", "nick": "Ana"})))
                conn.execute(
                    insert,
                    ("b2", "chat_message", Jsonb({"message_length": 4, "preview": "hola"})),
                )
                conn.execute(insert, ("b3", "presence", Jsonb({"email": "a@b.co"})))
                conn.execute("ALTER TABLE room_kpis ADD COLUMN host_name TEXT")
                assert run_audit(conn).violations == [
                    "1 eventos `chat_message` con campos de texto libre o PII en el payload",
                    "1 eventos `presence` con campos de texto libre o PII en el payload",
                    "2 `chat_message` con algo más que metadatos numéricos (message_length)",
                    "columna de texto no prevista: room_kpis.host_name",
                ]
        finally:
            admin.execute(f"DROP SCHEMA {schema} CASCADE")
