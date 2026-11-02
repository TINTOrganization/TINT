#!/usr/bin/env bash
# Spike S2 (dominio-transmision §7.1 y §9): 1 publicador sintético + VIEWERS bots WHEP contra stream-core.
# Usa el stream-core que esté arriba en :8086; si no hay, levanta redis + stream-core con compose y al
# final baja solo lo que levantó (y borra el .env temporal si lo creó).
#
#   make load-stream                          # 50 viewers, 30 s
#   VIEWERS=10 DURATION=10 make load-stream   # humo (CI)
#
# Falla si TTFF p95 ≥ 2 s, hay fallos, el viewer N+1 no recibe 409 ROOM_FULL o el hilo más cargado de
# stream-core supera el 70 % de un núcleo.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
SVC="$ROOT/services/stream-core"
cd "$ROOT"

VIEWERS="${VIEWERS:-50}"
DURATION="${DURATION:-30}"
URL="${STREAM_URL:-http://127.0.0.1:8086}"
CONTAINER="${STREAM_CONTAINER:-tint-stream-core}"
DEV_IMAGE="${STREAM_DEV:-tint-stream-dev}"
MUX_MAX_PCT="${MUX_MAX_PCT:-70}"

created_env=0
started=()
cleanup() {
  if [ "${#started[@]}" -gt 0 ]; then
    echo "==> bajando ${started[*]}"
    docker compose rm -sf "${started[@]}" >/dev/null 2>&1 || true
    docker compose rm -f env-check >/dev/null 2>&1 || true
  fi
  if [ "$created_env" = 1 ]; then rm -f "$ROOT/.env"; fi
  rm -f "${STATS_FILE:-}" "${TOP_FILE:-}"
}
trap cleanup EXIT

if ! curl -fs "$URL/healthz" >/dev/null 2>&1; then
  if [ ! -f "$ROOT/.env" ]; then
    cp "$ROOT/.env.example" "$ROOT/.env"
    created_env=1
  fi
  for s in redis stream-core; do
    if [ -z "$(docker compose ps -q --status running "$s" 2>/dev/null)" ]; then started+=("$s"); fi
  done
  echo "==> docker compose up -d --build redis stream-core"
  docker compose up -d --build redis stream-core
  for _ in $(seq 1 50); do curl -fs "$URL/healthz" >/dev/null 2>&1 && break; sleep 0.2; done
  curl -fs "$URL/healthz" >/dev/null || { docker compose logs --tail 50 stream-core; exit 1; }
fi

JWT_SECRET="${JWT_SECRET:-$(grep -E '^JWT_SECRET=' "$ROOT/.env" 2>/dev/null | cut -d= -f2- || true)}"
JWT_SECRET="${JWT_SECRET:-dev-secret-change-in-prod}"

echo "==> compilando stream_core_loadbot (imagen dev)"
docker build -q --target dev -t "$DEV_IMAGE" "$SVC" >/dev/null
docker run --rm --user "$(id -u):$(id -g)" -v "$SVC:/src" -w /src "$DEV_IMAGE" bash -c \
  'cmake -S . -B build-load -G Ninja -DCMAKE_BUILD_TYPE=Release -DSTREAM_BUILD_TESTS=OFF -DSTREAM_BUILD_LOADBOT=ON >/dev/null &&
   cmake --build build-load --target stream_core_loadbot >/dev/null'

# CPU del contenedor (docker stats, % de un núcleo) y del hilo más cargado (top -H sobre su PID).
STATS_FILE="$(mktemp)"
TOP_FILE="$(mktemp)"
pid="$(docker inspect -f '{{.State.Pid}}' "$CONTAINER" 2>/dev/null || echo 0)"
(
  sleep 5  # tras la entrada de los viewers
  end=$((SECONDS + DURATION - 6))
  while [ "$SECONDS" -lt "$end" ]; do
    docker stats --no-stream --format '{{.CPUPerc}}' "$CONTAINER" 2>/dev/null | tr -d '%' >>"$STATS_FILE" || true
    sleep 1
  done
) &
stats_pid=$!
(
  sleep 8
  if [ "$pid" != 0 ] && command -v top >/dev/null; then
    top -H -b -n 2 -d $((DURATION > 20 ? DURATION - 12 : 5)) -p "$pid" >"$TOP_FILE" 2>/dev/null || true
  fi
) &
top_pid=$!

set +e
docker run --rm --user "$(id -u):$(id -g)" --network host -e JWT_SECRET="$JWT_SECRET" -v "$SVC:/src" -w /src \
  "$DEV_IMAGE" ./build-load/stream_core_loadbot --url "$URL" --viewers "$VIEWERS" --duration "$DURATION"
bot_status=$?
set -e
wait "$stats_pid" "$top_pid" 2>/dev/null || true

status=$bot_status
if [ -s "$STATS_FILE" ]; then
  awk '{s+=$1; if($1>m)m=$1; n++} END {printf "CPU del contenedor (docker stats): media %.1f %%, máx %.1f %% (de un núcleo, %d muestras)\n", s/n, m, n}' "$STATS_FILE"
fi
if [ -s "$TOP_FILE" ]; then
  # Segunda iteración de top: % de CPU por hilo durante el régimen estable.
  thread_line="$(awk '/^top -/{it++} it==2 && $1 ~ /^[0-9]+$/ {print $9, $12}' "$TOP_FILE" | sort -rn | head -1)"
  thread_pct="${thread_line%% *}"
  echo "Hilo más cargado de stream-core: ${thread_pct:-n/d} % de un núcleo (${thread_line#* }; umbral < ${MUX_MAX_PCT} %)"
  if [ -n "$thread_pct" ] && awk -v p="$thread_pct" -v m="$MUX_MAX_PCT" 'BEGIN{exit !(p>=m)}'; then
    echo "FALLA: el hilo más cargado supera ${MUX_MAX_PCT} %"
    status=1
  fi
else
  echo "Hilo más cargado: n/d (sin top o sin PID del contenedor)"
fi
exit "$status"
