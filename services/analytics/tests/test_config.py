from datetime import timedelta

import pytest

from analytics.config import ConfigError, Settings

ENV = {"DATABASE_URL": "postgresql://u:p@db:5432/tint", "JWT_SECRET": "s3cret"}


def test_defaults():
    settings = Settings.from_env(ENV)
    assert settings.database_url == ENV["DATABASE_URL"]
    assert settings.jwt_secret == "s3cret"
    assert settings.jwt_issuer == "tint-identity"
    assert settings.jwt_audience == "tint:room"
    assert settings.redis_url == "redis://localhost:6379"
    assert settings.port == 8084
    assert settings.allowed_origins == ("http://localhost:5173",)
    assert settings.consumer
    assert settings.room_grace == timedelta(hours=12)
    assert settings.timezone == "America/Bogota"
    assert settings.admin_password is None
    assert "s3cret" not in repr(settings)
    assert "u:p" not in repr(settings)


def test_overrides():
    settings = Settings.from_env(
        {
            **ENV,
            "JWT_ISSUER": "iss",
            "JWT_AUDIENCE": "aud",
            "REDIS_URL": "redis://redis:6379",
            "ANALYTICS_PORT": "9000",
            "ANALYTICS_ALLOWED_ORIGINS": " http://a.test , ,http://b.test ",
            "ANALYTICS_CONSUMER": "analytics-1",
            "ANALYTICS_ROOM_GRACE_HOURS": "0",
            "ANALYTICS_TIMEZONE": "UTC",
            "ANALYTICS_ADMIN_PASSWORD": "clave-del-grupo",
        }
    )
    assert (settings.jwt_issuer, settings.jwt_audience) == ("iss", "aud")
    assert settings.redis_url == "redis://redis:6379"
    assert settings.port == 9000
    assert settings.allowed_origins == ("http://a.test", "http://b.test")
    assert settings.consumer == "analytics-1"
    assert settings.room_grace == timedelta(0)
    assert settings.timezone == "UTC"
    assert settings.admin_password == "clave-del-grupo"
    assert "clave-del-grupo" not in repr(settings)


@pytest.mark.parametrize("missing", ["DATABASE_URL", "JWT_SECRET"])
def test_required_variables(missing):
    env = {k: v for k, v in ENV.items() if k != missing}
    with pytest.raises(ConfigError, match=missing):
        Settings.from_env(env)


@pytest.mark.parametrize("port", ["abc", "0", "70000"])
def test_invalid_port(port):
    with pytest.raises(ConfigError, match="ANALYTICS_PORT"):
        Settings.from_env({**ENV, "ANALYTICS_PORT": port})


@pytest.mark.parametrize("hours", ["doce", "-1", "1.5"])
def test_invalid_room_grace(hours):
    with pytest.raises(ConfigError, match="ANALYTICS_ROOM_GRACE_HOURS"):
        Settings.from_env({**ENV, "ANALYTICS_ROOM_GRACE_HOURS": hours})


def test_reads_os_environ_by_default(monkeypatch):
    for key, value in ENV.items():
        monkeypatch.setenv(key, value)
    assert Settings.from_env().jwt_secret == "s3cret"
