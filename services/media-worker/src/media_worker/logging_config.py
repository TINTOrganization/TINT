"""Logs JSON a stdout para media-worker (ADR 0021).

Una línea por evento con `timestamp`, `level`, `service` y `message`; el nivel
sale de `LOG_LEVEL` y un valor inválido impide el arranque.
"""

from __future__ import annotations

import json
import logging
import os
import sys
from collections.abc import Mapping
from datetime import UTC, datetime
from typing import TextIO

LEVELS = {
    "debug": logging.DEBUG,
    "info": logging.INFO,
    "warn": logging.WARNING,
    "error": logging.ERROR,
}

_LEVEL_NAMES = {
    logging.DEBUG: "debug",
    logging.INFO: "info",
    logging.WARNING: "warn",
    logging.ERROR: "error",
    logging.CRITICAL: "error",
}


class LogLevelError(ValueError):
    """`LOG_LEVEL` no es uno de los valores admitidos."""


def parse_level(raw: str | None) -> int:
    if not raw:
        return logging.INFO
    level = raw.strip().lower()
    if level not in LEVELS:
        raise LogLevelError(f"LOG_LEVEL inválido: {raw!r} (usa debug|info|warn|error)")
    return LEVELS[level]


class JsonFormatter(logging.Formatter):
    def __init__(self, service: str) -> None:
        super().__init__()
        self.service = service

    def format(self, record: logging.LogRecord) -> str:
        timestamp = (
            datetime.fromtimestamp(record.created, tz=UTC)
            .isoformat(timespec="milliseconds")
            .replace("+00:00", "Z")
        )
        entry: dict[str, object] = {
            "timestamp": timestamp,
            "level": _LEVEL_NAMES.get(record.levelno, "info"),
            "service": self.service,
            "message": record.getMessage(),
        }
        correlation_id = getattr(record, "correlation_id", None)
        if correlation_id is not None:
            entry["correlation_id"] = correlation_id
        if record.exc_info:
            entry["error"] = self.formatException(record.exc_info)
        return json.dumps(entry, ensure_ascii=False)


def install_logging(
    service: str,
    env: Mapping[str, str] | None = None,
    stream: TextIO | None = None,
) -> None:
    """Configura el logger raíz con JSON a stdout y el nivel de `LOG_LEVEL`."""
    env = os.environ if env is None else env
    level = parse_level(env.get("LOG_LEVEL"))
    handler = logging.StreamHandler(stream if stream is not None else sys.stdout)
    handler.setFormatter(JsonFormatter(service))
    root = logging.getLogger()
    for existing in list(root.handlers):
        root.removeHandler(existing)
    root.addHandler(handler)
    root.setLevel(level)
