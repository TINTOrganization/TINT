# 🤖 AGENT Guidelines — Domain: Canal de Voz (`services/voice-core`)

## Contexto & Responsabilidad
Eres el agente del **Canal de Voz** de TINT: los participantes de una sala hablan entre sí mientras ven el vídeo. El audio viaja **P2P entre navegadores (WebRTC, mesh)**; voice-core no toca audio. Su responsabilidad es:

- **Salas de voz:** una por `room_id`, creada al entrar el primero y olvidada al salir el último.
- **Membresía:** quién está en la voz, con cupo máximo (`VOICE_MAX_MEMBERS`, mesh), avisos `peer_joined`/`peer_left`.
- **Autorización:** el mismo JWT HS256 de identity-api que usan sync-core y social-core, más la revocación `token:revoked:{jti}` (falla cerrado).
- **Señalización:** reenvía offer/answer/candidatos ICE (`signal`) solo entre miembros de la misma sala, con el remitente que fija el servidor.
- **Moderación:** silencio propio (`self_mute`) y silencio del host (`host_mute` por WebSocket o REST), persistido en Redis para que siga vigente al volver a entrar.

Documento de dominio: [docs/dominio-voz.md](../../docs/dominio-voz.md) · decisión: [ADR 0015](../../docs/adr/0015-voice-core-en-cpp-con-webrtc-p2p.md).

## Stack Técnico
| Pieza | Versión | Por qué |
| :--- | :--- | :--- |
| C++23 · GCC 14 (Debian trixie) / GCC 13 (Ubuntu 24.04 en CI) | — | Lenguaje nuevo del monorepo (ADR 0015); `std::expected` para errores sin excepciones. |
| CMake ≥ 3.25 + Ninja | — | Build y `ctest`. |
| Boost.Beast / Boost.Asio | 1.83 (paquete del sistema) | HTTP y WebSocket en un solo puerto, asíncrono. Solo cabeceras. |
| hiredis | 1.1/1.2 | `EXISTS token:revoked:{jti}` y `PSUBSCRIBE room:*:sync`. |
| nlohmann/json | 3.11 | Protocolo JSON. |
| OpenSSL (libcrypto) | 3.x | HMAC-SHA256 del JWT y comparación en tiempo constante (`CRYPTO_memcmp`). **No** se usa una librería de JWT: es una dependencia menos y el verificador tiene sus pruebas. |
| GoogleTest / GoogleMock · gcovr | 1.14+ · 7+ | Pruebas y cobertura. |

Las versiones las fija la imagen base (`debian:trixie-slim` en el `Dockerfile`, `ubuntu-24.04` en CI).

## Límites de Dominio
- ❌ No transporta audio ni vídeo: solo señalización. Si algún día hiciera falta un SFU, es una decisión nueva (ADR).
- ❌ No toca el Canal Sync ni el Canal Social: si voice-core se cae, sync y chat siguen (contenedor y socket propios).
- ❌ No lee PostgreSQL ni llama a identity-api: autoriza con el JWT y la clave de revocación en Redis.
- ❌ Nunca expone el `jti` a otros clientes (`peer_json` no lo incluye).
- ✅ Lee `room:{id}:sync` **solo** para `REVOKED` (mismo contrato que social-core).

## Protocolo del Canal de Voz
`GET /ws/voice?room_id=<id>&token=<guest token o sync-ticket>` · JSON · todo evento lleva `event_id`, `occurred_at` (reloj del emisor) y `received_at` (reloj del servidor).

| Dirección | `type` | Campos | Notas |
| :--- | :--- | :--- | :--- |
| S → C | `voice_state` | `room_id`, `self{peer_id,user_id,nick,role,muted,host_muted}`, `peers[]`, `ice_servers[]` (RTCIceServer: STUN sin credencial y TURN con `username`/`credential` efímeros del usuario), `max_members` | Al entrar. **Quien llega** inicia la oferta WebRTC a cada peer de la lista. |
| S → C | `peer_joined` | `room_id`, `peer{…}` | A los que ya estaban. |
| S → C | `peer_left` | `room_id`, `peer_id` | Cierre limpio, caída de red (ping/pong, ≤ 20 s), `leave` o revocación. El cliente cierra esa `RTCPeerConnection`. |
| C → S | `signal` | `to` (peer_id), `data` (objeto opaco: `{sdp}` o `{candidate}`) | Solo a un miembro de la misma sala. |
| S → C | `signal` | `from`, `data` | `from` lo pone el servidor (no se puede suplantar). |
| C → S | `self_mute` | `muted` (bool) | HU-VOZ-02. El cliente además hace `replaceTrack(null)` (no envía audio). Con el silencio del host, `muted:false` responde `HOST_MUTED`. |
| C → S | `host_mute` | `user_id`, `muted` (bool) | HU-VOZ-04. Solo `host`/`cohost` (si no, `FORBIDDEN`). Se guarda en Redis **antes** de anunciarse (si falla, `UNAVAILABLE`). Alcanza todas las conexiones del usuario. |
| S → C | `peer_muted` | `room_id`, `peer_id`, `user_id`, `muted`, `host_muted` | A **toda** la sala, incluido el afectado. Con `host_muted:true` los receptores silencian esa pista aunque el emisor siga enviando (en P2P el servidor no puede cortar el audio). Al levantar el silencio del host, `muted` sigue en `true` hasta que el participante se active. |
| C → S | `leave` | — | Sale de la voz; el servidor cierra con `1000`. |
| S → C | `error` | `code`, `event_id_ref?` | `INVALID_MESSAGE`, `UNKNOWN_TYPE`, `MESSAGE_TOO_LARGE`, `PEER_NOT_FOUND`, `VOICE_FULL`, `HOST_MUTED`, `FORBIDDEN`, `UNAVAILABLE`. No cierra la conexión salvo `VOICE_FULL`. |

| Handshake | Respuesta |
| :--- | :--- |
| Ruta distinta de `/ws/voice` | 404 |
| `Origin` presente y fuera de `ALLOWED_ORIGINS` | 403 (sin `Origin` no es un navegador: se acepta) |
| Falta `room_id` o `token` | 400 |
| Firma, `alg`, `iss`, `aud`, claims o rol inválidos | 401 antes del upgrade |
| `room_id` del token ≠ el de la URL | 403 |
| Redis no responde (revocación o silencios) | 503 (falla cerrado) |
| Token caducado (firma válida) | upgrade y cierre **4003** |
| `jti` revocado (retirado o bloqueado) | upgrade y cierre **4001** |
| Sala de voz llena | upgrade, `error{VOICE_FULL}` y cierre **4008** |

Mensajes de hasta 64 KiB (`kMaxMessageBytes`); uno mayor cierra la conexión.

## API REST de moderación
`PUT` (silenciar) o `DELETE` (levantar) `/api/v1/voice/rooms/{room_id}/mutes/{user_id}` con `Authorization: Bearer <sync-ticket>`. Responde `204` y voice-core anuncia `peer_muted` a la sala. El `user_id` es el `sub` del token del participante (va codificado en la URL: `guest%3A…`).

| Caso | Respuesta |
| :--- | :--- |
| Host o cohost de esa sala | `204` |
| Rol `participant` (HU-VOZ-04 AC3) o token de otra sala | `403` |
| Sin `Bearer`, firma inválida, caducado o revocado | `401` |
| Método distinto de `PUT`/`DELETE` | `405` |
| `Origin` fuera de `ALLOWED_ORIGINS` | `403` |
| Redis no responde | `503` (no se anuncia nada) |

CORS: `OPTIONS` responde `204` con `Access-Control-Allow-Methods: PUT, DELETE` y `Allow-Headers: Authorization` solo para los orígenes permitidos. Un usuario que no está en la voz también se puede silenciar: entra ya silenciado.

## Modelo de Datos Involucrado
| Dato | Dónde | Notas |
| :--- | :--- | :--- |
| Membresía de la voz | Memoria del proceso (`hub::Hub`) | **Una réplica** en esta fase (ver Limitaciones). |
| `token:revoked:{jti}` | Redis (lo escribe identity-api) | `EXISTS` en cada handshake. |
| `room:{id}:sync` | Redis Pub/Sub (lo publica identity-api) | `PSUBSCRIBE room:*:sync`; solo se usa `{"type":"REVOKED","jti":…}`. |
| `room:{id}:voice:muted` | Redis SET (lo escribe voice-core) | `user_id` silenciados por el host. `SISMEMBER` en cada handshake; `SADD` + `EXPIRE` 24 h al silenciar, `SREM` al levantar. El silencio propio **no** se persiste. |

## Estructura
| Ruta | Rol |
| :--- | :--- |
| `src/auth/` | `base64url`, `TokenVerifier` (HS256, `iss`, `aud`, `exp`, rol). |
| `src/domain/voice_room` | Membresía y cupo de una sala, sin red. |
| `src/protocol/messages` | Parseo defensivo de mensajes del cliente y construcción de los del servidor. |
| `src/moderation/mute_store` | Interfaz `MuteStore` y `can_moderate` (host/cohost). |
| `src/ice/ice_servers` | Credenciales TURN efímeras y lista `RTCIceServer` por usuario. |
| `src/hub/hub` | Salas, `join`/`leave`/`revoke`, reenvío de `signal`, `self_mute`/`host_mute`/`apply_host_mute`. Thread-safe; guarda `weak_ptr<Peer>`. La escritura en Redis de `host_mute` corre en `run_blocking`, sin el mutex. |
| `src/net/handshake` | Decisión pura del handshake (404/403/400/401/503 o 4001/4003) y lectura del silencio del host. |
| `src/net/mute_api` | Decisión pura del REST de silencios (404/405/401/403/503 o `MuteCommand`). |
| `src/net/server` | Boost.Beast: `/healthz`, REST de silencios con CORS, upgrade, sesiones WebSocket con cola de escritura y keep-alive. Lo que toca Redis corre en un `thread_pool` aparte. |
| `src/redis/` | `parse_redis_url`, `open_context` compartido, `RedisRevocationChecker`, `RevokedListener` (reconexión con espera exponencial), `RedisMuteStore`. |
| `src/config` | Variables de entorno validadas. |
| `src/main.cpp` | Ensamblado y señales (fuera de la cobertura). |

## Reglas de Dominio
1. **TDD:** prueba primero (GoogleTest) y verla fallar. Cobertura de líneas ≥ **85 %** en `src/` (sin `main.cpp`), medida con gcovr.
2. **Sanitizers:** la suite debe pasar con ASan+UBSan y con TSan (equivalente al `-race` de Go).
3. **Falla cerrado** en autorización: sin Redis no se entra.
4. **Peer asíncrono:** `Peer::send`/`close` solo encolan; el Hub los llama con su mutex tomado.
5. **Formato:** `clang-format` (`.clang-format`, Google, 110 columnas).

## Comandos
```bash
# Imagen de desarrollo (cmake, Boost, GoogleTest, hiredis, gcovr)
docker build --target dev -t tint-voice-dev services/voice-core

# Compilar y probar (las de integración con Redis se saltan sin VOICE_TEST_REDIS_URL)
docker run --rm -v "$PWD/services/voice-core:/src" -w /src tint-voice-dev bash -c \
  'cmake -S . -B build -G Ninja && cmake --build build && ctest --test-dir build --output-on-failure'

# Gate completo (cobertura ≥ 85 %), igual que CI
make test-cpp     # requiere las dependencias en el host o correrlo dentro de tint-voice-dev

# Prueba rápida contra el servicio levantado (docker compose up -d voice-core), solo stdlib
python3 services/voice-core/scripts/smoke.py
```
Sanitizers: `-DVOICE_SANITIZE=address` o `-DVOICE_SANITIZE=thread`. Cobertura: `-DVOICE_COVERAGE=ON` y `gcovr --root . --filter src/ --exclude src/main.cpp build-cov --fail-under-line 85`.

## Variables de Entorno
| Variable | Por defecto | Descripción |
| :--- | :--- | :--- |
| `VOICE_CORE_ADDR` | `0.0.0.0:8085` | `host:puerto` o `:puerto`. |
| `REDIS_URL` | — (obligatoria) | `redis://[:pass@]host[:port][/db]`. |
| `JWT_SECRET` | — (obligatoria) | El mismo de identity-api. |
| `JWT_ISSUER` / `JWT_AUDIENCE` | `tint-identity` / `tint:room` | Iguales a identity-api. |
| `ALLOWED_ORIGINS` | `localhost:5173,127.0.0.1:5173` | `host[:puerto]` (en compose viene de `VOICE_ALLOWED_ORIGINS`). |
| `VOICE_MAX_MEMBERS` | `8` | Cupo de la voz por sala (2–16). |
| `STUN_URLS` | vacío | Se envían en `ice_servers`. |
| `TURN_URLS` / `TURN_SECRET` / `TURN_TTL_SECONDS` | vacío / vacío / `3600` | TURN con credencial efímera por usuario: `username = <ahora+TTL>:<sub>`, `credential = base64(HMAC-SHA1(TURN_SECRET, username))` (REST API de TURN). `TURN_SECRET` debe ser el `static-auth-secret` de coturn. |

## Limitaciones conocidas
- **Una réplica:** la membresía vive en memoria. Varias réplicas necesitarían un registro compartido en Redis (ZSET + Pub/Sub `room:{id}:voice`). Con mesh de ≤ 8 personas la carga por sala es baja.
- **Mesh:** cada participante envía su audio a todos los demás; por eso el cupo.
- **Formato de `REVOKED`:** se asume `{"type":"REVOKED","jti":"…"}` (el contrato del Canal Sync v2); verificar con sync-core si cambia.
