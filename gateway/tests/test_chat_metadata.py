"""Infraestructura de los metadatos del chat en MongoDB (ADR 0025)."""

import unittest
from pathlib import Path

import yaml

ROOT = Path(__file__).parents[2]
COMPOSE = ROOT / "docker-compose.yml"
CI = ROOT / ".github" / "workflows" / "ci-pipeline.yml"


def services():
    return yaml.safe_load(COMPOSE.read_text(encoding="utf-8"))["services"]


class ChatMetadataInfraTests(unittest.TestCase):
    def test_mongo_init_creates_the_app_user_idempotently(self):
        init = services().get("mongo-init")
        self.assertIsNotNone(init, "Falta el servicio mongo-init")
        self.assertEqual(init["depends_on"]["mongodb"]["condition"], "service_healthy")
        script = " ".join(str(part) for part in (init.get("entrypoint") or init.get("command") or []))
        for needle in ("createUser", "updateUser", "readWrite", "social", "MONGO_APP_USER", "MONGO_APP_PASSWORD"):
            self.assertIn(needle, script, f"mongo-init debe usar {needle}")
        # social-core actualiza el validador y el TTL con collMod en cada arranque:
        # readWrite no lo incluye, así que va en un rol propio limitado a la base social.
        for needle in ("createRole", "updateRole", "collMod", "chat_meta_schema"):
            self.assertIn(needle, script, f"mongo-init debe usar {needle}")
        self.assertNotIn("dbAdmin", script, "solo el permiso necesario, no dbAdmin")
        self.assertNotIn("restart", init, "mongo-init es de una sola ejecución")

    def test_social_core_uses_the_app_user_not_root(self):
        env = services()["social-core"]["environment"]
        uri = env.get("MONGO_URI", "")
        self.assertIn("${MONGO_APP_PASSWORD}", uri)
        self.assertIn("@mongodb:27017/social", uri)
        self.assertIn("authSource=social", uri)
        self.assertNotIn("MONGO_ROOT", uri)
        self.assertEqual(env.get("CHAT_META_PEPPER"), "${CHAT_META_PEPPER}")
        self.assertEqual(env.get("CHAT_META_RETENTION_DAYS"), "${CHAT_META_RETENTION_DAYS:-90}")

    def test_chat_does_not_depend_on_mongo(self):
        deps = services()["social-core"].get("depends_on", {})
        self.assertNotIn("mongodb", deps, "Una caída de MongoDB no debe impedir arrancar el chat")
        self.assertNotIn("mongo-init", deps, "Una caída de MongoDB no debe impedir arrancar el chat")

    def test_ci_runs_social_core_against_a_real_mongo(self):
        job = yaml.safe_load(CI.read_text(encoding="utf-8"))["jobs"]["go"]
        self.assertIn("mongo", job.get("services", {}), "El job de Go necesita MongoDB para las pruebas de integración")
        self.assertTrue(job["services"]["mongo"]["image"].startswith("mongo:8"))
        self.assertIn("MONGO_TEST_URI", job.get("env", {}))


if __name__ == "__main__":
    unittest.main()
