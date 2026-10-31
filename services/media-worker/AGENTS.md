# 🤖 AGENT Guidelines — Domain: Media Worker (`services/media-worker`)

## Contexto & Responsabilidad

Eres el agente responsable del procesamiento multimedia asíncrono de **TINT**. Operas en Python y manejas los binarios de FFmpeg/ffprobe para validar vídeos y extraer paletas de color Ambilight.

Cómo funciona el servicio por dentro (consumo de `media:uploads`, pipeline, Ambilight, calidades y fallos): [README.md](README.md).

## Stack Técnico

- Python 3.11
- Redis Streams (`redis==5.2.1`) solo en el disparador y en la publicación de analítica; el núcleo no depende de Redis
- FFmpeg / ffprobe (instalados en la imagen Docker)
- MinIO (Blob Storage) y PostgreSQL (estado del vídeo)
- pytest + pytest-cov, ruff

## Responsabilidades

- Inspección de vídeos subidos (`src/media_worker/probe.py`).
- Normalización a MP4 H.264 + AAC (`src/media_worker/normalize.py`).
- Extracción de paleta Ambilight por bordes (`src/media_worker/ambilight.py`).
- Calidades reducidas 720p/360p del vídeo normalizado (`src/media_worker/renditions.py`).
- Preprocesamiento del vídeo recibido (validación, normalización y Ambilight) antes de publicarlo en el bucket.
- Transición de estado del vídeo y publicación de artefactos en el bucket.
- Disparador: consumir `media:uploads` y procesar el original de `incoming/` (`consumer.py`, `jobs.py`, `__main__.py`).
- Publicar `media_processed` en `analytics:events` al terminar cada vídeo (`events.py`, emitido desde `jobs.py`).

## Límites de Dominio

- ❌ No sirvas vídeo ni gestiones salas o sockets (→ `sync-core` / `social-core`).
- ❌ No calcules KPIs ni analítica (→ `services/analytics`); solo publicas el evento `media_processed`.
- ❌ Nunca ejecutes FFmpeg real en las pruebas unitarias: inyecta/mockea el `runner`.

## Modelo de Datos Involucrado

| Entidad | Almacén | Campos clave |
| :--- | :--- | :--- |
| `videos` | PostgreSQL | `id`, `storage_key` (lo escribe el worker al publicar), `duration_ms`, `status` (`processing` → `ready` \| `failed`), `renditions` (jsonb, alturas publicadas en orden descendente, p. ej. `[720,360]`; `[]` si no hay), `updated_at` |
| `incoming/{video_id}/original.*` | MinIO (`tint-media`) | Original subido por el navegador (staging; lo lee el worker, caduca a los 2 días) |
| `{video_id}/source.mp4` | MinIO (`tint-media`) | Vídeo normalizado (MP4 H.264 + AAC, `+faststart`): re-codificado o, si el original ya cumple, remuxado. Nunca el original sin preprocesar |
| `media:uploads` | Redis Stream (grupo `media-workers`) | Evento `{video_id}` que publica identity-api al confirmar la subida |
| `{video_id}/ambilight.json` | MinIO (`tint-media`) | `[{ "t_ms", "top", "bottom", "left", "right" }]` colores hex a 1 FPS |
| `{video_id}/{720,360}p.mp4` | MinIO (`tint-media`) | Calidades reducidas (MP4 H.264 + AAC, `scale=-2:H`), solo las de altura estrictamente menor que la del original |
| `users` | PostgreSQL (solo lectura) | `provider_sub` de `videos.uploaded_by` (`LEFT JOIN` en `GET_VIDEO_SQL`), para el `user_id` de analítica |
| `analytics:events` | Redis Stream (`XADD MAXLEN ~ 100000`) | `media_processed`: `event_id`, `type`, `source=media-worker`, `occurred_at`, `received_at`, `media_id`, `status` (`ready`\|`failed`), `duration_ms` (vacío si `failed`), `processing_ms`, `user_id` (vacío si no hay dueño). Sin `room_id` ni PII |

## Reglas de Dominio

1. **Inspección de Archivos:** Usa `ffprobe` para obtener la duración exacta en ms. Si el archivo está corrupto, actualiza el estado en SQL a `failed`.
2. **Extracción Ambilight:** Analiza una franja del 10% en cada uno de los 4 bordes del fotograma a 1 FPS. Genera el archivo `ambilight.json` y súbelo al Blob Storage.
3. **Normalización (`normalize.py`):** el original nunca se publica tal cual.
   - **Re-codificación** (caso general): `libx264 -preset veryfast -crf 23 -pix_fmt yuv420p`, keyframe cada 2 s (`-force_key_frames expr:gte(t,n_forced*2) -sc_threshold 0`), tope VBV `-maxrate 8000k -bufsize 16000k`, `-profile:v high` sin nivel fijo (conserva la resolución original, que puede ser 4K o 60 fps); audio `aac 128k -ac 2 -ar 48000`; `-movflags +faststart`.
   - **Remux** (`-c copy -movflags +faststart`): solo si el original es MP4 real (ni extensión `.mov` ni major brand `qt  `), H.264 `yuv420p` + AAC (o sin audio) y bitrate total conocido ≤ 12 Mbps (`MAX_REMUX_BITRATE`). Bitrate desconocido → re-codificar. Si el remux falla se re-codifica. El remux no corrige el intervalo de keyframes del original (compromiso aceptado).
4. **Calidades:** Tras publicar `source.mp4` y `ambilight.json`, genera `720p`/`360p` (solo alturas menores que el original). Mismos parámetros que la re-codificación salvo perfil y tope: 720p `high` 4.1 con `-maxrate 3000k -bufsize 6000k`, 360p `main` 3.1 con `-maxrate 1000k -bufsize 2000k`. Son opcionales: una que falle se omite con un aviso y **no** marca `failed`.
5. **Cabeceras al publicar (`storage.py`):** los MP4 se suben con `ContentType: video/mp4`; MP4 y `ambilight.json` con `CacheControl: public, max-age=86400`. Sin `immutable`: reprocesar sobrescribe las mismas claves.
6. **Persistencia:** Al finalizar con éxito, marca el vídeo como `ready` y escribe en `renditions` las calidades publicadas.
7. **Idempotencia:** Reprocesar el mismo vídeo debe producir el mismo resultado sin duplicar artefactos.
8. **Analítica best-effort:** `media_processed` se publica en cada resultado terminal (`ready`/`failed`, incluido el original ausente y la extensión no admitida) desde el adaptador (`jobs.handle_upload`, `publish` inyectado). Un fallo al publicar solo se registra: nunca cambia el resultado ni impide el `XACK`. No se publica para duplicados, eventos descartados ni fallos de infraestructura que dejan el mensaje pendiente.
9. **TDD:** Escribe primero pruebas unitarias con `pytest` mockeando ejecuciones de FFmpeg. Cobertura obligatoria **≥ 85 %**.

## Comandos

```bash
pip install -r requirements-dev.txt
ruff check . && ruff format --check .
pytest --cov=src --cov-fail-under=85
```
