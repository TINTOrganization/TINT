"""Transiciones de estado de la tabla `videos` (el worker no crea filas ni esquema)."""

from __future__ import annotations

import json
from collections.abc import Sequence
from typing import NamedTuple

from media_worker.probe import FailureReason, VideoStatus

# Un intento nuevo y un éxito borran el motivo del fallo anterior (`failure_reason`).
START_PROCESSING_SQL = (
    "UPDATE videos SET status = %s, failure_reason = NULL, updated_at = now() "
    "WHERE id = %s RETURNING id"
)
MARK_READY_SQL = (
    "UPDATE videos SET status = %s, duration_ms = %s, storage_key = %s, "
    "renditions = %s::jsonb, failure_reason = NULL, updated_at = now() WHERE id = %s"
)
MARK_FAILED_SQL = (
    "UPDATE videos SET status = %s, failure_reason = %s, updated_at = now() WHERE id = %s"
)
# LEFT JOIN: `uploaded_by` es ON DELETE SET NULL y la fila del vídeo no debe perderse sin dueño.
GET_VIDEO_SQL = (
    "SELECT videos.status, videos.storage_key, users.provider_sub FROM videos "
    "LEFT JOIN users ON users.id = videos.uploaded_by WHERE videos.id = %s"
)


class VideoRow(NamedTuple):
    status: str
    storage_key: str
    # `users.provider_sub` de quien subió el vídeo (el `sub` del token); None si no hay dueño.
    uploader_sub: str | None


class VideoRepository:
    """Envuelve una conexión psycopg en modo autocommit: cada UPDATE es idempotente."""

    def __init__(self, conn) -> None:
        self.conn = conn

    def get_video(self, video_id: str) -> VideoRow | None:
        """`(status, storage_key, uploader_sub)` del vídeo, o None si la fila no existe."""
        row = self.conn.execute(GET_VIDEO_SQL, (video_id,)).fetchone()
        return None if row is None else VideoRow(row[0], row[1], row[2])

    def start_processing(self, video_id: str) -> bool:
        """Pasa el vídeo a `processing`; False si no existe la fila."""
        row = self.conn.execute(
            START_PROCESSING_SQL, (VideoStatus.PROCESSING.value, video_id)
        ).fetchone()
        return row is not None

    def mark_ready(
        self,
        video_id: str,
        duration_ms: int,
        storage_key: str,
        renditions: Sequence[int] = (),
    ) -> None:
        """Marca `ready` y sobrescribe `renditions` (jsonb, alturas publicadas, desc.)."""
        renditions_json = json.dumps([int(h) for h in renditions], separators=(",", ":"))
        self.conn.execute(
            MARK_READY_SQL,
            (VideoStatus.READY.value, duration_ms, storage_key, renditions_json, video_id),
        )

    def mark_failed(self, video_id: str, reason: FailureReason) -> None:
        """Marca `failed` y guarda el motivo (código de `FailureReason`)."""
        self.conn.execute(MARK_FAILED_SQL, (VideoStatus.FAILED.value, reason.value, video_id))
