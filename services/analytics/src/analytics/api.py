"""API HTTP de solo lectura de KPIs (`ANALYTICS_PORT`, por defecto 8084).

Lectura diferida para el host: nunca tiempo real ni eventos crudos. La lógica vive en
`AnalyticsApi.handle` (sin sockets, fácil de probar); `create_server` solo la monta sobre
`http.server.ThreadingHTTPServer` de la stdlib.

Auth: `Authorization: Bearer <analytics-ticket>` HS256 emitido por identity-api (`iss`, `aud`,
`exp` y `jti` obligatorios), `role == "host"` y `room_id` igual al de la ruta. Si existe
`token:revoked:{jti}` → 401; si Redis no responde → 503 (falla cerrado).

Aparte, `GET /api/v1/analytics/overview` entrega el panel de negocio (DAU/MAU, volumen de
eventos y KPIs de las salas cerradas, siempre agregados). Se protege con una contraseña
compartida (`ANALYTICS_ADMIN_PASSWORD`) enviada como Bearer; sin esa variable la ruta no existe.
"""

from __future__ import annotations

import hmac
import json
import logging
import re
from collections.abc import Callable, Iterable, Mapping
from dataclasses import dataclass, field
from datetime import UTC, datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any
from urllib.parse import parse_qs, urlsplit

import jwt

from analytics.kpis import (
    HEATMAP_TYPES,
    KPI_TYPES,
    TIMELINE_TYPES,
    compute_room_kpis,
    format_timestamp,
    heatmap_density,
    reaction_heatmap,
    reactions_by_emoji,
    timeline,
)

logger = logging.getLogger(__name__)

DEFAULT_PORT = 8084
DEFAULT_ALLOWED_ORIGINS = ("http://localhost:5173",)
REVOKED_KEY = "token:revoked:{jti}"
ROUTE = re.compile(r"^/api/v1/rooms/(?P<room_id>[^/]+)/(?P<view>kpis|reactions/heatmap|timeline)$")
OVERVIEW_PATH = "/api/v1/analytics/overview"
# Ventana del panel de negocio: días de DAU/MAU y salas cerradas más recientes.
OVERVIEW_DAYS = 30
OVERVIEW_ROOMS = 50
# Métricas en el orden del contrato y con su tipo JSON (los promedios siempre como float).
METRICS = (
    ("peak_users", int),
    ("avg_users", float),
    ("avg_drift_ms", float),
    ("trivia_accuracy_pct", float),
    ("messages", int),
    ("reactions", int),
    ("playback_commands", int),
    ("buffering_events", int),
    ("avg_buffering_ms", float),
    ("avg_rtt_ms", float),
    ("p95_drift_ms", float),
    ("total_buffering_ms", int),
)
# (default, mínimo, máximo) de los parámetros de consulta.
BUCKET_MS = (5000, 1000, 60000)
STEP_S = (60, 10, 3600)


@dataclass(frozen=True)
class Response:
    status: int
    body: dict[str, Any] | None
    headers: dict[str, str] = field(default_factory=dict)


class ApiError(Exception):
    def __init__(self, status: int, message: str, headers: dict[str, str] | None = None):
        super().__init__(message)
        self.status = status
        self.message = message
        self.headers = headers or {}


def _iso(value: datetime | None) -> str | None:
    return None if value is None else format_timestamp(value)


def _int_param(query: dict[str, list[str]], name: str, bounds: tuple[int, int, int]) -> int:
    default, low, high = bounds
    if name not in query:
        return default
    raw = query[name][-1]
    if not raw.isdigit() or not low <= int(raw) <= high:
        raise ApiError(400, f"{name} debe ser un entero entre {low} y {high}")
    return int(raw)


class AnalyticsApi:
    def __init__(
        self,
        repo,
        redis,
        secret: str,
        issuer: str,
        audience: str,
        allowed_origins: Iterable[str] = DEFAULT_ALLOWED_ORIGINS,
        clock: Callable[[], datetime] = lambda: datetime.now(UTC),
        admin_password: str | None = None,
    ) -> None:
        self.repo = repo
        self.redis = redis
        self.secret = secret
        self.issuer = issuer
        self.audience = audience
        self.allowed_origins = frozenset(allowed_origins)
        self.clock = clock
        self.admin_password = admin_password or None

    def handle(self, method: str, target: str, headers: Mapping[str, str]) -> Response:
        headers = {key.lower(): value for key, value in headers.items()}
        cors = self._cors_headers(headers.get("origin"))
        if method == "OPTIONS":
            return Response(204, None, {**cors, **self._preflight_headers()})
        try:
            status, body = self._route(method, target, headers)
        except ApiError as exc:
            return Response(exc.status, {"error": exc.message}, {**cors, **exc.headers})
        except Exception:
            logger.exception("error no controlado en %s %s", method, urlsplit(target).path)
            return Response(500, {"error": "error interno"}, cors)
        return Response(status, body, cors)

    # --- enrutamiento -------------------------------------------------------------------------

    def _route(self, method: str, target: str, headers: dict[str, str]) -> tuple[int, dict]:
        url = urlsplit(target)
        match = ROUTE.match(url.path)
        # Sin contraseña configurada el panel de negocio no existe (falla cerrado).
        overview = url.path == OVERVIEW_PATH and self.admin_password is not None
        if url.path != "/healthz" and match is None and not overview:
            raise ApiError(404, "no encontrado")
        if method != "GET":
            raise ApiError(405, "método no permitido", {"Allow": "GET, OPTIONS"})
        if overview:
            self._authorize_admin(headers.get("authorization", ""))
            return 200, self._overview()
        if match is None:
            return 200, {"status": "ok"}

        room_id = match["room_id"]
        self._authorize(headers.get("authorization", ""), room_id)
        query = parse_qs(url.query, keep_blank_values=True)
        view = match["view"]
        if view == "kpis":
            return 200, self._kpis(room_id)
        if view == "reactions/heatmap":
            return 200, self._heatmap(room_id, _int_param(query, "bucket_ms", BUCKET_MS))
        return 200, self._timeline(room_id, _int_param(query, "step_s", STEP_S))

    # --- auth ---------------------------------------------------------------------------------

    def _authorize(self, authorization: str, room_id: str) -> None:
        scheme, _, token = authorization.partition(" ")
        token = token.strip()
        if scheme.lower() != "bearer" or not token:
            raise ApiError(401, "falta el token de analítica")
        try:
            claims = jwt.decode(
                token,
                self.secret,
                algorithms=["HS256"],
                issuer=self.issuer,
                audience=self.audience,
                options={"require": ["exp", "iss", "aud", "jti"]},
            )
        except jwt.ExpiredSignatureError as exc:
            raise ApiError(401, "token expirado") from exc
        except jwt.InvalidTokenError as exc:
            raise ApiError(401, "token inválido") from exc

        jti = claims["jti"]
        if not isinstance(jti, str) or not jti:
            raise ApiError(401, "token inválido")
        try:
            revoked = self.redis.exists(REVOKED_KEY.format(jti=jti))
        except Exception as exc:
            logger.warning("no se pudo consultar la revocación: %s", exc)
            raise ApiError(503, "no se pudo verificar la revocación del token") from exc
        if revoked:
            raise ApiError(401, "token revocado")
        if claims.get("role") != "host":
            raise ApiError(403, "solo el host puede ver la analítica de la sala")
        if claims.get("room_id") != room_id:
            raise ApiError(403, "el token no corresponde a esta sala")

    def _authorize_admin(self, authorization: str) -> None:
        scheme, _, password = authorization.partition(" ")
        expected = (self.admin_password or "").encode()
        if scheme.lower() != "bearer" or not hmac.compare_digest(
            password.strip().encode(), expected
        ):
            raise ApiError(401, "contraseña incorrecta")

    # --- vistas -------------------------------------------------------------------------------

    def _read(self, call: Callable[[], Any]) -> Any:
        try:
            return call()
        except (KeyError, TypeError, ValueError):
            raise  # errores de programación: 500, no ocultarlos como caída de la BD
        except Exception as exc:
            logger.warning("PostgreSQL no disponible: %s", exc)
            raise ApiError(503, "base de datos no disponible") from exc

    def _kpis(self, room_id: str) -> dict[str, Any]:
        row = self._read(lambda: self.repo.room_kpis(room_id))
        if row is not None:
            return {
                "room_id": room_id,
                "live": False,
                **{name: cast(row[name]) for name, cast in METRICS},
                "close_reason": row["close_reason"],
                "closed_at": _iso(row["closed_at"]),
                "computed_at": _iso(row["computed_at"]),
            }
        events = self._read(lambda: self.repo.room_events(room_id, KPI_TYPES))
        kpis = compute_room_kpis(room_id, events).as_dict()
        return {
            "room_id": room_id,
            "live": True,
            **{name: cast(kpis[name]) for name, cast in METRICS},
            "close_reason": None,
            "closed_at": None,
            "computed_at": _iso(self.clock()),
        }

    def _overview(self) -> dict[str, Any]:
        """Panel de negocio: solo agregados, nunca eventos crudos ni identificadores de usuario."""
        data = self._read(lambda: self.repo.business_overview(OVERVIEW_DAYS, OVERVIEW_ROOMS))
        return {
            "generated_at": _iso(self.clock()),
            "daily": [
                {"day": day.isoformat(), "dau": dau, "mau": mau} for day, dau, mau in data["daily"]
            ],
            "events": {
                "total": sum(count for _type, _source, count in data["events"]),
                "rooms": data["active_rooms"],
                "by_type": [
                    {"type": kind, "source": source, "count": count}
                    for kind, source, count in data["events"]
                ],
            },
            "rooms": [
                {
                    "room_id": row["room_id"],
                    **{name: cast(row[name]) for name, cast in METRICS},
                    "close_reason": row["close_reason"],
                    "closed_at": _iso(row["closed_at"]),
                    "computed_at": _iso(row["computed_at"]),
                    "heatmap": [
                        {"bucket_start_ms": start, "reactions": reactions, "density": density}
                        for start, reactions, density in data["heatmaps"].get(row["room_id"], [])
                    ],
                }
                for row in data["rooms"]
            ],
        }

    def _heatmap(self, room_id: str, bucket_ms: int) -> dict[str, Any]:
        events = self._read(lambda: self.repo.room_events(room_id, HEATMAP_TYPES))
        return {
            "room_id": room_id,
            "bucket_ms": bucket_ms,
            "buckets": reaction_heatmap(events, bucket_ms),
            "density": heatmap_density(events, bucket_ms),
            "by_emoji": reactions_by_emoji(events),
        }

    def _timeline(self, room_id: str, step_s: int) -> dict[str, Any]:
        events = self._read(lambda: self.repo.room_events(room_id, TIMELINE_TYPES))
        return {"room_id": room_id, "step_s": step_s, "points": timeline(events, step_s)}

    # --- CORS ---------------------------------------------------------------------------------

    def _cors_headers(self, origin: str | None) -> dict[str, str]:
        if origin and origin in self.allowed_origins:
            return {"Access-Control-Allow-Origin": origin, "Vary": "Origin"}
        return {}

    @staticmethod
    def _preflight_headers() -> dict[str, str]:
        return {
            "Access-Control-Allow-Methods": "GET, OPTIONS",
            "Access-Control-Allow-Headers": "Authorization, Content-Type",
            "Access-Control-Max-Age": "600",
        }


def make_handler(api: AnalyticsApi) -> type[BaseHTTPRequestHandler]:
    class Handler(BaseHTTPRequestHandler):
        server_version = "tint-analytics"
        protocol_version = "HTTP/1.1"

        def _dispatch(self) -> None:
            response = api.handle(self.command, self.path, dict(self.headers.items()))
            payload = b""
            if response.body is not None:
                payload = json.dumps(response.body, ensure_ascii=False).encode()
            self.send_response(response.status)
            for name, value in response.headers.items():
                self.send_header(name, value)
            if response.body is not None:
                self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(payload)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(payload)

        do_GET = do_OPTIONS = do_POST = do_PUT = do_PATCH = do_DELETE = _dispatch

        def log_message(self, format: str, *args: Any) -> None:
            # Solo método, ruta y estado: nunca cabeceras (el token va en Authorization).
            logger.info("%s %s", self.address_string(), format % args)

    return Handler


def create_server(api: AnalyticsApi, host: str, port: int) -> ThreadingHTTPServer:
    server = ThreadingHTTPServer((host, port), make_handler(api))
    server.daemon_threads = True
    return server
