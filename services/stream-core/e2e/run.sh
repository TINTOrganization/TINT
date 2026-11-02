#!/usr/bin/env bash
# E2E de la transmisión en vivo (R7) con Chromium real: la web (`/live/:id`, hook useLiveStream) como
# host y dos viewers contra stream-core. Valida el spike S1 (simulcast VP8 de 3 rid), TTFF,
# glass-to-glass, audio Opus, modo relay (coturn) y la gracia del host (docs/dominio-transmision.md §7–§9).
#
#   make e2e-stream                  # modos normal y relay
#   MODES=normal make e2e-stream
#   TTFF_ROUNDS=5 G2G_MS=15000 DIAG=1 make e2e-stream   # recargas por viewer, ventana de glass-to-glass,
#                                                        # y PLI/keyframes del host por cada TTFF
#
# No usa docker compose ni .env (lo lee si existe para JWT_SECRET, INTERNAL_API_SECRET y TURN_SECRET):
# necesita IDENTITY_API_URL apuntando al stub y una gracia corta, que compose no permite cambiar.
#
# Levanta su propio entorno aislado, en puertos que no chocan con `docker compose` (todo con
# --network host): Redis (:16390), stream-core de este árbol (:18086, UDP :18087, gracia
# STREAM_HOST_GRACE_S=10), la web compilada contra ellos (:15173) y, si no hay uno en :3478, coturn.
# identity-api lo reemplaza un stub HTTP dentro del script (:18081): responde a la web (sala `live`,
# sync-ticket firmado con JWT_SECRET) y registra el `POST /api/v1/internal/rooms/{id}/disable` de
# stream-core. Al terminar borra todos los contenedores que levantó.
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
root="$(cd "$here/../../.." && pwd)"

env_value() { [[ -f "$root/.env" ]] && grep -E "^$1=" "$root/.env" | cut -d= -f2- | tr -d '"' || true; }
JWT_SECRET="${JWT_SECRET:-$(env_value JWT_SECRET)}"
JWT_SECRET="${JWT_SECRET:-dev-secret-change-in-prod}"
INTERNAL_API_SECRET="${INTERNAL_API_SECRET:-$(env_value INTERNAL_API_SECRET)}"
INTERNAL_API_SECRET="${INTERNAL_API_SECRET:-dev-internal-secret-change-in-prod}"
TURN_SECRET="${TURN_SECRET:-$(env_value TURN_SECRET)}"
TURN_SECRET="${TURN_SECRET:-dev-turn-secret-change-in-prod}"

# El candidato del SFU debe ser una IP que coturn pueda alcanzar como peer (coturn rechaza loopback).
PUBLIC_IP="${STREAM_PUBLIC_IP:-$(ip route get 1.1.1.1 2>/dev/null | awk '{for (i = 1; i < NF; i++) if ($i == "src") { print $(i + 1); exit }}')}"
[[ -n "$PUBLIC_IP" ]] || { echo "No pude deducir la IP de la LAN; define STREAM_PUBLIC_IP" >&2; exit 2; }
GRACE_S="${STREAM_HOST_GRACE_S:-10}"
REDIS_PORT=16390
STREAM_PORT=18086
STREAM_UDP=18087
STUB_PORT=18081
WEB_PORT=15173

prefix="tint-e2e-stream"
started=()
cleanup() {
  if [[ "${#started[@]}" -gt 0 ]]; then
    echo "==> borrando ${started[*]}"
    docker rm -f "${started[@]}" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

for port in $REDIS_PORT $STREAM_PORT $STUB_PORT $WEB_PORT; do
  if ss -ltn "( sport = :$port )" | grep -q LISTEN; then
    echo "El puerto $port está ocupado (¿otro E2E corriendo?). Libéralo y repite." >&2
    exit 2
  fi
done

echo "==> imágenes: stream-core de este árbol y la web (VITE_* apuntando al entorno del E2E)"
docker build -q -t tint-stream-core:e2e "$root/services/stream-core" >/dev/null
docker build -q -t tint-web:e2e-stream \
  --build-arg VITE_IDENTITY_API_URL="http://localhost:$STUB_PORT/api/v1" \
  --build-arg VITE_STREAM_API_URL="http://localhost:$STREAM_PORT" \
  --build-arg VITE_SOCIAL_WS_URL="ws://127.0.0.1:9/ws/social" \
  --build-arg VITE_SYNC_WS_URL="ws://127.0.0.1:9/ws/sync" \
  "$root/apps/web" >/dev/null

docker rm -f "$prefix-redis" "$prefix-core" "$prefix-web" "$prefix-coturn" >/dev/null 2>&1 || true

docker run -d --name "$prefix-redis" --network host redis:7-alpine \
  redis-server --port "$REDIS_PORT" --save '' --appendonly no >/dev/null
started+=("$prefix-redis")

if ss -lun "( sport = :3478 )" | grep -q 3478; then
  echo "==> uso el coturn que ya escucha en :3478 (debe usar TURN_SECRET=$TURN_SECRET)"
else
  docker run -d --name "$prefix-coturn" --network host coturn/coturn:4.6.3 \
    --listening-port=3478 --min-port=49160 --max-port=49200 --use-auth-secret \
    --static-auth-secret="$TURN_SECRET" --realm=tint.local --fingerprint --no-cli --no-tls --no-dtls \
    --log-file=stdout >/dev/null
  started+=("$prefix-coturn")
fi

docker run -d --name "$prefix-core" --network host \
  -e STREAM_CORE_ADDR="0.0.0.0:$STREAM_PORT" -e STREAM_UDP_PORT="$STREAM_UDP" \
  -e STREAM_PUBLIC_IP="$PUBLIC_IP" -e STREAM_HOST_GRACE_S="$GRACE_S" \
  -e REDIS_URL="redis://127.0.0.1:$REDIS_PORT" -e JWT_SECRET="$JWT_SECRET" \
  -e ALLOWED_ORIGINS="localhost:$WEB_PORT,127.0.0.1:$WEB_PORT" \
  -e IDENTITY_API_URL="http://127.0.0.1:$STUB_PORT" -e INTERNAL_API_SECRET="$INTERNAL_API_SECRET" \
  -e STUN_URLS="stun:localhost:3478" \
  -e TURN_URLS="turn:localhost:3478?transport=udp,turn:localhost:3478?transport=tcp" \
  -e TURN_SECRET="$TURN_SECRET" tint-stream-core:e2e >/dev/null
started+=("$prefix-core")

docker run -d --name "$prefix-web" -p "$WEB_PORT:80" tint-web:e2e-stream >/dev/null
started+=("$prefix-web")

for url in "http://127.0.0.1:$STREAM_PORT/healthz" "http://127.0.0.1:$WEB_PORT/"; do
  for _ in $(seq 1 50); do curl -fs "$url" >/dev/null 2>&1 && break; sleep 0.2; done
  curl -fs "$url" >/dev/null || { docker logs --tail 50 "$prefix-core"; exit 1; }
done
echo "==> stream-core :$STREAM_PORT (candidato $PUBLIC_IP:$STREAM_UDP, gracia ${GRACE_S} s) · web :$WEB_PORT"

status=0
for mode in ${MODES:-normal relay}; do
  docker run --rm --network host --entrypoint node \
    -e JWT_SECRET="$JWT_SECRET" -e INTERNAL_API_SECRET="$INTERNAL_API_SECRET" \
    -e WEB_URL="http://localhost:$WEB_PORT" -e STREAM_HTTP="http://127.0.0.1:$STREAM_PORT" \
    -e STUB_PORT="$STUB_PORT" -e GRACE_S="$GRACE_S" -e TTFF_ROUNDS="${TTFF_ROUNDS:-5}" -e G2G_MS="${G2G_MS:-15000}" -e DIAG="${DIAG:-}" \
    -v "$here:/e2e:ro" minlag/mermaid-cli:11.4.2 /e2e/stream-e2e.cjs "$mode" || status=1
done
if [[ "$status" != 0 ]]; then
  echo "==> últimas líneas de stream-core"
  docker logs --tail 40 "$prefix-core" 2>&1 || true
fi
exit "$status"
