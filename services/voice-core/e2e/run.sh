#!/usr/bin/env bash
# E2E de la voz con dos Chromium reales: ruta libre y solo TURN.
# Necesita levantados: la web (WEB_URL, por defecto http://localhost:5173), voice-core, Redis
# y coturn (`docker compose up -d voice-core coturn`). Usa la imagen minlag/mermaid-cli, que
# trae Chromium y Puppeteer (la misma que valida los diagramas Mermaid).
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
root="$(cd "$here/../../.." && pwd)"

# JWT_SECRET: del entorno, del .env de la raíz o el de compose por defecto.
if [[ -z "${JWT_SECRET:-}" && -f "$root/.env" ]]; then
  JWT_SECRET="$(grep -E '^JWT_SECRET=' "$root/.env" | cut -d= -f2- | tr -d '"')"
fi
JWT_SECRET="${JWT_SECRET:-dev-secret-change-in-prod}"

image="minlag/mermaid-cli:11.4.2"
status=0
for mode in ${MODES:-normal relay}; do
  docker run --rm --network host --entrypoint node \
    -e JWT_SECRET="$JWT_SECRET" \
    -e WEB_URL="${WEB_URL:-http://localhost:5173}" \
    -e VOICE_HTTP="${VOICE_HTTP:-http://localhost:8085}" \
    -v "$here:/e2e:ro" "$image" /e2e/voice-e2e.cjs "$mode" || status=1
done
exit "$status"
