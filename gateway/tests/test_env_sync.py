"""Sincronización de .env con .env.example (make env-sync / make up)."""

import importlib.util
import io
import re
import tempfile
import unittest
from contextlib import redirect_stdout
from pathlib import Path

import yaml

ROOT = Path(__file__).parents[2]
SCRIPT = ROOT / "scripts" / "env_sync.py"
MAKEFILE = ROOT / "Makefile"
COMPOSE = ROOT / "docker-compose.yml"
README = ROOT / "README.md"


def load_script():
    spec = importlib.util.spec_from_file_location("env_sync", SCRIPT)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


EXAMPLE = """# Comentario de la plantilla
POSTGRES_PASSWORD=tint
JWT_SECRET=dev-secret-change-in-prod

# Sección nueva
CHAT_META_PEPPER=chat-meta-dev-pepper-change-me
LOG_LEVEL=info
"""


class EnvSyncTests(unittest.TestCase):
    def setUp(self):
        self.mod = load_script()
        self.tmp = tempfile.TemporaryDirectory()
        self.dir = Path(self.tmp.name)
        self.example = self.dir / ".env.example"
        self.env = self.dir / ".env"
        self.example.write_text(EXAMPLE, encoding="utf-8")

    def tearDown(self):
        self.tmp.cleanup()

    def test_creates_env_from_the_template_when_missing(self):
        added = self.mod.sync(self.env, self.example)
        self.assertEqual(self.env.read_text(encoding="utf-8"), EXAMPLE)
        self.assertEqual(added, ["POSTGRES_PASSWORD", "JWT_SECRET", "CHAT_META_PEPPER", "LOG_LEVEL"])

    def test_appends_only_missing_variables_and_keeps_existing_values(self):
        self.env.write_text("# mío\nPOSTGRES_PASSWORD=mi-clave\nJWT_SECRET=otro\nEXTRA_LOCAL=1\n", encoding="utf-8")
        added = self.mod.sync(self.env, self.example)
        self.assertEqual(added, ["CHAT_META_PEPPER", "LOG_LEVEL"])
        content = self.env.read_text(encoding="utf-8")
        self.assertTrue(content.startswith("# mío\nPOSTGRES_PASSWORD=mi-clave\nJWT_SECRET=otro\nEXTRA_LOCAL=1\n"))
        self.assertIn("CHAT_META_PEPPER=chat-meta-dev-pepper-change-me\n", content)
        self.assertIn("LOG_LEVEL=info\n", content)
        self.assertEqual(content.count("POSTGRES_PASSWORD="), 1)

    def test_is_idempotent(self):
        self.env.write_text("POSTGRES_PASSWORD=x\n", encoding="utf-8")
        self.mod.sync(self.env, self.example)
        once = self.env.read_text(encoding="utf-8")
        self.assertEqual(self.mod.sync(self.env, self.example), [])
        self.assertEqual(self.env.read_text(encoding="utf-8"), once)

    def test_an_empty_value_counts_as_present(self):
        # env-check avisa de los vacíos: el script nunca pisa lo que el usuario dejó.
        self.env.write_text("POSTGRES_PASSWORD=\n", encoding="utf-8")
        self.assertNotIn("POSTGRES_PASSWORD", self.mod.sync(self.env, self.example))
        self.assertIn("POSTGRES_PASSWORD=\n", self.env.read_text(encoding="utf-8"))

    def test_handles_files_without_trailing_newline(self):
        self.env.write_text("POSTGRES_PASSWORD=x", encoding="utf-8")
        self.example.write_text(EXAMPLE.rstrip("\n"), encoding="utf-8")
        self.mod.sync(self.env, self.example)
        lines = self.env.read_text(encoding="utf-8").splitlines()
        self.assertEqual(lines[0], "POSTGRES_PASSWORD=x")
        self.assertIn("LOG_LEVEL=info", lines)

    def test_secret_like_variables_are_flagged(self):
        for key in ("POSTGRES_PASSWORD", "JWT_SECRET", "CHAT_META_PEPPER", "MONGO_URI", "API_TOKEN"):
            self.assertTrue(self.mod.is_secret(key), key)
        for key in ("LOG_LEVEL", "MONGO_APP_USER", "STREAM_UDP_PORT"):
            self.assertFalse(self.mod.is_secret(key), key)

    def test_main_reports_what_it_added_and_warns_about_dev_secrets(self):
        out = io.StringIO()
        with redirect_stdout(out):
            code = self.mod.main([str(self.env), str(self.example)])
        self.assertEqual(code, 0)
        text = out.getvalue()
        self.assertIn("CHAT_META_PEPPER", text)
        self.assertIn("desarrollo", text)
        out = io.StringIO()
        with redirect_stdout(out):
            self.mod.main([str(self.env), str(self.example)])
        self.assertIn("al día", out.getvalue())

    def test_main_fails_without_the_template(self):
        self.example.unlink()
        with redirect_stdout(io.StringIO()):
            self.assertEqual(self.mod.main([str(self.env), str(self.example)]), 1)


class StartupWorkflowTests(unittest.TestCase):
    def test_make_up_syncs_env_and_rebuilds(self):
        makefile = MAKEFILE.read_text(encoding="utf-8")
        self.assertRegex(makefile, r"(?m)^\.PHONY:.*\benv-sync\b")
        self.assertRegex(makefile, r"(?m)^env-sync:\n\tpython3 scripts/env_sync\.py$")
        up = re.search(r"(?m)^up:(.*)\n((?:\t.*\n)+)", makefile)
        self.assertIsNotNone(up, "Falta el objetivo up")
        self.assertIn("env-sync", up.group(1), "make up debe sincronizar .env antes de arrancar")
        self.assertIn("docker compose up -d --build", up.group(2), "make up debe reconstruir tras un pull")

    def test_env_check_points_to_env_sync(self):
        services = yaml.safe_load(COMPOSE.read_text(encoding="utf-8"))["services"]
        command = " ".join(str(part) for part in services["env-check"]["command"])
        self.assertIn("make env-sync", command)

    def test_readme_recommends_make_up_and_env_sync(self):
        readme = README.read_text(encoding="utf-8")
        section = re.search(r"(##\s+🚀\s+Instrucciones de Ejecución del Prototipo.*?)(?=\n##\s+|$)", readme, re.DOTALL).group(1)
        self.assertIn("make up", section)
        self.assertIn("make env-sync", section)
        self.assertIn("python scripts/env_sync.py", section, "Alternativa sin make (Windows)")


if __name__ == "__main__":
    unittest.main()
