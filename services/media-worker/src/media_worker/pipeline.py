"""Preprocesamiento completo de un vídeo antes de publicarlo: processing -> ready | failed."""

from __future__ import annotations

import logging
import re
import subprocess
import tempfile
from pathlib import Path, PurePosixPath

from media_worker.ambilight import AmbilightError, extract_ambilight
from media_worker.normalize import NormalizeError, is_normalized, normalize_video, remux_video
from media_worker.probe import VideoStatus, inspect_media
from media_worker.renditions import generate_renditions
from media_worker.storage import ambilight_key, source_key

logger = logging.getLogger(__name__)

# El id forma parte de las claves del bucket: se rechaza cualquier cosa que no sea un id plano.
VIDEO_ID_PATTERN = re.compile(r"[A-Za-z0-9][A-Za-z0-9_-]{0,127}")


# Contenedores que se aceptan para preprocesar; cualquier otro se rechaza antes de tocar nada.
SUPPORTED_EXTENSIONS = frozenset({".mp4", ".mov", ".mkv", ".webm"})


class UnsupportedFormatError(ValueError):
    """La extensión del archivo no es una de `SUPPORTED_EXTENSIONS`."""


class InvalidVideoIdError(ValueError):
    """El `video_id` recibido no es un id plano válido."""


class VideoNotFoundError(LookupError):
    """El vídeo no existe en la tabla `videos` (el worker no crea filas)."""


def validate_video_id(video_id: object) -> str:
    """Devuelve `video_id` si es un id plano; si no, lanza `InvalidVideoIdError`."""
    if isinstance(video_id, str) and VIDEO_ID_PATTERN.fullmatch(video_id):
        return video_id
    raise InvalidVideoIdError(f"video_id inválido: {video_id!r}")


def validate_extension(name: str | Path) -> str | Path:
    """Devuelve `name` si su extensión es admitida; si no, lanza `UnsupportedFormatError`."""
    suffix = PurePosixPath(str(name)).suffix.lower()
    if suffix in SUPPORTED_EXTENSIONS:
        return name
    allowed = ", ".join(sorted(SUPPORTED_EXTENSIONS))
    raise UnsupportedFormatError(f"formato {suffix or '(sin extensión)'} no admitido ({allowed})")


def process_video(
    video_id: str,
    source: Path,
    repo,
    blobs,
    runner=subprocess.run,
    popen=subprocess.Popen,
) -> VideoStatus:
    """Normaliza a MP4 y extrae el Ambilight de `source`; solo entonces publica en el bucket.

    Si `source` ya es MP4 H.264 + AAC de bitrate moderado no se re-codifica: se remuxa con
    `+faststart` (si el remux falla, se re-codifica). Nunca se publica el original. Tras publicar
    `source.mp4` y `ambilight.json` se generan las calidades reducidas (720p, 360p) menores que
    la altura del original; una calidad que falle se omite sin marcar `failed`.

    El vídeo recibido nunca se sube sin preprocesar: si es inválido o falla la normalización
    o la extracción Ambilight queda en `failed` y no se publica nada. `source` pertenece a quien
    llama (la API), que lo borra cuando quiera.

    Los errores de entrada se lanzan antes de tocar SQL o el bucket: `InvalidVideoIdError` si el
    id no es válido, `UnsupportedFormatError` si la extensión no es mp4/mov/mkv/webm y
    `VideoNotFoundError` si la fila no existe. Los errores de infraestructura
    (SQL, S3) se propagan sin marcar `failed` para que quien llama pueda reintentar.
    """
    validate_video_id(video_id)
    validate_extension(source)
    if not repo.start_processing(video_id):
        raise VideoNotFoundError(f"vídeo {video_id} no existe en la tabla videos")

    status, duration_ms, height = inspect_media(str(source), runner)
    if status is VideoStatus.FAILED:
        repo.mark_failed(video_id)
        return VideoStatus.FAILED

    with tempfile.TemporaryDirectory(prefix="media-worker-") as workdir:
        normalized = Path(workdir) / "source.mp4"
        try:
            _normalize_or_remux(video_id, source, normalized, runner)
            palette = extract_ambilight(str(normalized), duration_ms, popen)
        except NormalizeError as exc:
            return _fail(repo, video_id, f"normalización: {exc}")
        except AmbilightError as exc:
            return _fail(repo, video_id, f"extracción ambilight: {exc}")

        # Se publica todo antes de marcar `ready`: `ready` implica que existen vídeo y ambilight.
        storage_key = source_key(video_id)
        blobs.upload_file(normalized, storage_key)
        blobs.put_json(ambilight_key(video_id), palette)
        # Calidades reducidas: opcionales, una que falle se omite sin marcar `failed`.
        renditions = generate_renditions(video_id, normalized, height, blobs, runner)
    repo.mark_ready(video_id, duration_ms, storage_key, renditions)
    logger.info(
        "vídeo %s listo (%d ms, %d muestras, calidades %s)",
        video_id,
        duration_ms,
        len(palette),
        renditions,
    )
    return VideoStatus.READY


def _normalize_or_remux(video_id: str, source: Path, dest: Path, runner) -> None:
    """Escribe en `dest` el MP4 a publicar: remux si `source` ya cumple, si no re-codificación."""
    if is_normalized(source, runner):
        try:
            remux_video(source, dest, runner)
            logger.info("vídeo %s ya está normalizado: remux con faststart", video_id)
            return
        except NormalizeError as exc:
            logger.warning("vídeo %s: falló el remux (%s); se re-codifica", video_id, exc)
    normalize_video(source, dest, runner)


def _fail(repo, video_id: str, reason: str) -> VideoStatus:
    logger.warning("vídeo %s marcado como failed: %s", video_id, reason)
    repo.mark_failed(video_id)
    return VideoStatus.FAILED
