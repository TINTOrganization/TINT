from unittest.mock import Mock

from media_worker.probe import FailureReason, VideoStatus
from media_worker.repository import VideoRepository


def conn_returning(row):
    conn = Mock()
    conn.execute.return_value.fetchone.return_value = row
    return conn


def test_start_processing_marks_processing_and_confirms_the_row_exists():
    conn = conn_returning(("v1",))
    assert VideoRepository(conn).start_processing("v1") is True
    sql, params = conn.execute.call_args.args
    assert sql.startswith("UPDATE videos SET status = %s")
    assert "RETURNING id" in sql
    assert params == (VideoStatus.PROCESSING.value, "v1")


def test_start_processing_returns_false_when_video_does_not_exist():
    assert VideoRepository(conn_returning(None)).start_processing("nope") is False


def test_mark_ready_sets_status_duration_storage_key_and_renditions():
    conn = Mock()
    VideoRepository(conn).mark_ready("v1", 2500, "v1/source.mp4", [720, 360])
    sql, params = conn.execute.call_args.args
    assert "duration_ms = %s" in sql
    assert "storage_key = %s" in sql
    assert "renditions = %s::jsonb" in sql
    assert "updated_at = now()" in sql
    assert params == (VideoStatus.READY.value, 2500, "v1/source.mp4", "[720,360]", "v1")


def test_mark_ready_without_renditions_writes_an_empty_array():
    conn = Mock()
    VideoRepository(conn).mark_ready("v1", 2500, "v1/source.mp4")
    _, params = conn.execute.call_args.args
    assert params[3] == "[]"


def test_mark_ready_overwrites_renditions_so_reprocessing_is_idempotent():
    conn = Mock()
    repo = VideoRepository(conn)
    repo.mark_ready("v1", 2500, "v1/source.mp4", (720, 360))
    first = conn.execute.call_args.args
    repo.mark_ready("v1", 2500, "v1/source.mp4", [720, 360])
    assert conn.execute.call_args.args == first
    assert "renditions = renditions" not in first[0]


def test_mark_failed_stores_the_reason_and_leaves_the_rest_alone():
    conn = Mock()
    VideoRepository(conn).mark_failed("v1", FailureReason.UNREADABLE)
    sql, params = conn.execute.call_args.args
    assert "failure_reason" in sql
    assert "duration_ms" not in sql
    assert "storage_key" not in sql
    assert "renditions" not in sql
    assert params == (VideoStatus.FAILED.value, "unreadable", "v1")


def test_a_new_attempt_and_a_success_clear_the_previous_failure_reason():
    conn = Mock()
    repo = VideoRepository(conn)
    conn.execute.return_value.fetchone.return_value = ("v1",)
    repo.start_processing("v1")
    assert "failure_reason = NULL" in conn.execute.call_args.args[0]
    repo.mark_ready("v1", 1000, "v1/source.mp4")
    assert "failure_reason = NULL" in conn.execute.call_args.args[0]


def test_get_video_returns_status_storage_key_and_uploader_sub():
    conn = conn_returning(("processing", "incoming/v1/original.mp4", "firebase-uid"))
    row = VideoRepository(conn).get_video("v1")
    assert row == ("processing", "incoming/v1/original.mp4", "firebase-uid")
    assert (row.status, row.storage_key, row.uploader_sub) == tuple(row)
    sql, params = conn.execute.call_args.args
    assert sql == (
        "SELECT videos.status, videos.storage_key, users.provider_sub FROM videos "
        "LEFT JOIN users ON users.id = videos.uploaded_by WHERE videos.id = %s"
    )
    assert params == ("v1",)


def test_get_video_without_uploader_has_no_sub():
    # uploaded_by es ON DELETE SET NULL: el LEFT JOIN no pierde la fila.
    row = VideoRepository(conn_returning(("processing", "k", None))).get_video("v1")
    assert row.uploader_sub is None


def test_get_video_returns_none_when_missing():
    assert VideoRepository(conn_returning(None)).get_video("nope") is None
