import json
import urllib.error
import urllib.request

import pytest

from media_worker.config import ConfigError
from media_worker.health import (
    DEFAULT_MAX_AGE_S,
    DEFAULT_PORT,
    HealthServer,
    HealthSettings,
    HealthState,
)


def test_health_settings_defaults():
    settings = HealthSettings.from_env({})
    assert (settings.port, settings.max_age_s) == (DEFAULT_PORT, DEFAULT_MAX_AGE_S)


def test_health_settings_read_environment():
    settings = HealthSettings.from_env(
        {"MEDIA_WORKER_PORT": "9001", "MEDIA_WORKER_HEARTBEAT_MAX_AGE_S": "12.5"}
    )
    assert (settings.port, settings.max_age_s) == (9001, 12.5)


@pytest.mark.parametrize(
    ("key", "value", "message"),
    [
        ("MEDIA_WORKER_PORT", "http", "entero"),
        ("MEDIA_WORKER_PORT", "70000", "entre 1 y 65535"),
        ("MEDIA_WORKER_HEARTBEAT_MAX_AGE_S", "pronto", "número"),
        ("MEDIA_WORKER_HEARTBEAT_MAX_AGE_S", "0", "mayor que 0"),
    ],
)
def test_health_settings_reject_invalid_values(key, value, message):
    with pytest.raises(ConfigError, match=message):
        HealthSettings.from_env({key: value})


def test_state_is_unhealthy_until_the_first_beat_and_then_stale():
    now = [100.0]
    state = HealthState(max_age_s=30, clock=lambda: now[0])

    assert not state.is_healthy(), "sin latido no se puede afirmar que el consumidor vive"
    state.touch()
    assert state.is_healthy()

    now[0] += 30
    assert state.is_healthy(), "el límite es inclusivo"
    now[0] += 0.1
    assert not state.is_healthy()


def _get(server: HealthServer, path: str = "/healthz"):
    request = urllib.request.Request(f"http://127.0.0.1:{server.port}{path}")
    try:
        with urllib.request.urlopen(request, timeout=2) as response:
            return response.status, json.loads(response.read())
    except urllib.error.HTTPError as exc:
        return exc.code, json.loads(exc.read())


def _running(state: HealthState) -> HealthServer:
    server = HealthServer(state, host="127.0.0.1", port=0)
    server.start()
    return server


def test_healthz_reports_ok_while_the_consumer_beats():
    state = HealthState(max_age_s=30)
    state.touch()
    server = _running(state)
    try:
        assert _get(server) == (200, {"status": "ok", "service": "media-worker"})
    finally:
        server.stop()


def test_healthz_reports_unavailable_when_the_heartbeat_is_stale():
    now = [0.0]
    state = HealthState(max_age_s=10, clock=lambda: now[0])
    state.touch()
    now[0] = 11
    server = _running(state)
    try:
        status, body = _get(server)
        assert (status, body) == (503, {"status": "unavailable", "service": "media-worker"})
    finally:
        server.stop()


def test_healthz_returns_404_for_other_paths():
    server = _running(HealthState())
    try:
        assert _get(server, "/readyz") == (404, {"status": "not_found", "service": "media-worker"})
    finally:
        server.stop()
