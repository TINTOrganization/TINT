import json
import threading
import time
import urllib.error
import urllib.request
from datetime import UTC, date, datetime
from unittest.mock import Mock

import jwt
import pytest
from fakes import FakeReadRepository, FakeRedis

from analytics.api import AnalyticsApi, create_server
from analytics.kpis import HEATMAP_TYPES, KPI_TYPES, TIMELINE_TYPES

SECRET = "test-secret"
ISSUER = "tint-identity"
AUDIENCE = "tint:room"
ROOM = "3d97d007-29c0-4cec-bb61-cb37683c3256"
ORIGIN = "http://localhost:5173"
NOW = datetime(2026, 10, 11, 12, 0, tzinfo=UTC)


def token(**overrides):
    secret = overrides.pop("secret", SECRET)
    claims = {
        "sub": "firebase-uid",
        "room_id": ROOM,
        "role": "host",
        "nick": "Ana",
        "jti": "jti-1",
        "iss": ISSUER,
        "aud": AUDIENCE,
        "exp": int(time.time()) + 300,
        "iat": int(time.time()),
    }
    claims.update(overrides)
    claims = {k: v for k, v in claims.items() if v is not None}
    return jwt.encode(claims, secret, algorithm="HS256")


def make_api(repo=None, redis=None, origins=(ORIGIN,), admin_password=None):
    return AnalyticsApi(
        admin_password=admin_password,
        repo=repo or FakeReadRepository(),
        redis=redis or FakeRedis(),
        secret=SECRET,
        issuer=ISSUER,
        audience=AUDIENCE,
        allowed_origins=origins,
        clock=lambda: NOW,
    )


def get(api, path, bearer=None, origin=ORIGIN, method="GET"):
    headers = {"Origin": origin} if origin else {}
    if bearer is not None:
        headers["Authorization"] = f"Bearer {bearer}"
    return api.handle(method, path, headers)


def kpis_path(room=ROOM):
    return f"/api/v1/rooms/{room}/kpis"


# --- salud, rutas y CORS ---------------------------------------------------------------------


def test_healthz_needs_no_token():
    response = get(make_api(), "/healthz")
    assert (response.status, response.body) == (200, {"status": "ok"})


def test_unknown_route_is_404():
    response = get(make_api(), "/api/v1/rooms/x/raw-events", bearer=token())
    assert response.status == 404
    assert "error" in response.body


def test_non_get_methods_are_rejected():
    response = get(make_api(), kpis_path(), bearer=token(), method="POST")
    assert response.status == 405
    assert response.headers["Allow"] == "GET, OPTIONS"


def test_preflight_allows_authorization_header_for_allowed_origin():
    response = get(make_api(), kpis_path(), method="OPTIONS")
    assert response.status == 204
    assert response.body is None
    assert response.headers["Access-Control-Allow-Origin"] == ORIGIN
    assert "Authorization" in response.headers["Access-Control-Allow-Headers"]
    assert "GET" in response.headers["Access-Control-Allow-Methods"]
    assert response.headers["Vary"] == "Origin"


def test_cors_headers_are_sent_on_errors_too_so_the_browser_can_read_them():
    response = get(make_api(), kpis_path())
    assert response.status == 401
    assert response.headers["Access-Control-Allow-Origin"] == ORIGIN


def test_disallowed_origin_gets_no_cors_headers():
    response = get(make_api(), kpis_path(), origin="https://evil.example", method="OPTIONS")
    assert response.status == 204
    assert "Access-Control-Allow-Origin" not in response.headers


def test_request_without_origin_gets_no_cors_headers():
    response = get(make_api(), "/healthz", origin=None)
    assert "Access-Control-Allow-Origin" not in response.headers


# --- autenticación y autorización ------------------------------------------------------------


@pytest.mark.parametrize(
    "authorization",
    [None, "", "Bearer", "Bearer ", "Basic abc", "Token x"],
)
def test_missing_or_malformed_authorization_is_401(authorization):
    headers = {} if authorization is None else {"Authorization": authorization}
    response = make_api().handle("GET", kpis_path(), headers)
    assert response.status == 401
    assert response.body["error"]


@pytest.mark.parametrize(
    "bad_token",
    [
        token(secret="otro-secreto"),
        token(exp=int(time.time()) - 10),
        token(iss="otro-emisor"),
        token(aud="otra-audiencia"),
        token(exp=None),
        token(jti=None),
        token(jti=""),
        jwt.encode({"room_id": ROOM, "role": "host"}, SECRET, algorithm="HS512"),
        "no.es.jwt",
    ],
)
def test_invalid_tokens_are_401(bad_token):
    assert get(make_api(), kpis_path(), bearer=bad_token).status == 401


def test_revoked_token_is_401():
    redis = FakeRedis()
    redis.keys.add("token:revoked:jti-1")
    response = get(make_api(redis=redis), kpis_path(), bearer=token())
    assert response.status == 401
    assert "revocado" in response.body["error"]


def test_revocation_check_fails_closed_with_503_when_redis_is_down():
    redis = FakeRedis()
    redis.down = True
    response = get(make_api(redis=redis), kpis_path(), bearer=token())
    assert response.status == 503
    assert response.body["error"]


def test_non_host_role_is_403():
    assert get(make_api(), kpis_path(), bearer=token(role="guest")).status == 403


def test_token_for_another_room_is_403():
    assert get(make_api(), kpis_path("otra-sala"), bearer=token()).status == 403


# --- KPIs -------------------------------------------------------------------------------------


def test_kpis_of_a_closed_room_come_from_room_kpis():
    row = {
        "room_id": ROOM,
        "peak_users": 7,
        "avg_users": 4.5,
        "avg_drift_ms": 120,
        "trivia_accuracy_pct": 50,
        "messages": 10,
        "reactions": 20,
        "playback_commands": 3,
        "buffering_events": 2,
        "avg_buffering_ms": 400,
        "avg_rtt_ms": 35,
        "p95_drift_ms": 900,
        "total_buffering_ms": 800,
        "close_reason": "grace_expired",
        "closed_at": datetime(2026, 10, 11, 11, 0, tzinfo=UTC),
        "computed_at": datetime(2026, 10, 11, 11, 0, 1, tzinfo=UTC),
    }
    repo = FakeReadRepository(kpis={ROOM: row})
    response = get(make_api(repo=repo), kpis_path(), bearer=token())
    assert response.status == 200
    assert response.body == {
        "room_id": ROOM,
        "live": False,
        "peak_users": 7,
        "avg_users": 4.5,
        "avg_drift_ms": 120.0,
        "trivia_accuracy_pct": 50.0,
        "messages": 10,
        "reactions": 20,
        "playback_commands": 3,
        "buffering_events": 2,
        "avg_buffering_ms": 400.0,
        "avg_rtt_ms": 35.0,
        "p95_drift_ms": 900.0,
        "total_buffering_ms": 800,
        "close_reason": "grace_expired",
        "closed_at": "2026-10-11T11:00:00.000Z",
        "computed_at": "2026-10-11T11:00:01.000Z",
    }
    assert isinstance(response.body["avg_drift_ms"], float)
    assert list(response.body)[:4] == ["room_id", "live", "peak_users", "avg_users"]


def test_kpis_of_an_open_room_are_computed_live_from_telemetry():
    events = [
        {"type": "presence", "connected_users": "2"},
        {"type": "presence", "connected_users": "4"},
        {"type": "chat_message", "message_length": "3"},
        {"type": "drift_correction", "drift_ms": "-700", "rtt_ms": "45"},
        {"type": "buffering", "duration_ms": "250"},
    ]
    repo = FakeReadRepository(events={ROOM: events})
    response = get(make_api(repo=repo), kpis_path(), bearer=token())
    assert response.status == 200
    assert response.body == {
        "room_id": ROOM,
        "live": True,
        "peak_users": 4,
        "avg_users": 3.0,
        "avg_drift_ms": 700.0,
        "trivia_accuracy_pct": 0.0,
        "messages": 1,
        "reactions": 0,
        "playback_commands": 0,
        "buffering_events": 1,
        "avg_buffering_ms": 250.0,
        "avg_rtt_ms": 45.0,
        "p95_drift_ms": 700.0,
        "total_buffering_ms": 250,
        "close_reason": None,
        "closed_at": None,
        "computed_at": "2026-10-11T12:00:00.000Z",
    }
    assert ("room_events", ROOM, KPI_TYPES) in repo.calls


def test_database_errors_are_503():
    repo = FakeReadRepository(fail=True)
    response = get(make_api(repo=repo), kpis_path(), bearer=token())
    assert response.status == 503
    assert response.body["error"]


def test_unexpected_errors_are_500():
    repo = Mock()
    repo.room_kpis.side_effect = KeyError("bug")
    response = get(make_api(repo=repo), kpis_path(), bearer=token())
    assert response.status == 500


# --- panel de negocio ---------------------------------------------------------------------------

OVERVIEW = "/api/v1/analytics/overview"
PASSWORD = "clave-del-grupo"


def overview_data():
    closed = {
        "room_id": ROOM,
        "peak_users": 7,
        "avg_users": 4.5,
        "avg_drift_ms": 120,
        "trivia_accuracy_pct": 50,
        "messages": 10,
        "reactions": 20,
        "playback_commands": 3,
        "buffering_events": 2,
        "avg_buffering_ms": 400,
        "avg_rtt_ms": 35,
        "p95_drift_ms": 900,
        "total_buffering_ms": 800,
        "close_reason": "grace_expired",
        "closed_at": datetime(2026, 10, 11, 11, 0, tzinfo=UTC),
        "computed_at": datetime(2026, 10, 11, 12, 0, tzinfo=UTC),
    }
    return {
        "daily": [(date(2026, 10, 11), 1, 1), (date(2026, 10, 12), 3, 4)],
        "events": [("drift_correction", "sync-core", 1173), ("presence", "social-core", 16)],
        "active_rooms": 5,
        "rooms": [closed, {**closed, "room_id": "sin-heatmap", "close_reason": None}],
        "heatmaps": {ROOM: [(0, 2, 0.4), (5000, 5, 1.0)]},
    }


def test_overview_returns_only_aggregates():
    repo = FakeReadRepository(overview=overview_data())
    response = get(make_api(repo=repo, admin_password=PASSWORD), OVERVIEW, bearer=PASSWORD)
    assert response.status == 200
    body = response.body
    assert body["generated_at"] == "2026-10-11T12:00:00.000Z"
    assert body["daily"] == [
        {"day": "2026-10-11", "dau": 1, "mau": 1},
        {"day": "2026-10-12", "dau": 3, "mau": 4},
    ]
    assert body["events"] == {
        "total": 1189,
        "rooms": 5,
        "by_type": [
            {"type": "drift_correction", "source": "sync-core", "count": 1173},
            {"type": "presence", "source": "social-core", "count": 16},
        ],
    }
    first, second = body["rooms"]
    assert first["room_id"] == ROOM
    assert (first["peak_users"], first["avg_rtt_ms"], first["p95_drift_ms"]) == (7, 35.0, 900.0)
    assert first["close_reason"] == "grace_expired"
    assert first["closed_at"] == "2026-10-11T11:00:00.000Z"
    assert first["heatmap"] == [
        {"bucket_start_ms": 0, "reactions": 2, "density": 0.4},
        {"bucket_start_ms": 5000, "reactions": 5, "density": 1.0},
    ]
    assert (second["close_reason"], second["heatmap"]) == (None, [])
    assert "user_id" not in json.dumps(body)
    assert ("business_overview", 30, 50) in repo.calls


@pytest.mark.parametrize("bearer", [None, "", "otra", PASSWORD + "x", token()])
def test_overview_rejects_a_missing_or_wrong_password(bearer):
    repo = FakeReadRepository(overview=overview_data())
    response = get(make_api(repo=repo, admin_password=PASSWORD), OVERVIEW, bearer=bearer)
    assert response.status == 401
    assert response.body == {"error": "contraseña incorrecta"}
    assert repo.calls == []
    assert response.headers["Access-Control-Allow-Origin"] == ORIGIN


@pytest.mark.parametrize("configured", [None, ""])
def test_overview_does_not_exist_without_a_configured_password(configured):
    repo = FakeReadRepository(overview=overview_data())
    api = make_api(repo=repo, admin_password=configured)
    assert get(api, OVERVIEW, bearer="").status == 404
    assert get(api, OVERVIEW, bearer="cualquiera").status == 404
    assert repo.calls == []


def test_overview_method_and_database_errors():
    api = make_api(repo=FakeReadRepository(fail=True), admin_password=PASSWORD)
    assert get(api, OVERVIEW, bearer=PASSWORD, method="POST").status == 405
    assert get(api, OVERVIEW, bearer=PASSWORD).status == 503


def test_the_admin_password_is_not_a_room_ticket():
    api = make_api(admin_password=PASSWORD)
    assert get(api, kpis_path(), bearer=PASSWORD).status == 401


# --- heatmap y timeline ------------------------------------------------------------------------


def test_heatmap_with_default_bucket():
    events = [
        {"type": "reaction", "emoji": "👏", "position_ms": "1000"},
        {"type": "reaction", "emoji": "👏", "position_ms": "7000"},
        {"type": "reaction", "emoji": "😂", "position_ms": "2000"},
    ]
    repo = FakeReadRepository(events={ROOM: events})
    path = f"/api/v1/rooms/{ROOM}/reactions/heatmap"
    response = get(make_api(repo=repo), path, bearer=token())
    assert response.status == 200
    assert response.body == {
        "room_id": ROOM,
        "bucket_ms": 5000,
        "buckets": [
            {"bucket_start_ms": 0, "emoji": "👏", "count": 1},
            {"bucket_start_ms": 0, "emoji": "😂", "count": 1},
            {"bucket_start_ms": 5000, "emoji": "👏", "count": 1},
        ],
        "density": [
            {"bucket_start_ms": 0, "count": 2, "density": 1.0},
            {"bucket_start_ms": 5000, "count": 1, "density": 0.5},
        ],
        "by_emoji": [{"emoji": "👏", "count": 2}, {"emoji": "😂", "count": 1}],
    }
    assert ("room_events", ROOM, HEATMAP_TYPES) in repo.calls


def test_heatmap_accepts_custom_bucket():
    path = f"/api/v1/rooms/{ROOM}/reactions/heatmap?bucket_ms=1000"
    response = get(make_api(), path, bearer=token())
    assert (response.status, response.body["bucket_ms"]) == (200, 1000)


@pytest.mark.parametrize("value", ["999", "60001", "abc", "", "5000.5"])
def test_heatmap_rejects_out_of_range_bucket(value):
    path = f"/api/v1/rooms/{ROOM}/reactions/heatmap?bucket_ms={value}"
    response = get(make_api(), path, bearer=token())
    assert response.status == 400
    assert "bucket_ms" in response.body["error"]


def test_timeline_with_custom_step():
    events = [
        {"type": "presence", "connected_users": "2", "occurred_at": "2026-10-11T10:00:05.000Z"},
        {"type": "chat_message", "occurred_at": "2026-10-11T10:00:15.000Z"},
    ]
    repo = FakeReadRepository(events={ROOM: events})
    path = f"/api/v1/rooms/{ROOM}/timeline?step_s=10"
    response = get(make_api(repo=repo), path, bearer=token())
    assert response.status == 200
    assert response.body == {
        "room_id": ROOM,
        "step_s": 10,
        "points": [
            {"t": "2026-10-11T10:00:00.000Z", "connected_users": 2, "messages": 0, "reactions": 0},
            {"t": "2026-10-11T10:00:10.000Z", "connected_users": 2, "messages": 1, "reactions": 0},
        ],
    }
    assert ("room_events", ROOM, TIMELINE_TYPES) in repo.calls


def test_timeline_default_step_and_validation():
    path = f"/api/v1/rooms/{ROOM}/timeline"
    assert get(make_api(), path, bearer=token()).body["step_s"] == 60
    assert get(make_api(), f"{path}?step_s=9", bearer=token()).status == 400
    assert get(make_api(), f"{path}?step_s=3601", bearer=token()).status == 400


# --- servidor HTTP real -------------------------------------------------------------------------


@pytest.fixture
def server():
    events = {ROOM: [{"type": "reaction", "emoji": "👏", "position_ms": "0"}]}
    srv = create_server(make_api(repo=FakeReadRepository(events=events)), "127.0.0.1", 0)
    thread = threading.Thread(target=srv.serve_forever, daemon=True)
    thread.start()
    yield f"http://127.0.0.1:{srv.server_address[1]}"
    srv.shutdown()
    srv.server_close()


def request(url, method="GET", headers=None):
    req = urllib.request.Request(url, method=method, headers=headers or {})
    try:
        with urllib.request.urlopen(req, timeout=5) as resp:
            return resp.status, dict(resp.headers), resp.read()
    except urllib.error.HTTPError as err:
        return err.code, dict(err.headers), err.read()


def test_server_serves_json_with_utf8_emoji(server):
    status, headers, body = request(
        f"{server}/api/v1/rooms/{ROOM}/reactions/heatmap",
        headers={"Authorization": f"Bearer {token()}", "Origin": ORIGIN},
    )
    assert status == 200
    assert headers["Content-Type"] == "application/json; charset=utf-8"
    assert headers["Access-Control-Allow-Origin"] == ORIGIN
    assert json.loads(body)["by_emoji"] == [{"emoji": "👏", "count": 1}]
    assert "👏".encode() in body


def test_server_errors_and_preflight(server):
    status, _headers, body = request(f"{server}/api/v1/rooms/{ROOM}/kpis")
    assert status == 401
    assert "error" in json.loads(body)
    status, headers, body = request(
        f"{server}/api/v1/rooms/{ROOM}/kpis", method="OPTIONS", headers={"Origin": ORIGIN}
    )
    assert (status, body) == (204, b"")
    assert headers["Access-Control-Allow-Origin"] == ORIGIN
    status, _headers, _body = request(f"{server}/healthz", method="DELETE")
    assert status == 405
