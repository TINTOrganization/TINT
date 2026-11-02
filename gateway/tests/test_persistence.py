"""Volúmenes persistentes, respaldo y restauración (DAT-06)."""

import re
import unittest
from pathlib import Path

import yaml

ROOT = Path(__file__).parents[2]
COMPOSE = ROOT / "docker-compose.yml"
MAKEFILE = ROOT / "Makefile"
README = ROOT / "README.md"
GITIGNORE = ROOT / ".gitignore"

# Almacén → ruta de datos dentro del contenedor.
STATEFUL = {
    "postgres": "/var/lib/postgresql/data",
    "redis": "/data",
    "mongodb": "/data/db",
    "minio": "/data",
}


def compose():
    return yaml.safe_load(COMPOSE.read_text(encoding="utf-8"))


class PersistentVolumesTests(unittest.TestCase):
    def test_every_data_store_mounts_a_named_volume(self):
        data = compose()
        declared = set((data.get("volumes") or {}).keys())
        for service, path in STATEFUL.items():
            mounts = data["services"][service].get("volumes", [])
            named = [m.split(":")[0] for m in mounts if isinstance(m, str) and m.endswith(":" + path)]
            self.assertTrue(named, f"{service} debe montar un volumen en {path}")
            self.assertIn(named[0], declared, f"{service}: {named[0]} debe ser un volumen con nombre declarado")

    def test_redis_persists_with_append_only_file(self):
        command = compose()["services"]["redis"].get("command", [])
        self.assertIn("--appendonly", command)
        self.assertEqual(command[command.index("--appendonly") + 1], "yes")

    def test_backups_are_not_versioned(self):
        lines = [line.strip() for line in GITIGNORE.read_text(encoding="utf-8").splitlines()]
        self.assertIn("backups/", lines, "Los respaldos contienen datos personales: nunca a git")


class BackupWorkflowTests(unittest.TestCase):
    def test_make_targets(self):
        makefile = MAKEFILE.read_text(encoding="utf-8")
        for target in ("backup", "restore", "smoke-persistence"):
            self.assertRegex(makefile, rf"(?m)^\.PHONY:.*\b{target}\b")
        self.assertRegex(makefile, r"(?m)^backup:\n\tpython3 scripts/data_backup\.py backup$")
        self.assertRegex(makefile, r"(?m)^restore:\n\tpython3 scripts/data_backup\.py restore \$\(BACKUP\)$")
        self.assertRegex(makefile, r"(?m)^smoke-persistence:\n\tpython3 scripts/persistence_smoke\.py$")

    def test_scripts_exist(self):
        for name in ("data_backup.py", "persistence_smoke.py"):
            self.assertTrue((ROOT / "scripts" / name).is_file(), f"Falta scripts/{name}")

    def test_readme_documents_backup_and_restore(self):
        text = README.read_text(encoding="utf-8")
        match = re.search(r"(##\s+💾\s+Respaldo y restauración.*?)(?=\n##\s+|$)", text, re.DOTALL)
        self.assertIsNotNone(match, "README.md debe tener la sección '## 💾 Respaldo y restauración'")
        section = match.group(1)
        for needle in ("make backup", "make restore", "python scripts/data_backup.py", "docker compose down -v",
                       "PostgreSQL", "MongoDB", "MinIO", "Redis", "make smoke-persistence"):
            self.assertIn(needle, section, f"La sección de respaldo debe mencionar {needle}")


def load_backup_script():
    import importlib.util

    spec = importlib.util.spec_from_file_location("data_backup", ROOT / "scripts" / "data_backup.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class DataBackupScriptTests(unittest.TestCase):
    def setUp(self):
        self.mod = load_backup_script()

    def test_restore_stops_only_services_that_write_to_the_stores(self):
        running = ["postgres", "redis", "mongodb", "minio", "gateway", "web", "coturn",
                   "identity-api", "social-core", "media-worker", "analytics", "sync-core", "voice-core", "stream-core"]
        self.assertEqual(
            self.mod.app_services(running),
            ["identity-api", "social-core", "media-worker", "analytics", "sync-core", "voice-core", "stream-core"],
        )

    def test_default_destination_is_timestamped_under_backups(self):
        import datetime as dt

        dest = self.mod.default_destination(dt.datetime(2026, 11, 2, 18, 30, 5))
        self.assertEqual(dest, ROOT / "backups" / "20261102-183005")

    def test_every_store_is_covered(self):
        self.assertEqual(set(self.mod.FILES), {"postgres", "mongodb", "redis", "minio"})
        self.assertIn("--clean", self.mod.PG_RESTORE)
        self.assertIn("--drop", self.mod.MONGO_RESTORE)
        self.assertIn('--nsExclude "admin.*"', self.mod.MONGO_RESTORE, "no pisar los usuarios de MongoDB")
        self.assertIn("CONFIG SET appendonly yes", self.mod.REDIS_LOAD, "Redis con AOF ignora dump.rdb sin esto")

    def test_restore_refuses_an_incomplete_backup(self):
        import io
        import tempfile
        from contextlib import redirect_stderr

        with tempfile.TemporaryDirectory() as tmp, redirect_stderr(io.StringIO()) as err:
            self.assertEqual(self.mod.main(["restore", tmp]), 1)
        self.assertIn("no es un respaldo completo", err.getvalue())

    def test_usage_without_arguments(self):
        import io
        from contextlib import redirect_stdout

        with redirect_stdout(io.StringIO()):
            self.assertEqual(self.mod.main([]), 2)
            self.assertEqual(self.mod.main(["restore"]), 2)


if __name__ == "__main__":
    unittest.main()
