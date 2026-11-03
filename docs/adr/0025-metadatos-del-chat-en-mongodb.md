# ADR 0025 — Metadatos del chat en MongoDB, sin el texto de los mensajes

| Campo | Valor |
| :--- | :--- |
| **Estado** | Propuesta |
| **Fecha** | 2026-11-02 |
| **Dominios afectados** | social-core, Infraestructura |

## Contexto

SOC-07 y DAT-02 piden guardar el chat en MongoDB para no cargar la base relacional. Se aclaró que MongoDB **no debe guardar los mensajes** (el texto), sino sus **metadatos**: longitud y hora de envío, entre otros. El ID del dispositivo se descartó (ver Alternativas).

Hoy:

1. El texto vive solo en Redis (`room:{id}:chat:history`, últimos 100 mensajes, TTL 12 h) para quienes llegan tarde (SOC-02) y para el `GET …/chat` del host. Eso no cambia.
2. social-core ya calcula la longitud en runas al aceptar un mensaje y la publica en `analytics:events` (`chat_message`, `message_length`). Nunca publica `text` ni `nick` (Ley 1581).
3. El mensaje aceptado tiene `occurred_at` (reloj del navegador, acotado con `ClampOccurred`) y `received_at` (reloj del servidor).
4. El contenedor `mongodb` existe (ADR 0017), pero ningún servicio lo usa.

**Diferencias con la HU** (hay que actualizarlas en el tablero):

- **AC1** dice "un documento con sala, autor, texto y hora". Con esta decisión el documento **no lleva el texto**.
- **AC3** dice "si MongoDB está caído, el usuario ve un error de entrega". Se decidió lo contrario: **una caída de MongoDB no debe impedir chatear**. Redacción propuesta: "Dado que MongoDB está caído, cuando se envía un mensaje, entonces se entrega y sus metadatos se guardan cuando MongoDB se recupera".

## Decisión

### 1. Un documento por intento de envío, sin texto ni apodo

Colección `chat_message_meta` en la base `social` de la instancia `mongodb` actual. Solo la escribe social-core.

| Campo | Tipo | Origen |
| :--- | :--- | :--- |
| `_id` | string | `event_id` del `chat_message` difundido. Hace idempotente el reintento y evita duplicados entre réplicas |
| `room_id` | string | Sala del token |
| `author` | string | Seudónimo: `HMAC-SHA256(CHAT_META_PEPPER, room_id + ":" + sub)` en hex. Distinto en cada sala; no se puede revertir sin el secreto |
| `role` | string | `host`, `cohost` o `participant` |
| `is_guest` | bool | Token de invitado (HS256 sin rol de moderación) |
| `status` | string | `accepted` o `rejected` |
| `reject_reason` | string \| ausente | `MUTED` o `SLOW_MODE` (ver §3) |
| `length` | int | Runas tras recortar el texto, igual que `message_length` |
| `words` | int | Palabras separadas por espacios |
| `emojis` | int | Emojis del texto |
| `has_link` | bool | Si contiene `http://`, `https://` o `www.` |
| `spoiler` | bool | Si se marcó como spoiler |
| `sent_at` | date | `occurred_at` del navegador, ya acotado (`ClampOccurred`) |
| `received_at` | date | Reloj del servidor. **Es la hora de referencia** |
| `latency_ms` | int | `received_at − sent_at`, solo orientativo (relojes distintos) |
| `room_kind` | string | `watch` o `live` (`room:{id}:kind`) |
| `position_ms` | int \| null | En `watch`, posición del vídeo (`recap.Store.Position`). `null` si no hay ancla |
| `stream_offset_ms` | int \| null | En `live`, `received_at − started_at_ms` (`room:{id}:stream:started_at`). `null` sin `STREAM_STARTED` |
| `slow_mode_s` | int | Modo lento vigente al enviar (0 = apagado) |
| `client` | objeto | `{platform, browser, os}` en familias amplias (`web`/`android`/`unknown`, `chrome`/`firefox`/`safari`/`other`, `windows`/`macos`/`linux`/`android`/`ios`/`other`), derivadas del `User-Agent` del handshake. Nunca el `User-Agent` completo |

El texto se usa para calcular `length`, `words`, `emojis` y `has_link` y se descarta. **Nunca** se guardan `text`, `nick`, `sub` en claro, identificadores de dispositivo ni la IP.

### 2. Índices, validación y retención

- `{room_id: 1, received_at: 1}`: consulta por sala y rango de tiempo (SOC-07 AC2, DAT-02 AC2).
- Índice TTL sobre `received_at` con `expireAfterSeconds` = `CHAT_META_RETENTION_DAYS` (90 días por defecto, como la retención de ANA-03).
- Validador `$jsonSchema` con `validationLevel: moderate`: exige `_id`, `room_id`, `author`, `status`, `length` y `received_at` con su tipo, y **admite campos extra** (DAT-02 AC3).
- Los índices y el validador los crea social-core al arrancar, de forma idempotente.

### 3. Escritura diferida: el chat no depende de MongoDB

El envío nunca espera a MongoDB. social-core deja los metadatos en una cola y los escribe en segundo plano:

1. **Al aceptar un mensaje** (o al rechazarlo por `MUTED` o `SLOW_MODE`) se calcula el documento y se hace `XADD chat:meta:outbox MAXLEN ~ 100000` en la Redis que ya usa social-core (`REDIS_URL`). Después se guarda en el historial y se difunde como hoy. El chat ya depende de esa Redis para la moderación, así que no se añade ninguna dependencia nueva al envío.
2. **Un escritor en segundo plano** por réplica (grupo `chat-meta-writer`) lee la cola en lotes y hace `insertMany` desordenado en MongoDB. Confirma (`XACK`) y borra (`XDEL`) cada lote solo después de escribirlo, así el tamaño de la cola es exactamente lo que falta por escribir. Un `_id` repetido (error `11000`) cuenta como escrito: la escritura es idempotente.
3. **Si MongoDB cae**, los lotes quedan pendientes y el escritor reintenta con espera creciente (de 1 s hasta 30 s). Al volver MongoDB se vacía la cola sin duplicados. Los pendientes de una réplica caída los reclama otra con `XAUTOCLAIM`, igual que media-worker.
4. **Límite:** la cola guarda hasta unos 100 000 documentos (~40 MB). Si MongoDB está caído tanto tiempo que la cola se llena, `MAXLEN` descarta los más antiguos: se pierden metadatos, nunca mensajes. El escritor avisa en el log cuando la cola pasa del 90 %. Si el registrador en memoria (4096) se llena porque Redis no responde, también descarta y cuenta.
5. `/healthz` (ADR 0021) sigue respondiendo `200` con MongoDB caído e informa `chat_meta: degraded` y el tamaño de la cola.

**No se encolan** `RATE_LIMITED`, `INVALID_PAYLOAD` ni `TEXT_TOO_LONG`: ocurren antes del límite de 5/s y encolarlos permitiría inundar la cola.

Sin `MONGO_URI`, sin `CHAT_META_PEPPER` o sin `REDIS_URL` (pruebas y modo memoria) no se encola nada y el chat funciona como hoy.

### 4. Configuración

- `MONGO_URI` de social-core: se construye en `docker-compose.yml` con el usuario de aplicación `MONGO_APP_USER` (`social_core` por defecto) y su secreto `MONGO_APP_PASSWORD`, con `readWrite` sobre la base `social` y un rol propio `chat_meta_schema` que solo permite `collMod` en esa base (lo usa `EnsureSchema` para actualizar el validador y el TTL en cada arranque; `readWrite` no lo incluye); nunca el usuario raíz ni `dbAdmin`. El servicio `mongo-init` crea el usuario o actualiza su contraseña y roles en cada arranque (idempotente, también con un volumen ya inicializado). social-core no depende de `mongodb` para arrancar.
- `MONGO_APP_PASSWORD` y `CHAT_META_PEPPER` son secretos nuevos: van en `.env.example`, `env-check` y `gateway/tests/test_secrets.py`, como pide ADR 0022. `CHAT_META_PEPPER` es el secreto de los seudónimos. Si se rota, los seudónimos dejan de enlazar con los anteriores (aceptado).
- `CHAT_META_RETENTION_DAYS`: 90 por defecto.
- Dependencia nueva en social-core: el driver oficial `go.mongodb.org/mongo-driver/v2`, con versión exacta y justificada en su `AGENTS.md`.

### 5. Verificación

| Criterio | Prueba |
| :--- | :--- |
| SOC-07 AC1 / DAT-02 AC1 | Integración con MongoDB real: tras un `chat_send` existe el documento con sus campos y **sin** `text` ni `nick` |
| SOC-07 AC2 / DAT-02 AC2 | `explain()` de la consulta por sala y rango de tiempo usa el índice `{room_id, received_at}` (`IXSCAN`) |
| SOC-07 AC3 (nueva redacción) | Con MongoDB detenido, los mensajes se entregan a toda la sala; al volver MongoDB aparecen sus documentos, sin duplicados |
| DAT-02 AC3 | Un documento con un campo extra se acepta; uno sin `room_id` se rechaza |
| Seudónimos | El mismo `sub` da el mismo `author` en una sala y uno distinto en otra |

## Plan de PR

1. **social-core:** cola `chat:meta:outbox`, escritor en segundo plano, almacén de metadatos (driver, índices, validador), cálculo de campos, `client` desde el `User-Agent` y las pruebas de integración.
2. **Infra:** servicio `mongo-init` (usuario de aplicación), `MONGO_URI` de social-core, `MONGO_APP_PASSWORD`, `CHAT_META_PEPPER` y `CHAT_META_RETENTION_DAYS` en `.env.example` y `env-check`, pruebas de secretos, MongoDB en el job de Go del CI y `make env-sync` (`scripts/env_sync.py`, que también ejecuta `make up`) para que quien ya tiene un `.env` reciba las variables nuevas sin editarlo a mano. Se fusiona **después** del 1 (sus pruebas leen este ADR); hasta entonces social-core no recibe `MONGO_URI` y no escribe nada.

## Alternativas consideradas

- **Guardar el texto en MongoDB.** Descartado: se pidió guardar solo metadatos y el texto ya se conserva 12 h en Redis.
- **Guardar `sub` en claro.** Descartado: es un identificador personal persistente (Ley 1581). El seudónimo por sala permite contar y agrupar sin seguir a una persona entre salas.
- **Escribir en MongoDB antes de entregar el mensaje** (lo que pide el AC3 original). Garantiza que no haya mensajes sin metadatos, pero una caída de MongoDB deja a toda la plataforma sin chat. Se descarta: el chat es más importante que sus metadatos.
- **Escribir en MongoDB en una goroutine sin cola.** No bloquea, pero con MongoDB caído los metadatos se pierden. La cola en Redis los conserva hasta que vuelva.
- **Guardar el ID del dispositivo.** El `deviceId` solo existe en identity-api (`guest_sessions.device_id`); traerlo exigía un claim nuevo en el token de invitado, solo cubría a los invitados y añadía un identificador personal persistente. Se descarta; si se pide más adelante, puede añadirse como campo extra sin rehacer la colección (el validador admite campos nuevos).

## Consecuencias

**Positivas:** MongoDB no guarda contenido personal; los metadatos permiten medir participación, ritmo del chat por minuto del vídeo o del directo, efecto del modo lento y plataformas usadas.

**Negativas y riesgos:**
- Mientras MongoDB está caído los metadatos llegan con retraso; si la caída supera la capacidad de la cola, se pierden los más antiguos (nunca los mensajes).
- Cada mensaje añade un `XADD` a Redis (submilisegundo) y una escritura diferida en MongoDB.
- Se debe cambiar la redacción de SOC-07 AC3 en el tablero.
- Parte de los datos se solapa con `chat_message` de `analytics:events`; analytics sigue siendo la fuente de los KPIs.

## Preguntas abiertas

- Metadatos del directo (DAT-02): pendiente elegir si los guarda social-core a partir de los eventos de stream-core o cada servicio en su propia instancia.

## Referencias

- `services/social-core/internal/server/social.go` (aceptación del `chat_send`), `services/social-core/internal/socialevent/event.go`.
- [ADR 0017](0017-despliegue-orientado-a-contenedores.md), [ADR 0022](0022-secretos-por-variables-de-entorno.md), [contrato de eventos de analítica](../contrato-eventos-analitica.md).
