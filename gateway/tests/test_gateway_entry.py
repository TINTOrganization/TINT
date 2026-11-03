"""La entrada única https://localhost (ADR 0020) funciona con la configuración por defecto.

Encontrado con el E2E del sistema completo en Chromium (2026-11-02): con los valores por defecto
la web servida por el gateway no podía abrir la voz (voice-core rechazaba el Origin con 403 antes
del upgrade) ni subir vídeos (MinIO no permitía el origen https://localhost en CORS).
"""

from pathlib import Path
import re
import unittest


ROOT = Path(__file__).parents[2]
COMPOSE = (ROOT / "docker-compose.yml").read_text(encoding="utf-8")
ENV_EXAMPLE = (ROOT / ".env.example").read_text(encoding="utf-8")
WEB_DOCKERFILE = (ROOT / "apps" / "web" / "Dockerfile").read_text(encoding="utf-8")
README = (ROOT / "README.md").read_text(encoding="utf-8")

WS_SERVICES = ("SYNC", "SOCIAL", "VOICE", "STREAM")


def _compose_default(variable: str) -> str:
    match = re.search(r"\$\{" + variable + r":-([^}]*)\}", COMPOSE)
    if not match:
        raise AssertionError(f"{variable} sin valor por defecto en docker-compose.yml")
    return match.group(1)


def _env_example(variable: str) -> str:
    match = re.search(rf"^{variable}=(.*)$", ENV_EXAMPLE, re.MULTILINE)
    if not match:
        raise AssertionError(f"{variable} no está en .env.example")
    return match.group(1)


class GatewayOriginTest(unittest.TestCase):
    def test_websocket_services_accept_the_gateway_origin_by_default(self):
        for service in WS_SERVICES:
            variable = f"{service}_ALLOWED_ORIGINS"
            with self.subTest(variable=variable):
                self.assertIn("localhost", _compose_default(variable).split(","))
                self.assertIn("localhost", _env_example(variable).split(","))

    def test_minio_cors_allows_uploads_from_the_gateway(self):
        origins = _compose_default("MINIO_CORS_ALLOW_ORIGIN").split(",")
        self.assertIn("https://localhost", origins)
        self.assertIn("http://localhost:5173", origins)
        self.assertIn("https://localhost", _env_example("MINIO_CORS_ALLOW_ORIGIN").split(","))


class WebImageTest(unittest.TestCase):
    def test_web_image_runs_without_compose_variables(self):
        # Sin NGINX_ERROR_LOG_LEVEL la plantilla deja `error_log stderr ;` y nginx no arranca.
        runtime = WEB_DOCKERFILE.split("FROM nginx", 1)[1]
        self.assertRegex(runtime, r"(?m)^ENV (?:[^\n]*\\\n)*[^\n]*NGINX_ERROR_LOG_LEVEL=warn")


class RunInstructionsTest(unittest.TestCase):
    def test_readme_says_5173_has_no_api_or_login(self):
        line = next(l for l in README.splitlines() if "http://localhost:5173" in l and "Entrada" in l)
        self.assertIn("sin API", line)
        self.assertIn("https://localhost", line)


if __name__ == "__main__":
    unittest.main()
