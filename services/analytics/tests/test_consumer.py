import logging
import threading
from datetime import timedelta
from unittest.mock import Mock

import pytest
from fakes import FakeEventStore, FakeRedis
from redis.exceptions import ResponseError

from analytics.consumer import (
    DAU_BACKFILL_DAYS,
    DAU_REFRESH_DAYS,
    MAINTENANCE_INTERVAL_S,
    RETRY_DELAY_S,
    StreamConsumer,
    run_maintenance_loop,
)
from analytics.sanitize import CONSUMER_GROUP, STREAM_KEY


def fields(event_id="e1", **extra):
    return {
        "event_id": event_id,
        "type": "chat_message",
        "source": "social-core",
        "room_id": "r1",
        "user_id": "guest:1",
        "message_length": "12",
        "occurred_at": "2026-10-11T10:00:00.000Z",
        "received_at": "2026-10-11T10:00:00.040Z",
        **extra,
    }


def make_consumer(redis, store=None, **kwargs):
    return StreamConsumer(redis, store or FakeEventStore(), consumer="a1", **kwargs)


def test_stream_and_group_names():
    assert (STREAM_KEY, CONSUMER_GROUP) == ("analytics:events", "analytics-workers")


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


def test_poll_sanitizes_persists_and_acks_each_message():
    redis = FakeRedis()
    ids = [redis.xadd(STREAM_KEY, fields(e, text="secreto")) for e in ("e1", "e2")]
    store = FakeEventStore()
    assert make_consumer(redis, store).poll() == 2
    assert list(store.events) == ["e1", "e2"]
    assert "text" not in store.events["e1"]
    assert store.events["e1"]["message_length"] == 7
    assert redis.acks == ids
    assert redis.pending == {}


def test_poll_persists_the_whole_batch_in_one_call_and_acks_it_at_once():
    redis = Mock()
    redis.xreadgroup.return_value = [[STREAM_KEY, [("1-0", fields("e1")), ("2-0", fields("e2"))]]]
    store = FakeEventStore()
    assert make_consumer(redis, store).poll() == 2
    assert store.batches == [["e1", "e2"]], "una sola transacción para el lote"
    redis.xack.assert_called_once_with(STREAM_KEY, CONSUMER_GROUP, "1-0", "2-0")


def test_poll_without_messages_does_not_touch_the_store_or_ack():
    redis = Mock()
    redis.xreadgroup.return_value = []
    store = FakeEventStore()
    assert make_consumer(redis, store).poll() == 0
    assert store.saves == 0
    redis.xack.assert_not_called()


def test_poll_passes_block_and_count_to_redis():
    redis = Mock()
    redis.xreadgroup.return_value = None
    assert make_consumer(redis, block_ms=1234, count=7).poll() == 0
    redis.xreadgroup.assert_called_once_with(
        CONSUMER_GROUP, "a1", {STREAM_KEY: ">"}, count=7, block=1234
    )


def test_duplicate_events_are_acked_without_counting_twice():
    redis = FakeRedis()
    first = redis.xadd(STREAM_KEY, fields())
    second = redis.xadd(STREAM_KEY, fields())
    store = FakeEventStore()
    make_consumer(redis, store).poll()
    assert len(store.events) == 1
    assert redis.acks == [first, second]


@pytest.mark.parametrize("bad", [fields(event_id=""), None, fields(occurred_at="ayer")])
def test_invalid_event_is_logged_and_acked_without_persisting(caplog, bad):
    redis = FakeRedis()
    message_id = redis.xadd(STREAM_KEY, bad)
    store = FakeEventStore()
    with caplog.at_level(logging.WARNING, logger="analytics.consumer"):
        make_consumer(redis, store).poll()
    assert store.saves == 0
    assert redis.acks == [message_id]
    assert message_id in caplog.text


def test_event_rejected_by_the_database_is_acked(caplog):
    redis = FakeRedis()
    message_id = redis.xadd(STREAM_KEY, fields("bad"))
    with caplog.at_level(logging.WARNING, logger="analytics.consumer"):
        make_consumer(redis, FakeEventStore(invalid_ids={"bad"})).poll()
    assert redis.acks == [message_id]
    assert "dato inválido" in caplog.text


def test_a_rejected_event_only_discards_itself_and_the_rest_of_the_batch_is_saved(caplog):
    redis = FakeRedis()
    ids = [redis.xadd(STREAM_KEY, fields(e)) for e in ("e1", "bad", "e3")]
    ids.append(redis.xadd(STREAM_KEY, fields(event_id="")))
    store = FakeEventStore(invalid_ids={"bad"})
    with caplog.at_level(logging.WARNING, logger="analytics.consumer"):
        make_consumer(redis, store).poll()
    assert list(store.events) == ["e1", "e3"]
    # El lote entero falla una vez y luego se reintenta evento por evento.
    assert store.batches == [["e1", "bad", "e3"], ["e1"], ["bad"], ["e3"]]
    assert redis.acks == ids
    assert f"evento {ids[1]} inválido" in caplog.text
    assert f"evento {ids[3]} inválido" in caplog.text


def test_store_error_leaves_the_whole_batch_pending():
    redis = FakeRedis()
    ids = [redis.xadd(STREAM_KEY, fields(e)) for e in ("e1", "e2")]
    store = FakeEventStore(fail_times=1)
    with pytest.raises(RuntimeError):
        make_consumer(redis, store).poll()
    assert redis.acks == []
    assert set(redis.pending) == set(ids)
    assert store.events == {}


def test_store_error_leaves_message_pending():
    redis = FakeRedis()
    message_id = redis.xadd(STREAM_KEY, fields())
    with pytest.raises(RuntimeError):
        make_consumer(redis, FakeEventStore(fail_times=1)).poll()
    assert redis.acks == []
    assert message_id in redis.pending


def test_recover_pending_retries_unacked_messages_after_restart():
    redis = FakeRedis()
    redis.xadd(STREAM_KEY, fields())
    with pytest.raises(RuntimeError):
        make_consumer(redis, FakeEventStore(fail_times=1)).poll()
    store = FakeEventStore()
    assert make_consumer(redis, store).recover_pending() == 1
    assert list(store.events) == ["e1"]
    assert redis.pending == {}


class StoppingStore(FakeEventStore):
    def __init__(self, stop, stop_on, **kwargs):
        super().__init__(**kwargs)
        self.stop = stop
        self.stop_on = stop_on

    def stored(self, event):
        if event["event_id"] == self.stop_on:
            self.stop.set()
        return super().stored(event)


def test_run_survives_store_errors_and_retries_pending(caplog):
    redis = FakeRedis()
    stop = threading.Event()
    redis.xadd(STREAM_KEY, fields())
    store = StoppingStore(stop, "e1", fail_times=2)
    sleeps = []
    with caplog.at_level(logging.ERROR, logger="analytics.consumer"):
        make_consumer(redis, store, sleep=sleeps.append).run(stop)
    assert store.saves == 3
    assert sleeps == [RETRY_DELAY_S, RETRY_DELAY_S]
    assert caplog.text.count("se reintenta") == 2
    assert redis.pending == {}


def test_run_recovers_pending_then_consumes_until_stopped(caplog):
    redis = FakeRedis()
    stop = threading.Event()
    redis.xadd(STREAM_KEY, fields("old"))
    redis.xreadgroup(CONSUMER_GROUP, "a1", {STREAM_KEY: ">"}, count=1)  # entregado y sin ACK
    redis.xadd(STREAM_KEY, fields("new"))
    store = StoppingStore(stop, "new")
    with caplog.at_level(logging.INFO, logger="analytics.consumer"):
        make_consumer(redis, store).run(stop)
    assert list(store.events) == ["old", "new"]
    assert redis.pending == {}
    assert "reprocesados 1 eventos pendientes" in caplog.text


def test_run_returns_immediately_when_already_stopped():
    redis = FakeRedis()
    stop = threading.Event()
    stop.set()
    redis.xadd(STREAM_KEY, fields())
    store = FakeEventStore()
    make_consumer(redis, store).run(stop)
    assert store.saves == 0
    assert redis.groups == {(STREAM_KEY, CONSUMER_GROUP)}


class StopAfter(threading.Event):
    """Evento de parada que se activa tras `n` esperas (sin dormir de verdad)."""

    def __init__(self, n):
        super().__init__()
        self.n = n
        self.waits = []

    def wait(self, timeout=None):
        self.waits.append(timeout)
        if len(self.waits) >= self.n:
            self.set()
        return self.is_set()


def test_maintenance_runs_at_start_and_every_interval_until_stopped():
    store = FakeEventStore()
    stop = StopAfter(2)
    run_maintenance_loop(store, stop)
    assert store.purges == 2
    assert store.grace_closes == [timedelta(hours=12)] * 2
    # El primer ciclo rellena el histórico; los siguientes solo hoy y ayer.
    assert store.dau_refreshes == [
        ("America/Bogota", DAU_BACKFILL_DAYS),
        ("America/Bogota", DAU_REFRESH_DAYS),
    ]
    assert stop.waits == [MAINTENANCE_INTERVAL_S, MAINTENANCE_INTERVAL_S]


def test_maintenance_uses_the_configured_grace_and_timezone():
    store = FakeEventStore()
    run_maintenance_loop(store, StopAfter(1), room_grace=timedelta(hours=1), timezone="UTC")
    assert store.grace_closes == [timedelta(hours=1)]
    assert store.dau_refreshes == [("UTC", DAU_BACKFILL_DAYS)]


def test_maintenance_consolidates_idle_rooms_before_purging_their_events():
    store = Mock()
    store.close_idle_rooms.return_value = store.purge_expired.return_value = 0
    store.refresh_daily_active_users.return_value = 2
    run_maintenance_loop(store, StopAfter(1))
    assert [call[0] for call in store.method_calls] == [
        "close_idle_rooms",
        "purge_expired",
        "refresh_daily_active_users",
    ]


def test_a_failing_maintenance_task_is_logged_and_does_not_stop_the_others(caplog):
    store = Mock()
    store.close_idle_rooms.side_effect = [RuntimeError("caído"), 1]
    store.purge_expired.side_effect = [RuntimeError("caído"), 3]
    store.refresh_daily_active_users.side_effect = [RuntimeError("caído"), 90]
    stop = StopAfter(2)
    with caplog.at_level(logging.INFO, logger="analytics.consumer"):
        run_maintenance_loop(store, stop, interval_s=10)
    assert store.purge_expired.call_count == 2
    assert store.close_idle_rooms.call_count == 2
    assert "fallo purgando" in caplog.text
    assert "fallo consolidando" in caplog.text
    assert "fallo calculando" in caplog.text
    assert "purgados 3 eventos" in caplog.text
    assert "consolidadas 1 salas" in caplog.text
    # El relleno del histórico se reintenta hasta que sale bien.
    days = [call.args[1] for call in store.refresh_daily_active_users.call_args_list]
    assert days == [DAU_BACKFILL_DAYS, DAU_BACKFILL_DAYS]
