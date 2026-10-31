from pathlib import Path
import unittest


CONFIG = Path(__file__).parents[1] / "Caddyfile"
COMPOSE = Path(__file__).parents[2] / "docker-compose.yml"


class GatewayConfigTests(unittest.TestCase):
    def test_gateway_config_exists_with_https_redirect_and_fallback_404(self):
        caddyfile = CONFIG.read_text(encoding="utf-8")

        self.assertIn("http://{$GATEWAY_HOST:localhost}", caddyfile)
        self.assertIn("redir https://{host}:{$GATEWAY_HTTPS_PORT:443}{uri} 308", caddyfile)
        self.assertIn("https://{$GATEWAY_HOST:localhost}", caddyfile)
        self.assertIn("respond @root 200", caddyfile)
        self.assertIn("respond 404", caddyfile)


    def test_gateway_routes_all_public_service_connectors(self):
        caddyfile = CONFIG.read_text(encoding="utf-8")

        self.assertIn(
            "reverse_proxy @identity {$IDENTITY_API_UPSTREAM:host.docker.internal:8081}",
            caddyfile,
        )
        self.assertIn("reverse_proxy @sync sync-core:8080", caddyfile)
        self.assertIn("reverse_proxy @social social-core:8082", caddyfile)
        self.assertIn("reverse_proxy @analytics analytics:8084", caddyfile)


    def test_gateway_service_publishes_http_and_https_and_restarts(self):
        compose = COMPOSE.read_text(encoding="utf-8")

        self.assertIn("gateway:", compose)
        self.assertIn('"${GATEWAY_HTTP_PORT:-80}:80"', compose)
        self.assertIn('"${GATEWAY_HTTPS_PORT:-443}:443"', compose)
        self.assertIn("restart: unless-stopped", compose)
