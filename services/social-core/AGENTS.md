# 🤖 AGENT Guidelines — Domain: Core Social & Gamificación (`services/social-core`)

## Contexto & Responsabilidad
Gestionas la interactividad de la audiencia en **TINT**: chat, reacciones con control de spam, puntero láser del host, encuestas en vivo, el resumen (recap) de la sesión, moderación del chat (modo lento, silencio), spoilers y motor de Trivias con Leaderboards. *Previsto (sin implementar):* heatmap en vivo y retransmisión de Ambilight.

> Funcionamiento interno (componentes, flujos paso a paso, claves Redis, concurrencia y ejecución): [`README.md`](README.md).

## Stack Técnico
- Go 1.22
- WebSockets (canal social, independiente de `/ws/sync`)
- Redis: Sorted Sets (leaderboards), Hashes/contadores (heatmaps), Pub/Sub
- Imagen Docker `distroless/static` (non-root)
- Verificación de Firebase ID tokens solo con la librería estándar (`crypto/rsa`, `crypto/x509`): sin dependencias nuevas.

## Responsabilidades
- Chat en vivo, reacciones y su rate limiting autoritativo (`internal/reactions`).
- Puntero láser del host/cohost (efímero, 30/s por usuario).
- Encuestas en vivo (`internal/polls`): una activa por sala, voto cambiable, cierre por tiempo o manual.
- Métricas de la sala y mensaje `recap` (`internal/recap`).
- Conteo de reacciones por buckets de 5 s (en memoria con `reactions.Buckets` y en el recap en Redis). *Previsto:* heatmap en vivo.
- *Previsto (sin implementar):* retransmisión de colores Ambilight. Hoy la web interpola `ambilight.json` directamente (ver [ADR 0011](../../docs/adr/0011-ambilight-precalculado-por-media-worker.md)).
- Motor de trivias y puntuación (`internal/trivia`): preguntas programadas por posición del vídeo, respuestas y rankings.
- Moderación del chat (`internal/moderation`): modo lento y silencio; spoilers en los mensajes.

## Límites de Dominio
- ❌ No emitas ni modifiques comandos de reproducción (→ `services/sync-core`).
- ❌ No extraigas paletas de color de vídeo (→ `services/media-worker`); solo consumes `ambilight.json`.
- ❌ No persistas el texto del chat en analítica; publica solo metadatos (→ `services/analytics`).

## Modelo de Datos Involucrado
| Clave / Entidad | Tipo | Descripción |
| :--- | :--- | :--- |
| `room:{id}:heatmap` | Redis Hash | *Previsto, sin implementar:* `bucket_index → {emoji: count}` (buckets de 5 s) |
| `video:{id}:heatmap:history` | Redis/SQL | *Previsto, sin implementar:* histórico acumulado entre sesiones |
| `room:{id}:chat:settings` | Redis Hash, TTL 12 h | `slow_mode_s` (0 = apagado) |
| `room:{id}:chat:muted` | Redis Set, TTL 12 h | `user_id` silenciados |
| `room:{id}:chat:last:{sub}` | Redis String, PX = modo lento | Último mensaje aceptado de ese `sub` (`SET NX PX`; vale entre réplicas y pestañas) |
| `room:{id}:trivia:questions` | Redis Hash, TTL 12 h | `trivia_id → JSON` (`at_ms`, `question`, `options`, `correct`, `answer_window_s`); máx. 50 por sala |
| `room:{id}:trivia:{tid}:state` | Redis Hash, TTL 12 h | `launched`, `opens_at_ms`, `closes_at_ms` (Lua `launch`, `HSETNX`) y `closed` (`HSETNX`) |
| `room:{id}:trivia:{tid}:answers` | Redis Hash, TTL 12 h | `user_id → opción` (`HSETNX`: una respuesta por usuario) |
| `room:{id}:trivia:{tid}:leaderboard` | Redis Sorted Set, TTL 12 h + 1 h | `user_id → puntos + fracción < 1` que desempata a favor de la respuesta más temprana (`trivia.LeaderboardKey`) |
| `room:{id}:trivia:leaderboard` | Redis Sorted Set, TTL 12 h + 1 h | Ranking acumulado de la sala: `user_id → puntos` |
| `room:{id}:trivia:nicks` | Redis Hash, TTL 12 h + 1 h | `user_id → último nick` (para el top) |
| `Reaction` | JSON | `user_id`, `emoji`, `position_ms` |
| `room:{id}:social` | Redis Pub/Sub | `chat_message`, `reaction`, `laser`, `poll_state`, `chat_settings`, `trivia_question` y `trivia_result` entre réplicas (dedup por `event_id`; se re-serializan por tipo: un campo inyectado, como `correct` en `trivia_question`, se descarta) |
| `room:{id}:sync` | Redis Pub/Sub (solo lectura) | `REVOKED` de identity-api y comandos `PLAY`/`PAUSE`/`SEEK`/`RATE`/`LOAD` de sync-core (recap y disparo de trivias) |
| `room:{id}:poll` | Redis Hash, TTL 12 h | Encuesta actual: `id`, `question`, `options` (JSON), `n_options`, `closes_at_ms`, `closed` (solo al cerrarse, `HSETNX`) |
| `room:{id}:poll:{pid}:votes` | Redis Hash, TTL 12 h | `user_id → índice de opción` (un voto por usuario, cambiable) |
| `room:{id}:poll:flush` | Redis String, PX 2 s | Marca de broadcast coalescido pendiente (una réplica emite por ventana de 250 ms) |
| `room:{id}:recap:emojis_by_user` | Redis Hash, TTL 12 h | `user_id → reacciones enviadas` |
| `room:{id}:recap:nicks` | Redis Hash, TTL 12 h | `user_id → último nick` |
| `room:{id}:recap:reactions` | Redis Hash, TTL 12 h | `bucket (5 s) → reacciones` |
| `room:{id}:recap:laughs` | Redis Hash, TTL 12 h | `bucket → reacciones 😂` |
| `room:{id}:recap:pauses` | Redis Hash, TTL 12 h | `bucket → pausas + rebobinados` (el rebobinado cuenta en el bucket de destino del `SEEK`) |
| `room:{id}:recap:totals` | Redis Hash, TTL 12 h | `reactions`, `pauses`, `rewinds`, `polls` |
| `room:{id}:recap:last_pos` | Redis Hash, TTL 12 h | Ancla de reproducción conocida: `pos`, `status`, `rate`, `updated_at_ms`, `version` y `seen_at_ms` (reloj de social-core al procesar el evento; base de `recap.Store.Position`) |
| `room:{id}:recap:seen:{event_id}` | Redis String, EX 1 h | Dedup entre réplicas de los eventos del bus de sync (`SET NX`) |
| `token:revoked:{jti}` | Redis String (solo lectura) | Marca de revocación de identity-api |
| `analytics:events` | Redis Stream (solo escritura) | `chat_message`, `presence`, `reaction` y `trivia_answer` para `services/analytics` (ver abajo) |

## Protocolo del Canal Social
JSON sobre `/ws/social`. Todo lo que se emite a la sala viaja también por `room:{id}:social` a las demás réplicas (dedup por `event_id`). Al entrar, el cliente recibe, en este orden: `history`, `chat_settings` (con Redis), el `poll_state` de la encuesta vigente (con `my_vote`), `trivia_schedule_state` (solo host/cohost) y el `trivia_question` de la pregunta abierta, si la hay.

| Cliente → servidor | Quién | Respuesta / efecto |
| :--- | :--- | :--- |
| `chat_send{event_id, room_id, text, occurred_at, spoiler?}` | Todos (5/s) | `chat_message` a la sala (con `spoiler: true` si se pidió). `MUTED` si el autor está silenciado; `SLOW_MODE` con `retry_after_ms` si el modo lento lo frena (host y cohost exentos de ambos) |
| `chat_slow_mode{event_id, room_id?, seconds}` (`seconds` ∈ {0, 5, 10, 30, 60}; 0 = apagado) | Host/cohost | `chat_settings` a la sala |
| `chat_mute{event_id, room_id?, user_id, muted}` (`user_id` = `sub`, 1..128) | Host/cohost | `chat_settings` a la sala. El silenciado sigue leyendo, reaccionando, votando y respondiendo trivias |
| `reaction_send{event_id, room_id, emoji, position_ms, occurred_at}` | Todos (5/s) | `reaction` a la sala; suma al heatmap y al recap |
| `laser_point{event_id, room_id?, x, y, end?}` (`x`,`y` ∈ [0,1]) | Host/cohost (30/s) | `laser{event_id, room_id, user_id, nick, x, y, end}` a la sala; efímero |
| `poll_create{event_id, room_id?, question, options, duration_s}` (1..140 / 2..4 de 1..60 / 10..300 s) | Host/cohost | `poll_state` a la sala; `POLL_ACTIVE` si ya hay una abierta |
| `poll_vote{event_id, room_id?, poll_id, option}` (índice) | Todos (10/s, compartido con `recap_request`) | `poll_state` con `my_vote` solo al votante; broadcast coalescido (≤ 1 por 250 ms y sala) |
| `poll_close{event_id, room_id?, poll_id}` | Host/cohost | `poll_state{closed: true}` a la sala |
| `recap_request{event_id, room_id?}` | Todos | `recap` solo al que lo pide |
| `trivia_schedule{event_id, room_id?, at_ms, question, options, correct, answer_window_s?}` (`at_ms` 0..24 h de vídeo; 1..140 / 2..4 de 1..60; `correct` = índice; ventana 10..60 s, por defecto 20) | Host/cohost | `trivia_schedule_state` solo al que la programó |
| `trivia_delete{event_id, room_id?, trivia_id}` | Host/cohost | `trivia_schedule_state` solo a él; `TRIVIA_NOT_FOUND` si no existe, `TRIVIA_CLOSED` si ya salió |
| `trivia_list{event_id, room_id?}` | Host/cohost | `trivia_schedule_state` solo a él |
| `trivia_answer{event_id, room_id?, trivia_id, option}` (índice) | Todos (10/s, compartido con votos y recap) | `trivia_ack` solo a quien respondió; una respuesta por usuario |

| Servidor → cliente | Forma |
| :--- | :--- |
| `chat_message` | `{event_id, type, room_id, user_id, nick, text, spoiler?, occurred_at, received_at}` (`spoiler` se omite si es false; se guarda igual en el historial) |
| `chat_settings` | `{event_id, type, room_id, slow_mode_s, muted_user_ids[]}` (`muted_user_ids` ordenado, nunca `null`) |
| `poll_state` | `{event_id, type, room_id, poll_id, question, options[], counts[], closes_at_ms, closed, my_vote?}` |
| `trivia_schedule_state` | `{type, room_id, event_id_ref?, questions: [{trivia_id, at_ms, question, options[], correct, answer_window_s, status}]}`; `status` ∈ `pending`, `open`, `closed`; ordenadas por `at_ms`. Solo para host/cohost (lleva `correct`) |
| `trivia_question` | `{event_id, type, room_id, trivia_id, question, options[], opens_at_ms, closes_at_ms}` (sin `correct`; horas del reloj del servidor) |
| `trivia_ack` | `{type, room_id, event_id_ref, trivia_id, option, score}` |
| `trivia_result` | `{event_id, type, room_id, trivia_id, correct, top: [{user_id, nick, score}] (≤ 10, de esta pregunta), leaderboard: [{user_id, nick, score}] (≤ 10, acumulado de la sala), my_score, my_total}` |
| `recap` | `{type, room_id, event_id_ref, top_emoji_user: {user_id, nick, count}\|null, most_paused: {position_ms, count}\|null, peak_reactions: {position_ms, count, laughs}\|null, totals: {reactions, pauses, rewinds, polls}}` |
| `error` | `{type, code, event_id_ref?, retry_after_ms?}` (`retry_after_ms` solo con `SLOW_MODE`) |

Códigos de `error`: `INVALID_PAYLOAD` (también opción de trivia fuera de rango o más de 50 trivias programadas), `TEXT_TOO_LONG`, `INVALID_EMOJI`, `RATE_LIMITED`, `FORBIDDEN` (láser, encuestas, moderación del chat o programación de trivias sin ser host o cohost), `POLL_ACTIVE`, `POLL_CLOSED` (votar o cerrar una encuesta ya cerrada o vencida), `POLL_NOT_FOUND` (`poll_id` que no es la encuesta actual), `SLOW_MODE` (con `retry_after_ms`), `MUTED`, `TRIVIA_NOT_FOUND` (no existe o todavía no se abrió), `TRIVIA_CLOSED` (responder tras `closes_at_ms` o borrar una que ya salió), `ALREADY_ANSWERED`, `UNAVAILABLE` (sin Redis o Redis caído: encuestas, recap, moderación y trivias; con Redis caído, el `chat_send` de los participantes falla cerrado porque no se puede comprobar el silencio).

**Host/cohost** = un HS256 de identity-api ligado a la sala con `role` `host` o `cohost` (el sync-ticket). Un Firebase ID token no dice de qué sala es dueño el usuario, así que **no** da permisos de moderación (falla cerrado): la web debe abrir `/ws/social` con el sync-ticket para usar láser, encuestas, moderación del chat y trivias (y para quedar exenta del modo lento y del silencio).

**`my_vote`:** el broadcast es el mismo para todos, así que solo los mensajes dirigidos a un cliente (al entrar y la respuesta a su propio voto) llevan `my_vote`; los broadcasts lo omiten y el cliente conserva el último que conoció para ese `poll_id`.

**Encuestas multirréplica:** cada réplica con clientes en la sala agenda un timer de cierre a `closes_at_ms` (reloj y `AfterFunc` inyectables); cerrar es idempotente (`HSETNX closed`) y solo la réplica que gana emite el `poll_state` final. Si una encuesta vencida no se cerró (p. ej. réplicas reiniciadas), se cierra cuando alguien entra. Votar después de `closes_at_ms` ya da `POLL_CLOSED` aunque el cierre no se haya emitido.

**Moderación del chat:** el modo lento y el silencio se comprueban en un solo Lua (`SISMEMBER` + `SET room:{id}:chat:last:{sub} NX PX`), después de validar el mensaje y del límite de 5/s: un mensaje rechazado no consume la ventana. Se aplican por `sub`, así que valen entre pestañas y réplicas. Host y cohost quedan exentos de ambos. Sin Redis (modo memoria) el chat funciona sin moderación.

**Spoilers:** `spoiler` es opcional y retrocompatible; el servidor solo lo transporta y lo persiste. Difuminar el texto es cosa de la web.

**Trivias:**
- **Disparo:** cada réplica con clientes en la sala mantiene un timer hacia la próxima pregunta pendiente con `at_ms ≥ posición`, donde posición = `recap.Store.Position(now)` = `pos + (now − seen_at_ms) × rate` desde `last_pos`. Se rearma en cada evento de sync del relay, al programar o borrar y al entrar alguien; solo hay timer si el vídeo se reproduce. Al vencer, el Lua `launch` (`HSETNX launched`) deja que una sola réplica emita `trivia_question`. Un `SEEK` que salta la marca no la dispara: queda pendiente y sale si se vuelve atrás. Si el timer vence con la posición más de 1 s por debajo de la marca (un evento perdido), no lanza y se rearma.
- **Relojes:** la proyección usa `seen_at_ms` (reloj de social-core al procesar el evento de sync), nunca `updated_at_ms` (reloj de sync-core). `elapsed` de una respuesta = `now(servidor) − opens_at_ms`; el reloj del cliente no interviene.
- **Puntaje:** `trivia.Score(correcta, elapsed)`: 0 si falla; 1000 + bono lineal hasta 1000 si acierta dentro de 10 s. `trivia_ack` devuelve ese puntaje al instante (así que revela si acertó antes del cierre).
- **Cierre:** cada réplica agenda el cierre a `closes_at_ms` (al lanzarla o al ver el `trivia_question` de otra); `HSETNX closed` deja que una sola emita `trivia_result`. Entre réplicas viaja sin `my_score`/`my_total` y cada una lo personaliza para sus conexiones (puntos de esta pregunta y acumulados; 0 si no respondió). Una pregunta vencida que nadie cerró (réplicas reiniciadas) se cierra cuando alguien entra.
- **Límites conocidos:** las preguntas son de la sala, no del vídeo: tras un `LOAD` de otro vídeo, las pendientes siguen programadas por posición. `trivia_schedule_state` solo se envía a quien programa, borra o lista (y a los moderadores al entrar); otro cohost conectado no lo recibe en vivo.

**Recap:** pausas = `PAUSE`; rebobinados = `SEEK` que cae más de 1 s por debajo de la posición proyectada del ancla previa (`last_pos`; si se reproducía, avanza con `updated_at_ms` y `rate`). Los eventos con `version` menor que el ancla llegaron tarde y no la mueven. Solo se cuentan los eventos que ve alguna réplica con clientes en la sala (la suscripción existe mientras haya conexiones). Empates: bucket más temprano y `user_id` menor. Sin Redis, láser funciona en una réplica; encuestas y recap responden `UNAVAILABLE`.

## Autenticación de `/ws/social`
El verificador se elige por el `alg` del header del token; nada se acepta sin firma válida y todo falla cerrado.

| Token | Quién | Verificación |
| :--- | :--- | :--- |
| HS256 (guest token o sync-ticket de identity-api) | Invitado | Firma con `JWT_SECRET`, `iss` = `JWT_ISSUER`, `aud` = `JWT_AUDIENCE`, `exp` obligatorio, `sub` y `jti` no vacíos, `room_id` = sala (si no, 403). Un HS256 inválido **no** cae al camino de host. |
| RS256 (Firebase ID token) | Host | Firma contra el certificado del `kid` ([certificados públicos de Google](https://www.googleapis.com/robot/v1/metadata/x509/securetoken@system.gserviceaccount.com), caché según `Cache-Control max-age`, refetch ante `kid` desconocido como mucho 1/min); `iss` = `https://securetoken.google.com/<FIREBASE_PROJECT_ID>`, `aud` = `FIREBASE_PROJECT_ID`, `exp` e `iat` obligatorios, `sub` no vacío. Sin `FIREBASE_PROJECT_ID` o sin certificados → 401. |

**Revocación (contrato con identity-api):** en el handshake se consulta `EXISTS token:revoked:{jti}` (revocado → 401; Redis caído → 503). La suscripción Pub/Sub de cada sala con clientes locales escucha también `room:{id}:sync` y, ante `type: "REVOKED"`, cierra con **4001** los sockets de ese `jti` (borrar una sala revoca todos sus `jti`). Sin `REDIS_URL` (modo memoria) no hay fuente de revocación.

**Conexiones:** ping cada 20 s (10 s para el pong) y plazo de 5 s por escritura; una conexión muerta se corta y emite el aviso de salida. Los orígenes del handshake se limitan con `ALLOWED_ORIGINS`.

## Analítica (`analytics:events`)
Contrato: [docs/contrato-eventos-analitica.md](../../docs/contrato-eventos-analitica.md). Lo publica `internal/analytics`, con el mismo patrón que la telemetría de sync-core:

- **No bloqueante:** los `Track*` de `Deps` solo encolan en un canal con buffer (4096); una goroutine (`Emitter.Run`, arrancada en `server.Run`) hace `XADD analytics:events MAXLEN ~ 100000`. Con el buffer lleno el evento se descarta y se cuenta (`Dropped`); un `XADD` fallido se cuenta (`Failed`) y solo se registra en el log.
- **Sin `REDIS_URL`** (modo memoria) los `Track*` quedan en `nil`: no se publica nada.
- **Campos comunes:** `event_id`, `type`, `source=social-core`, `room_id`, `user_id` (`sub` del token), `occurred_at` y `received_at` (RFC 3339 UTC con milisegundos). **Nunca** `text` ni `nick` (Ley 1581).

| `type` | Cuándo | Campos propios | `event_id` |
| :--- | :--- | :--- | :--- |
| `chat_message` | Mensaje aceptado (tras validación y límite) | `message_length` (runas tras recortar) | El del `chat_message` difundido |
| `presence` | Se emite un aviso `joined`/`left` (el `left`, tras la gracia de 5 s; multipestaña y reingresos dentro de la gracia no generan evento) | `kind` (`joined`, `left`), `connected_users` | El del aviso (`notice`) |
| `reaction` | Reacción aceptada (después del límite de 5/s) | `emoji`, `position_ms` | El de la `reaction` difundida |
| `trivia_answer` | Respuesta de trivia aceptada y evaluada (no las rechazadas ni las repetidas) | `question_id` (`trivia_id`), `correct` (`true`/`false`), `response_ms` (reloj del servidor) | Propio (no hay broadcast de la respuesta) |

**Limitación de `connected_users`:** es el conteo de usuarios distintos con presencia **en esta réplica** (incluye a quien acaba de salir y sigue dentro de la gracia), tomado bajo el mismo lock que el cambio. La presencia no se comparte entre réplicas: con varias réplicas, cada una publica su propio conteo y Analítica no debe sumarlos como si fueran globales.


## Variables de entorno
| Variable | Por defecto | Uso |
| :--- | :--- | :--- |
| `SOCIAL_CORE_ADDR` | `:8082` | Dirección de escucha |
| `JWT_SECRET` | — (**obligatoria**: sin ella no arranca) | Secreto HS256 compartido con identity-api |
| `JWT_ISSUER` | `tint-identity` | `iss` esperado en tokens HS256 |
| `JWT_AUDIENCE` | `tint:room` | `aud` esperado en tokens HS256 |
| `FIREBASE_PROJECT_ID` | — (vacía = se rechazan los host tokens) | Proyecto Firebase de los host tokens |
| `ALLOWED_ORIGINS` | `localhost:5173,127.0.0.1:5173` | Patrones de origen (host[:puerto]) aceptados en el handshake; en compose sale de `SOCIAL_ALLOWED_ORIGINS` |
| `REDIS_URL` | — (vacía = memoria, una réplica) | Historial, Pub/Sub entre réplicas, revocación, encuestas, recap, moderación del chat, trivias y analítica |

## Reglas de Dominio
1. **Bucketing & Rate Limiting:** Limita las reacciones a 5/s por usuario, el láser a 30/s y votos/recap a 10/s. Agrupa datos en buckets de 5 segundos.
2. **Heatmaps (previsto, sin implementar):** emitir el evento de Heatmap en vivo cada 1 s. Consulta el histórico acumulado si existen ≥ 3 sesiones previas.
3. **Trivias:** Calcula el puntaje bonificando la velocidad (hasta 10 000 ms) con el reloj del servidor. Persiste los Leaderboards en Sorted Sets de Redis con TTL de 1 hora post-cierre de sala (12 h de gracia + 1 h, renovado en cada respuesta).
4. **TDD:** Pruebas rigurosas (prueba primero) de algoritmos de puntuación y límites de tasa, con relojes inyectados (nunca `time.Sleep` en tests). Cobertura mínima: **85%**.

## Comandos
```bash
go vet ./...
go test -race -coverprofile=coverage.out ./...
../../scripts/check-go-coverage.sh coverage.out 85
```
