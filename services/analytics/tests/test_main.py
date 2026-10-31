import signal
import threading

import psycopg
from fakes import FakeConn, FakeRedis

from analytics import __main__ as entry
from analytics.sanitize import CONSUMER_GROUP, STREAM_KEY

ENV = {
    "DATABASE_URL": "postgresql://u:p@db/tint",
    "JWT_SECRET": "s3cret",
    "REDIS_URL": "redis://redis:6379",
    "ANALYTICS_PORT": "8084",
}


class Recorder:
    def __init__(self):
        self.conns = []
        self.redis_calls = []
        self.redis = FakeRedis()
        self.servers = []

    def connect(self, dsn, **kwargs):
        assert dsn == ENV["DATABASE_URL"]
        assert kwargs == {"autocommit": True}
        self.conns.append(FakeConn())
        return self.conns[-1]

    def redis_factory(self, url, **kwargs):
        self.redis_calls.append((url, kwargs))
        return self.redis

    def server_factory(self, api, host, port):
        server = FakeServer(api, host, port)
        self.servers.append(server)
        return server


class FakeServer:
    def __init__(self, api, host, port):
        self.api = api
        self.address = (host, port)
        self.served = threading.Event()
        self.stopped = threading.Event()
        self.closed = False

    def serve_forever(self):
        self.served.set()
        self.stopped.wait(5)

    def shutdown(self):
        self.stopped.set()

    def server_close(self):
        self.closed = True


def run_main(env=ENV, rec=None):
    rec = rec or Recorder()
    stop = threading.Event()
    stop.set()  # arranca todo y se apaga enseguida
    code = entry.main(
        env,
        stop=stop,
        connect=rec.connect,
        redis_factory=rec.redis_factory,
        server_factory=rec.server_factory,
    )
    return code, rec


def test_main_migrates_then_starts_consumer_maintenance_and_api_and_shuts_down():
    code, rec = run_main()
    assert code == 0
    migrations = rec.conns[0].statements("INSERT INTO schema_migrations")
    assert [params for _sql, params in migrations] == [("001_init",), ("002_business_kpis",)]
    assert rec.conns[0].closed
    # El mantenimiento corre una vez al arrancar, con su propia conexión, y la cierra al apagar.
    (maintenance,) = (conn for conn in rec.conns if conn.statements("DELETE FROM telemetry_events"))
    assert maintenance.statements("INSERT INTO daily_active_users")
    assert maintenance.closed
    assert (STREAM_KEY, CONSUMER_GROUP) in rec.redis.groups
    (server,) = rec.servers
    assert server.address == ("0.0.0.0", 8084)
    assert server.served.is_set() and server.stopped.is_set() and server.closed
    assert server.api.issuer == "tint-identity"
    assert server.api.admin_password is None, "sin ANALYTICS_ADMIN_PASSWORD no hay panel"
    # La API usa un cliente con timeout corto para fallar rápido (503) si Redis se cuelga.
    consumer_kwargs, api_kwargs = (kwargs for _url, kwargs in rec.redis_calls)
    assert consumer_kwargs == {"decode_responses": True}
    assert api_kwargs["socket_timeout"] <= 2


def test_main_exits_2_on_missing_configuration(capsys):
    code, _rec = run_main(env={"JWT_SECRET": "x"})
    assert code == 2
    assert "DATABASE_URL" in capsys.readouterr().err


def test_main_exits_1_when_migrations_cannot_run(caplog):
    rec = Recorder()

    def broken_connect(dsn, **kwargs):
        raise psycopg.OperationalError("sin base")

    rec.connect = broken_connect
    code, _rec = run_main(rec=rec)
    assert code == 1
    assert "migraciones" in caplog.text
    assert rec.servers == []


def test_install_signal_handlers_sets_stop(monkeypatch):
    handlers = {}
    monkeypatch.setattr(signal, "signal", lambda sig, handler: handlers.setdefault(sig, handler))
    stop = threading.Event()
    entry.install_signal_handlers(stop)
    assert set(handlers) == {signal.SIGTERM, signal.SIGINT}
    handlers[signal.SIGTERM](signal.SIGTERM, None)
    assert stop.is_set()


def test_main_passes_the_admin_password_to_the_api():
    _code, rec = run_main(env={**ENV, "ANALYTICS_ADMIN_PASSWORD": "clave-del-grupo"})
    assert rec.servers[0].api.admin_password == "clave-del-grupo"
