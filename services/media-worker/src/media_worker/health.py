"""Servidor de salud (liveness) del worker (ADR 0021).

`GET /healthz` responde `200 {"status":"ok","service":"media-worker"}` mientras el
bucle del consumidor siga dando señales de vida; si lleva más de
`MEDIA_WORKER_HEARTBEAT_MAX_AGE_S` segundos sin avanzar (Redis caído, bucle
bloqueado) responde `503 {"status":"unavailable",...}` para que Docker lo marque
`unhealthy`. No consulta PostgreSQL, Redis ni MinIO: es liveness, no readiness.
"""

from __future__ import annotations

import json
import logging
import threading
import time
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlsplit

from media_worker.config import ConfigError

logger = logging.getLogger(__name__)

SERVICE = "media-worker"
DEFAULT_PORT = 8088
DEFAULT_MAX_AGE_S = 30.0


@dataclass(frozen=True)
class HealthSettings:
    port: int = DEFAULT_PORT
    max_age_s: float = DEFAULT_MAX_AGE_S

    @classmethod
    def from_env(cls, env: Mapping[str, str] | None = None) -> HealthSettings:
        env = {} if env is None else env
        return cls(
            port=_int_var(env, "MEDIA_WORKER_PORT", DEFAULT_PORT, minimum=1, maximum=65535),
            max_age_s=_age_var(env, "MEDIA_WORKER_HEARTBEAT_MAX_AGE_S", DEFAULT_MAX_AGE_S),
        )


def _int_var(env: Mapping[str, str], name: str, default: int, *, minimum: int, maximum: int) -> int:
    raw = env.get(name)
    if raw in (None, ""):
        return default
    try:
        value = int(raw)
    except ValueError:
        raise ConfigError(f"{name} debe ser un entero (recibido: {raw!r})") from None
    if not minimum <= value <= maximum:
        raise ConfigError(f"{name} debe estar entre {minimum} y {maximum} (recibido: {value})")
    return value


def _age_var(env: Mapping[str, str], name: str, default: float) -> float:
    raw = env.get(name)
    if raw in (None, ""):
        return default
    try:
        value = float(raw)
    except ValueError:
        raise ConfigError(f"{name} debe ser un número (recibido: {raw!r})") from None
    if value <= 0:
        raise ConfigError(f"{name} debe ser mayor que 0 (recibido: {value})")
    return value


class HealthState:
    """Última señal de vida del consumidor; sin ninguna, el worker no está sano."""

    def __init__(
        self, max_age_s: float = DEFAULT_MAX_AGE_S, clock: Callable[[], float] = time.monotonic
    ) -> None:
        self.max_age_s = max_age_s
        self._clock = clock
        self._last_beat: float | None = None

    def touch(self) -> None:
        self._last_beat = self._clock()

    def is_healthy(self) -> bool:
        return self._last_beat is not None and self._clock() - self._last_beat <= self.max_age_s


def _make_handler(state: HealthState) -> type[BaseHTTPRequestHandler]:
    class HealthHandler(BaseHTTPRequestHandler):
        def do_GET(self) -> None:  # noqa: N802 (nombre impuesto por BaseHTTPRequestHandler)
            if urlsplit(self.path).path != "/healthz":
                self._send(404, {"status": "not_found", "service": SERVICE})
                return
            healthy = state.is_healthy()
            self._send(
                200 if healthy else 503,
                {
                    "status": "ok" if healthy else "unavailable",
                    "service": SERVICE,
                },
            )

        def _send(self, status: int, body: dict[str, str]) -> None:
            payload = json.dumps(body).encode("utf-8")
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)

        def log_message(self, format: str, *args: object) -> None:
            logger.debug("%s - %s", self.address_string(), format % args)

    return HealthHandler


class HealthServer:
    """`GET /healthz` en un hilo daemon mientras corre el consumidor."""

    def __init__(self, state: HealthState, host: str = "0.0.0.0", port: int = DEFAULT_PORT) -> None:
        self.state = state
        self.httpd = ThreadingHTTPServer((host, port), _make_handler(state))
        self.httpd.daemon_threads = True
        self._thread: threading.Thread | None = None

    @property
    def port(self) -> int:
        return int(self.httpd.server_address[1])

    def start(self) -> None:
        self._thread = threading.Thread(target=self.httpd.serve_forever, name="health", daemon=True)
        self._thread.start()

    def stop(self) -> None:
        self.httpd.shutdown()
        self.httpd.server_close()
        if self._thread is not None:
            self._thread.join(5)
