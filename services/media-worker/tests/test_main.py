import signal
import threading
from unittest.mock import Mock

from fakes import FakeRedis

from media_worker import __main__ as entry
from media_worker.consumer import StreamConsumer

ENV = {
    "DATABASE_URL": "postgresql://tint:tint@db:5432/tint",
    "S3_ACCESS_KEY": "key",
    "S3_SECRET_KEY": "secret",
    "S3_ENDPOINT_URL": "http://minio:9000",
    "REDIS_URL": "redis://redis:6379/0",
    "MEDIA_WORKER_CONSUMER": "worker-a",
}


def test_trigger_settings_read_redis_and_consumer_name():
    t = entry.TriggerSettings.from_env(ENV)
    assert (t.redis_url, t.consumer) == ("redis://redis:6379/0", "worker-a")


def test_trigger_settings_defaults(monkeypatch):
    monkeypatch.setattr(entry.socket, "gethostname", lambda: "host-1")
    t = entry.TriggerSettings.from_env({})
    assert (t.redis_url, t.consumer) == ("redis://localhost:6379", "host-1")


def test_build_consumer_wires_clients_and_pipeline():
    redis_factory, s3_factory, connect = Mock(), Mock(), Mock()
    consumer = entry.build_consumer(
        ENV, redis_factory=redis_factory, s3_factory=s3_factory, connect=connect
    )
    assert isinstance(consumer, StreamConsumer)
    assert consumer.consumer == "worker-a"
    redis_factory.assert_called_once_with("redis://redis:6379/0", decode_responses=True)
    s3_factory.assert_called_once_with(
        "s3",
        endpoint_url="http://minio:9000",
        aws_access_key_id="key",
        aws_secret_access_key="secret",
    )
    connect.assert_called_once_with("postgresql://tint:tint@db:5432/tint", autocommit=True)


def test_build_consumer_handler_runs_handle_upload(monkeypatch):
    handled = Mock(return_value=None)
    monkeypatch.setattr(entry, "handle_upload", handled)
    consumer = entry.build_consumer(ENV, redis_factory=Mock(), s3_factory=Mock(), connect=Mock())
    consumer.handler("v1")
    video_id, repo, blobs = handled.call_args.args
    assert video_id == "v1"
    assert repo.conn is not None and blobs.bucket == "tint-media"


def test_build_consumer_marks_exhausted_jobs_failed(monkeypatch):
    redis = FakeRedis()
    exhausted = Mock()
    monkeypatch.setattr(entry, "mark_exhausted", exhausted)
    consumer = entry.build_consumer(
        ENV, redis_factory=lambda *a, **k: redis, s3_factory=Mock(), connect=Mock()
    )
    consumer.on_exhausted("v1")
    video_id, repo = exhausted.call_args.args
    assert video_id == "v1" and repo.conn is not None
    exhausted.call_args.kwargs["publish"]({"type": "media_processed"})
    assert redis.entries("analytics:events") == [{"type": "media_processed"}]


def test_build_consumer_publishes_analytics_on_the_same_redis(monkeypatch):
    redis = FakeRedis()
    handled = Mock(return_value=None)
    monkeypatch.setattr(entry, "handle_upload", handled)
    consumer = entry.build_consumer(
        ENV, redis_factory=lambda *a, **k: redis, s3_factory=Mock(), connect=Mock()
    )
    consumer.handler("v1")
    publish = handled.call_args.kwargs["publish"]
    publish({"type": "media_processed"})
    assert redis.entries("analytics:events") == [{"type": "media_processed"}]
    assert redis.xadd_calls == [("analytics:events", 100_000, True)]


def test_main_runs_until_a_signal_stops_it(monkeypatch):
    handlers = {}
    monkeypatch.setattr(entry.signal, "signal", lambda sig, fn: handlers.__setitem__(sig, fn))
    fake = Mock()

    def run(stop: threading.Event):
        handlers[signal.SIGTERM](signal.SIGTERM, None)
        assert stop.is_set()

    fake.run.side_effect = run
    monkeypatch.setattr(entry, "build_consumer", lambda env: fake)
    assert entry.main(ENV) == 0
    assert set(handlers) == {signal.SIGTERM, signal.SIGINT}


def test_main_reports_missing_configuration(capsys):
    assert entry.main({}) == 2
    assert "faltan variables de entorno" in capsys.readouterr().err
