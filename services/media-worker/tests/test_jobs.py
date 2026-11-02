import logging
from pathlib import Path
from unittest.mock import Mock

import pytest
from fakes import FakeBlobStore, FakeRepository

from media_worker.jobs import INCOMING_PREFIX, handle_upload, mark_exhausted
from media_worker.pipeline import VideoNotFoundError
from media_worker.probe import FailureReason, VideoStatus
from media_worker.repository import VideoRow
from media_worker.storage import BlobNotFoundError

VIDEO_ID = "0b9f7c1e-2d4a-4b8e-9f00-1a2b3c4d5e6f"
STAGED = f"{INCOMING_PREFIX}{VIDEO_ID}/original.MP4"


class Blobs(FakeBlobStore):
    """Añade `download` al FakeBlobStore compartido."""

    def download(self, key, dest):
        if key not in self.objects:
            raise BlobNotFoundError(key)
        Path(dest).write_bytes(self.objects[key])


def repo_with(row):
    repo = Mock()
    repo.get_video.return_value = (
        None if row is None else VideoRow(*row, *([None] * (3 - len(row))))
    )
    return repo


def test_incoming_prefix_is_the_staging_area():
    assert INCOMING_PREFIX == "incoming/"


def test_downloads_the_staged_upload_and_runs_the_pipeline_with_its_original_name():
    blobs = Blobs({STAGED: b"bytes del navegador"})
    repo = repo_with(("processing", STAGED))
    seen = {}

    def process(video_id, source, repo_, blobs_):
        seen.update(video_id=video_id, name=source.name, data=source.read_bytes(), exists=True)
        assert blobs_ is blobs
        return VideoStatus.READY

    assert handle_upload(VIDEO_ID, repo, blobs, process=process) is VideoStatus.READY
    assert seen == {
        "video_id": VIDEO_ID,
        "name": "original.MP4",
        "data": b"bytes del navegador",
        "exists": True,
    }


def test_temporary_file_is_removed_after_processing():
    blobs = Blobs({STAGED: b"x"})
    paths = []
    handle_upload(
        VIDEO_ID,
        repo_with(("processing", STAGED)),
        blobs,
        process=lambda v, s, r, b: paths.append(s),
    )
    assert paths and not paths[0].exists()


def test_already_published_video_is_not_reprocessed(caplog):
    process = Mock()
    repo = repo_with(("ready", f"{VIDEO_ID}/source.mp4"))
    with caplog.at_level(logging.INFO, logger="media_worker.jobs"):
        assert handle_upload(VIDEO_ID, repo, Blobs(), process=process) is VideoStatus.READY
    process.assert_not_called()
    assert "ya publicado" in caplog.text


@pytest.mark.parametrize("video_id", ["abc", "abc_123", "x" * 36])
def test_non_uuid_ids_are_skipped_before_touching_sql(video_id, caplog):
    repo = Mock()
    with caplog.at_level(logging.WARNING, logger="media_worker.jobs"):
        assert handle_upload(video_id, repo, Blobs(), process=Mock()) is None
    repo.get_video.assert_not_called()
    assert "no es un UUID" in caplog.text


def test_unknown_video_is_skipped(caplog):
    process = Mock()
    with caplog.at_level(logging.WARNING, logger="media_worker.jobs"):
        assert handle_upload(VIDEO_ID, repo_with(None), Blobs(), process=process) is None
    process.assert_not_called()
    assert "no existe" in caplog.text


def test_missing_upload_marks_failed():
    repo = repo_with(("processing", STAGED))
    assert handle_upload(VIDEO_ID, repo, Blobs(), process=Mock()) is VideoStatus.FAILED
    repo.mark_failed.assert_called_once_with(VIDEO_ID, FailureReason.MISSING_FILE)


def test_row_deleted_while_processing_is_skipped():
    blobs = Blobs({STAGED: b"x"})
    process = Mock(side_effect=VideoNotFoundError("borrado"))
    assert (
        handle_upload(VIDEO_ID, repo_with(("processing", STAGED)), blobs, process=process) is None
    )


def test_infrastructure_errors_propagate_so_the_event_is_retried():
    blobs = Blobs({STAGED: b"x"})
    process = Mock(side_effect=ConnectionError("S3 caído"))
    with pytest.raises(ConnectionError):
        handle_upload(VIDEO_ID, repo_with(("processing", STAGED)), blobs, process=process)


def test_default_process_is_the_pipeline(monkeypatch):
    import media_worker.jobs as jobs

    called = Mock(return_value=VideoStatus.FAILED)
    monkeypatch.setattr(jobs, "process_video", called)
    blobs = Blobs({STAGED: b"x"})
    assert handle_upload(VIDEO_ID, repo_with(("processing", STAGED)), blobs) is VideoStatus.FAILED
    called.assert_called_once()


def test_unsupported_extension_marks_failed_without_downloading():
    key = f"{INCOMING_PREFIX}{VIDEO_ID}/original.avi"
    blobs = Blobs({key: b"x"})
    blobs.download = Mock()
    repo = repo_with(("processing", key))
    process = Mock()
    assert handle_upload(VIDEO_ID, repo, blobs, process=process) is VideoStatus.FAILED
    repo.mark_failed.assert_called_once_with(VIDEO_ID, FailureReason.UNSUPPORTED_FORMAT)
    blobs.download.assert_not_called()
    process.assert_not_called()


# --- media_processed en analytics:events ---------------------------------------------------


def clock(*ticks):
    return Mock(side_effect=list(ticks))


def ready_process(duration_ms=2500):
    def process(video_id, source, repo, blobs):
        repo.mark_ready(video_id, duration_ms, f"{video_id}/source.mp4")
        return VideoStatus.READY

    return process


def only_event(publish):
    publish.assert_called_once()
    (event,) = publish.call_args.args
    return event


def test_pipeline_sees_a_repo_that_delegates_to_the_real_one():
    repo = repo_with(("processing", STAGED))
    handle_upload(VIDEO_ID, repo, Blobs({STAGED: b"x"}), process=ready_process(2500))
    repo.mark_ready.assert_called_once_with(VIDEO_ID, 2500, f"{VIDEO_ID}/source.mp4", ())


def test_pipeline_renditions_reach_the_real_repo():
    def process(video_id, source, repo, blobs):
        repo.mark_ready(video_id, 2500, f"{video_id}/source.mp4", [720, 360])
        return VideoStatus.READY

    repo = repo_with(("processing", STAGED))
    handle_upload(VIDEO_ID, repo, Blobs({STAGED: b"x"}), process=process)
    repo.mark_ready.assert_called_once_with(VIDEO_ID, 2500, f"{VIDEO_ID}/source.mp4", [720, 360])


def test_ready_emits_media_processed_with_duration_elapsed_time_and_uploader():
    publish = Mock()
    status = handle_upload(
        VIDEO_ID,
        repo_with(("processing", STAGED, "firebase-uid")),
        Blobs({STAGED: b"x"}),
        process=ready_process(2500),
        publish=publish,
        clock=clock(10.0, 11.5),
    )
    assert status is VideoStatus.READY
    event = only_event(publish)
    assert event["type"] == "media_processed"
    assert event["source"] == "media-worker"
    assert event["media_id"] == VIDEO_ID
    assert event["status"] == "ready"
    assert event["duration_ms"] == "2500"
    assert event["processing_ms"] == "1500"
    assert event["user_id"] == "firebase-uid"
    assert "room_id" not in event


def test_pipeline_failure_emits_failed_without_duration():
    publish = Mock()
    handle_upload(
        VIDEO_ID,
        repo_with(("processing", STAGED, "uid")),
        Blobs({STAGED: b"x"}),
        process=Mock(return_value=VideoStatus.FAILED),
        publish=publish,
        clock=clock(1.0, 1.25),
    )
    event = only_event(publish)
    assert (event["status"], event["duration_ms"], event["processing_ms"]) == ("failed", "", "250")


def test_missing_upload_emits_failed():
    publish = Mock()
    status = handle_upload(
        VIDEO_ID, repo_with(("processing", STAGED)), Blobs(), process=Mock(), publish=publish
    )
    assert status is VideoStatus.FAILED
    assert only_event(publish)["status"] == "failed"


def test_unsupported_extension_emits_failed():
    key = f"{INCOMING_PREFIX}{VIDEO_ID}/original.avi"
    publish = Mock()
    handle_upload(VIDEO_ID, repo_with(("processing", key)), Blobs(), publish=publish)
    assert only_event(publish)["status"] == "failed"


def test_reprocessing_with_the_fake_repository_reads_uploader_and_records_ready():
    repo = FakeRepository({VIDEO_ID}, uploaders={VIDEO_ID: "uid-9"})
    key = f"{INCOMING_PREFIX}{VIDEO_ID}/original.mp4"
    publish = Mock()
    handle_upload(VIDEO_ID, repo, Blobs({key: b"x"}), process=ready_process(900), publish=publish)
    assert repo.statuses[VIDEO_ID] == "ready"
    assert repo.get_video(VIDEO_ID).storage_key == f"{VIDEO_ID}/source.mp4"
    event = only_event(publish)
    assert (event["user_id"], event["duration_ms"]) == ("uid-9", "900")
    # Un segundo evento del mismo vídeo es un duplicado: no se publica otra vez.
    handle_upload(VIDEO_ID, repo, Blobs(), publish=publish)
    publish.assert_called_once()
    assert FakeRepository(set()).get_video(VIDEO_ID) is None


def test_video_without_uploader_emits_empty_user_id():
    publish = Mock()
    handle_upload(
        VIDEO_ID,
        repo_with(("processing", STAGED, None)),
        Blobs({STAGED: b"x"}),
        process=ready_process(),
        publish=publish,
    )
    assert only_event(publish)["user_id"] == ""


@pytest.mark.parametrize(
    ("video_id", "row", "process"),
    [
        ("abc", ("processing", STAGED), Mock()),
        (VIDEO_ID, None, Mock()),
        (VIDEO_ID, ("ready", f"{VIDEO_ID}/source.mp4"), Mock()),
        (VIDEO_ID, ("processing", STAGED), Mock(side_effect=VideoNotFoundError("borrado"))),
    ],
    ids=["no-uuid", "sin-fila", "duplicado", "fila-borrada"],
)
def test_events_that_process_nothing_emit_nothing(video_id, row, process):
    publish = Mock()
    handle_upload(video_id, repo_with(row), Blobs({STAGED: b"x"}), process=process, publish=publish)
    publish.assert_not_called()


def test_infrastructure_errors_emit_nothing_because_the_event_is_retried():
    publish = Mock()
    with pytest.raises(ConnectionError):
        handle_upload(
            VIDEO_ID,
            repo_with(("processing", STAGED)),
            Blobs({STAGED: b"x"}),
            process=Mock(side_effect=ConnectionError("S3 caído")),
            publish=publish,
        )
    publish.assert_not_called()


def test_publish_errors_are_logged_and_do_not_change_the_outcome(caplog):
    publish = Mock(side_effect=ConnectionError("redis caído"))
    with caplog.at_level(logging.WARNING, logger="media_worker.jobs"):
        status = handle_upload(
            VIDEO_ID,
            repo_with(("processing", STAGED)),
            Blobs({STAGED: b"x"}),
            process=ready_process(),
            publish=publish,
        )
    assert status is VideoStatus.READY
    assert "media_processed" in caplog.text


def test_exhausted_retries_mark_the_video_failed_and_emit_the_outcome():
    repo = FakeRepository([VIDEO_ID], uploaders={VIDEO_ID: "sub-1"})
    publish = Mock()
    mark_exhausted(VIDEO_ID, repo, publish=publish)
    assert repo.statuses[VIDEO_ID] == "failed"
    assert repo.reasons[VIDEO_ID] is FailureReason.PROCESSING_FAILED
    (event,) = (call.args[0] for call in publish.call_args_list)
    assert (event["type"], event["status"], event["user_id"]) == (
        "media_processed",
        "failed",
        "sub-1",
    )
    assert event["duration_ms"] == ""


def test_exhausted_retries_work_without_analytics():
    repo = FakeRepository([VIDEO_ID])
    mark_exhausted(VIDEO_ID, repo)
    assert repo.statuses[VIDEO_ID] == "failed"


@pytest.mark.parametrize("video_id", ["abc", "x" * 36], ids=["not-a-uuid", "long-not-a-uuid"])
def test_exhausted_retries_skip_ids_that_are_not_uuids(video_id):
    repo = Mock()
    mark_exhausted(video_id, repo)
    repo.get_video.assert_not_called()
    repo.mark_failed.assert_not_called()


def test_exhausted_retries_skip_unknown_and_already_published_videos():
    repo = FakeRepository([VIDEO_ID])
    publish = Mock()
    mark_exhausted("11111111-1111-4111-8111-111111111111", repo, publish=publish)
    repo.statuses[VIDEO_ID] = "ready"
    repo.storage_keys[VIDEO_ID] = f"{VIDEO_ID}/source.mp4"
    mark_exhausted(VIDEO_ID, repo, publish=publish)
    assert repo.statuses[VIDEO_ID] == "ready"
    assert repo.reasons == {}
    publish.assert_not_called()


def test_exhausted_retries_log_the_reason(caplog):
    repo = FakeRepository([VIDEO_ID])
    with caplog.at_level(logging.WARNING, logger="media_worker.jobs"):
        mark_exhausted(VIDEO_ID, repo)
    assert VIDEO_ID in caplog.text and "reintentos agotados" in caplog.text
