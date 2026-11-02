import logging
import threading
from unittest.mock import Mock

import pytest
from fakes import FakeRedis
from redis.exceptions import ResponseError

from media_worker.consumer import CONSUMER_GROUP, STREAM_KEY, StreamConsumer, parse_video_id


def make_consumer(redis, handler=None, **kwargs):
    return StreamConsumer(redis, handler or Mock(), consumer="w1", **kwargs)


def test_stream_and_group_names():
    assert (STREAM_KEY, CONSUMER_GROUP) == ("media:uploads", "media-workers")


@pytest.mark.parametrize(
    ("fields", "expected"),
    [
        (
            {"video_id": "0b9f7c1e-2d4a-4b8e-9f00-1a2b3c4d5e6f"},
            "0b9f7c1e-2d4a-4b8e-9f00-1a2b3c4d5e6f",
        ),
        ({"video_id": "abc_123"}, "abc_123"),
        ({"video_id": "../etc"}, None),
        ({"video_id": "a/b"}, None),
        ({"video_id": ""}, None),
        ({"video_id": "x" * 129}, None),
        ({"other": "1"}, None),
        ({}, None),
        (None, None),
    ],
)
def test_parse_video_id(fields, expected):
    assert parse_video_id(fields) == expected


def test_ensure_group_creates_group_and_stream_once():
    redis = FakeRedis()
    consumer = make_consumer(redis)
    consumer.ensure_group()
    consumer.ensure_group()
    assert redis.groups == {(STREAM_KEY, CONSUMER_GROUP)}


def test_ensure_group_propagates_other_errors():
    redis = Mock()
    redis.xgroup_create.side_effect = ResponseError("NOPERM")
    with pytest.raises(ResponseError):
        make_consumer(redis).ensure_group()


def test_poll_handles_and_acks_each_message():
    redis = FakeRedis()
    ids = [redis.xadd(STREAM_KEY, {"video_id": v}) for v in ("a", "b")]
    handler = Mock()
    assert make_consumer(redis, handler).poll() == 2
    assert [call.args[0] for call in handler.call_args_list] == ["a", "b"]
    assert redis.acks == ids
    assert redis.pending == {}


def test_poll_passes_block_and_count_to_redis():
    redis = Mock()
    redis.xreadgroup.return_value = None
    assert make_consumer(redis, block_ms=1234, count=7).poll() == 0
    redis.xreadgroup.assert_called_once_with(
        CONSUMER_GROUP, "w1", {STREAM_KEY: ">"}, count=7, block=1234
    )


def test_invalid_event_is_acked_and_discarded(caplog):
    redis = FakeRedis()
    message_id = redis.xadd(STREAM_KEY, {"video_id": "../../x"})
    handler = Mock()
    with caplog.at_level(logging.WARNING, logger="media_worker.consumer"):
        make_consumer(redis, handler).poll()
    handler.assert_not_called()
    assert redis.acks == [message_id]
    assert message_id in caplog.text


def test_run_retries_a_failed_event_and_then_succeeds():
    """Un fallo temporal no tumba el worker: el evento se reintenta con `attempt` incrementado."""
    redis = FakeRedis()
    stop = threading.Event()
    redis.xadd(STREAM_KEY, {"video_id": "a"})
    calls = []

    def handler(video_id):
        calls.append(video_id)
        if len(calls) == 1:
            raise ConnectionError("minio caído")
        stop.set()

    sleeps = []
    make_consumer(redis, handler, sleep=sleeps.append).run(stop)
    assert calls == ["a", "a"]
    assert redis.pending == {}
    assert sleeps == [5.0]
    assert redis.entries(STREAM_KEY) == [{"video_id": "a"}, {"video_id": "a", "attempt": "2"}]


def test_failed_event_is_acked_and_requeued_with_the_next_attempt(caplog):
    redis = FakeRedis()
    message_id = redis.xadd(STREAM_KEY, {"video_id": "a"})
    sleeps = []
    handler = Mock(side_effect=ConnectionError("postgres caído"))
    with caplog.at_level(logging.WARNING, logger="media_worker.consumer"):
        make_consumer(redis, handler, sleep=sleeps.append).poll()
    assert redis.acks == [message_id]
    assert redis.pending == {}
    assert redis.entries(STREAM_KEY)[-1] == {"video_id": "a", "attempt": "2"}
    assert sleeps == [5.0]
    assert "a" in caplog.text and "intento 1/3" in caplog.text and "postgres caído" in caplog.text


@pytest.mark.parametrize("attempt", [None, "", "x", "0", "-3"])
def test_missing_or_invalid_attempt_counts_as_the_first(attempt):
    redis = FakeRedis()
    fields = {"video_id": "a"} if attempt is None else {"video_id": "a", "attempt": attempt}
    redis.xadd(STREAM_KEY, fields)
    make_consumer(redis, Mock(side_effect=OSError()), sleep=lambda _s: None).poll()
    assert redis.entries(STREAM_KEY)[-1]["attempt"] == "2"


def test_exhausted_retries_move_the_job_to_failed_and_log_the_reason(caplog):
    redis = FakeRedis()
    message_id = redis.xadd(STREAM_KEY, {"video_id": "a", "attempt": "3"})
    exhausted = Mock()
    handler = Mock(side_effect=ConnectionError("minio caído"))
    consumer = make_consumer(redis, handler, on_exhausted=exhausted, sleep=lambda _s: None)
    with caplog.at_level(logging.ERROR, logger="media_worker.consumer"):
        consumer.poll()
    exhausted.assert_called_once_with("a")
    assert redis.acks == [message_id]
    assert len(redis.entries(STREAM_KEY)) == 1
    assert "reintentos agotados" in caplog.text and "minio caído" in caplog.text


def test_exhausted_retries_without_a_callback_are_only_acked():
    redis = FakeRedis()
    redis.xadd(STREAM_KEY, {"video_id": "a", "attempt": "3"})
    make_consumer(redis, Mock(side_effect=OSError())).poll()
    assert redis.pending == {}
    assert len(redis.entries(STREAM_KEY)) == 1


def test_max_attempts_is_configurable():
    redis = FakeRedis()
    redis.xadd(STREAM_KEY, {"video_id": "a"})
    exhausted = Mock()
    consumer = make_consumer(
        redis, Mock(side_effect=OSError()), on_exhausted=exhausted, max_attempts=1
    )
    consumer.poll()
    exhausted.assert_called_once_with("a")


def test_exhausted_callback_error_leaves_the_message_pending():
    redis = FakeRedis()
    message_id = redis.xadd(STREAM_KEY, {"video_id": "a", "attempt": "3"})
    exhausted = Mock(side_effect=ConnectionError("postgres caído"))
    consumer = make_consumer(redis, Mock(side_effect=OSError()), on_exhausted=exhausted)
    with pytest.raises(ConnectionError):
        consumer.poll()
    assert redis.acks == []
    assert (STREAM_KEY, message_id) in redis.pending


def test_run_gives_up_after_the_maximum_attempts_without_blocking_the_queue():
    redis = FakeRedis()
    stop = threading.Event()
    redis.xadd(STREAM_KEY, {"video_id": "bad"})
    redis.xadd(STREAM_KEY, {"video_id": "good"})
    seen, exhausted = [], []

    def handler(video_id):
        seen.append(video_id)
        if video_id == "bad":
            raise ValueError("ffmpeg murió")

    def on_exhausted(video_id):
        exhausted.append(video_id)
        stop.set()

    make_consumer(redis, handler, on_exhausted=on_exhausted, sleep=lambda _s: None).run(stop)
    assert seen == ["bad", "good", "bad", "bad"]
    assert exhausted == ["bad"]
    assert redis.pending == {}


def test_redis_errors_leave_the_message_pending_and_run_retries_it():
    """Si Redis falla al reencolar, el evento sigue pendiente y `run` lo recupera."""
    redis = FakeRedis()
    stop = threading.Event()
    message_id = redis.xadd(STREAM_KEY, {"video_id": "a"})
    calls = []

    def handler(video_id):
        calls.append(video_id)
        if len(calls) == 1:
            raise ConnectionError("minio caído")
        stop.set()

    real_xadd = redis.xadd
    failures = iter([ConnectionError("redis caído")])

    def flaky_xadd(*args, **kwargs):
        error = next(failures, None)
        if error:
            raise error
        return real_xadd(*args, **kwargs)

    redis.xadd = flaky_xadd
    sleeps = []
    make_consumer(redis, handler, sleep=sleeps.append).run(stop)
    assert calls == ["a", "a"]
    assert (STREAM_KEY, message_id) not in redis.pending
    assert sleeps == [5.0]


def test_fake_redis_keeps_streams_apart():
    redis = FakeRedis()
    redis.xadd("analytics:events", {"type": "x"}, maxlen=10, approximate=True)
    redis.xadd(STREAM_KEY, {"video_id": "a"})
    handler = Mock()
    assert make_consumer(redis, handler).poll() == 1
    handler.assert_called_once_with("a")
    assert redis.entries("analytics:events") == [{"type": "x"}]
    assert redis.xadd_calls[0] == ("analytics:events", 10, True)


def test_recover_pending_retries_unacked_messages_after_restart():
    redis = FakeRedis()
    redis.xadd(STREAM_KEY, {"video_id": "a"})
    redis.xreadgroup(CONSUMER_GROUP, "w1", {STREAM_KEY: ">"}, count=1)  # entregado y sin ACK
    handler = Mock()
    assert make_consumer(redis, handler).recover_pending() == 1
    handler.assert_called_once_with("a")
    assert redis.pending == {}


def test_run_recovers_pending_then_consumes_until_stopped():
    redis = FakeRedis()
    stop = threading.Event()
    seen = []

    def handler(video_id):
        seen.append(video_id)
        if video_id == "new":
            stop.set()

    redis.xadd(STREAM_KEY, {"video_id": "old"})
    redis.xreadgroup(CONSUMER_GROUP, "w1", {STREAM_KEY: ">"}, count=1)  # entregado y sin ACK
    redis.xadd(STREAM_KEY, {"video_id": "new"})
    make_consumer(redis, handler).run(stop)
    assert seen == ["old", "new"]
    assert redis.pending == {}


def test_run_without_pending_goes_straight_to_new_events(caplog):
    redis = FakeRedis()
    stop = threading.Event()
    redis.xadd(STREAM_KEY, {"video_id": "a"})
    with caplog.at_level(logging.INFO, logger="media_worker.consumer"):
        make_consumer(redis, lambda _video_id: stop.set()).run(stop)
    assert redis.pending == {}
    assert "pendientes" not in caplog.text


def test_run_logs_recovered_events(caplog):
    redis = FakeRedis()
    stop = threading.Event()
    redis.xadd(STREAM_KEY, {"video_id": "a"})
    redis.xreadgroup(CONSUMER_GROUP, "w1", {STREAM_KEY: ">"}, count=1)
    redis.xadd(STREAM_KEY, {"video_id": "b"})
    handler = Mock(side_effect=lambda video_id: video_id == "b" and stop.set())
    with caplog.at_level(logging.INFO, logger="media_worker.consumer"):
        make_consumer(redis, handler).run(stop)
    assert "reprocesados 1 eventos pendientes" in caplog.text


def test_run_returns_immediately_when_already_stopped():
    redis = FakeRedis()
    stop = threading.Event()
    stop.set()
    handler = Mock()
    redis.xadd(STREAM_KEY, {"video_id": "a"})
    make_consumer(redis, handler).run(stop)
    handler.assert_not_called()
    assert redis.groups == {(STREAM_KEY, CONSUMER_GROUP)}


def test_claim_stale_takes_over_jobs_left_by_a_dead_worker():
    redis = FakeRedis()
    message_id = redis.xadd(STREAM_KEY, {"video_id": "a"})
    redis.xreadgroup(CONSUMER_GROUP, "dead", {STREAM_KEY: ">"}, count=1)
    redis.idle_ms[message_id] = 20 * 60 * 1000
    handler = Mock()
    assert make_consumer(redis, handler, claim_idle_ms=600_000).claim_stale() == 1
    handler.assert_called_once_with("a")
    assert redis.acks == [message_id]
    assert redis.autoclaim_calls == [("w1", 600_000, 10)]


def test_claim_stale_leaves_recent_jobs_to_their_worker():
    redis = FakeRedis()
    message_id = redis.xadd(STREAM_KEY, {"video_id": "a"})
    redis.xreadgroup(CONSUMER_GROUP, "busy", {STREAM_KEY: ">"}, count=1)
    redis.idle_ms[message_id] = 1_000
    handler = Mock()
    assert make_consumer(redis, handler, claim_idle_ms=600_000).claim_stale() == 0
    handler.assert_not_called()
    assert redis.pending[(STREAM_KEY, message_id)][0] == "busy"


def test_claim_stale_accepts_the_two_element_reply_of_older_redis():
    redis = Mock()
    redis.xautoclaim.return_value = ["0-0", [("1-0", {"video_id": "a"})]]
    handler = Mock()
    assert make_consumer(redis, handler).claim_stale() == 1
    handler.assert_called_once_with("a")


def test_claim_stale_discards_entries_deleted_from_the_stream():
    redis = Mock()
    redis.xautoclaim.return_value = ["0-0", [("1-0", None)], []]
    handler = Mock()
    assert make_consumer(redis, handler).claim_stale() == 1
    handler.assert_not_called()
    redis.xack.assert_called_once_with(STREAM_KEY, CONSUMER_GROUP, "1-0")


def test_run_claims_stale_jobs_at_startup(caplog):
    redis = FakeRedis()
    stop = threading.Event()
    message_id = redis.xadd(STREAM_KEY, {"video_id": "orphan"})
    redis.xreadgroup(CONSUMER_GROUP, "dead", {STREAM_KEY: ">"}, count=1)
    redis.idle_ms[message_id] = 10**9
    with caplog.at_level(logging.INFO, logger="media_worker.consumer"):
        make_consumer(redis, lambda _v: stop.set()).run(stop)
    assert redis.pending == {}
    assert "reclamados 1 eventos de otros workers" in caplog.text


def test_run_sweeps_for_stale_jobs_only_once_per_interval():
    redis = FakeRedis()
    stop = threading.Event()
    now = [0.0]
    polls = []

    def poll(last_id=">"):
        polls.append(now[0])
        now[0] += 30.0
        if len(polls) == 6:
            stop.set()
        return 0

    consumer = make_consumer(redis, clock=lambda: now[0])
    consumer.poll = poll
    consumer.run(stop)
    # Barrido inicial (t=0) y uno por cada 60 s de espera con la cola vacía.
    assert [call[0] for call in redis.autoclaim_calls] == ["w1"] * 3


def test_claim_stale_follows_the_cursor_until_the_scan_is_complete():
    redis = Mock()
    redis.xautoclaim.side_effect = [
        ["5-0", [("1-0", {"video_id": "a"})], []],
        ["0-0", [("5-0", {"video_id": "b"})], []],
    ]
    handler = Mock()
    assert make_consumer(redis, handler).claim_stale() == 2
    assert [call.args[0] for call in handler.call_args_list] == ["a", "b"]
    starts = [call.kwargs["start_id"] for call in redis.xautoclaim.call_args_list]
    assert starts == ["0-0", "5-0"]
