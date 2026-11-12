"""Contrato del login local con el Firebase Auth Emulator (ADR 0024).

El emulador emite ID tokens SIN firma (alg: none): solo existe en el Compose de
desarrollo. El override de producción no lo arranca, fija NODE_ENV=production en
identity-api (que así se niega a arrancar con emulador), vacía
FIREBASE_AUTH_EMULATOR_HOST y construye la web sin VITE_FIREBASE_AUTH_EMULATOR_URL.
"""

from pathlib import Path
import re
import unittest

import yaml


ROOT = Path(__file__).parents[2]
COMPOSE = ROOT / "docker-compose.yml"
PRODUCTION_COMPOSE = ROOT / "docker-compose.production.yml"
ENV_EXAMPLE = ROOT / ".env.example"
EMULATOR_DOCKERFILE = ROOT / "firebase-auth-emulator" / "Dockerfile"
EMULATOR_CONFIG = ROOT / "firebase-auth-emulator" / "firebase.json"
ADR = ROOT / "docs" / "adr" / "0024-login-local-con-firebase-auth-emulator.md"
ADR_INDEX = ROOT / "docs" / "adr" / "README.md"


class _ComposeLoader(yaml.SafeLoader):
    """SafeLoader que entiende las etiquetas de Compose (!reset, !override)."""


def _compose_tag(loader, _suffix, node):
    if isinstance(node, yaml.MappingNode):
        return loader.construct_mapping(node)
    if isinstance(node, yaml.SequenceNode):
        return loader.construct_sequence(node)
    return loader.construct_scalar(node)


_ComposeLoader.add_multi_constructor("!", _compose_tag)


def load(path: Path) -> dict:
    return yaml.load(path.read_text(encoding="utf-8"), Loader=_ComposeLoader)


def env_example() -> dict:
    values = {}
    for line in ENV_EXAMPLE.read_text(encoding="utf-8").splitlines():
        if line and not line.startswith("#") and "=" in line:
            key, value = line.split("=", 1)
            values[key] = value
    return values


class DevelopmentComposeTests(unittest.TestCase):
    def test_emulator_service_builds_local_image_with_healthcheck(self):
        service = load(COMPOSE)["services"]["firebase-auth-emulator"]
        self.assertEqual(service["build"], "./firebase-auth-emulator")
        self.assertIn("/9099/", " ".join(service["healthcheck"]["test"]).replace(":9099/", "/9099/"))
        self.assertEqual(service["depends_on"]["env-check"]["condition"], "service_completed_successfully")

    def test_emulator_is_published_only_on_loopback(self):
        ports = load(COMPOSE)["services"]["firebase-auth-emulator"]["ports"]
        self.assertEqual(ports, ["127.0.0.1:9099:9099"])

    def test_emulator_image_pins_exact_firebase_tools_version(self):
        dockerfile = EMULATOR_DOCKERFILE.read_text(encoding="utf-8")
        self.assertRegex(dockerfile, r"ARG FIREBASE_TOOLS_VERSION=\d+\.\d+\.\d+\n")
        self.assertIn('firebase-tools@${FIREBASE_TOOLS_VERSION}', dockerfile)
        self.assertNotIn("firebase-tools@latest", dockerfile)
        self.assertIn("USER node", dockerfile)
        self.assertIn("HEALTHCHECK", dockerfile)
        self.assertIn("--only auth", dockerfile)
        self.assertIn("demo-*)", dockerfile, "La imagen debe negarse a arrancar sin proyecto demo-*")

    def test_emulator_config_only_auth_without_ui(self):
        config = EMULATOR_CONFIG.read_text(encoding="utf-8")
        self.assertIn('"port": 9099', config)
        self.assertIn('"enabled": false', config)

    def test_identity_api_runs_in_development_with_emulator_host_from_env(self):
        environment = load(COMPOSE)["services"]["identity-api"]["environment"]
        self.assertEqual(environment["NODE_ENV"], "development")
        self.assertEqual(environment["FIREBASE_AUTH_EMULATOR_HOST"], "${FIREBASE_AUTH_EMULATOR_HOST:-}")

    def test_web_build_receives_emulator_url_without_default(self):
        args = load(COMPOSE)["services"]["web"]["build"]["args"]
        self.assertEqual(args["VITE_FIREBASE_AUTH_EMULATOR_URL"], "${VITE_FIREBASE_AUTH_EMULATOR_URL:-}")

    def test_env_check_requires_demo_project_with_emulator(self):
        command = " ".join(load(COMPOSE)["services"]["env-check"]["command"])
        self.assertIn("FIREBASE_AUTH_EMULATOR_HOST", command)
        self.assertIn("demo-*", command)


class EnvExampleTests(unittest.TestCase):
    def test_env_example_uses_emulator_by_default_with_consistent_demo_project(self):
        values = env_example()
        self.assertTrue(values["FIREBASE_PROJECT_ID"].startswith("demo-"))
        self.assertEqual(values["VITE_FIREBASE_PROJECT_ID"], values["FIREBASE_PROJECT_ID"])
        self.assertEqual(values["FIREBASE_AUTH_EMULATOR_HOST"], "firebase-auth-emulator:9099")
        self.assertEqual(values["VITE_FIREBASE_AUTH_EMULATOR_URL"], "http://localhost:9099")


class ProductionOverrideTests(unittest.TestCase):
    def setUp(self):
        self.services = load(PRODUCTION_COMPOSE)["services"]

    def test_production_never_starts_the_emulator(self):
        emulator = self.services["firebase-auth-emulator"]
        self.assertTrue(emulator.get("profiles"), "El emulador debe quedar tras un perfil inactivo")
        self.assertEqual(emulator.get("ports"), [])
        raw = PRODUCTION_COMPOSE.read_text(encoding="utf-8")
        self.assertNotRegex(raw, r"COMPOSE_PROFILES|never-in-production.*up")

    def test_production_identity_api_is_production_without_emulator(self):
        environment = self.services["identity-api"]["environment"]
        self.assertEqual(environment["NODE_ENV"], "production")
        self.assertEqual(environment["FIREBASE_AUTH_EMULATOR_HOST"], "")

    def test_production_web_build_has_no_emulator_url(self):
        args = self.services["web"]["build"]["args"]
        self.assertEqual(args["VITE_FIREBASE_AUTH_EMULATOR_URL"], "")


class AdrTests(unittest.TestCase):
    def test_adr_0024_exists_and_is_indexed(self):
        self.assertTrue(ADR.exists(), f"Falta {ADR}")
        text = ADR.read_text(encoding="utf-8")
        for fragment in ("alg: none", "NODE_ENV", "demo-", "FIREBASE_AUTH_EMULATOR_HOST", "docker-compose.production.yml"):
            self.assertIn(fragment, text)
        self.assertIn("0024-login-local-con-firebase-auth-emulator.md", ADR_INDEX.read_text(encoding="utf-8"))


if __name__ == "__main__":
    unittest.main()
