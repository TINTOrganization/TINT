import json
import subprocess
from pathlib import Path
from unittest.mock import Mock

import pytest
from fakes import fake_run

from media_worker.normalize import (
    DEFAULT_TIMEOUT_S,
    KEYFRAME_INTERVAL_S,
    MAX_REMUX_BITRATE,
    REMUX_TIMEOUT_S,
    NormalizeError,
    ffmpeg_normalize_cmd,
    ffmpeg_remux_cmd,
    is_normalized,
    normalize_video,
    remux_video,
    x264_args,
)


def test_normalize_cmd_targets_mp4_h264_aac_with_faststart():
    cmd = ffmpeg_normalize_cmd("in.mkv", "out.mp4")
    assert cmd[cmd.index("-i") + 1] == "in.mkv"
    assert cmd[-1] == "out.mp4"
    assert cmd[cmd.index("-c:v") + 1] == "libx264"
    assert cmd[cmd.index("-pix_fmt") + 1] == "yuv420p"
    assert cmd[cmd.index("-c:a") + 1] == "aac"
    assert cmd[cmd.index("-movflags") + 1] == "+faststart"
    assert "0:a:0?" in cmd  # el audio es opcional


def test_normalize_cmd_exact_args_for_fast_seek_and_start():
    assert ffmpeg_normalize_cmd("in.mkv", "out.mp4") == [
        "ffmpeg",
        "-v",
        "error",
        "-nostdin",
        "-y",
        "-i",
        "in.mkv",
        "-map",
        "0:v:0",
        "-map",
        "0:a:0?",
        "-c:v",
        "libx264",
        "-preset",
        "veryfast",
        "-crf",
        "23",
        "-pix_fmt",
        "yuv420p",
        "-profile:v",
        "high",
        "-maxrate",
        "8000k",
        "-bufsize",
        "16000k",
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


def test_keyframe_interval_is_two_seconds():
    assert KEYFRAME_INTERVAL_S == 2
    cmd = ffmpeg_normalize_cmd("in.mkv", "out.mp4")
    assert cmd[cmd.index("-force_key_frames") + 1] == "expr:gte(t,n_forced*2)"


def test_x264_args_includes_level_only_when_given():
    assert "-level:v" not in x264_args("high", None, "8000k", "16000k")
    args = x264_args("main", "3.1", "1000k", "2000k")
    assert args[args.index("-profile:v") + 1] == "main"
    assert args[args.index("-level:v") + 1] == "3.1"
    assert args[args.index("-maxrate") + 1] == "1000k"
    assert args[args.index("-bufsize") + 1] == "2000k"


def test_normalize_runs_ffmpeg_with_timeout():
    runner = fake_run()
    normalize_video(Path("in.mp4"), Path("out.mp4"), runner)
    assert runner.call_args.args[0] == ffmpeg_normalize_cmd("in.mp4", "out.mp4")
    assert runner.call_args.kwargs["timeout"] == DEFAULT_TIMEOUT_S


def test_normalize_raises_with_ffmpeg_stderr_on_failure():
    with pytest.raises(NormalizeError, match="codec roto"):
        normalize_video(
            Path("in.mp4"), Path("out.mp4"), fake_run(returncode=1, stderr="codec roto")
        )


def test_normalize_raises_on_timeout():
    runner = fake_run()
    runner.side_effect = subprocess.TimeoutExpired("ffmpeg", 5)
    with pytest.raises(NormalizeError, match="tiempo límite"):
        normalize_video(Path("in.mp4"), Path("out.mp4"), runner, timeout=5)


def test_normalize_raises_if_ffmpeg_cannot_start():
    runner = fake_run()
    runner.side_effect = FileNotFoundError("ffmpeg")
    with pytest.raises(NormalizeError, match="no se pudo ejecutar"):
        normalize_video(Path("in.mp4"), Path("out.mp4"), runner)


def probe_json(
    container="mov,mp4,m4a,3gp,3g2,mj2",
    video="h264",
    audio="aac",
    pix_fmt="yuv420p",
    bit_rate="5000000",
    major_brand="isom",
):
    streams = []
    if video:
        streams.append({"codec_type": "video", "codec_name": video, "pix_fmt": pix_fmt})
    if audio:
        streams.append({"codec_type": "audio", "codec_name": audio})
    fmt = {"format_name": container}
    if bit_rate is not None:
        fmt["bit_rate"] = bit_rate
    if major_brand is not None:
        fmt["tags"] = {"major_brand": major_brand}
    return json.dumps({"streams": streams, "format": fmt})


def test_is_normalized_for_mp4_h264_aac():
    runner = fake_run(stdout=probe_json())
    assert is_normalized(Path("in.mp4"), runner) is True
    cmd = runner.call_args.args[0]
    assert cmd[0] == "ffprobe"
    assert cmd[-1] == "in.mp4"
    entries = cmd[cmd.index("-show_entries") + 1]
    assert "format=format_name,bit_rate" in entries
    assert "format_tags=major_brand" in entries


def test_is_normalized_accepts_video_without_audio():
    assert is_normalized(Path("in.mp4"), fake_run(stdout=probe_json(audio=None))) is True


def test_is_normalized_accepts_bitrate_at_the_limit_and_no_brand():
    output = probe_json(bit_rate=str(MAX_REMUX_BITRATE), major_brand=None)
    assert MAX_REMUX_BITRATE == 12_000_000
    assert is_normalized(Path("in.mp4"), fake_run(stdout=output)) is True


@pytest.mark.parametrize(
    "output",
    [
        probe_json(container="matroska,webm"),
        probe_json(video="hevc"),
        probe_json(audio="ac3"),
        probe_json(pix_fmt="yuv444p"),
        probe_json(video=None),
        probe_json(bit_rate="12000001"),  # demasiado pesado para streaming: se re-codifica
        probe_json(bit_rate=None),  # bitrate desconocido: ante la duda, re-codificar
        probe_json(bit_rate="N/A"),
        probe_json(major_brand="qt  "),  # QuickTime (.mov de móvil) que ffprobe ve como mp4
        "no es json",
        "{}",
    ],
)
def test_is_normalized_false_when_something_differs(output):
    assert is_normalized(Path("in.mp4"), fake_run(stdout=output)) is False


def test_is_normalized_false_for_mov_extension_even_with_mp4_brand():
    runner = fake_run(stdout=probe_json())
    assert is_normalized(Path("clip.MOV"), runner) is False


@pytest.mark.parametrize(
    "runner",
    [
        fake_run(returncode=1, stderr="corrupto"),
        Mock(side_effect=subprocess.TimeoutExpired("ffprobe", 1)),
        Mock(side_effect=FileNotFoundError("ffprobe")),
    ],
)
def test_is_normalized_false_when_probe_fails(runner):
    assert is_normalized(Path("in.mp4"), runner) is False


def test_remux_cmd_copies_streams_with_faststart():
    assert ffmpeg_remux_cmd("in.mp4", "out.mp4") == [
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
        "-c",
        "copy",
        "-movflags",
        "+faststart",
        "-f",
        "mp4",
        "out.mp4",
    ]


def test_remux_runs_ffmpeg_with_timeout():
    runner = fake_run()
    remux_video(Path("in.mp4"), Path("out.mp4"), runner)
    assert runner.call_args.args[0] == ffmpeg_remux_cmd("in.mp4", "out.mp4")
    assert runner.call_args.kwargs["timeout"] == REMUX_TIMEOUT_S


@pytest.mark.parametrize(
    ("runner", "message"),
    [
        (fake_run(returncode=1, stderr="moov roto"), "moov roto"),
        (Mock(side_effect=subprocess.TimeoutExpired("ffmpeg", 1)), "tiempo límite"),
        (Mock(side_effect=FileNotFoundError("ffmpeg")), "no se pudo ejecutar"),
    ],
)
def test_remux_raises_normalize_error_on_failure(runner, message):
    with pytest.raises(NormalizeError, match=message):
        remux_video(Path("in.mp4"), Path("out.mp4"), runner)
