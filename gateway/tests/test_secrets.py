"""Contrato estático de secretos por entorno (OPS-05 #90, ADR 0022).

Valida que ningún secreto se versione en git, ni se hornee en imágenes Docker,
ni tenga valores por defecto inseguros en docker-compose.yml. Los secretos
deben inyectarse en tiempo de creación de contenedores desde .env.
"""

from pathlib import Path
import re
import unittest

import yaml


ROOT = Path(__file__).parents[2]
COMPOSE = ROOT / "docker-compose.yml"
GITIGNORE = ROOT / ".gitignore"
DOCKERIGNORE = ROOT / ".dockerignore"
ENV_EXAMPLE = ROOT / ".env.example"
GITLEAKS_TOML = ROOT / ".gitleaks.toml"
ADR = ROOT / "docs" / "adr" / "0022-secretos-por-variables-de-entorno.md"

REQUIRED_SECRETS = (
    "POSTGRES_PASSWORD",
    "MINIO_ROOT_PASSWORD",
    "MONGO_ROOT_PASSWORD",
    "MONGO_URI",
    "JWT_SECRET",
    "TURN_SECRET",
    "INTERNAL_API_SECRET",
)

DOCKERFILES = [
    ROOT / "apps" / "web" / "Dockerfile",
    ROOT / "services" / "identity-api" / "Dockerfile",
    ROOT / "services" / "sync-core" / "Dockerfile",
    ROOT / "services" / "social-core" / "Dockerfile",
    ROOT / "services" / "analytics" / "Dockerfile",
    ROOT / "services" / "media-worker" / "Dockerfile",
    ROOT / "services" / "voice-core" / "Dockerfile",
    ROOT / "services" / "stream-core" / "Dockerfile",
]


class SecretsContractTests(unittest.TestCase):
    def test_adr_documents_secrets_contract(self):
        self.assertTrue(ADR.exists(), f"Falta el ADR 0022 en {ADR}")
        content = ADR.read_text(encoding="utf-8")
        for secret in REQUIRED_SECRETS:
            self.assertIn(secret, content, f"ADR 0022 debe documentar el secreto {secret}")
        self.assertTrue(
            "docker compose up -d --no-build" in content or "--no-build" in content,
            "ADR 0022 debe documentar la regla de recreación con --no-build",
        )
        self.assertIn("VITE_", content, "ADR 0022 debe documentar la excepción de variables públicas del cliente")

    def test_gitignore_protects_env_files(self):
        self.assertTrue(GITIGNORE.exists(), "Falta .gitignore")
        lines = [line.strip() for line in GITIGNORE.read_text(encoding="utf-8").splitlines()]
        self.assertIn(".env", lines, ".gitignore debe contener .env")
        self.assertIn(".env.*", lines, ".gitignore debe contener .env.*")
        self.assertIn("!.env.example", lines, ".gitignore debe permitir !.env.example")

    def test_env_example_documents_all_required_secrets(self):
        self.assertTrue(ENV_EXAMPLE.exists(), "Falta .env.example")
        content = ENV_EXAMPLE.read_text(encoding="utf-8")
        for secret in REQUIRED_SECRETS:
            self.assertTrue(
                bool(re.search(rf"^{secret}=", content, re.MULTILINE)),
                f".env.example debe documentar la variable {secret}",
            )
        self.assertTrue(
            bool(re.search(r"^ANALYTICS_ADMIN_PASSWORD=", content, re.MULTILINE)),
            ".env.example debe incluir ANALYTICS_ADMIN_PASSWORD",
        )

    def test_env_check_enforces_all_required_secrets(self):
        self.assertTrue(COMPOSE.exists(), "Falta docker-compose.yml")
        compose_data = yaml.safe_load(COMPOSE.read_text(encoding="utf-8"))
        env_check = compose_data.get("services", {}).get("env-check", {})
        command = " ".join(str(part) for part in env_check.get("command", []))
        for secret in REQUIRED_SECRETS:
            self.assertIn(secret, command, f"env-check debe validar que {secret} no esté vacío")

    def test_compose_does_not_contain_secret_fallbacks(self):
        raw_compose = COMPOSE.read_text(encoding="utf-8")
        for secret in (
            "POSTGRES_PASSWORD",
            "MINIO_ROOT_PASSWORD",
            "MONGO_ROOT_PASSWORD",
            "JWT_SECRET",
            "TURN_SECRET",
            "INTERNAL_API_SECRET",
        ):
            pattern = rf"\$\{{{secret}:-[^}}]*\}}"
            matches = re.findall(pattern, raw_compose)
            self.assertEqual(
                matches,
                [],
                f"docker-compose.yml no debe usar fallbacks ':-' para el secreto {secret}: encontrados {matches}",
            )

    def test_dockerfiles_do_not_bake_secrets(self):
        forbidden_secret_names = (
            "JWT_SECRET",
            "TURN_SECRET",
            "INTERNAL_API_SECRET",
            "POSTGRES_PASSWORD",
            "MINIO_ROOT_PASSWORD",
            "MONGO_ROOT_PASSWORD",
        )
        for dockerfile in DOCKERFILES:
            self.assertTrue(dockerfile.exists(), f"No existe {dockerfile}")
            text = dockerfile.read_text(encoding="utf-8")
            for secret in forbidden_secret_names:
                self.assertNotIn(
                    f"ENV {secret}",
                    text,
                    f"{dockerfile.name} no debe contener ENV {secret}",
                )
                self.assertNotIn(
                    f"ARG {secret}",
                    text,
                    f"{dockerfile.name} no debe contener ARG {secret}",
                )

    def test_dockerignore_excludes_env_files(self):
        self.assertTrue(DOCKERIGNORE.exists(), "Falta .dockerignore en la raíz")
        lines = [line.strip() for line in DOCKERIGNORE.read_text(encoding="utf-8").splitlines()]
        self.assertIn(".env", lines, ".dockerignore debe excluir .env")
        self.assertTrue(
            any(".env.*" in line for line in lines),
            ".dockerignore debe excluir .env.*",
        )

    def test_gitleaks_configuration_exists_and_scopes_allowlist(self):
        self.assertTrue(GITLEAKS_TOML.exists(), "Falta .gitleaks.toml en la raíz")
        content = GITLEAKS_TOML.read_text(encoding="utf-8")
        # Debe contener allowlist de los placeholders conocidos de desarrollo
        self.assertIn("dev-secret-change-in-prod", content)
        self.assertIn("dev-turn-secret-change-in-prod", content)
        self.assertIn("dev-internal-secret-change-in-prod", content)


if __name__ == "__main__":
    unittest.main()
