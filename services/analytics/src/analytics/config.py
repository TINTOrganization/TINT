"""Configuración desde variables de entorno (sin secretos por defecto: falla cerrado)."""

from __future__ import annotations

import os
import socket
from collections.abc import Mapping
from dataclasses import dataclass, field
from datetime import timedelta

from analytics.api import DEFAULT_ALLOWED_ORIGINS, DEFAULT_PORT
from analytics.consumer import DEFAULT_ROOM_GRACE, DEFAULT_TIMEZONE


class ConfigError(Exception):
    """Faltan variables obligatorias o tienen un valor inválido."""


@dataclass(frozen=True)
class Settings:
    database_url: str = field(repr=False)
    jwt_secret: str = field(repr=False)
    jwt_issuer: str = "tint-identity"
    jwt_audience: str = "tint:room"
    redis_url: str = "redis://localhost:6379"
    port: int = DEFAULT_PORT
    allowed_origins: tuple[str, ...] = DEFAULT_ALLOWED_ORIGINS
    consumer: str = field(default_factory=socket.gethostname)
    room_grace: timedelta = DEFAULT_ROOM_GRACE
    # Contraseña compartida del panel de negocio; sin ella la ruta no se sirve.
    admin_password: str | None = field(default=None, repr=False)
    timezone: str = DEFAULT_TIMEZONE

    @classmethod
    def from_env(cls, env: Mapping[str, str] | None = None) -> Settings:
        env = os.environ if env is None else env
        missing = [name for name in ("DATABASE_URL", "JWT_SECRET") if not env.get(name)]
        if missing:
            raise ConfigError(f"faltan variables de entorno: {', '.join(missing)}")

        optional: dict = {}
        for var, attr in (
            ("JWT_ISSUER", "jwt_issuer"),
            ("JWT_AUDIENCE", "jwt_audience"),
            ("REDIS_URL", "redis_url"),
            # Nombre estable por réplica: al reiniciar recupera sus propios pendientes.
            ("ANALYTICS_CONSUMER", "consumer"),
            # Zona horaria (nombre IANA) del corte del día en DAU/MAU; la resuelve PostgreSQL.
            ("ANALYTICS_TIMEZONE", "timezone"),
            ("ANALYTICS_ADMIN_PASSWORD", "admin_password"),
        ):
            if env.get(var):
                optional[attr] = env[var]
        if env.get("ANALYTICS_PORT"):
            port = env["ANALYTICS_PORT"]
            if not port.isdigit() or not 0 < int(port) < 65536:
                raise ConfigError(f"ANALYTICS_PORT inválido: {port!r}")
            optional["port"] = int(port)
        if env.get("ANALYTICS_ROOM_GRACE_HOURS"):
            hours = env["ANALYTICS_ROOM_GRACE_HOURS"]
            if not hours.isdigit():
                raise ConfigError(f"ANALYTICS_ROOM_GRACE_HOURS inválido: {hours!r}")
            optional["room_grace"] = timedelta(hours=int(hours))
        if env.get("ANALYTICS_ALLOWED_ORIGINS"):
            origins = [o.strip() for o in env["ANALYTICS_ALLOWED_ORIGINS"].split(",")]
            optional["allowed_origins"] = tuple(o for o in origins if o)
        return cls(database_url=env["DATABASE_URL"], jwt_secret=env["JWT_SECRET"], **optional)
