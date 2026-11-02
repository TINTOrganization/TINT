"""Contrato estático de observabilidad (OPS-04 #89, ADR 0021).

Estas pruebas no levantan contenedores: comprueban que el repositorio declara el
contrato de salud y logs que después verifica `scripts/observability_smoke.py`.
"""

from pathlib import Path
import unittest

import yaml


ROOT = Path(__file__).parents[2]
COMPOSE = ROOT / "docker-compose.yml"
CADDYFILE = ROOT / "gateway" / "Caddyfile"
NGINX_TEMPLATE = ROOT / "apps" / "web" / "nginx.conf"
ENV_EXAMPLE = ROOT / ".env.example"
ADR = ROOT / "docs" / "adr" / "0021-observabilidad-salud-y-logs.md"

# Servicios de larga duración que deben declarar healthcheck en Compose.
LONG_RUNNING = {
    "gateway",
    "web",
    "postgres",
    "redis",
    "minio",
    "media-worker",
    "analytics",
    "social-core",
    "sync-core",
    "identity-api",
    "voice-core",
    "mongodb",
    "stream-core",
    "coturn",
}

# Servicios de aplicación que deben escribir logs JSON con nivel configurable.
APP_SERVICES = {
    "media-worker",
    "analytics",
    "social-core",
    "sync-core",
    "identity-api",
    "voice-core",
    "stream-core",
}

# Servicios con imagen propia y, por tanto, HEALTHCHECK en su Dockerfile.
DOCKERFILES = {
    "web": ROOT / "apps" / "web" / "Dockerfile",
    "identity-api": ROOT / "services" / "identity-api" / "Dockerfile",
    "sync-core": ROOT / "services" / "sync-core" / "Dockerfile",
    "social-core": ROOT / "services" / "social-core" / "Dockerfile",
    "analytics": ROOT / "services" / "analytics" / "Dockerfile",
    "media-worker": ROOT / "services" / "media-worker" / "Dockerfile",
    "voice-core": ROOT / "services" / "voice-core" / "Dockerfile",
    "stream-core": ROOT / "services" / "stream-core" / "Dockerfile",
}


def compose_services() -> dict:
    return yaml.safe_load(COMPOSE.read_text(encoding="utf-8"))["services"]


class ObservabilityContractTests(unittest.TestCase):
    def test_adr_documents_the_contract(self):
        self.assertTrue(ADR.exists(), "Falta el ADR 0021")
        text = ADR.read_text(encoding="utf-8")
        for fragment in ("/healthz", "liveness", "JSON", "LOG_LEVEL", "/readyz"):
            self.assertIn(fragment, text)

    def test_every_long_running_service_has_a_healthcheck(self):
        services = compose_services()
        missing = [
            name
            for name in sorted(LONG_RUNNING)
            if not services.get(name, {}).get("healthcheck", {}).get("test")
        ]
        self.assertEqual(missing, [], f"Servicios sin healthcheck en Compose: {missing}")

    def test_application_healthchecks_target_healthz(self):
        services = compose_services()
        for name in sorted(APP_SERVICES):
            test = services[name]["healthcheck"]["test"]
            command = " ".join(str(part) for part in test)
            self.assertIn("/healthz", command, f"{name} no sondea /healthz: {command}")

    def test_coturn_healthcheck_uses_stun_client(self):
        test = compose_services()["coturn"]["healthcheck"]["test"]
        command = " ".join(str(part) for part in test)
        self.assertIn("turnutils_stunclient", command)

    def test_application_services_configure_log_level(self):
        services = compose_services()
        for name in sorted(APP_SERVICES):
            environment = services[name].get("environment", {})
            self.assertIn("LOG_LEVEL", environment, f"{name} no declara LOG_LEVEL")

    def test_gateway_and_web_configure_their_own_log_levels(self):
        services = compose_services()
        self.assertIn("GATEWAY_LOG_LEVEL", services["gateway"]["environment"])
        self.assertIn("NGINX_ERROR_LOG_LEVEL", services["web"]["environment"])

    def test_media_worker_exposes_an_internal_health_port(self):
        services = compose_services()
        self.assertIn("MEDIA_WORKER_PORT", services["media-worker"]["environment"])
        ports = services["media-worker"].get("ports", []) or []
        self.assertEqual(ports, [], "El puerto de salud de media-worker no debe publicarse")

    def test_dockerfiles_declare_healthcheck(self):
        missing = []
        for name, path in DOCKERFILES.items():
            text = path.read_text(encoding="utf-8")
            if "HEALTHCHECK" not in text:
                missing.append(name)
        self.assertEqual(missing, [], f"Imágenes sin HEALTHCHECK: {missing}")

    def test_gateway_health_is_json_and_level_is_configurable(self):
        caddyfile = CADDYFILE.read_text(encoding="utf-8")
        self.assertIn("format json", caddyfile)
        self.assertIn("GATEWAY_LOG_LEVEL", caddyfile)
        self.assertIn('"status":"ok"', caddyfile)
        self.assertIn('"service":"gateway"', caddyfile)

    def test_web_health_endpoint_and_configurable_error_log(self):
        nginx = NGINX_TEMPLATE.read_text(encoding="utf-8")
        self.assertIn("location = /healthz", nginx)
        self.assertIn("NGINX_ERROR_LOG_LEVEL", nginx)
        self.assertIn('"service":"web"', nginx)
        # La plantilla se procesa con envsubst: las variables de nginx deben sobrevivir.
        self.assertIn("$uri", nginx)

    def test_env_example_documents_new_variables(self):
        text = ENV_EXAMPLE.read_text(encoding="utf-8")
        for variable in (
            "LOG_LEVEL",
            "GATEWAY_LOG_LEVEL",
            "NGINX_ERROR_LOG_LEVEL",
            "MEDIA_WORKER_PORT",
            "MEDIA_WORKER_HEARTBEAT_MAX_AGE_S",
        ):
            self.assertIn(variable, text, f".env.example no documenta {variable}")


if __name__ == "__main__":
    unittest.main()
