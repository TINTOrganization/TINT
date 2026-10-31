"""Normalización del vídeo a MP4 H.264 + AAC con FFmpeg."""

from __future__ import annotations

import json
import subprocess
from pathlib import Path

# Una película de 2-3 h tarda en re-codificarse; el timeout mata FFmpeg si se cuelga.
DEFAULT_TIMEOUT_S = 4 * 3600


PROBE_TIMEOUT_S = 30

# Un remux solo copia paquetes: aun para una película basta con mucho menos que re-codificar.
REMUX_TIMEOUT_S = 3600

# Bitrate total (bit/s) máximo para publicar con remux un original ya H.264 + AAC; por encima
# (p. ej. 4K de móvil a 50 Mbps) se re-codifica con el tope VBV de `source.mp4`.
MAX_REMUX_BITRATE = 12_000_000


class NormalizeError(Exception):
    """No se pudo normalizar el vídeo."""


def is_normalized(src: Path, runner=subprocess.run, timeout: float = PROBE_TIMEOUT_S) -> bool:
    """True si `src` se puede publicar con un remux (`-c copy`) en vez de re-codificarlo.

    Exige MP4 real (ni extensión `.mov` ni major brand `qt  `: ffprobe informa los QuickTime de
    móvil como `mov,mp4,...`), primer vídeo H.264 `yuv420p`, primer audio AAC (si hay) y un
    bitrate total conocido de como mucho `MAX_REMUX_BITRATE`. Cualquier duda (ffprobe falla,
    salida ilegible, bitrate desconocido) devuelve False: se re-codifica.
    """
    if src.suffix.lower() == ".mov":
        return False
    cmd = [
        "ffprobe",
        "-v",
        "error",
        "-show_entries",
        "stream=codec_type,codec_name,pix_fmt:format=format_name,bit_rate:format_tags=major_brand",
        "-of",
        "json",
        str(src),
    ]
    try:
        result = runner(cmd, capture_output=True, text=True, check=False, timeout=timeout)
        if result.returncode != 0:
            return False
        info = json.loads(result.stdout)
        fmt = info["format"]
        containers = fmt["format_name"].split(",")
        bit_rate = int(fmt["bit_rate"])
        brand = (fmt.get("tags") or {}).get("major_brand", "").strip()
        streams = info["streams"]
    except (subprocess.TimeoutExpired, OSError, ValueError, KeyError, TypeError, AttributeError):
        return False
    video = next((s for s in streams if s.get("codec_type") == "video"), None)
    audio = next((s for s in streams if s.get("codec_type") == "audio"), None)
    return (
        "mp4" in containers
        and brand != "qt"
        and bit_rate <= MAX_REMUX_BITRATE
        and video is not None
        and video.get("codec_name") == "h264"
        and video.get("pix_fmt") == "yuv420p"
        and (audio is None or audio.get("codec_name") == "aac")
    )


# Un keyframe cada 2 s (sin cortes de escena extra): los seeks y las correcciones del Canal Sync
# caen como mucho a 2 s de un keyframe en vez de hasta ~10 s (keyint 250 por defecto de x264).
KEYFRAME_INTERVAL_S = 2

# `source.mp4` conserva la resolución del original (puede ser 4K o 60 fps), así que no se fija el
# nivel H.264: x264 elige el correcto. CRF 23 con tope VBV para que los picos no atasquen el buffer.
SOURCE_PROFILE = "high"
SOURCE_MAXRATE = "8000k"
SOURCE_BUFSIZE = "16000k"

AUDIO_ARGS = ("-c:a", "aac", "-b:a", "128k", "-ac", "2", "-ar", "48000")


def x264_args(profile: str, level: str | None, maxrate: str, bufsize: str) -> list[str]:
    """Argumentos de vídeo comunes: H.264 yuv420p, CRF con tope de bitrate y GOP de 2 s."""
    args = [
        "-c:v",
        "libx264",
        "-preset",
        "veryfast",
        "-crf",
        "23",
        "-pix_fmt",
        "yuv420p",
        "-profile:v",
        profile,
    ]
    if level is not None:
        args += ["-level:v", level]
    return [
        *args,
        "-maxrate",
        maxrate,
        "-bufsize",
        bufsize,
        "-force_key_frames",
        f"expr:gte(t,n_forced*{KEYFRAME_INTERVAL_S})",
        "-sc_threshold",
        "0",
    ]


def mp4_output_args(dest: str) -> list[str]:
    """Salida MP4 con el `moov` al principio: el navegador arranca sin pedir el final."""
    return ["-movflags", "+faststart", "-f", "mp4", dest]


def ffmpeg_normalize_cmd(src: str, dest: str) -> list[str]:
    """Comando FFmpeg que re-codifica a MP4 H.264 (yuv420p) + AAC listo para streaming."""
    return [
        "ffmpeg",
        "-v",
        "error",
        "-nostdin",
        "-y",
        "-i",
        src,
        "-map",
        "0:v:0",
        "-map",
        "0:a:0?",
        *x264_args(SOURCE_PROFILE, None, SOURCE_MAXRATE, SOURCE_BUFSIZE),
        *AUDIO_ARGS,
        *mp4_output_args(dest),
    ]


def ffmpeg_remux_cmd(src: str, dest: str) -> list[str]:
    """Comando FFmpeg que copia el primer vídeo y audio a un MP4 nuevo con `+faststart`.

    No cambia el intervalo de keyframes del original: es el precio de no re-codificar un
    original que ya cumple códecs y bitrate.
    """
    return [
        "ffmpeg",
        "-v",
        "error",
        "-nostdin",
        "-y",
        "-i",
        src,
        "-map",
        "0:v:0",
        "-map",
        "0:a:0?",
        "-c",
        "copy",
        *mp4_output_args(dest),
    ]


def _run_ffmpeg(cmd: list[str], runner, timeout: float) -> None:
    try:
        result = runner(
            cmd,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.PIPE,
            text=True,
            check=False,
            timeout=timeout,
        )
    except subprocess.TimeoutExpired as exc:
        raise NormalizeError(f"ffmpeg excedió el tiempo límite ({timeout} s)") from exc
    except OSError as exc:
        raise NormalizeError(f"no se pudo ejecutar ffmpeg: {exc}") from exc
    if result.returncode != 0:
        raise NormalizeError((result.stderr or "").strip() or "ffmpeg falló")


def normalize_video(
    src: Path, dest: Path, runner=subprocess.run, timeout: float = DEFAULT_TIMEOUT_S
) -> None:
    """Escribe en `dest` la versión MP4 H.264 + AAC de `src`; trabaja de archivo a archivo."""
    _run_ffmpeg(ffmpeg_normalize_cmd(str(src), str(dest)), runner, timeout)


def remux_video(
    src: Path, dest: Path, runner=subprocess.run, timeout: float = REMUX_TIMEOUT_S
) -> None:
    """Escribe en `dest` un MP4 con `moov` al principio copiando los streams de `src`."""
    _run_ffmpeg(ffmpeg_remux_cmd(str(src), str(dest)), runner, timeout)
