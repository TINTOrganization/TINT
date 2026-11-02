# 🤖 AGENT Guidelines — Domain: Transmisión en vivo (`services/stream-core`)

## Contexto & Responsabilidad
Eres el agente de la **Transmisión en vivo** de TINT. El host transmite su pantalla (cámara opcional y audio del PC) y el servidor reenvía esa señal a cada espectador (**SFU**). stream-core:

- **Señaliza por HTTP (WHIP/WHEP)** a través del gateway (R8, HU-LIVE-06).
- **Reenvía medios sin transcodificar**: VP8 con simulcast de 3 capas (`l`/`m`/`h`) y Opus estéreo. Elige la capa de cada viewer y reescribe SSRC/seq/ts/PictureID para que el viewer vea una secuencia continua.
- **Controla el ciclo de vida**: `waiting → live → reconnecting (gracia 60 s) → ended`. Cuando vence la gracia, pide a identity-api que deshabilite la sala.
- **Avisa por DataChannel** (`stream_state`, `viewer_count`, `scene`, `host_stats`).

Documento de dominio: [docs/dominio-transmision.md](../../docs/dominio-transmision.md). Decisiones: [ADR 0018](../../docs/adr/0018-stream-core-sfu-cpp-con-libdatachannel.md) y [ADR 0019](../../docs/adr/0019-salas-live-y-cierre-room-closed.md).

## Stack Técnico
| Pieza | Versión | Por qué |
| :--- | :--- | :--- |
| C++23 · GCC 14 (Debian trixie) | — | Mismo lenguaje y estilo que voice-core (ADR 0015/0017); `std::expected`. |
| **libdatachannel** | **v0.24.6** (commit `6b1e2e6`, fijado en el `Dockerfile`) | ICE/DTLS/SRTP y pistas RTP sin escribir un stack de medios (HU-LIVE-07). No está en Debian ni Ubuntu: se compila en la etapa `dev` con libjuice, usrsctp y plog como submódulos. |
| libsrtp2 | 2.7 (paquete del sistema) | SRTP para libdatachannel (`USE_SYSTEM_SRTP`). |
| Boost.Beast / Asio | 1.83 | Servidor HTTP y cliente hacia identity-api. |
| hiredis | 1.2 | Revocación, estado de la sala y `PSUBSCRIBE room:*:sync`. |
| nlohmann/json · OpenSSL | 3.11 · 3.x | JSON; HMAC-SHA256 del JWT y HMAC-SHA1 de TURN. |
| GoogleTest/GoogleMock · gcovr | 1.15 · 8 | Pruebas y cobertura. |

## Límites de Dominio
- ❌ **No transcodifica ni decodifica.** Recibe VP8 y Opus y los reenvía tal cual.
- ❌ **No escribe `rooms.status`.** Al vencer la gracia llama a `POST /api/v1/internal/rooms/{id}/disable` de identity-api, que es la dueña del estado (ADR 0019).
- ❌ No lee PostgreSQL. Autoriza con el JWT y Redis.
- ❌ Nunca expone el `jti` ni datos de otros viewers.
- ✅ Lee `room:{id}:sync` **solo** para `REVOKED` y `ROOM_CLOSED`. Publica en `room:{id}:stream` (`STREAM_STARTED`/`STREAM_ENDED`), que consume social-core.

## API WHIP/WHEP
La tabla completa de rutas y respuestas está en [dominio-transmision §3](../../docs/dominio-transmision.md#3-api-whipwhep-apiv1stream).

- **Rutas públicas** (las publica Caddy en `/api/v1/stream/*`): `GET /rooms/{id}/ice-servers`, `POST /rooms/{id}/whip?kind=video|audio`, `POST /rooms/{id}/whep`, `PATCH`/`DELETE /sessions/{sid}` y `GET /healthz`.
- **Rutas internas** (no pasan por Caddy): `POST`/`DELETE /internal/events/start/{roomId}`. Las llama identity-api para habilitar o deshabilitar una sala `live`.
- **Orden de comprobación** (`http/request_decision`): ruta → Origin → token → revocación → sala del token → rol → estado de la sala (`503`/`404`/`410`) → `Content-Type` → SDP → cupo.

## Modelo de Datos Involucrado
| Clave | Tipo | Quién escribe | Descripción |
| :--- | :--- | :--- | :--- |
| `token:revoked:{jti}` | String | identity-api | `EXISTS` en cada petición (falla cerrado). |
| `room:{id}:closed` | String | identity-api | Sala deshabilitada: `410 ROOM_DISABLED`. |
| `room:{id}:stream:enabled` | String (TTL 24 h) | stream-core | Sala `live` dada de alta por `/internal/events/start`. |
| `room:{id}:stream:started_at` | String ms (`SET NX`, 24 h) | stream-core | Primer keyframe. Una reconexión no lo reinicia. Se borra (`DEL`) al terminar la sala, antes de `STREAM_ENDED`, para que social-core no rearme trivias tras un reinicio. |
| `room:{id}:sync` | Pub/Sub | identity-api | Lee `REVOKED{jti}` y `ROOM_CLOSED{reason}` (`host_ended`\|`grace_expired`; si falta o es desconocido, `host_ended`). |
| `room:{id}:stream` | Pub/Sub | stream-core | `STREAM_STARTED{event_id, room_id, started_at, started_at_ms, occurred_at}` y `STREAM_ENDED{event_id, room_id, reason, occurred_at}` ([§6.1](../../docs/dominio-transmision.md#61-formatos-estándar)). |
| Salas, sesiones y viewers | Memoria | stream-core | Una réplica (ver Limitaciones). |

## Estructura
| Ruta | Rol | ¿Puro? |
| :--- | :--- | :--- |
| `src/http/request_decision` | Tabla de decisión de WHIP/WHEP. | ✅ |
| `src/http/handler` | Respuestas: `201` + `Location` + `Link rel="ice-server"`, CORS y rutas internas. | ✅ (con fakes) |
| `src/sdp/offer_inspect`, `src/sdp/munge` | Lectura de la oferta y correcciones de la respuesta (rid `recv`, IP pública, Opus estéreo, start-bitrate). | ✅ |
| `src/rtp/{packet,vp8,rtcp}` | Cabeceras RTP y extensiones, descriptor VP8 y RTCP (RR/SR/NACK/PLI/FIR/REMB). | ✅ |
| `src/sfu/stream_state` | Ciclo de vida con reloj inyectado. | ✅ |
| `src/sfu/layers` | Demux por rid, selector de capas con histéresis, `PliThrottle` y `NackBuffer`. | ✅ |
| `src/sfu/rtp_rewriter` | Continuidad hacia el viewer y épocas para NACK. | ✅ |
| `src/sfu/room` | Reenvío de una sala: lista de viewers copy-on-write y cupo. | ✅ |
| `src/service/stream_service` | Orquestación: sesiones, efectos del ciclo de vida, `ROOM_CLOSED`/`REVOKED`. | ✅ (puertos inyectados) |
| `src/redis/stores` | `RedisClient`, revocación, `RoomStore`, `SyncListener`. | IO |
| `src/identity/identity_client` | `POST …/internal/rooms/{id}/disable` con reintentos. | IO |
| `src/net/http_server` | Boost.Beast; el handler corre en un pool. | IO |
| `src/rtc/peer_factory` | **El único código que incluye `<rtc/rtc.hpp>`.** | IO |
| `src/main.cpp` | Ensamblado (fuera de la cobertura). | — |

## Reglas de Dominio
1. **TDD.** Escribe la prueba y mírala fallar con un stub antes de implementar. Cobertura de líneas ≥ **85 %** en `src/` (sin `main.cpp`).
2. **Sanitizers.**
   - ASan+UBSan sobre todo, incluido el loopback de libdatachannel.
   - TSan sobre `stream_core_lib` con `-DSTREAM_BUILD_RTC=OFF`, porque libdatachannel no está instrumentada.
3. **Camino caliente sin locks.**
   - La lista de viewers es `atomic<shared_ptr<const vector>>`.
   - Cada reescritor tiene un único escritor (el hilo de ingesta).
   - `PliThrottle` usa CAS.
   - Única excepción documentada: el mutex por capa de `NackBuffer`, porque los NACK son raros.
4. **Instantáneas en variables.** Nunca `for (… : *viewers())`: el `shared_ptr` temporal muere antes del bucle (GCC 14 no aplica P2718). La prueba concurrente lo detectó.
5. **Callbacks de libdatachannel.** No captures estado de la pila. `Peer::close()` desconecta los callbacks antes de cerrar.
6. **`reason` único** (`host_ended` | `grace_expired`, §6.1): el de `ROOM_CLOSED` se propaga tal cual a `stream_state{state:"ended",reason}` y a `STREAM_ENDED`; la gracia vencida local es `grace_expired`. `stream_state` lleva `reason` solo con `ended` y `grace_deadline_ms` solo con `reconnecting`.
7. **Falla cerrado** en autorización y en el estado de la sala: sin Redis responde `503`.
8. **Formato:** `clang-format` (Google, 110 columnas) **de la imagen dev** (clang-format 19). Otras versiones formatean distinto.

## Comandos
```bash
# Todo en la imagen dev (libdatachannel fijada), como en CI:
make test-stream                         # formato + pruebas + cobertura ≥ 85 %
STREAM_TEST_REDIS_URL=redis://localhost:6379 make test-stream   # + integración con Redis real

# A mano, dentro de la imagen
docker build --target dev -t tint-stream-dev services/stream-core
docker run --rm --user "$(id -u):$(id -g)" -v "$PWD/services/stream-core:/src" -w /src tint-stream-dev bash -c \
  'cmake -S . -B build -G Ninja && cmake --build build && ctest --test-dir build --output-on-failure'
# Sanitizers: -DSTREAM_SANITIZE=address | thread (con -DSTREAM_BUILD_RTC=OFF)

# Servicio y prueba rápida
docker compose up -d redis stream-core && make smoke-stream

# Carga S2: 1 publicador simulcast + 50 viewers WHEP (bots libdatachannel, target CMake opcional
# STREAM_BUILD_LOADBOT=ON, fuera de la cobertura). Levanta redis + stream-core si no están y los baja.
make load-stream                          # VIEWERS=50 DURATION=30 por defecto

# E2E con Chromium real (S1, TTFF, glass-to-glass, audio, relay y gracia). Local, fuera de CI: levanta su
# propio entorno en puertos 1xxxx (web real + stub de identity-api) y lo borra. MODES=normal|relay.
make e2e-stream
```

## Variables de Entorno
| Variable | Por defecto | Descripción |
| :--- | :--- | :--- |
| `STREAM_CORE_ADDR` | `0.0.0.0:8086` | HTTP (`host:puerto` o `:puerto`). |
| `STREAM_UDP_PORT` | `8087` | Puerto UDP único (ICE UDP mux). Se publica en compose. |
| `STREAM_PUBLIC_IP` | — (obligatoria) | IP del candidato host: la que alcanza el navegador. |
| `STREAM_MAX_VIEWERS` | `50` | Cupo por sala (1–50). El viewer siguiente recibe `409 ROOM_FULL`. |
| `STREAM_HOST_GRACE_S` | `60` | Gracia del host (10–300 s). |
| `REDIS_URL` | — (obligatoria) | Revocación y estado de la sala. |
| `JWT_SECRET` / `JWT_ISSUER` / `JWT_AUDIENCE` | — / `tint-identity` / `tint:room` | Iguales a los de identity-api. |
| `ALLOWED_ORIGINS` | `localhost:5173,127.0.0.1:5173` | `host[:puerto]`. En compose viene de `STREAM_ALLOWED_ORIGINS`. |
| `IDENTITY_API_URL` / `INTERNAL_API_SECRET` | — (obligatorias) | Para `POST /api/v1/internal/rooms/{id}/disable` con `X-Internal-Token`. |
| `STUN_URLS` / `TURN_URLS` / `TURN_SECRET` / `TURN_TTL_SECONDS` | vacío / vacío / vacío / `3600` | Se entregan al cliente en `Link` y en `/ice-servers` (REST API de TURN, igual que voice-core). |

## Limitaciones conocidas
- **Una réplica.** Salas y sesiones viven en memoria.
- **El host necesita dos sesiones WHIP** (vídeo y audio): libdatachannel solo enruta el simulcast por `rid` si la PeerConnection tiene una pista (ADR 0018).
- **No hay ICE restart por `PATCH`** (`405`): el cliente hace un POST nuevo.
- **S1 (simulcast) pasó en Chrome** con `make e2e-stream`. Siguen pendientes en navegador real: S1 en Firefox, S3 Docker/LAN y S5 audio del PC. Ver [dominio-transmision §9](../../docs/dominio-transmision.md#9-fase-0-spikes). Hasta que pasen, ADR 0018 sigue como *Propuesta*.
- **Carga de 50 viewers (S2): pasó** (TTFF p50 ~0.17 s, p95 ~1.2 s, 0 fallos, 409 al 51, hilo más cargado 4.7 %; [§7.1](../../docs/dominio-transmision.md#71-medido-2026-11-01)). El keyframe de un viewer nuevo se pide cuando **abre su DataChannel o llega su primer RTCP**, lo que ocurra antes. No se pide al entrar ni al abrir su pista: ese keyframe llega antes de sus claves SRTP y se pierde. Con Chrome, el primer RTCP tarda ~2.5 s. `Room::tick` repite el pedido (limitado) mientras un viewer listo no reciba su capa. El p95 sigue acotado por la ventana de 1 s de `PliThrottle` cuando entran muchos viewers a la vez.
- **E2E en navegador** (`make e2e-stream`, Chromium real, 2026-11-02). Ruta libre: TTFF p95 1.06 s y glass-to-glass p95 142 ms. En `relay`: TTFF p95 1.28 s y glass-to-glass p95 141 ms. La gracia termina en `grace_expired` ([§7.1](../../docs/dominio-transmision.md#71-medido-2026-11-01)).
- **Capas:** el REMB de Chrome no pasa de ~1.5 veces lo que recibe, así que **no sirve para subir**. El selector sube tras 5 s sin pérdida ni caída del REMB y baja por pérdida o cuando el REMB cae. Al host no le llega ninguna señal de ancho de banda (sin transport-cc ni REMB): Chrome envía ~1 Mbps de padding en `l`.
- **Imagen de runtime: ~148 MB** (Debian slim + libssl/hiredis/libsrtp2 + libdatachannel sin símbolos). La etapa `dev` conserva los símbolos para depurar.
