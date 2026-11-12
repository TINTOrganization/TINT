"""Auditoría de privacidad sobre la base de analítica (`python -m analytics.audit`, ANA-TEST-02).

Certifica contra PostgreSQL que la telemetría persistida cumple Privacy by Design (Ley 1581):

1. ningún `payload` conserva campos de texto libre o PII (`FORBIDDEN_FIELDS`);
2. todo `chat_message` guarda solo metadatos: `message_length` numérico y los campos comunes;
3. las tablas de analítica no tienen columnas de texto fuera de las conocidas.

Imprime un resumen y termina con 0 si todo cumple, 1 si hay alguna violación y 2 si falta
`DATABASE_URL`. Solo lee: nunca modifica ni borra datos.
"""

from __future__ import annotations

import os
import sys
from collections.abc import Callable, Mapping
from dataclasses import dataclass, field

import psycopg

from analytics.sanitize import FORBIDDEN_FIELDS

# Lo único que puede traer un `chat_message` persistido: los campos comunes y la longitud.
CHAT_ALLOWED_KEYS = (
    "event_id",
    "type",
    "source",
    "room_id",
    "user_id",
    "occurred_at",
    "received_at",
    "message_length",
)
# Columnas que pueden guardar texto, por tabla. Cualquier otra exige revisar esta auditoría.
ALLOWED_TEXT_COLUMNS: dict[str, frozenset[str]] = {
    "telemetry_events": frozenset({"event_id", "type", "room_id", "user_id", "source", "payload"}),
    "room_kpis": frozenset({"room_id", "close_reason"}),
    "room_heatmap": frozenset({"room_id"}),
    "daily_active_users": frozenset(),
}
TEXT_TYPES = ("text", "character varying", "character", "json", "jsonb")

COUNT_EVENTS_SQL = (
    "SELECT count(*), count(*) FILTER (WHERE type = 'chat_message') FROM telemetry_events"
)
FORBIDDEN_KEYS_SQL = (
    "SELECT type, count(*) FROM telemetry_events WHERE payload ?| %s GROUP BY type ORDER BY type"
)
CHAT_VIOLATIONS_SQL = (
    "SELECT count(*) FROM telemetry_events WHERE type = 'chat_message' AND ("
    "payload->>'message_length' IS NULL OR payload->>'message_length' !~ '^[0-9]+$' "
    "OR EXISTS (SELECT 1 FROM jsonb_object_keys(payload) AS key WHERE key <> ALL(%s)))"
)
TEXT_COLUMNS_SQL = (
    "SELECT table_name, column_name FROM information_schema.columns "
    "WHERE table_schema = current_schema() AND table_name = ANY(%s) AND data_type = ANY(%s) "
    "ORDER BY table_name, column_name"
)


@dataclass(frozen=True)
class AuditReport:
    events: int
    chat_messages: int
    violations: list[str] = field(default_factory=list)

    @property
    def ok(self) -> bool:
        return not self.violations


def run_audit(conn) -> AuditReport:
    """Ejecuta las tres comprobaciones sobre una conexión abierta (solo `SELECT`)."""
    events, chat_messages = conn.execute(COUNT_EVENTS_SQL).fetchone()
    violations = [
        f"{count} eventos `{kind}` con campos de texto libre o PII en el payload"
        for kind, count in conn.execute(FORBIDDEN_KEYS_SQL, (sorted(FORBIDDEN_FIELDS),)).fetchall()
    ]
    (bad_chat,) = conn.execute(CHAT_VIOLATIONS_SQL, (list(CHAT_ALLOWED_KEYS),)).fetchone()
    if bad_chat:
        violations.append(
            f"{bad_chat} `chat_message` con algo más que metadatos numéricos (message_length)"
        )
    columns = conn.execute(TEXT_COLUMNS_SQL, (list(ALLOWED_TEXT_COLUMNS), list(TEXT_TYPES)))
    violations.extend(
        f"columna de texto no prevista: {table}.{column}"
        for table, column in columns.fetchall()
        if column not in ALLOWED_TEXT_COLUMNS[table]
    )
    return AuditReport(events, chat_messages, violations)


def main(
    env: Mapping[str, str] | None = None,
    connect=psycopg.connect,
    out: Callable[[str], object] = print,
) -> int:
    env = os.environ if env is None else env
    if not env.get("DATABASE_URL"):
        print("analytics.audit: falta la variable de entorno DATABASE_URL", file=sys.stderr)
        return 2
    with connect(env["DATABASE_URL"], autocommit=True) as conn:
        report = run_audit(conn)
    out(
        f"auditoría de privacidad: {report.events} eventos, "
        f"{report.chat_messages} de chat revisados"
    )
    for violation in report.violations:
        out(f"VIOLACIÓN: {violation}")
    out("resultado: " + ("CUMPLE" if report.ok else f"{len(report.violations)} violaciones"))
    return 0 if report.ok else 1


if __name__ == "__main__":  # pragma: no cover
    sys.exit(main())
