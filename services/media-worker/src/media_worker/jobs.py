"""Procesa una subida directa del navegador: descarga el original y llama al pipeline.

identity-api firma un PUT a `incoming/{video_id}/original.<ext>` (zona de staging, nunca la clave
publicada) y guarda esa clave en `videos.storage_key`. Aquí se descarga a un archivo temporal y se
pasa a `pipeline.process_video` sin modificarlo: solo si el vídeo es válido se publica en
`{video_id}/source.mp4` (ya normalizado) y `mark_ready` actualiza `storage_key`. El staging lo
limpia la regla de ciclo de vida del bucket (`minio-init`), así no se corta a quien ya lo está
reproduciendo.

Cada resultado terminal (`ready` o `failed`) publica `media_processed` en `analytics:events` con el
`publish` inyectado (ver `events.py`). Es best-effort: un fallo al publicar solo se registra y no
cambia el resultado ni impide el `XACK` de `media:uploads`. Los eventos que no procesan nada
(id inválido, fila inexistente o borrada, duplicado ya publicado) y los fallos de infraestructura
que dejan el mensaje pendiente no publican.
"""

from __future__ import annotations

import logging
import tempfile
import time
import uuid
from collections.abc import Callable, Sequence
from pathlib import Path, PurePosixPath

from media_worker.events import Publisher, media_processed
from media_worker.pipeline import (
    InvalidVideoIdError,
    UnsupportedFormatError,
    VideoNotFoundError,
    process_video,
    validate_extension,
)
from media_worker.probe import FailureReason, VideoStatus
from media_worker.storage import BlobNotFoundError

logger = logging.getLogger(__name__)

INCOMING_PREFIX = "incoming/"


def _is_uuid(value: str) -> bool:
    try:
        uuid.UUID(value)
    except ValueError:
        return False
    return True


class _ReadyRecorder:
    """Delega en el repositorio real y recuerda la duración que `mark_ready` guarda en SQL."""

    def __init__(self, repo) -> None:
        self._repo = repo
        self.duration_ms: int | None = None

    def mark_ready(
        self,
        video_id: str,
        duration_ms: int,
        storage_key: str,
        renditions: Sequence[int] = (),
    ) -> None:
        self._repo.mark_ready(video_id, duration_ms, storage_key, renditions)
        self.duration_ms = duration_ms

    def __getattr__(self, name: str):
        return getattr(self._repo, name)


def handle_upload(
    video_id: str,
    repo,
    blobs,
    process=None,
    publish: Publisher | None = None,
    clock: Callable[[], float] = time.monotonic,
) -> VideoStatus | None:
    """Procesa el vídeo; None si el evento no corresponde a un vídeo procesable.

    Los fallos de infraestructura (SQL, S3) se propagan para que el evento quede pendiente.
    """
    started = clock()
    if not _is_uuid(video_id):
        # videos.id es uuid: PostgreSQL rechazaría el id en cada reintento (evento venenoso).
        logger.warning("video_id %r no es un UUID; se descarta", video_id)
        return None
    row = repo.get_video(video_id)
    if row is None:
        logger.warning("vídeo %s no existe en la tabla videos; se descarta", video_id)
        return None
    if row.status == VideoStatus.READY.value and not row.storage_key.startswith(INCOMING_PREFIX):
        logger.info("vídeo %s ya publicado en %s; evento duplicado", video_id, row.storage_key)
        return VideoStatus.READY

    recorder = _ReadyRecorder(repo)
    status = _process_upload(video_id, row.storage_key, recorder, blobs, process or process_video)
    if status is not None and publish is not None:
        duration_ms = recorder.duration_ms if status is VideoStatus.READY else None
        elapsed_ms = round((clock() - started) * 1000)
        _publish(publish, video_id, status, duration_ms, elapsed_ms, row.uploader_sub)
    return status


def _process_upload(video_id: str, key: str, repo, blobs, process) -> VideoStatus | None:
    try:
        validate_extension(key)
    except UnsupportedFormatError as exc:
        # Reintentar no cambia la extensión: se marca failed sin descargar el archivo.
        logger.warning("vídeo %s rechazado: %s", video_id, exc)
        repo.mark_failed(video_id, FailureReason.UNSUPPORTED_FORMAT)
        return VideoStatus.FAILED

    with tempfile.TemporaryDirectory(prefix="tint-media-") as workdir:
        local = Path(workdir) / f"original{PurePosixPath(key).suffix}"
        try:
            blobs.download(key, local)
        except BlobNotFoundError:
            logger.warning("vídeo %s: no está %s en el bucket; se marca failed", video_id, key)
            repo.mark_failed(video_id, FailureReason.MISSING_FILE)
            return VideoStatus.FAILED
        try:
            return process(video_id, local, repo, blobs)
        except (InvalidVideoIdError, VideoNotFoundError) as exc:
            logger.warning("vídeo %s descartado: %s", video_id, exc)
            return None


def _publish(publish: Publisher, video_id, status, duration_ms, elapsed_ms, user_id) -> None:
    try:
        publish(media_processed(video_id, status, duration_ms, elapsed_ms, user_id))
    except Exception:
        # Analítica es best-effort: el vídeo ya quedó procesado y el evento de subida se confirma.
        logger.warning("no se pudo publicar media_processed de %s", video_id, exc_info=True)
