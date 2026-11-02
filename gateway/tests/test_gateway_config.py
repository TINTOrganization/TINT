from pathlib import Path
import unittest
import yaml


CONFIG = Path(__file__).parents[1] / "Caddyfile"
COMPOSE = Path(__file__).parents[2] / "docker-compose.yml"
PRODUCTION_COMPOSE = Path(__file__).parents[2] / "docker-compose.production.yml"


class GatewayConfigTests(unittest.TestCase):
    def test_gateway_config_exists_with_https_redirect_and_frontend_fallback(self):
        caddyfile = CONFIG.read_text(encoding="utf-8")

        self.assertIn("http://{$GATEWAY_HOST:localhost}", caddyfile)
        self.assertIn("redir https://{host}:{$GATEWAY_HTTPS_PORT:443}{uri} 308", caddyfile)
        self.assertIn("https://{$GATEWAY_HOST:localhost}", caddyfile)
        self.assertIn("@health path /healthz", caddyfile)
        self.assertIn("@frontend not path /api/* /ws/*", caddyfile)
        self.assertIn("reverse_proxy @frontend web:80", caddyfile)

    def test_gateway_redirects_plain_http_to_https_with_308(self):
        """OPS-03/AC3: redirige HTTP plano a HTTPS con código 308 conservando host y URI."""
        caddyfile = CONFIG.read_text(encoding="utf-8")
        self.assertIn("http://{$GATEWAY_HOST:localhost}", caddyfile)
        self.assertIn("redir https://{host}:{$GATEWAY_HTTPS_PORT:443}{uri} 308", caddyfile)

    def test_gateway_routes_all_public_service_connectors(self):
        caddyfile = CONFIG.read_text(encoding="utf-8")

        self.assertIn("path /api/* /ws/*", caddyfile)
        self.assertIn("not path /api/v1/healthz /api/v1/invitations/claim", caddyfile)
        self.assertIn("forward_auth @protected {$IDENTITY_API_UPSTREAM:identity-api:8081}", caddyfile)
        self.assertIn("uri /api/v1/internal/auth/check", caddyfile)
        self.assertIn("copy_headers X-User-Id X-User-Sub X-User-Role X-User-Room-Id X-User-Nick", caddyfile)
        self.assertIn("import service_timeout", caddyfile)
        self.assertIn(
            "reverse_proxy @identity {$IDENTITY_API_UPSTREAM:identity-api:8081}",
            caddyfile,
        )
        self.assertIn("reverse_proxy @sync {$SYNC_CORE_UPSTREAM:sync-core:8080}", caddyfile)
        self.assertIn("reverse_proxy @social {$SOCIAL_CORE_UPSTREAM:social-core:8082}", caddyfile)
        self.assertIn("reverse_proxy @analytics {$ANALYTICS_UPSTREAM:analytics:8084}", caddyfile)
        self.assertIn("@voice path /ws/voice /ws/voice/*", caddyfile)
        self.assertIn("reverse_proxy @voice {$VOICE_CORE_UPSTREAM:voice-core:8085}", caddyfile)
        self.assertIn("@voice_api path /api/v1/voice/*", caddyfile)
        self.assertIn("reverse_proxy @voice_api {$VOICE_CORE_UPSTREAM:voice-core:8085}", caddyfile)

    def test_gateway_declares_configurable_service_upstreams(self):
        compose = COMPOSE.read_text(encoding="utf-8")

        self.assertIn("SYNC_CORE_UPSTREAM:", compose)
        self.assertIn("SOCIAL_CORE_UPSTREAM:", compose)
        self.assertIn("ANALYTICS_UPSTREAM:", compose)
        self.assertIn("VOICE_CORE_UPSTREAM:", compose)

    def test_gateway_returns_clear_503_for_unavailable_upstreams(self):
        caddyfile = CONFIG.read_text(encoding="utf-8")

        self.assertIn("handle_errors", caddyfile)
        self.assertIn("http.error.status_code", caddyfile)
        self.assertIn("respond @upstream_unavailable", caddyfile)
        self.assertIn('"error":"service_unavailable"', caddyfile)
        self.assertIn(" 503", caddyfile)

    def test_gateway_limits_upstream_waits_to_five_seconds(self):
        caddyfile = CONFIG.read_text(encoding="utf-8")

        self.assertGreaterEqual(caddyfile.count("dial_timeout 5s"), 1)
        self.assertGreaterEqual(caddyfile.count("response_header_timeout 5s"), 1)

    def test_gateway_service_publishes_http_and_https_and_restarts(self):
        compose = COMPOSE.read_text(encoding="utf-8")

        self.assertIn("gateway:", compose)
        self.assertIn('"${GATEWAY_HTTP_PORT:-80}:80"', compose)
        self.assertIn('"${GATEWAY_HTTPS_PORT:-443}:443"', compose)
        self.assertIn("restart: unless-stopped", compose)
        self.assertIn("- gateway-data:/data", compose)

    def test_gateway_preserves_or_generates_correlation_id(self):
        caddyfile = CONFIG.read_text(encoding="utf-8")

        self.assertIn("@missing_correlation not header X-Correlation-ID *", caddyfile)
        self.assertIn("request_header @missing_correlation X-Correlation-ID {http.request.uuid}", caddyfile)
        self.assertIn("header X-Correlation-ID {http.request.header.X-Correlation-ID}", caddyfile)
        self.assertIn("format json", caddyfile)
        self.assertIn("log_append correlation_id {http.request.header.X-Correlation-ID}", caddyfile)


class ComposeStructureTests(unittest.TestCase):
    def test_production_override_keeps_gateway_as_the_only_public_web_api_ws_entry(self):
        """OPS-03/AC1: en producción web, API y WS no se publican fuera del gateway."""
        compose = COMPOSE.read_text(encoding="utf-8")
        production = PRODUCTION_COMPOSE.read_text(encoding="utf-8")

        self.assertIn('"${GATEWAY_HTTP_PORT:-80}:80"', compose)
        self.assertIn('"${GATEWAY_HTTPS_PORT:-443}:443"', compose)
        self.assertNotIn("  gateway:\n    ports: !reset []", production)
        for service in ("web", "identity-api", "sync-core", "social-core", "analytics", "voice-core"):
            self.assertIn(
                f"  {service}:\n    ports: !reset []",
                production,
                msg=f"{service} debe dejar de publicar puertos en producción",
            )

    def test_gateway_persists_certificates_and_restarts_on_failure(self):
        """OPS-03/AC2: Caddy conserva certificados en gateway-data y se reinicia automáticamente."""
        data = yaml.safe_load(COMPOSE.read_text(encoding="utf-8"))
        gateway = data.get("services", {}).get("gateway", {})
        self.assertEqual(gateway.get("restart"), "unless-stopped")
        volumes = gateway.get("volumes", [])
        self.assertTrue(
            any("gateway-data:/data" in str(v) for v in volumes),
            "El gateway debe montar gateway-data en /data para preservar certificados",
        )
        self.assertIn("gateway-data", data.get("volumes", {}))

    def test_compose_lists_all_required_services(self):
        """OPS-02/AC1: gateway, web, servicios, bases de datos, MongoDB y coturn en el Compose."""
        compose = COMPOSE.read_text(encoding="utf-8")
        required = [
            "gateway:",
            "web:",
            "identity-api:",
            "sync-core:",
            "social-core:",
            "media-worker:",
            "analytics:",
            "voice-core:",
            "postgres:",
            "redis:",
            "minio:",
            "mongodb:",
            "coturn:",
        ]
        for svc in required:
            self.assertIn(svc, compose, msg=f"Falta el servicio {svc!r} en docker-compose.yml")

    def test_compose_images_use_pinned_versions(self):
        """OPS-02/AC2: ninguna imagen de infraestructura usa :latest."""
        data = yaml.safe_load(COMPOSE.read_text(encoding="utf-8"))
        for name, svc in data.get("services", {}).items():
            image = svc.get("image", "")
            if image:
                self.assertFalse(
                    image.endswith(":latest"),
                    msg=f"Servicio {name!r} usa imagen con :latest -> {image!r}",
                )

    def test_compose_coturn_is_declared_as_container(self):
        """OPS-02/AC3: coturn declarado como servicio Compose (no proceso host)."""
        compose = COMPOSE.read_text(encoding="utf-8")
        self.assertIn("coturn:", compose)
        self.assertIn("coturn/coturn:", compose)

    def test_compose_minio_version_is_pinned(self):
        """OPS-02/AC2: las imágenes de MinIO y mc deben tener tag semver, no :latest."""
        data = yaml.safe_load(COMPOSE.read_text(encoding="utf-8"))
        for svc_name in ("minio", "minio-init"):
            image = data["services"][svc_name].get("image", "")
            self.assertNotEqual(image, "", msg=f"{svc_name} no tiene imagen declarada")
            self.assertFalse(
                image.endswith(":latest"),
                msg=f"{svc_name} usa :latest -> {image!r}",
            )

    def test_compose_mongodb_service_exists_with_pinned_image(self):
        """SOC-07/DAT-02 prerequisito: mongodb declarado con imagen mongo:<tag> fijo."""
        data = yaml.safe_load(COMPOSE.read_text(encoding="utf-8"))
        self.assertIn("mongodb", data["services"], "Falta el servicio mongodb")
        image = data["services"]["mongodb"].get("image", "")
        self.assertFalse(image.endswith(":latest"), f"mongodb usa :latest -> {image!r}")
        self.assertTrue(image.startswith("mongo:"), f"Imagen de mongodb debe ser mongo:<tag>, no {image!r}")

    def test_compose_mongodb_has_volume_and_healthcheck(self):
        """SOC-02/AC3: MongoDB debe tener volumen persistente y healthcheck."""
        data = yaml.safe_load(COMPOSE.read_text(encoding="utf-8"))
        svc = data["services"].get("mongodb", {})
        volumes = svc.get("volumes", [])
        self.assertTrue(
            any("mongo" in str(v) for v in volumes),
            "mongodb debe montar un volumen nombrado para persistencia",
        )
        self.assertIn("healthcheck", svc, "mongodb debe tener healthcheck")

    def test_env_example_declares_mongo_uri(self):
        """SOC-07: MONGO_URI debe estar declarado en .env.example."""
        env_example = Path(__file__).parents[2] / ".env.example"
        content = env_example.read_text(encoding="utf-8")
        self.assertIn("MONGO_URI", content, "MONGO_URI debe estar en .env.example")


class DockerfileTests(unittest.TestCase):
    def test_voice_core_runtime_image_installs_curl_for_healthcheck(self):
        """OPS-02/AC2: la etapa final de voice-core debe tener curl para su HEALTHCHECK."""
        dockerfile = Path(__file__).parents[2] / "services" / "voice-core" / "Dockerfile"
        text = dockerfile.read_text(encoding="utf-8")
        runtime_section = text.split("FROM debian:trixie-slim\n")[-1]
        self.assertIn("curl", runtime_section)
        self.assertIn("HEALTHCHECK", runtime_section)

    def test_identity_api_dockerfile_is_multistage(self):
        """OPS-02/AC2: identity-api debe usar build multi-stage (no devDependencies en prod)."""
        dockerfile = Path(__file__).parents[2] / "services" / "identity-api" / "Dockerfile"
        text = dockerfile.read_text(encoding="utf-8")
        from_count = sum(
            1 for line in text.splitlines() if line.strip().upper().startswith("FROM")
        )
        self.assertGreaterEqual(
            from_count,
            2,
            "Dockerfile de identity-api debe tener al menos 2 etapas (multi-stage)",
        )
