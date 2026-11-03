#!/usr/bin/env bash
# E2E del sistema completo con Chromium real por la entrada única https://localhost (gateway).
# Necesita el stack levantado con el Firebase Auth Emulator (`make up`: desarrollo, ADR 0024).
# Usa la imagen minlag/mermaid-cli (Chromium + Puppeteer, la misma que valida los diagramas).
#   make e2e-system                 # watch y live
#   MODES=live make e2e-system      # solo uno
#   OUT=/tmp/capturas make e2e-system   # guarda capturas de cada paso
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
media="$(mktemp -d)"
trap 'rm -rf "$media"' EXIT

# Clip de prueba de 10 min (barras de color + tono) generado con el ffmpeg del media-worker.
docker exec tint-media-worker ffmpeg -loglevel error -y \
  -f lavfi -i testsrc2=size=640x360:rate=15 -f lavfi -i sine=frequency=440 -t 600 \
  -c:v libx264 -preset ultrafast -crf 35 -pix_fmt yuv420p -c:a aac -b:a 32k -shortest /tmp/e2e-clip.mp4
docker cp -q tint-media-worker:/tmp/e2e-clip.mp4 "$media/clip.mp4"
docker exec tint-media-worker rm -f /tmp/e2e-clip.mp4
chmod 755 "$media" && chmod 644 "$media/clip.mp4"

out_mount=()
if [[ -n "${OUT:-}" ]]; then
  mkdir -p "$OUT" && chmod 777 "$OUT"
  out_mount=(-v "$OUT:/e2e-out" -e OUT=/e2e-out)
fi

status=0
for mode in ${MODES:-watch live}; do
  docker run --rm --network host --entrypoint node \
    -e BASE="${BASE:-https://localhost}" \
    -v "$here:/e2e:ro" -v "$media:/e2e-media:ro" "${out_mount[@]}" \
    minlag/mermaid-cli:11.4.2 /e2e/system-e2e.cjs "$mode" || status=1
done
exit "$status"
