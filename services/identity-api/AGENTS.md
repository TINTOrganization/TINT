# 🤖 AGENT Guidelines — Domain: Identity (`services/identity-api`)

## Contexto & Responsabilidad
Eres el agente encargado de la **identidad** de TINT. Te ocupas de los usuarios registrados (Host), las salas, las invitaciones, las sesiones de invitado y la emisión de los tokens HS256 que sync-core verifica. También asignas el vídeo de cada sala y firmas su URL de reproducción.

Documentación de referencia: [README del servicio (cómo funciona por dentro)](README.md) · [Usuarios, identidad y permisos](../../docs/usuarios-e-identidad.md) · [Arquitectura](../../docs/arquitectura.md).

## Stack Técnico
- Node.js 22 + TypeScript 5 (ESM) + Express 5. Validación con `zod`.
- PostgreSQL con Drizzle ORM (`drizzle-kit` para migraciones).
- Auth del Host: ID tokens de Firebase (RS256) verificados con `jwks-rsa` + `jsonwebtoken`.
- Tokens propios: `jsonwebtoken` HS256 con `JWT_SECRET`.
- Redis (`ioredis`): revocación de tokens y aviso a sync-core.
- MinIO/S3 (`@aws-sdk/client-s3` + `@aws-sdk/s3-request-presigner`): URLs GET y PUT pre-firmadas, calculadas en local, `HEAD` para confirmar subidas (y su tamaño real) y `DeleteObject` para descartar las que superan el límite.
- Vitest + supertest + cobertura `v8`.

## Responsabilidades
- Crear o recuperar el usuario en cada inicio de sesión: *upsert* atómico `INSERT … ON CONFLICT (provider, provider_sub) DO UPDATE` que refresca email, nombre y avatar.
- Salas (`rooms`) e invitaciones (`invitations`, código `nanoid(12)`).
- **Guest token** (`role: participant`, 4 h) al reclamar una invitación, registrado en `guest_sessions`.
- **Sync-ticket** (`role: host`, 10 min) para el Canal Sync y **analytics-ticket** (mismos claims y TTL) para la API de lectura de analytics.
- Publicar eventos de analítica en `analytics:events` (best-effort, sin datos personales).
- Subida de vídeo: reservar (`videos`), firmar el PUT directo a MinIO, confirmar y encolar en `media:uploads`.
- Vídeo de la sala (`media_id`, `media_key`) y URL firmada de reproducción, con el estado del procesamiento.
- Salas: renombrar y borrado lógico (`status`). Borrar una sala revoca todas sus sesiones de invitado activas.
- Listar y retirar invitados: BD + `token:revoked:{jti}` + `PUBLISH REVOKED`.
- Bloquear invitados por dispositivo (`room_bans`, `deviceId` del claim) y desbloquearlos. Es una barrera contra la reentrada casual, no un control de seguridad: borrar los datos del navegador la evade ([usuarios-e-identidad §6.6](../../docs/usuarios-e-identidad.md#66-bloquear-a-un-invitado-por-dispositivo)).
- Biblioteca de vídeos del host (`GET /videos`, `PATCH /videos/:id`) y reuso de un vídeo propio en una sala (`PUT /rooms/:id/media { videoId }`).

## Límites de Dominio
- ❌ No gestiones el estado de reproducción: el Reloj Maestro es de sync-core. Aquí solo se asigna el vídeo; el `LOAD` lo envía el cliente por el Canal Sync.
- ❌ No proceses vídeo: transcodificar, `ffprobe` y Ambilight son de `services/media-worker`.
- ❌ No escribas otras claves de Redis de sync-core que no sean `token:revoked:{jti}` y el `PUBLISH` de `REVOKED` (contrato v2 §5).
- ❌ No pongas datos personales en logs ni en eventos de analítica.
- ❌ No cambies los claims de los tokens sin actualizar también `services/sync-core/internal/auth` y [usuarios-e-identidad.md](../../docs/usuarios-e-identidad.md#4-esquemas-de-tokens).

## Modelo de Datos Involucrado
| Tabla / clave | Tipo | Descripción |
| :--- | :--- | :--- |
| `users` | PostgreSQL | `id`, `provider` (`firebase`), `provider_sub`, `email`, `display_name`, `avatar_url`, timestamps. Único `(provider, provider_sub)` (migración `0005`) |
| `rooms` | PostgreSQL | `id`, `host_id` → `users`, `title` (≤150), `status` (`active`/`deleted`, borrado lógico), `media_id`, `media_key`, timestamps |
| `invitations` | PostgreSQL | `id`, `code` (único, 12), `room_id`, `created_by`, `expires_at`, `revoked` |
| `room_bans` | PostgreSQL | `id`, `room_id`, `device_id` (nullable), `sub`, `nick`, `created_at`, `created_by`. Único `(room_id, device_id)` (migración `0007`). Nunca se exponen `device_id` ni `sub` |
| `guest_sessions` | PostgreSQL | `jti` (PK), `room_id`, `sub` (`guest:<uuid>`), `nick` (≤64), `joined_at`, `expires_at`, `revoked`, `device_id` (uuid nullable, migración `0007`) |
| `videos` | PostgreSQL | `id` (= `video_id`), `room_id`, `uploaded_by`, `storage_key` (`incoming/{id}/original.*` al reservar; el worker la cambia a `{id}/source.*` al publicar), `content_type`, `size_bytes`, `duration_ms`, `status` (`pending` → `processing` al confirmar, en identity-api → `ready`/`failed`, en media-worker), `renditions` (jsonb, `[]` por defecto: alturas publicadas por media-worker en `{id}/{h}p.mp4`, migración `0006`), `title` (≤255, nullable: `filename` sin extensión al reservar, migración `0007`) |
| `token:revoked:{jti}` | Redis String | Marca de revocación con `EXAT` = `exp` del token (la lee sync-core) |
| `media:uploads` | Redis Stream | `XADD * video_id <id>` al confirmar una subida (lo consume media-worker, grupo `media-workers`) |
| `analytics:events` | Redis Stream | `XADD MAXLEN ~ 100000 *` de `user_login`, `room_created`, `room_closed` e `invitation_claimed` (lo consume analytics). Ver [Eventos de analítica](#eventos-de-analítica) |
| `room:{id}:sync` | Redis Pub/Sub | Solo se publica `REVOKED{jti}` |

ER completo y ciclos de vida en [usuarios-e-identidad.md](../../docs/usuarios-e-identidad.md#3-esquema-de-datos-postgresql).

## API
Prefijo `/api/v1`. Los errores siempre tienen la forma `{ "error": "<texto>" }`; los 400 de zod añaden `details`. Los 500 son siempre `{ "error": "Internal error" }`: el detalle se registra en el servidor y nunca llega al cliente.

| Método y ruta | Autorización | Descripción |
| :--- | :--- | :--- |
| `GET /healthz` | — | Estado del servicio |
| `POST /auth/verify` | Firebase | Verifica el token y crea o recupera el usuario |
| `POST /rooms` | Firebase | Crea sala (`title` 1–150) + invitación inicial |
| `GET /rooms` | Firebase | Salas activas del usuario, con su invitación vigente |
| `GET /rooms/:id` · `PATCH /rooms/:id` · `DELETE /rooms/:id` | Firebase + dueño | Detalle, renombrar (`{ title }` ≤ 150) y borrado lógico. El borrado revoca las sesiones de invitado activas (`token:revoked:{jti}` + `REVOKED`); si Redis falla responde 503 y repetir el `DELETE` sobre la sala ya borrada re-publica las pendientes (410 cuando termina) |
| `GET /rooms/:id/invitations` | Firebase + dueño | Invitaciones de la sala con `link` |
| `POST /rooms/:id/invitations` | Firebase + dueño | Nueva invitación (`ttlHours` opcional, entero 1–720) |
| `POST /invitations/:code/revoke` | Firebase + dueño | Cierra la invitación (no retira a quienes ya entraron). 404 si la invitación o su sala no existen, 403 si no es el dueño |
| `POST /invitations/claim` | — | `{ code, nick, deviceId? }` → `{ token, roomId, nick, roomTitle }`. `deviceId` es un UUID opcional del navegador que se guarda en `guest_sessions.device_id`. Errores: 400, 404, 409 (revocada), 410 (vencida o sala borrada), **403 `{ error: "BANNED" }`** (dispositivo bloqueado en la sala; sin `deviceId` no se comprueba) |
| `POST /rooms/:id/sync-ticket` | Firebase + dueño | Sync-ticket HS256 para `/ws/sync`. `nick` = `displayName`, si no la parte local del email, si no `Host` (nunca el email completo) |
| `POST /rooms/:id/analytics-ticket` | Firebase + dueño | `{ token, expiresAt }`: ticket de host HS256 (mismos claims y TTL que el sync-ticket, `generateHostTicket`) para la API de lectura de analytics. **Sin** `requireActiveRoom`: también se entrega para una sala borrada, para ver sus KPIs |
| `POST /rooms/:id/media/uploads` | Firebase + dueño | `{ filename, contentType: video/*, sizeBytes }` → `{ videoId, uploadUrl, storageKey, expiresAt, headers }` (PUT firmado a MinIO; 413 si supera `MAX_UPLOAD_BYTES`) |
| `POST /rooms/:id/media/uploads/:videoId/complete` | Firebase + dueño | HEAD del objeto (409 `Upload missing`; 413 y se borra si el tamaño real supera `sizeBytes` o `MAX_UPLOAD_BYTES`), `pending → processing` condicional, `XADD media:uploads` (503 si Redis falla, vuelve a `pending`) y asigna el vídeo → `{ mediaId, mediaKey, status }`. Idempotente: si ya no está en `pending` devuelve el estado actual sin re-encolar |
| `PUT /rooms/:id/media` | Firebase + dueño | `{ mediaKey }` (objeto que ya está en el bucket, `mediaId` nuevo) **o** `{ videoId }` (vídeo de su biblioteca: `mediaId = videoId`, `mediaKey = storage_key`; 404 si no lo subió él, no existe o no está `processing`/`ready`) → `{ mediaId, mediaKey }`. Enviar ambos es 400 |
| `GET /videos` | Firebase | Biblioteca: `{ videos: [{ id, title, durationMs, status, createdAt, previewUrl }] }`, los vídeos con `uploaded_by` = el host y `status` en `processing`/`ready` (subida confirmada), recientes primero. `previewUrl` firma `{id}/360p.mp4` si está `ready` con `360` en `renditions`; si no, `storage_key` |
| `PATCH /videos/:id` | Firebase + quien lo subió | `{ title }` (1–255) → `{ video }` con la forma de la biblioteca. 404 si no es suyo |
| `GET /rooms/:id/playback` | dueño **o** guest token de la sala | `{ mediaId, url, expiresAt, status, ambilightUrl, qualities }` (o `null`s y `qualities: []`). `qualities: [{ id, label, url }]`: primero `{ id: 'source', label: 'Original' }` con la misma URL que `url`; si el vídeo está `ready`, después `720p` y `360p` (de mayor a menor, solo las de `videos.renditions`) firmadas sobre `{id}/{h}p.mp4` con el mismo TTL. Un vídeo `failed` → `qualities: []` |
| `GET /rooms/:id/guests` | Firebase + dueño | Invitados de la sala (sin `sub`) |
| `POST /rooms/:id/guests/:jti/revoke` | Firebase + dueño | Retira al invitado (idempotente) |
| `POST /rooms/:id/bans` | Firebase + dueño | `{ jti }` (panel) **o** `{ sub }` (chat) → `{ ban: { id, nick, createdAt } }`. Inserta un ban por cada `device_id` de las sesiones del invitado (o uno por `sub` si ninguna lo tiene, cliente viejo) y revoca todas sus sesiones vigentes (`token:revoked:{jti}` + `REVOKED`). Idempotente; 404 si el invitado no tiene sesiones en la sala; **503** si Redis falla (el ban ya quedó guardado, reintentar) |
| `GET /rooms/:id/bans` | Firebase + dueño | `{ bans: [{ id, nick, createdAt }] }`, recientes primero |
| `DELETE /rooms/:id/bans/:banId` | Firebase + dueño | Desbloquea → `{ success: true }`; 404 si no existe en la sala |

Middlewares: `requireAuthHost`, `requireRoomOwner` (no filtra por estado de la sala), `requireRoomGuest`, `requireRoomHostOrGuest` (decide según el `alg` del JWT), `requireActiveRoom` (404/410 y `req.room`) y `validate(schema)`. Las rutas del Canal Sync y de medios responden **410** si la sala tiene borrado lógico.

### Eventos de analítica
`src/modules/analytics/analytics.events.ts` → `publishAnalyticsEvent(type, fields)`. Contrato en [contrato-eventos-analitica.md](../../docs/contrato-eventos-analitica.md).

| Ruta | `type` | Campos propios |
| :--- | :--- | :--- |
| `POST /auth/verify` | `user_login` | `method=google`, `user_id` (sin `room_id`) |
| `POST /rooms` | `room_created` | `room_id`, `user_id` |
| `DELETE /rooms/:id` | `room_closed` | `room_id`, `user_id`, `reason=deleted`. Solo el primer borrado exitoso: ni el reintento (sala ya borrada) ni el 503 emiten |
| `POST /invitations/claim` | `invitation_claimed` | `room_id`, `user_id` = `guest:<uuid>` del token emitido |

- Siempre se añaden `event_id` (UUID v4), `source=identity-api`, `occurred_at` y `received_at` (ISO UTC con ms); se omiten los campos `undefined`/`null`.
- `user_id` del host es `users.provider_sub` (uid de Firebase), **no** `users.id`. Nunca `email`, `displayName` ni `nick`.
- **Best-effort:** se llama con `void` después de responder; la promesa nunca rechaza (ni si `xadd` lanza) y el error solo se registra con el tipo del evento. Un fallo de Redis no cambia la respuesta.

## Reglas de Dominio
1. **Contratos compartidos:** los claims de los tokens, la clave `token:revoked:{jti}` y el payload `REVOKED` son contratos con sync-core. Cualquier cambio se coordina y se documenta.
2. **Falla cerrado:** si no se puede comprobar una revocación (BD o Redis caídos), responde 503; nunca aceptes el token por defecto.
3. **Secretos:** `JWT_SECRET` debe coincidir con el de sync-core. Nunca lo subas al repo; usa `.env` local.
4. **Migraciones:** todo cambio de `src/db/schema.ts` va acompañado de su migración generada con `npx drizzle-kit generate`, commiteada junto con `migrations/meta`.
5. **Dependencias inyectables:** Redis (`setRedisClient`), el firmado (`setMediaSigner`), el bucket (`setMediaStore`: `stat`/`remove`) y los repos se reemplazan por dobles en las pruebas. Las pruebas no dependen de Postgres, Redis ni MinIO reales.
6. **TDD:** prueba primero (supertest para rutas y mocks de repos). Cobertura mínima **85 %** (`vitest.config.ts`).
7. **Privacidad:** `GET /guests` y `GET /bans` nunca devuelven `sub` (ni `device_id`); no registres tokens ni emails en los logs.

## Variables de Entorno
| Variable | Por defecto | Descripción |
| :--- | :--- | :--- |
| `IDENTITY_API_PORT` | `8081` | Puerto HTTP |
| `DATABASE_URL` | `postgres://tint:tint@localhost:5432/tint` | PostgreSQL |
| `REDIS_URL` | `redis://localhost:6379` | Revocación, `media:uploads` y `analytics:events` |
| `FIREBASE_PROJECT_ID` | — (**obligatoria**) | `iss`/`aud` de los ID tokens |
| `JWT_SECRET` / `JWT_ISSUER` / `JWT_AUDIENCE` | `dev-secret-change-in-prod` / `tint-identity` / `tint:room` | Iguales que en sync-core |
| `GUEST_TOKEN_TTL_HOURS` | `4` | Vida del guest token |
| `INVITATION_DEFAULT_TTL_HOURS` | `24` | Vida de una invitación |
| `SYNC_TICKET_TTL_SECONDS` | `600` | Vida del sync-ticket y del analytics-ticket |
| `MINIO_ENDPOINT` / `MINIO_PUBLIC_ENDPOINT` | `http://localhost:9000` / = endpoint | El público es el host que ve el navegador (va dentro de la firma SigV4) |
| `MINIO_ACCESS_KEY` / `MINIO_SECRET_KEY` / `MINIO_BUCKET` / `MINIO_REGION` | `tintadmin` / `tintadmin123` / `tint-media` / `us-east-1` | Firmado |
| `PLAYBACK_URL_TTL_SECONDS` | `3600` | Vida de la URL firmada de reproducción |
| `UPLOAD_URL_TTL_SECONDS` | `900` | Vida de la URL PUT de subida |
| `MAX_UPLOAD_BYTES` | `2147483648` | Tamaño máximo de un vídeo (2 GiB) |

## Comandos
```bash
npm ci                          # sin --legacy-peer-deps
npm run dev                     # :8081 con recarga
npm run typecheck
npx vitest run --coverage       # umbral 85 %
npx drizzle-kit generate        # nueva migración tras cambiar schema.ts
npx drizzle-kit migrate         # aplica migrations/ en DATABASE_URL

# Flujo completo contra docker compose (PostgreSQL, Redis, MinIO, sync-core);
# con WAIT_WORKER=1 espera además a que media-worker deje el vídeo en ready.
npm run test:integration
```
