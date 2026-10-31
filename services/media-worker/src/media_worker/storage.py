"""Acceso al Blob Storage (MinIO/S3): publicación del vídeo preprocesado y de artefactos."""

from __future__ import annotations

import json
from pathlib import Path, PurePosixPath

from botocore.exceptions import ClientError

NOT_FOUND_CODES = {"404", "NoSuchKey", "NotFound"}

# Las claves llevan el id del vídeo, pero reprocesarlo sobrescribe las mismas claves (regla de
# idempotencia): por eso no se marcan `immutable`. Un día basta para que los seeks y los cambios
# de calidad reutilicen lo ya descargado durante la sesión.
CACHE_CONTROL = "public, max-age=86400"

CONTENT_TYPES = {".mp4": "video/mp4", ".json": "application/json"}


class BlobNotFoundError(Exception):
    """La clave pedida no existe en el bucket."""


def source_key(video_id: str) -> str:
    """Clave determinista del vídeo normalizado (siempre MP4)."""
    return f"{video_id}/source.mp4"


def ambilight_key(video_id: str) -> str:
    """Clave determinista del artefacto: reprocesar sobrescribe en vez de duplicar."""
    return f"{video_id}/ambilight.json"


def rendition_key(video_id: str, height: int) -> str:
    """Clave determinista de una calidad reducida (`{id}/720p.mp4`, `{id}/360p.mp4`)."""
    return f"{video_id}/{height}p.mp4"


class S3BlobStore:
    def __init__(self, client, bucket: str) -> None:
        self.client = client
        self.bucket = bucket

    def download(self, key: str, dest: Path) -> None:
        try:
            self.client.download_file(self.bucket, key, str(dest))
        except ClientError as exc:
            if exc.response.get("Error", {}).get("Code") in NOT_FOUND_CODES:
                raise BlobNotFoundError(f"no existe {self.bucket}/{key}") from exc
            raise

    def upload_file(self, path: Path, key: str) -> None:
        content_type = CONTENT_TYPES.get(PurePosixPath(key).suffix, "application/octet-stream")
        self.client.upload_file(
            str(path),
            self.bucket,
            key,
            ExtraArgs={"ContentType": content_type, "CacheControl": CACHE_CONTROL},
        )

    def put_json(self, key: str, data: object) -> None:
        body = json.dumps(data, separators=(",", ":")).encode()
        self.client.put_object(
            Bucket=self.bucket,
            Key=key,
            Body=body,
            ContentType="application/json",
            CacheControl=CACHE_CONTROL,
        )
