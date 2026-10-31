# 🤖 AGENT Guidelines — Domain: Core Sync (`services/sync-core`)

## Contexto & Responsabilidad
Eres el agente encargado del corazón de reproducción en tiempo real de **TINT**, desarrollado en **Golang**. Tu única meta es garantizar latencia ultrabaja (<100 ms) y precisión en la sincronización.

> Diagramas de flujo, secuencia y datos del dominio: [`docs/dominio-reproduccion.md`](../../docs/dominio-reproduccion.md).

> Funcionamiento interno (componentes, flujos paso a paso, claves Redis, concurrencia y ejecución): [`README.md`](README.md).

## Stack Técnico
- Go 1.22 (`net/http` con patrones de ruta de Go 1.22). Dependencias externas, cada una justificada por su impacto en latencia:
  - `github.com/coder/websocket` — WebSocket con `context`, sin goroutines ocultas por conexión y con `SetReadLimit`; la librería estándar no implementa WebSocket.
  - `github.com/redis/go-redis/v9` — cliente Redis con pool de conexiones, compare-and-set atómico con script Lua (`casScript` en `internal/store/store.go`; reemplazó a `WATCH/MULTI/EXEC`, ver [ADR 0004](../../docs/adr/0004-scripts-lua-en-lugar-de-watch-multi.md)), `MULTI` en pipeline para `Init` y Pub/Sub sobre una única conexión por réplica.
  - `github.com/golang-jwt/jwt/v5` — validación HS256 de tokens de identity-api restringiendo algoritmo, `iss`, `aud` y `exp` (evita reimplementar criptografía).
  - `github.com/google/uuid` — `event_id` y `id` de conexión (UUID v4).
  - `github.com/vmihailenco/msgpack/v5` — codificación MessagePack opcional (subprotocolo `tint.sync.msgpack`); sin cgo.
  - `github.com/alicebob/miniredis/v2` — **solo pruebas**: Redis en memoria para tests deterministas del store, bus y telemetría.
- Las métricas Prometheus se exponen con un paquete propio (`internal/metrics`), sin `client_golang`.
- WebSockets para `/ws/sync`
- Redis (estado maestro + Pub/Sub entre réplicas + presencia de hosts)
- Imagen Docker `distroless/static` (non-root)

## Responsabilidades
- Reloj maestro por sala y difusión de comandos de reproducción.
- Validación del contrato de eventos (`internal/syncevent`).
- Latidos (`HEARTBEAT`) para medir latencia y detectar clientes caídos.
- Detección y corrección de drift (> 500 ms) y presencia del Host.

## Límites de Dominio
- ❌ No proceses chat, reacciones, trivias ni Ambilight (→ `services/social-core`).
- ❌ No persistas telemetría directamente: publica eventos en `analytics:events` (→ `services/analytics`).
- ❌ No introduzcas dependencias externas sin justificar su impacto en latencia (y documentarla en el Stack Técnico).
- ❌ No emitas tokens: los firma identity-api; sync-core solo los verifica.

## Modelo de Datos Involucrado
| Clave / Entidad | Tipo | Descripción |
| :--- | :--- | :--- |
| `room:{id}:sync_state` | Redis Hash | Ancla del Reloj Maestro: `status` (playing/paused), `position_ms`, `updated_at_ms` (reloj del servidor), `rate`, `version` (orden total de comandos), `host_id`, `media_id` (vídeo actual), `volume` (0–1, por defecto `1`) y `quality` (por defecto `auto`); los hashes anteriores sin estos campos se leen con sus valores por defecto. TTL 12 h (`ROOM_TTL`), refrescado en cada comando, desconexión y barrido de presencia (mientras haya clientes conectados). |
| `room:{id}:evt:{event_id}` | Redis String | Idempotencia: un `event_id` ya aplicado se ignora durante 1 min (ACK con `duplicate: true`). |
| `room:{id}:sync` | Redis Pub/Sub | Difusión de `Event` (comandos y `HOST_STATUS`) entre réplicas. |
| `room:{id}:hosts_online` | Redis ZSET | Presencia de conexiones host/cohost: miembro = id de conexión, score = último latido (unix ms). Un host sin latir en 5 s se considera fuera. |
| `room:{id}:members` | Redis ZSET | Presencia de participantes: miembro = `sub`, score = último latido. Se renueva en lote en cada barrido. |
| `room:{id}:host_online` | Redis String | Último `HOST_STATUS` publicado (`1`/`0`): solo se publican transiciones aunque varias réplicas evalúen la sala. |
| `room:{id}:hostless_since` | Redis String | Unix ms desde que la sala perdió a su host (solo si alguna vez lo tuvo). |
| `room:{id}:delegate` | Redis String | `sub` del participante con control delegado. |
| `token:revoked:{jti}` | Redis String | Lo escribe identity-api al retirar a un invitado (`EXAT` = expiración del token). |
| `analytics:events` | Redis Stream | Eventos `playback_command` (`command`, `position_ms`), `drift_correction` (`drift_ms`, `position_ms`, `rtt_ms`, `strategy`) y `buffering` (`duration_ms`, `position_ms`), todos con `event_id`, `source=sync-core`, `room_id`, `role` y `occurred_at`/`received_at` RFC 3339 UTC con milisegundos; **sin PII** (ni `sub`, ni `nick`, ni `user_id`). `MAXLEN ~100000`. Contrato: [`docs/contrato-eventos-analitica.md`](../../docs/contrato-eventos-analitica.md#sync-core). |
| `Event` | JSON | `event_id` (UUID), `type`, `room_id`, `position_ms`, `occurred_at`, `received_at`, `version` + campos opcionales por tipo (ver protocolo). |

La posición nunca se guarda "en vivo": `posición(t) = position_ms + (t − updated_at_ms) × rate` si `status = playing`; si no, `position_ms`.

## Protocolo del Canal Sync

### Conexión
`GET /ws/sync?room_id={id}&token={JWT}` (el token va en la query porque el navegador no permite headers en WebSocket; **nunca registres la URL completa**).

Tokens HS256 firmados por identity-api con `JWT_SECRET`, `iss=tint-identity`, `aud=tint:room`, `exp` obligatorio, `sub` no vacío, `room_id` igual al de la query:
- **Guest token** (al unirse a la sala) → `role: participant`.
- **Sync-ticket** (`POST /api/v1/rooms/:id/sync-ticket`) → `role: host` (`cohost` también puede controlar).

| Handshake | Resultado |
| :--- | :--- |
| Falta `room_id` o `token` | `400` |
| Token inválido (firma, `iss`, `aud`) / algoritmo distinto de HS256 / sin `exp` / rol desconocido | `401` |
| Token de otra sala (aunque esté expirado) | `403` |
| `Origin` fuera de `ALLOWED_ORIGINS` | `403` (se comprueba también antes de los cierres terminales) |
| Token expirado pero bien firmado (`iss`, `aud`, sala y rol correctos) | upgrade y cierre `4003` "token expirado" |
| Token revocado (`token:revoked:{jti}`) | upgrade y cierre `4001` "token revocado" (sin `STATE`) |
| Redis no permite comprobar la revocación | `503` (falla cerrado) |
| Redis no disponible al conectar | upgrade y cierre `1011` |
| OK | `101` y el servidor envía de inmediato un `STATE` |

Los casos terminales hacen upgrade porque el navegador no ve el status HTTP de un handshake rechazado (solo un cierre `1006`), y un cliente que reconecta ante `1006` lo haría para siempre.

**Códigos de cierre terminales** (el cliente **no** debe reconectar con el mismo token):

| Código | Motivo | Qué hace el cliente |
| :--- | :--- | :--- |
| `4001` | Token revocado (en el handshake o por `REVOKED` en vivo) | Borra el token y muestra "Fuiste retirado". |
| `4003` | Token expirado | Pide un token nuevo (sync-ticket del Host o volver a unirse). **Pendiente en la web**: hoy solo se detiene ante `4001`. |

**Subprotocolo opcional:** `Sec-WebSocket-Protocol: tint.sync.msgpack` → todos los frames son binarios MessagePack con las mismas claves que el JSON (timestamps como string ISO-8601). Sin subprotocolo o con `tint.sync.json` → JSON. El bus entre réplicas siempre usa JSON.

### Mensajes
Todos los mensajes son JSON con `event_id`, `type`, `room_id`, `position_ms`, `occurred_at`, `received_at`, `version`; los campos opcionales se omiten si no aplican. `received_at` lo sella siempre el servidor.

| Tipo | Dirección | Campos relevantes |
| :--- | :--- | :--- |
| `PLAY` / `PAUSE` / `SEEK` | C → S (quien tenga control) | `event_id` (UUID, idempotencia), `room_id`, `position_ms` (posición del reproductor del Host), `occurred_at` |
| `RATE` | C → S (quien tenga control) | lo anterior + `rate` ∈ [0.25, 4]. Re-ancla y cambia la velocidad; el status no cambia. |
| `LOAD` | C → S (quien tenga control) | lo anterior + `media_id` (1–128 caracteres). Deja la sala en pausa en `position_ms`, `rate = 1` y el vídeo nuevo. |
| `VOLUME` | C → S (quien tenga control) | lo anterior + `volume` ∈ [0, 1] (obligatorio; `0` = silencio). No mueve la reproducción: re-ancla en la posición maestra de `received_at` (ignora `position_ms` del emisor) y conserva status y velocidad. |
| `QUALITY` | C → S (quien tenga control) | lo anterior + `quality` ∈ {`auto`, `source`, `720p`, `360p`}. Igual que `VOLUME`: re-ancla sin saltos y conserva status y velocidad. |
| `PLAY` / `PAUSE` / `SEEK` / `RATE` / `LOAD` / `VOLUME` / `QUALITY` | S → todos (broadcast vía Pub/Sub, incluido el emisor) | mismo `event_id` y `occurred_at` del emisor, `received_at`, `version`, ancla: `status`, `position_ms`, `rate`, `updated_at_ms`, `server_time_ms`, `media_id`, `volume` (siempre presente, también si es `0`) y `quality` |
| `ACK` | S → emisor | `ref_event_id`, `version` resultante, `duplicate` |
| `STATE` | S → cliente al conectar | ancla completa + `media_id` + `volume` + `quality` + `online` (hay host vivo) + `can_control`; `server_time_ms` se sella justo antes de encolarlo (después de las idas y vueltas a Redis del alta) |
| `HEARTBEAT` | S → C cada 1 s | `server_time_ms`, `rtt_ms` (RTT suavizado de ese cliente), `drift_ms` (último drift medido; se omite si es 0) |
| `CONTROL` | S → participantes | `can_control` cuando cambia la delegación (ver abajo) |
| `BUFFERING` | C → S (cualquier rol) | `event_id`, `room_id`, `position_ms` (≥ 0), `duration_ms` (0–120000, duración del stall), `occurred_at`. Sin `ACK` ni broadcast: solo se publica `buffering` en `analytics:events`. Máximo 1 por segundo y conexión (el exceso se descarta en silencio); inválido → `ERROR{INVALID}`. |
| `SYNC_CHECK` | C → S (respuesta a cada `HEARTBEAT`) | `event_id`, `room_id`, `position_ms` (posición local actual), `echo_server_ts` (= `server_time_ms` del HEARTBEAT), `occurred_at` + opcional `version` (última `version` aplicada por el cliente; si es > 0 y menor que la de la sala, el servidor no corrige ese `SYNC_CHECK`). Límite propio de 5/s, fuera de los 20 msg/s. |
| `SYNC_CORRECTION` | S → C (solo si \|drift\| > 500 ms) | `target_ms` (= `position_ms`), `strategy` (`rate`/`seek`), `drift_ms` (+ adelantado, − atrasado), `version` + opcionales `status`, `rate` (velocidad de la sala, no la de corrección), `media_id`, `volume` y `quality` del estado en esa `version`, para que un cliente que perdió un broadcast se reconcilie (la web aún no los usa) |
| `HOST_STATUS` | S → todos (vía Pub/Sub) | `online`; solo en transiciones, incluida la caída de la réplica del host (detectada por el barrido) |
| `REVOKED` | identity-api → réplicas (solo bus) | `jti`: cada réplica cierra esas conexiones con `4001`; nunca llega a los clientes |
| `ERROR` | S → C | `code` (`FORBIDDEN`, `INVALID`, `RATE_LIMITED`, `INTERNAL`), `ref_event_id` |

### Heartbeat, RTT y drift
1. El servidor envía `HEARTBEAT{server_time_ms}`; el cliente responde `SYNC_CHECK` con `echo_server_ts` y su posición.
2. RTT = `ahora − echo_server_ts` medido **solo con el reloj del servidor** (el skew del cliente no afecta), suavizado con EWMA α = 0.2; muestras negativas se descartan. Tras la primera muestra, cada una se recorta a `min(muestra, 2·RTT_previo + 200)` antes de la EWMA (un `SYNC_CHECK` retrasado por una pestaña en segundo plano o un stall no infla el RTT).
3. El cliente leyó su posición ~RTT/2 antes de la llegada: `drift = posición_cliente − posición_maestra(recepción − RTT/2)`.
4. Si el `SYNC_CHECK` trae `version` > 0 y menor que la `version` del estado usado, se ignora (ni corrección ni drift): el cliente aún no aplicó el último broadcast y corregirlo duplicaría el seek de un `SEEK`/`LOAD`. Sin `version` (o `0`) se corrige como siempre.
5. `|drift| ≤ 500 ms` → sin respuesta. `> 500 ms` → `SYNC_CORRECTION` con `target_ms = posición_maestra(ahora + RTT/2)`; estrategia `rate` si la sala reproduce y `|drift| ≤ 2000 ms`, `seek` si no. Cada corrección se emite como `drift_correction` a `analytics:events` (con `position_ms` = `target_ms`).
6. **Enfriamiento de seek:** tras enviar un `seek` a un cliente no se le envía otro durante 3 s (`drift.SeekCooldownMs`); las correcciones `rate` siguen permitidas. El seek suprimido no emite telemetría ni cuenta en `sync_corrections_total`. Evita el bucle seek→stall→seek de un cliente en buffering que reporta una posición congelada.
7. Los comandos fijan el ancla en `received_at − RTT/2` del Host. Cada comando aplicado (no duplicado) se emite como `playback_command` con el `event_id` del cliente.
8. El `SYNC_CHECK` no escribe en Redis: la presencia se renueva en lote en el barrido de cada réplica (1 s).

### Presencia y delegación de control
- Cada réplica ejecuta un **barrido** por segundo: renueva `hosts_online` y `members` de sus clientes locales y reevalúa cada sala. Un único script Lua por sala (`Store.Sweep`, 1 ida y vuelta) registra el latido, lee la presencia y guarda el último `HOST_STATUS` para publicar solo transiciones; así la caída de la réplica del host también se avisa (cuando su presencia expira a los 5 s).
- Si una sala que tuvo host pasa `CONTROL_HANDOFF_AFTER` (5 min) sin host/cohost, el participante vivo de **menor `sub`** (determinista entre réplicas) recibe el control: `CONTROL{can_control:true}` a él y `false` al resto. Si el delegado se va se reasigna; cuando vuelve un host/cohost, la delegación se anula. Una sala a la que nunca entró el host no delega.

### Orden y versiones
- El orden entre el `ACK` (directo) y el broadcast (vía Pub/Sub) **no está garantizado**; el cliente no debe depender de él.
- Todo el estado viaja con `version`; el cliente descarta `STATE`/broadcast/`SYNC_CORRECTION` con `version` menor a la última aplicada.
- Un `event_id` repetido no cambia el estado ni se difunde: solo recibe `ACK{duplicate: true}`.

### Límites
| Límite | Valor | Consecuencia |
| :--- | :--- | :--- |
| Tamaño de mensaje entrante | 4 KB | cierre `1009` |
| Mensajes entrantes (salvo `SYNC_CHECK`) | 20 msg/s por conexión (ventana fija) | `ERROR{RATE_LIMITED}` |
| `SYNC_CHECK` | 5 por segundo por conexión (ventana propia, no cuenta en los 20 msg/s) | se descarta en silencio |
| `BUFFERING` | 1 por segundo por conexión | se descarta en silencio |
| Cola de salida | 64 mensajes por cliente | cliente lento → cierre `1008` |
| Latidos sin `SYNC_CHECK` | 3 intervalos | cierre `1008` |
| Token revocado (handshake o durante la conexión) | — | cierre `4001` (no reconectar) |
| Token expirado en el handshake | — | cierre `4003` (pedir token nuevo) |
| Comando de un `participant` (incluidos `VOLUME` y `QUALITY`) | — | `ERROR{FORBIDDEN}` |
| `rate`, `media_id`, `volume` o `quality` fuera de contrato | — | `ERROR{INVALID}` (el estado no cambia) |

## Arquitectura interna
| Paquete | Responsabilidad |
| :--- | :--- |
| `internal/config` | Configuración desde el entorno (`getenv` inyectable). |
| `internal/syncevent` | Contrato `Event`, tipos, códigos de error, validación y claves Redis. |
| `internal/master` | Reloj Maestro puro (sin I/O): ancla, `PositionAt`, `Apply`. |
| `internal/drift` | EWMA del RTT y decisión de corrección (`rate`/`seek`). |
| `internal/auth` | Verificación HS256 de tokens de identity-api y roles. |
| `internal/store` | `sync_state` con compare-and-set (lectura en pipeline —o el último estado escrito por la réplica, sin leer— + script Lua que escribe y publica si la `version` no cambió), candado local por sala, dedupe, presencia (barrido en un solo script por sala), delegación y revocación. |
| `internal/codec` | JSON y MessagePack (subprotocolo). |
| `internal/metrics` | Exposición Prometheus sin dependencias. |
| `internal/bus` | Pub/Sub entre réplicas (una conexión por réplica, suscripción solo a salas con clientes locales). |
| `internal/telemetry` | Emisión no bloqueante de `playback_command`, `drift_correction` y `buffering` (un solo canal con buffer; si se llena se descarta). Reutiliza el `event_id` del cliente si es UUID. |
| `internal/hub` | Salas locales, despacho de comandos, heartbeat/drift, presencia del host. Independiente del transporte. |
| `internal/ws` | Handshake y transporte WebSocket. |
| `internal/server` | Rutas HTTP (`/healthz`, `/ws/sync`, `/metrics`). |

**Modelo de concurrencia:** cada conexión tiene una goroutine **lectora** (la del handler HTTP, llama a `hub.Handle`) y una **escritora** (única dueña de `conn.Write`, drena la cola). `hub.Run` mantiene por réplica un solo temporizador de `HEARTBEAT` (que también cierra a los clientes sin respuesta) y el barrido de presencia. Cada cliente tiene una cola con buffer (64); `enqueue` nunca bloquea, así un cliente lento no frena a los demás. La réplica emisora no difunde localmente: todo comando pasa por Redis Pub/Sub, lo que da un único camino y orden consistente entre réplicas. `hub.rooms` se protege con `sync.Mutex` (`h.mu`), que **nunca** se mantiene durante I/O de red: `Subscribe`/`Unsubscribe` del bus se serializan con otro mutex (`subMu`, orden `subMu → mu`) y una sala está en `hub.rooms` solo mientras su suscripción está activa (se inserta tras `Subscribe`, se borra antes de `Unsubscribe` y la baja re-comprueba que nadie la volvió a crear). RTT, último latido, último drift y último seek son `atomic`.

## Reglas de Dominio
1. **Aislamiento:** El canal WebSocket `/ws/sync` es exclusivo para comandos de reproducción (`PLAY`, `PAUSE`, `SEEK`, `RATE`, `LOAD`, `VOLUME`, `QUALITY`), latidos y el aviso de `BUFFERING` (solo telemetría). No proceses mensajes de chat aquí.
2. **Reloj Maestro:** Mantén el estado maestro de la sala en Redis (`room:{id}:sync_state`) como ancla; nunca con timers en el servidor.
3. **Formato de Payload:** Todo evento transmitido debe incluir `event_id` (UUID), `occurred_at` y `received_at`.
4. **Concurrencia:** Todo estado compartido protegido (`sync.Mutex`/canales/`atomic`); las pruebas corren con `-race`.
5. **TDD:** Implementa pruebas unitarias e integración en Go con `go test -cover`, escribiendo la prueba primero. La cobertura no puede bajar del **85%**. `main.go` debe ser mínimo; la lógica vive en `internal/`.
6. **Privacidad:** La telemetría nunca incluye `sub`, `nick` ni tokens (por eso no envía `user_id`, sino `role`).
7. **Telemetría fuera del camino caliente:** emitir a `analytics:events` solo encola; nunca un `XADD` síncrono en `Handle`.

## Variables de Entorno
| Variable | Por defecto | Descripción |
| :--- | :--- | :--- |
| `SYNC_CORE_ADDR` | `:8080` | Dirección de escucha HTTP. |
| `REDIS_URL` | `redis://localhost:6379` | Redis de estado, Pub/Sub y streams. |
| `JWT_SECRET` | — (**obligatoria**) | Secreto HS256; debe ser el mismo de identity-api. Sin él el servicio no arranca. |
| `JWT_ISSUER` | `tint-identity` | `iss` esperado. |
| `JWT_AUDIENCE` | `tint:room` | `aud` esperado. |
| `ALLOWED_ORIGINS` | `localhost:5173,127.0.0.1:5173` | Patrones de host permitidos en el handshake, separados por coma. |
| `ROOM_TTL` | `12h` | Periodo de gracia de la sala (duración Go, positiva). |
| `CONTROL_HANDOFF_AFTER` | `5m` | Tiempo sin host/cohost tras el cual se delega el control (duración Go, positiva). |

## Métricas (`GET /metrics`, formato Prometheus)
`sync_connections`, `sync_rooms`, `sync_commands_total{result}`, `sync_messages_invalid_total`, `sync_messages_rate_limited_total`, `sync_disconnects_total{reason}`, `sync_corrections_total{strategy}`, `sync_command_apply_seconds`, `sync_broadcast_delivery_seconds`, `sync_store_conflicts_total`, `sync_telemetry_dropped_total`, `sync_telemetry_failed_total`. **No exponer públicamente**: debe quedar detrás del ingress.

## Rendimiento (caminos calientes)
Cada optimización se mide con `testing.B` + `benchstat` (n=6, binarios viejo/nuevo intercalados) y su commit lleva el antes/después. Para Redis la métrica estable es **rt/op** (idas y vueltas; la reporta un hook de go-redis en los benchmarks).

| Camino | Costo actual | Cómo |
| :--- | :--- | :--- |
| `HEARTBEAT` (`beatAll`, 500 clientes JSON) | ~0,27 ms · 2 allocs/cliente | Plantilla JSON por sala y tick; por cliente solo `event_id`, `drift_ms`, `rtt_ms` (idéntico byte a byte a `json.Marshal`). |
| `SYNC_CHECK` con caché vigente | 0 rt · 8 allocs | Sin Redis ni `context.WithTimeout` salvo que la caché haya expirado. |
| Comando (`store.Apply`) | **1 rt** tras un comando propio; 2 si otra réplica escribió | Último estado escrito por franja del candado (máx. 1 min); el CAS por `version` detecta escrituras ajenas. |
| Barrido por sala | **1 rt** | `sweep.lua`: latido en lote + presencia + transición de `HOST_STATUS`. |
| Alta + baja de un participante | **5 rt** | `Init` con `HGETALL` en la misma `MULTI`; latido + presencia en un pipeline. |

## Comandos
```bash
go vet ./...
go test -race -coverprofile=coverage.out ./...
../../scripts/check-go-coverage.sh coverage.out 85

# Benchmarks (sin BENCH_REDIS_URL usan miniredis: rt/op y allocs/op valen, ns/op no)
BENCH_REDIS_URL=redis://localhost:6379/15 go test ./internal/store ./internal/hub -run '^$' -bench . -benchmem -count 6

# Prueba de carga SYNC-TEST-01 (500 conexiones; ver loadtest/README.md)
k6 run -e ROOM_ID=sala-carga -e JWT_SECRET=$JWT_SECRET loadtest/sync.js
```
