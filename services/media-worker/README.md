# media-worker

Worker asíncrono de **procesamiento de vídeo** de TINT (Python 3.11 + FFmpeg/ffprobe). Recibe por Redis Streams los vídeos que el Host subió directo al bucket, los valida, los normaliza a MP4 H.264 + AAC, precalcula el **Ambilight**, genera las calidades 720p/360p y deja la fila de `videos` en `ready` o `failed`. Requiere `ffprobe` y `ffmpeg` en el `PATH` (la imagen Docker los instala).

Este README explica **cómo funciona por dentro**. Las reglas del dominio están en [AGENTS.md](AGENTS.md) y el estado, las decisiones y lo pendiente en [STATUS.md](STATUS.md). Para ver dónde encaja en el flujo completo de TINT, lee también [docs/Flujo general de TINT.pdf](docs/Flujo%20general%20de%20TINT.pdf).

## Índice

1. [Propósito y responsabilidades](#1-propósito-y-responsabilidades)
2. [Arquitectura interna](#2-arquitectura-interna)
3. [Cómo funciona, paso a paso](#3-cómo-funciona-paso-a-paso)
4. [Estado y datos](#4-estado-y-datos)
5. [Configuración](#5-configuración)
6. [Ejecutar y probar](#6-ejecutar-y-probar)
7. [Observabilidad y errores](#7-observabilidad-y-errores)
8. [Decisiones de arquitectura](#8-decisiones-de-arquitectura)
9. [Enlaces](#9-enlaces)

---

## 1. Propósito y responsabilidades

| Hace | Dónde |
| :--- | :--- |
| Consumir `media:uploads` con el grupo `media-workers` y confirmar (`XACK`) cada evento | `consumer.py` |
| Descargar el original de `incoming/{id}/original.*` y decidir si se procesa | `jobs.py` |
| Inspeccionar el archivo con `ffprobe` (duración en ms y altura) | `probe.py` |
| Normalizar a MP4 H.264 `yuv420p` + AAC con `+faststart` (o publicarlo tal cual si ya lo es) | `normalize.py` |
| Calcular la paleta **Ambilight** a 1 FPS y publicarla como `ambilight.json` | `ambilight.py` |
| Generar las calidades `720p` y `360p` (solo las menores que el original) | `renditions.py` |
| Publicar los artefactos en MinIO con claves deterministas | `storage.py` |
| Actualizar `videos` (`status`, `duration_ms`, `storage_key`, `renditions`, `updated_at`) | `repository.py` |
| Publicar `media_processed` en `analytics:events` (best-effort) | `events.py` |

**Lo que NO hace:**

- No crea filas en `videos` ni cambia su esquema: la tabla es de `identity-api`, que la crea al reservar la subida.
- No firma URLs, no sirve vídeo ni autentica a nadie: eso lo hace `identity-api`, y el navegador descarga directo de MinIO.
- No gestiona salas, sockets ni reproducción (→ `sync-core` / `social-core`).
- No calcula KPIs (→ `analytics`): solo publica el evento `media_processed`.
- No borra el original de `incoming/`: lo borra la regla de ciclo de vida del bucket a los 2 días, para no cortar a quien ya lo está reproduciendo mientras se procesa.

## 2. Arquitectura interna

El código está dividido en un **núcleo** que no conoce Redis (`pipeline`, `probe`, `normalize`, `ambilight`, `renditions`, `storage`, `repository`, `config`) y un **disparador** que sí (`__main__`, `consumer`, `jobs`, `events`). Así el núcleo se puede invocar y probar sin colas.

```mermaid
flowchart LR
    subgraph TRIG["Disparador"]
        MAIN["__main__.py<br/>TriggerSettings, señales"]
        CONS["consumer.py<br/>StreamConsumer"]
        JOBS["jobs.py<br/>handle_upload"]
        EVT["events.py<br/>media_processed"]
    end

    subgraph CORE["Núcleo (sin Redis)"]
        PIPE["pipeline.py<br/>process_video"]
        PROBE["probe.py<br/>ffprobe"]
        NORM["normalize.py<br/>FFmpeg H.264 + AAC"]
        AMB["ambilight.py<br/>bordes a 1 FPS"]
        REND["renditions.py<br/>720p / 360p"]
        STO["storage.py<br/>S3BlobStore"]
        REPO["repository.py<br/>VideoRepository"]
        CFG["config.py<br/>Settings"]
    end

    MAIN --> CONS
    MAIN --> CFG
    CONS --> JOBS
    JOBS --> PIPE
    JOBS --> EVT
    JOBS --> STO
    JOBS --> REPO
    PIPE --> PROBE
    PIPE --> NORM
    PIPE --> AMB
    PIPE --> REND
    PIPE --> STO
    PIPE --> REPO
    REND --> STO

    CONS -- "XREADGROUP · XACK media:uploads" --> RD[("Redis")]
    EVT -- "XADD analytics:events" --> RD
    STO -- "download · upload · put_object" --> MI[("MinIO")]
    REPO -- "SELECT · UPDATE videos" --> PG[("PostgreSQL")]
    PROBE -. "subprocess" .-> FF["ffprobe / ffmpeg"]
    NORM -. "subprocess" .-> FF
    AMB -. "subprocess (pipe rgb24)" .-> FF
    REND -. "subprocess" .-> FF
```

| Módulo | Responsabilidad | Archivo |
| :--- | :--- | :--- |
| Arranque | Lee `Settings` y `TriggerSettings`, conecta Redis, S3 y PostgreSQL (`autocommit`), instala SIGTERM/SIGINT y lanza el consumidor | `src/media_worker/__main__.py` |
| Configuración del núcleo | `DATABASE_URL` y credenciales S3 obligatorias; sin secretos por defecto (`ConfigError` → salida 2) | `src/media_worker/config.py` |
| Consumidor | `XGROUP CREATE ... MKSTREAM`, recupera pendientes, `XREADGROUP` en lotes de 10, `XACK` tras procesar, reintento cada 5 s | `src/media_worker/consumer.py` |
| Adaptador de la subida | Filtra eventos que no procesan nada, comprueba la extensión antes de descargar, descarga a un temporal, llama al pipeline y publica la analítica | `src/media_worker/jobs.py` |
| Pipeline | Orquesta `processing → ready \| failed`; publica solo si todo el preprocesamiento salió bien | `src/media_worker/pipeline.py` |
| Inspección | Una sola llamada a `ffprobe` (`format=duration:stream=height` del primer vídeo) | `src/media_worker/probe.py` |
| Normalización | `is_normalized` (MP4 + H.264 `yuv420p` + AAC o sin audio) y re-codificación con FFmpeg | `src/media_worker/normalize.py` |
| Ambilight | Lee fotogramas `rgb24` de 160×90 por un pipe y promedia las cuatro franjas de borde | `src/media_worker/ambilight.py` |
| Calidades | Re-codifica `scale=-2:H` para cada altura de `(720, 360)` menor que el original | `src/media_worker/renditions.py` |
| Almacenamiento | Claves deterministas y acceso a S3/MinIO (`boto3`); traduce el 404 a `BlobNotFoundError` | `src/media_worker/storage.py` |
| Repositorio | SQL de la tabla `videos` (y `users.provider_sub` por `LEFT JOIN`) | `src/media_worker/repository.py` |
| Analítica | Campos de `media_processed` y `XADD analytics:events MAXLEN ~ 100000` | `src/media_worker/events.py` |

## 3. Cómo funciona, paso a paso

### 3.1 Vista general

```mermaid
sequenceDiagram
    autonumber
    actor H as Host (navegador)
    participant API as identity-api
    participant MI as MinIO
    participant R as Redis
    participant W as media-worker
    participant PG as PostgreSQL

    H->>MI: PUT incoming/{id}/original.ext (URL firmada)
    H->>API: POST .../uploads/{id}/complete
    API->>PG: videos.status = processing
    API->>R: XADD media:uploads * video_id {id}
    R-->>W: XREADGROUP media-workers
    W->>PG: SELECT status, storage_key, users.provider_sub
    W->>MI: download incoming/{id}/original.ext
    W->>W: ffprobe, normalizar, Ambilight
    W->>MI: {id}/source.mp4 y {id}/ambilight.json
    W->>W: calidades 720p y 360p
    W->>MI: {id}/720p.mp4, {id}/360p.mp4
    W->>PG: status ready, duration_ms, storage_key, renditions
    W->>R: XACK media:uploads
    W-)R: XADD analytics:events media_processed
    H->>API: GET /rooms/:id/playback
    API-->>H: URLs firmadas de source, calidades y ambilight.json
```

### 3.2 Consumo de `media:uploads` (grupo de consumidores y reintentos)

identity-api publica `XADD media:uploads * video_id <uuid>` al confirmar una subida. `StreamConsumer.run`:

1. **Crea el grupo** `media-workers` desde el principio del stream (`id="0"`, `mkstream=True`); si ya existe (`BUSYGROUP`) sigue.
2. **Recupera sus pendientes**: lee con `XREADGROUP ... 0` los mensajes entregados a este consumidor que nunca se confirmaron (por ejemplo, si el contenedor se reinició a mitad de un vídeo). Por eso `MEDIA_WORKER_CONSUMER` debe ser un nombre **estable** por réplica.
3. **Bucle normal**: `XREADGROUP ... >` con `COUNT 10` y `BLOCK 5000` ms.
4. Por cada mensaje: si `video_id` falta o no es un id plano (`[A-Za-z0-9][A-Za-z0-9_-]{0,127}`) se registra un aviso y se descarta; si no, se llama a `handle_upload`. En los dos casos se hace **`XACK`**.
5. Si el handler **lanza** (fallo de PostgreSQL o MinIO) el mensaje **no** se confirma: el consumidor registra la excepción, espera `RETRY_DELAY_S` (5 s) y vuelve a procesar sus pendientes. No avanza a mensajes nuevos hasta que los pendientes salen bien, y nunca se cae por un fallo de infraestructura.

```mermaid
stateDiagram-v2
    direction LR
    [*] --> Recuperar: arranque
    Recuperar --> Leer: pendientes procesados
    Leer --> Leer: mensaje procesado y XACK
    Leer --> Esperar: el handler lanza
    Esperar --> Reintentar: 5 s
    Reintentar --> Leer: pendientes OK
    Reintentar --> Esperar: vuelve a fallar
    Leer --> [*]: SIGTERM o SIGINT
```

`handle_upload` (en `jobs.py`) decide qué hacer con un `video_id` válido:

| Situación | Resultado | ¿`XACK`? | ¿Analítica? |
| :--- | :--- | :--- | :--- |
| `video_id` no es UUID (evitaría un error de PostgreSQL en cada reintento) | Se descarta | Sí | No |
| No hay fila en `videos` | Se descarta | Sí | No |
| Ya está `ready` y `storage_key` no empieza por `incoming/` | Evento duplicado: no se reprocesa | Sí | No |
| La extensión de la clave no es `.mp4`, `.mov`, `.mkv` ni `.webm` | `failed` **sin descargar** el archivo | Sí | Sí (`failed`) |
| El original no está en el bucket | `failed` | Sí | Sí (`failed`) |
| Se procesa | `ready` o `failed` según el pipeline | Sí | Sí |
| PostgreSQL o MinIO fallan | La excepción se propaga | **No** (queda pendiente) | No |

> identity-api acepta también `.m4v` y `.ogv` al firmar el PUT; el worker no los admite y los deja en `failed` sin descargarlos (ver "Siguiente prototipo" en [STATUS.md](STATUS.md)).

### 3.3 Pipeline (`pipeline.process_video`)

El vídeo **nunca se publica sin preprocesar**: nada llega a `{id}/source.mp4` hasta pasar validación, normalización y Ambilight.

```mermaid
flowchart TD
    A["process_video(video_id, original)"] --> B{"video_id plano y<br/>extensión admitida?"}
    B -- "no" --> X1["InvalidVideoIdError /<br/>UnsupportedFormatError<br/>(sin tocar SQL ni bucket)"]
    B -- "sí" --> C["UPDATE videos SET status = processing"]
    C -- "fila inexistente" --> X2["VideoNotFoundError"]
    C --> D["ffprobe: duración ms y altura"]
    D -- "corrupto, duración no positiva" --> F["status = failed"]
    D --> E{"is_normalized?<br/>MP4 + H.264 yuv420p + AAC"}
    E -- "sí" --> G["se usa el original tal cual"]
    E -- "no" --> N["FFmpeg: libx264 veryfast crf 23,<br/>aac 128k, +faststart"]
    N -- "falla o timeout 4 h" --> F
    G --> AM["Ambilight sobre el normalizado"]
    N --> AM
    AM -- "falla o timeout 1 h" --> F
    AM --> P["upload {id}/source.mp4<br/>put_json {id}/ambilight.json"]
    P --> R["calidades 720p / 360p<br/>(una que falle se omite)"]
    R --> OK["UPDATE status = ready,<br/>duration_ms, storage_key, renditions"]
```

1. **Validación de entrada.** `video_id` debe ser un id plano (forma parte de las claves del bucket) y la extensión una de `SUPPORTED_EXTENSIONS`. Si no, lanza antes de tocar SQL o el bucket.
2. **`processing`.** `UPDATE videos SET status = 'processing' ... RETURNING id`; si no devuelve fila, `VideoNotFoundError` (el worker no crea filas).
3. **ffprobe.** Una sola llamada (`-select_streams v:0 -show_entries format=duration:stream=height -of json`, timeout 30 s). La duración se redondea a ms y debe ser finita y positiva. La altura solo decide las calidades: si falta, el vídeo **no** falla, simplemente no se generan calidades.
4. **Normalización.** Si `ffprobe` dice que el original ya es MP4 con primer vídeo H.264 `yuv420p` y primer audio AAC (o sin audio), **no se re-codifica**. Ante cualquier duda (ffprobe falla, salida ilegible) se re-codifica: primer vídeo y primer audio opcional (`-map 0:v:0 -map 0:a:0?`), `libx264 -preset veryfast -crf 23 -pix_fmt yuv420p`, `aac -b:a 128k`, `-movflags +faststart`, en un directorio temporal que se borra siempre. Timeout de 4 h (`normalize.DEFAULT_TIMEOUT_S`), tras el cual se mata FFmpeg.
5. **Ambilight** sobre el vídeo normalizado (ver §3.4).
6. **Publicación.** `upload_file` a `{id}/source.mp4` y `put_json` a `{id}/ambilight.json`. Todo se publica **antes** de marcar `ready`: `ready` implica que existen el vídeo y su Ambilight.
7. **Calidades** (ver §3.5).
8. **`ready`.** `UPDATE videos SET status = 'ready', duration_ms, storage_key = '{id}/source.mp4', renditions = '[720,360]'::jsonb, updated_at = now()`.

Desde que identity-api lo confirma hasta que el worker lo deja `ready`, el navegador reproduce el original de `incoming/`. Al reescribir `storage_key`, el playback de identity-api pasa a firmar `{id}/source.mp4`.

### 3.4 Ambilight (`ambilight.json`)

El Ambilight es la paleta de colores de los **cuatro bordes** del vídeo, muestreada a 1 FPS, que la web usa para iluminar el fondo del reproductor. Se precalcula una vez aquí para que ningún navegador tenga que leer píxeles del vídeo.

**Formato.** Un array JSON compacto (`separators=(",", ":")`, `Content-Type: application/json`), una entrada por segundo:

```json
[
  {"t_ms": 0,    "top": "#1a2b3c", "bottom": "#0f0f0f", "left": "#203040", "right": "#1d2a36"},
  {"t_ms": 1000, "top": "#1b2c3d", "bottom": "#101010", "left": "#213141", "right": "#1e2b37"}
]
```

- `t_ms`: instante del vídeo en ms (`0, 1000, 2000, ...` menores que `duration_ms`).
- `top`, `bottom`, `left`, `right`: color promedio `#rrggbb` de cada franja.

**Cálculo.**

1. FFmpeg decodifica el vídeo normalizado y emite por `stdout` un fotograma por segundo reducido a **160×90** en RGB crudo: `-vf fps=1,scale=160:90 -f rawvideo -pix_fmt rgb24 pipe:1`. Cada fotograma ocupa 160 × 90 × 3 = 43 200 bytes.
2. Las franjas son el **10 %** de cada borde (`EDGE_RATIO = 0.10`): `top` y `bottom` son 9 filas de ancho completo; `left` y `right`, 16 columnas de alto completo (las esquinas cuentan en las dos franjas que las tocan).
3. Para cada franja se suman los canales R, G y B de todos sus píxeles y se divide por el número de píxeles (redondeo al entero más cercano). Las sumas se hacen sobre cortes de `bytes` (`itemgetter` + cortes de paso 3), sin bucles por píxel en Python y sin numpy ni Pillow.
4. Se procesa **fotograma a fotograma** en streaming: la memoria no crece con la duración del vídeo. `stderr` se drena en un hilo aparte para que FFmpeg no se bloquee, y un temporizador mata FFmpeg si supera `DEFAULT_EXTRACT_TIMEOUT_S` (1 h).
5. Los instantes se emparejan con los fotogramas recibidos; si FFmpeg emite uno de más se descarta. Si FFmpeg termina con error, excede el tiempo, entrega un fotograma truncado o no produce ninguno, se lanza `AmbilightError` y el vídeo queda en `failed`.

Rendimiento medido con FFmpeg real en [STATUS.md](STATUS.md#rendimiento-del-ambilight-medido-con-ffmpeg-real): el coste es decodificar el vídeo completo.

### 3.5 Calidades 720p y 360p

Tras publicar `source.mp4` y `ambilight.json`, `generate_renditions` toma las alturas de `RENDITION_HEIGHTS = (720, 360)` **estrictamente menores** que la del original (un original de 720p solo produce 360p; uno sin altura conocida, ninguna). Para cada una:

- Re-codifica desde el **normalizado** con `-vf scale=-2:H` (ancho par proporcional), `libx264 -preset veryfast -crf 23 -pix_fmt yuv420p`, `aac 128k` y `+faststart`, en un temporal, con el mismo timeout de 4 h.
- La sube a `{id}/{H}p.mp4`.
- Si FFmpeg falla o se pasa del tiempo, la calidad se **omite** con un aviso y el vídeo **no** pasa a `failed`. Un fallo del bucket, en cambio, se propaga para reintentar.

Las alturas publicadas se guardan en `videos.renditions` en orden descendente (`[720,360]`, `[360]` o `[]`). identity-api solo ofrece como calidad lo que aparece ahí.

### 3.6 Manejo de fallos

| Tipo de fallo | Ejemplos | Qué pasa |
| :--- | :--- | :--- |
| **Del vídeo** (reintentar no lo arregla) | Archivo corrupto, duración no positiva, FFmpeg falla o excede el tiempo en normalización o Ambilight, extensión no admitida, original ausente | `UPDATE videos SET status = 'failed'`, no se publica nada nuevo, `XACK` y `media_processed` con `status=failed`. El motivo solo va al log |
| **De una calidad** | FFmpeg no logra generar 720p o 360p | Se omite esa calidad; el vídeo sigue hacia `ready` |
| **De infraestructura** | PostgreSQL o MinIO caídos, error S3 distinto de 404 | La excepción se propaga **sin** marcar `failed`; el mensaje queda pendiente y se reintenta cada 5 s |
| **Evento inválido** | Sin `video_id`, id no plano o no UUID, fila inexistente | Se descarta con un aviso y `XACK` |

**Idempotencia.** Las claves son deterministas (`{id}/source.mp4`, `{id}/ambilight.json`, `{id}/{H}p.mp4`) y se sobrescriben; los `UPDATE` son idempotentes. Reprocesar el mismo vídeo da el mismo resultado sin duplicar artefactos.

### 3.7 Eventos de analítica (`media_processed`)

`jobs.handle_upload` publica un evento por cada resultado **terminal** (`ready` o `failed`) con el `publish` inyectado por `__main__` (`events.redis_publisher`, que usa el mismo cliente Redis del consumidor):

```text
XADD analytics:events MAXLEN ~ 100000 *
  event_id      <uuid v4>
  type          media_processed
  source        media-worker
  occurred_at   2026-10-11T04:29:49.368Z
  received_at   2026-10-11T04:29:49.368Z
  media_id      <video_id>
  status        ready | failed
  duration_ms   <ms, vacío si failed>
  processing_ms <ms de proceso del worker, reloj monotónico>
  user_id       <users.provider_sub de quien subió el vídeo, vacío si no hay>
```

- No lleva `room_id` ni datos personales. `user_id` sale de `GET_VIDEO_SQL` con `LEFT JOIN users` (`uploaded_by` puede ser `NULL`).
- Es **best-effort**: si el `XADD` falla, solo se registra un aviso; el resultado no cambia y el `XACK` de `media:uploads` se hace igual.
- No se publica para duplicados, eventos descartados ni fallos de infraestructura. Contrato completo en [contrato-eventos-analitica.md](../../docs/contrato-eventos-analitica.md#media-worker).

## 4. Estado y datos

| Dato | Almacén | Escribe | Lee |
| :--- | :--- | :--- | :--- |
| `media:uploads` | Redis Stream (grupo `media-workers`) | identity-api (`XADD * video_id`) | media-worker (`XREADGROUP` / `XACK`) |
| `analytics:events` | Redis Stream (`MAXLEN ~ 100000`) | media-worker (`media_processed`) y otros servicios | analytics |
| `videos` | PostgreSQL (esquema de identity-api) | identity-api crea la fila (`pending` → `processing`); media-worker solo `UPDATE` de `status`, `duration_ms`, `storage_key`, `renditions` y `updated_at` | identity-api (playback, biblioteca), media-worker |
| `users.provider_sub` | PostgreSQL | identity-api | media-worker (solo lectura, para `user_id`) |
| `incoming/{id}/original.*` | MinIO `tint-media` | Navegador (PUT firmado) | media-worker; caduca a los 2 días (regla `incoming-expira` de `minio-init`) |
| `{id}/source.mp4` | MinIO | media-worker | Navegador (GET firmado por identity-api) |
| `{id}/ambilight.json` | MinIO | media-worker | Navegador (`ambilightUrl` del playback) |
| `{id}/720p.mp4`, `{id}/360p.mp4` | MinIO | media-worker | Navegador (`qualities` del playback) |

Estados de `videos.status` que toca el worker: `processing → ready | failed`. El estado `pending` (antes de confirmar la subida) es de identity-api.

SQL que ejecuta (`repository.py`, conexión psycopg en `autocommit`):

| Operación | SQL |
| :--- | :--- |
| `get_video` | `SELECT videos.status, videos.storage_key, users.provider_sub FROM videos LEFT JOIN users ON users.id = videos.uploaded_by WHERE videos.id = %s` |
| `start_processing` | `UPDATE videos SET status = 'processing', updated_at = now() WHERE id = %s RETURNING id` |
| `mark_ready` | `UPDATE videos SET status = 'ready', duration_ms, storage_key, renditions = %s::jsonb, updated_at = now() WHERE id = %s` |
| `mark_failed` | `UPDATE videos SET status = 'failed', updated_at = now() WHERE id = %s` |

## 5. Configuración

Núcleo (`config.Settings.from_env`):

| Variable | Obligatoria | Por defecto |
| :-- | :-- | :-- |
| `DATABASE_URL` | sí | — (p. ej. `postgresql://tint:tint@localhost:5432/tint`) |
| `S3_ACCESS_KEY` / `S3_SECRET_KEY` | sí | `MINIO_ROOT_USER` / `MINIO_ROOT_PASSWORD` si existen |
| `S3_ENDPOINT_URL` | no | `http://localhost:9000` |
| `MINIO_BUCKET` | no | `tint-media` |

Disparador (`__main__.TriggerSettings`, aparte porque el núcleo no conoce Redis):

| Variable | Por defecto |
| :-- | :-- |
| `REDIS_URL` | `redis://localhost:6379` |
| `MEDIA_WORKER_CONSUMER` | nombre del host (estable por réplica: al reiniciar recupera sus pendientes) |

En `docker-compose.yml` el servicio `media-worker` (`tint-media-worker`) recibe `DATABASE_URL`, `REDIS_URL`, `S3_ENDPOINT_URL=http://minio:9000`, las credenciales de MinIO del `.env` raíz, `MINIO_BUCKET` y `MEDIA_WORKER_CONSUMER=media-worker-1`. No expone puertos: solo consume el stream. Arranca cuando PostgreSQL y Redis están sanos y `minio-init` creó el bucket.

## 6. Ejecutar y probar

```bash
# Con docker compose (desde la raíz del monorepo)
cp .env.example .env
docker compose up -d            # incluye media-worker; las tablas las crean las migraciones de identity-api
docker compose logs -f media-worker

# En local, fuera de Docker (requiere ffmpeg y ffprobe en el PATH)
cd services/media-worker
pip install -r requirements-dev.txt
DATABASE_URL=postgresql://tint:tint@localhost:5432/tint \
S3_ACCESS_KEY=tintadmin S3_SECRET_KEY=tintadmin123 \
PYTHONPATH=src python -m media_worker
```

**Gate del dominio:**

```bash
ruff check . && ruff format --check .
pytest --cov=src --cov-fail-under=85
pytest -m stress          # solo las pruebas de estrés (MED-TEST-01)
pytest -m "not stress"    # ciclo rápido sin las pruebas de estrés
```

Las pruebas nunca ejecutan FFmpeg, S3, Redis ni PostgreSQL reales: se inyectan dobles (`tests/fakes.py`, y `runner`/`popen` en lugar de `subprocess`). El flujo con servicios reales se prueba desde identity-api: `WAIT_WORKER=1 npm run test:integration`.

El núcleo también se puede invocar directamente con `media_worker.pipeline.process_video(video_id, source, repo, blobs)`, donde `source` es la ruta local del archivo.

### Pruebas locales con películas reales (2026-10-11)

Se ejecutó `process_video` con `ffprobe`/`ffmpeg` reales, pero con repositorio y bucket en memoria (`tests/fakes.py`): no se tocó PostgreSQL ni MinIO y los resultados no se guardaron en disco.

| Archivo | Formato | Resultado | Binarios | Tiempo |
| :-- | :-- | :-- | :-- | :-- |
| `source.mp4` (2 h, 710 MB) | H.264 + AAC, mp4 | `ready`, publicado sin re-codificar | solo `ffprobe` | 153 s |
| `silence.mp4` (~2 h, 1,9 GB) | H.264 + AAC, mp4 | `ready`, publicado sin re-codificar | solo `ffprobe` | 305 s |
| `BadApple.webm` (3,6 min) | AV1 + Opus, webm | `ready`, re-codificado a MP4 | `ffprobe` + `ffmpeg` | 23 s |
| MKV de 30 s (copia de stream) | H.264 + AAC, mkv | `is_normalized` = `False` (se normalizaría) | solo la comprobación | — |

En lo ya normalizado el tiempo es casi todo Ambilight (7 149 y 7 112 muestras). La re-codificación completa de una película de 2 h y las calidades con FFmpeg real no se han medido todavía (ver Pendiente en [STATUS.md](STATUS.md)).

## 7. Observabilidad y errores

**Logs.** `logging` estándar a nivel `INFO` con el formato `%(asctime)s %(levelname)s %(name)s %(message)s` (salida sin búfer en Docker, `PYTHONUNBUFFERED=1`). Mensajes clave:

| Nivel | Mensaje | Significado |
| :--- | :--- | :--- |
| INFO | `media-worker consumiendo media:uploads` | Arranque correcto |
| INFO | `reprocesados N eventos pendientes` | Recuperó mensajes sin `XACK` al arrancar |
| INFO | `vídeo X listo (D ms, N muestras, calidades [...])` | Vídeo `ready` |
| INFO | `vídeo X ya está normalizado: se omite la re-codificación` | Se publicó el original tal cual |
| WARNING | `vídeo X marcado como failed: <motivo>` | Fallo del vídeo (normalización, Ambilight o ffprobe) |
| WARNING | `vídeo X: se omite la calidad Hp: <motivo>` | Calidad omitida |
| WARNING | `evento ... inválido, se descarta` / `... se descarta` | Evento descartado |
| ERROR (excepción) | `fallo procesando un evento; se reintenta en 5 s` | Fallo de infraestructura; el mensaje queda pendiente |

El motivo de un `failed` solo queda en el log (no se guarda en SQL).

**Errores de arranque.** Si falta `DATABASE_URL` o las credenciales S3, imprime `media-worker: faltan variables de entorno: ...` y termina con código **2**.

**Métricas.** El worker no expone endpoint de métricas ni de salud. Su telemetría de negocio es `media_processed` (tasa de fallo y `processing_ms`), que agrega `analytics`. Para ver la cola: `XPENDING media:uploads media-workers` en Redis.

## 8. Decisiones de arquitectura

- [ADR 0008 · Subida directa a MinIO con URL firmada](../../docs/adr/0008-subida-directa-a-minio-con-url-firmada.md)
- [ADR 0009 · Procesamiento asíncrono con Redis Streams](../../docs/adr/0009-procesamiento-asincrono-con-redis-streams.md)
- [ADR 0010 · Eventos de analítica sin PII](../../docs/adr/0010-eventos-de-analitica-sin-pii.md)
- [ADR 0011 · Ambilight precalculado por media-worker](../../docs/adr/0011-ambilight-precalculado-por-media-worker.md)

Las decisiones locales del servicio (formato estándar, normalización condicional, lectura de píxeles sin numpy, idempotencia) están en [STATUS.md › Decisiones tomadas](STATUS.md#decisiones-tomadas).

## 9. Enlaces

- [AGENTS.md](AGENTS.md): reglas y límites del dominio.
- [STATUS.md](STATUS.md): estado, decisiones, mediciones y pendientes.
- [Dominio de Reproducción §6.7](../../docs/dominio-reproduccion.md#67-subida-y-cambio-de-vídeo): subida y cambio de vídeo de punta a punta.
- [Contrato de eventos de analítica](../../docs/contrato-eventos-analitica.md).
- [Arquitectura](../../docs/arquitectura.md): [vista de componentes y conectores (§4)](../../docs/arquitectura.md#vista-de-componentes-y-conectores), almacenes (§6) y contrato `media:uploads` + `videos` (§5).
- [identity-api](../identity-api/AGENTS.md): dueño de la tabla `videos` y del stream `media:uploads`.
