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

        self.assertIn("@public path / /healthz /api/v1/healthz /api/v1/invitations/claim", caddyfile)
        self.assertIn("forward_auth @protected {$IDENTITY_API_UPSTREAM:host.docker.internal:8081}", caddyfile)
        self.assertIn("uri /api/v1/internal/auth/check", caddyfile)
        self.assertIn("copy_headers X-User-Id X-User-Sub X-User-Role X-User-Room-Id X-User-Nick", caddyfile)
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

    def test_gateway_preserves_or_generates_correlation_id(self):
        caddyfile = CONFIG.read_text(encoding="utf-8")

        self.assertIn("@missing_correlation not header X-Correlation-ID *", caddyfile)
        self.assertIn("request_header @missing_correlation X-Correlation-ID {http.request.uuid}", caddyfile)
        self.assertIn("header X-Correlation-ID {http.request.header.X-Correlation-ID}", caddyfile)
        self.assertIn("format json", caddyfile)
        self.assertIn("log_append correlation_id {http.request.header.X-Correlation-ID}", caddyfile)
