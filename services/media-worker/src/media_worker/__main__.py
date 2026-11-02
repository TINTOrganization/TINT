"""Punto de entrada del worker (`python -m media_worker`): consume `media:uploads`.

La configuración del núcleo sale de `config.Settings`; la del disparador (Redis y nombre del
consumidor) vive aparte en `TriggerSettings`, porque el pipeline no depende de Redis. El mismo
cliente Redis publica `media_processed` en `analytics:events` (ver `events.py`).
"""

from __future__ import annotations

import functools
import logging
import os
import signal
import socket
import sys
import threading
from collections.abc import Mapping
from dataclasses import dataclass

import boto3
import psycopg
import redis

from media_worker.config import ConfigError, Settings
from media_worker.consumer import StreamConsumer
from media_worker.events import redis_publisher
from media_worker.jobs import handle_upload, mark_exhausted
from media_worker.repository import VideoRepository
from media_worker.storage import S3BlobStore

logger = logging.getLogger("media_worker")


@dataclass(frozen=True)
class TriggerSettings:
    redis_url: str
    consumer: str

    @classmethod
    def from_env(cls, env: Mapping[str, str]) -> TriggerSettings:
        return cls(
            redis_url=env.get("REDIS_URL") or "redis://localhost:6379",
            # Nombre estable por réplica: al reiniciar recupera sus propios pendientes.
            consumer=env.get("MEDIA_WORKER_CONSUMER") or socket.gethostname(),
        )


def build_consumer(
    env: Mapping[str, str],
    redis_factory=redis.Redis.from_url,
    s3_factory=boto3.client,
    connect=psycopg.connect,
) -> StreamConsumer:
    """Conecta Redis, MinIO/S3 y PostgreSQL y devuelve el consumidor listo para `run`."""
    settings = Settings.from_env(env)
    trigger = TriggerSettings.from_env(env)
    s3 = s3_factory(
        "s3",
        endpoint_url=settings.s3_endpoint_url,
        aws_access_key_id=settings.s3_access_key,
        aws_secret_access_key=settings.s3_secret_key,
    )
    client = redis_factory(trigger.redis_url, decode_responses=True)
    repo = VideoRepository(connect(settings.database_url, autocommit=True))
    publish = redis_publisher(client)
    handler = functools.partial(
        _handle, repo=repo, blobs=S3BlobStore(s3, settings.bucket), publish=publish
    )
    on_exhausted = functools.partial(_exhausted, repo=repo, publish=publish)
    return StreamConsumer(client, handler, trigger.consumer, on_exhausted=on_exhausted)


def _handle(video_id: str, repo, blobs, publish):
    # Se resuelve en cada llamada para poder sustituirlo en las pruebas.
    return handle_upload(video_id, repo, blobs, publish=publish)


def _exhausted(video_id: str, repo, publish):
    return mark_exhausted(video_id, repo, publish=publish)


def main(env: Mapping[str, str] | None = None) -> int:
    env = os.environ if env is None else env
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")
    try:
        consumer = build_consumer(env)
    except ConfigError as exc:
        print(f"media-worker: {exc}", file=sys.stderr)
        return 2
    stop = threading.Event()
    for sig in (signal.SIGTERM, signal.SIGINT):
        signal.signal(sig, lambda *_: stop.set())
    logger.info("media-worker consumiendo media:uploads")
    consumer.run(stop)
    return 0


if __name__ == "__main__":  # pragma: no cover
    sys.exit(main())
