import logging
import subprocess
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock

import pytest
from fakes import FakeBlobStore

from media_worker.renditions import (
    DEFAULT_TIMEOUT_S,
    RENDITION_ENCODING,
    RENDITION_HEIGHTS,
    ffmpeg_rendition_cmd,
    generate_renditions,
    plan_renditions,
)


def test_rendition_heights_are_720_and_360():
    assert RENDITION_HEIGHTS == (720, 360)


@pytest.mark.parametrize(
    ("source_height", "expected"),
    [
        (2160, [720, 360]),
        (1080, [720, 360]),
        (721, [720, 360]),
        (720, [360]),
        (480, [360]),
        (361, [360]),
        (360, []),
        (240, []),
        (None, []),
        (0, []),
    ],
)
def test_plan_renditions_only_strictly_lower_heights_descending(source_height, expected):
    assert plan_renditions(source_height) == expected


def test_ffmpeg_rendition_cmd_scales_to_height_keeping_even_width():
    cmd = ffmpeg_rendition_cmd("in.mp4", "out.mp4", 360)
    assert cmd[0] == "ffmpeg"
    assert cmd[cmd.index("-i") + 1] == "in.mp4"
    assert cmd[cmd.index("-vf") + 1] == "scale=-2:360"
    assert cmd[cmd.index("-c:v") + 1] == "libx264"
    assert cmd[cmd.index("-preset") + 1] == "veryfast"
    assert cmd[cmd.index("-crf") + 1] == "23"
    assert cmd[cmd.index("-pix_fmt") + 1] == "yuv420p"
    assert cmd[cmd.index("-c:a") + 1] == "aac"
    assert cmd[cmd.index("-movflags") + 1] == "+faststart"
    assert cmd[cmd.index("-f") + 1] == "mp4"
    assert "-nostdin" in cmd and "-y" in cmd
    assert cmd[-1] == "out.mp4"


@pytest.mark.parametrize(
    ("height", "profile", "level", "maxrate", "bufsize"),
    [(720, "high", "4.1", "3000k", "6000k"), (360, "main", "3.1", "1000k", "2000k")],
)
def test_ffmpeg_rendition_cmd_exact_args_per_height(height, profile, level, maxrate, bufsize):
    assert ffmpeg_rendition_cmd("in.mp4", "out.mp4", height) == [
        "ffmpeg",
        "-v",
        "error",
        "-nostdin",
        "-y",
        "-i",
        "in.mp4",
        "-map",
        "0:v:0",
        "-map",
        "0:a:0?",
        "-vf",
        f"scale=-2:{height}",
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
        "-level:v",
        level,
        "-maxrate",
        maxrate,
        "-bufsize",
        bufsize,
        "-force_key_frames",
        "expr:gte(t,n_forced*2)",
        "-sc_threshold",
        "0",
        "-c:a",
        "aac",
        "-b:a",
        "128k",
        "-ac",
        "2",
        "-ar",
        "48000",
        "-movflags",
        "+faststart",
        "-f",
        "mp4",
        "out.mp4",
    ]


def test_every_planned_height_has_encoding_settings():
    assert set(RENDITION_ENCODING) == set(RENDITION_HEIGHTS)


def rendition_runner(fail_heights=(), errors=None):
    """Runner falso: escribe un MP4 ficticio por altura o falla en las indicadas."""
    errors = errors or {}
    seen = []

    def run(cmd, **kwargs):
        height = int(cmd[cmd.index("-vf") + 1].split(":")[1])
        dest = Path(cmd[-1])
        seen.append((height, dest, kwargs))
        if height in errors:
            raise errors[height]
        if height in fail_heights:
            return SimpleNamespace(returncode=1, stdout="", stderr="x264 boom")
        dest.write_bytes(f"{height}p-bytes".encode())
        return SimpleNamespace(returncode=0, stdout="", stderr="")

    runner = Mock(side_effect=run)
    runner.seen = seen
    return runner


@pytest.fixture
def source(tmp_path):
    path = tmp_path / "source.mp4"
    path.write_bytes(b"normalized")
    return path


def test_generate_renditions_uploads_each_planned_height(source):
    blobs = FakeBlobStore()
    runner = rendition_runner()
    assert generate_renditions("v1", source, 1080, blobs, runner) == [720, 360]
    assert blobs.objects == {"v1/720p.mp4": b"720p-bytes", "v1/360p.mp4": b"360p-bytes"}
    assert [height for height, _, _ in runner.seen] == [720, 360]
    for _, _, kwargs in runner.seen:
        assert kwargs["check"] is False
        assert kwargs["timeout"] == DEFAULT_TIMEOUT_S


def test_generate_renditions_reads_the_source_and_cleans_temp_files(source):
    runner = rendition_runner()
    generate_renditions("v1", source, 1080, FakeBlobStore(), runner)
    for call in runner.call_args_list:
        cmd = call.args[0]
        assert cmd[cmd.index("-i") + 1] == str(source)
    for _, dest, _ in runner.seen:
        assert dest != source
        assert not dest.exists() and not dest.parent.exists()
    assert source.read_bytes() == b"normalized"


def test_generate_renditions_does_nothing_for_small_sources(source):
    blobs = FakeBlobStore()
    runner = rendition_runner()
    assert generate_renditions("v1", source, 360, blobs, runner) == []
    runner.assert_not_called()
    assert blobs.objects == {}


@pytest.mark.parametrize(
    "runner",
    [
        rendition_runner(fail_heights={720}),
        rendition_runner(errors={720: subprocess.TimeoutExpired("ffmpeg", 1)}),
        rendition_runner(errors={720: OSError("ffmpeg no encontrado")}),
    ],
)
def test_failed_rendition_is_skipped_with_a_warning(source, runner, caplog):
    blobs = FakeBlobStore()
    with caplog.at_level(logging.WARNING, logger="media_worker.renditions"):
        assert generate_renditions("v1", source, 1080, blobs, runner) == [360]
    assert sorted(blobs.objects) == ["v1/360p.mp4"]
    assert "720" in caplog.text and "v1" in caplog.text


def test_upload_errors_propagate_so_the_job_can_be_retried(source):
    blobs = FakeBlobStore()

    def broken_upload(path, key):
        raise ConnectionError("minio caído")

    blobs.upload_file = broken_upload
    with pytest.raises(ConnectionError):
        generate_renditions("v1", source, 1080, blobs, rendition_runner())
