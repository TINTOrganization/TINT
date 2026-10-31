"""Punto de entrada (`python -m analytics`).

1. Aplica las migraciones pendientes (`migrations/*.sql`).
2. Arranca en hilos el consumidor de `analytics:events`, el mantenimiento (cierre por gracia,
   purga de 90 días y DAU/MAU) y la API de lectura.
3. Con SIGTERM/SIGINT detiene la API, espera al consumidor y cierra las conexiones.
"""

from __future__ import annotations

import functools
import logging
import os
import signal
import sys
import threading
from collections.abc import Mapping

import psycopg
import redis

from analytics.api import AnalyticsApi, create_server
from analytics.config import ConfigError, Settings
from analytics.consumer import StreamConsumer, run_maintenance_loop
from analytics.db import EventStore, ReadRepository, apply_migrations

logger = logging.getLogger("analytics")

# La API consulta la revocación con timeout corto: si Redis se cuelga responde 503 rápido.
API_REDIS_TIMEOUT_S = 2.0
SHUTDOWN_TIMEOUT_S = 10.0


def install_signal_handlers(stop: threading.Event) -> None:
    for sig in (signal.SIGTERM, signal.SIGINT):
        signal.signal(sig, lambda *_: stop.set())


def main(
    env: Mapping[str, str] | None = None,
    stop: threading.Event | None = None,
    connect=psycopg.connect,
    redis_factory=redis.Redis.from_url,
    server_factory=create_server,
) -> int:
    env = os.environ if env is None else env
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")
    try:
        settings = Settings.from_env(env)
    except ConfigError as exc:
        print(f"analytics: {exc}", file=sys.stderr)
        return 2

    connect_db = functools.partial(connect, settings.database_url, autocommit=True)
    try:
        with connect_db() as conn:
            applied = apply_migrations(conn)
    except psycopg.Error:
        logger.exception("no se pudieron aplicar las migraciones")
        return 1
    logger.info("migraciones aplicadas: %s", ", ".join(applied) or "ninguna pendiente")

    if stop is None:
        stop = threading.Event()
        install_signal_handlers(stop)

    store = EventStore(connect_db)
    # Conexión propia: `EventStore` no es seguro entre hilos y el consumidor ya usa la suya.
    maintenance = EventStore(connect_db)
    consumer = StreamConsumer(
        redis_factory(settings.redis_url, decode_responses=True), store, settings.consumer
    )
    api_redis = redis_factory(
        settings.redis_url,
        decode_responses=True,
        socket_timeout=API_REDIS_TIMEOUT_S,
        socket_connect_timeout=API_REDIS_TIMEOUT_S,
    )
    api = AnalyticsApi(
        ReadRepository(connect_db),
        api_redis,
        secret=settings.jwt_secret,
        issuer=settings.jwt_issuer,
        audience=settings.jwt_audience,
        allowed_origins=settings.allowed_origins,
        admin_password=settings.admin_password,
    )
    server = server_factory(api, "0.0.0.0", settings.port)
    workers = [
        threading.Thread(target=consumer.run, args=(stop,), name="consumer"),
        threading.Thread(
            target=run_maintenance_loop,
            args=(maintenance, stop),
            kwargs={"room_grace": settings.room_grace, "timezone": settings.timezone},
            name="maintenance",
        ),
    ]
    api_thread = threading.Thread(target=server.serve_forever, name="api", daemon=True)
    for thread in (*workers, api_thread):
        thread.start()
    logger.info("analytics consumiendo analytics:events; API en :%d", settings.port)

    stop.wait()
    logger.info("apagando analytics")
    server.shutdown()
    server.server_close()
    for thread in workers:
        thread.join(SHUTDOWN_TIMEOUT_S)
    store.close()
    maintenance.close()
    return 0


if __name__ == "__main__":  # pragma: no cover
    sys.exit(main())
