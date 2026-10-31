# 🤖 AGENT Guidelines — Domain: Analytics & Insights (`services/analytics`)

## Contexto & Responsabilidad
Eres el cerebro de inteligencia de negocio de **TINT**. Ingieres eventos desde Redis Streams (`XADD analytics:events`), procesas datos mediante `XREADGROUP` en Python, los persistes en PostgreSQL y entregas al host una **lectura diferida** de los KPIs de su sala.

El contrato de eventos (qué publica cada servicio) está en [docs/contrato-eventos-analitica.md](../../docs/contrato-eventos-analitica.md); este dominio es su dueño.

Cómo funciona el servicio por dentro (ingesta, sanitización, KPIs y API): [README.md](README.md).

## Stack Técnico
| Pieza | Versión | Por qué |
| :--- | :--- | :--- |
| Python | 3.11 | Igual que media-worker. |
| `psycopg[binary]` | `==3.2.13` | Driver PostgreSQL; la misma versión que media-worker. |
| `redis` | `==5.2.1` | `XREADGROUP`/`XACK` de `analytics:events` y consulta de `token:revoked:{jti}`; la misma versión que media-worker. |
| `PyJWT` | `==2.9.0` | Verificar el `analytics-ticket` HS256 (`iss`, `aud`, `exp`, `jti`) en la API. Es la única dependencia nueva respecto a media-worker. |
| HTTP | stdlib (`http.server.ThreadingHTTPServer`) | La API son tres GET de solo lectura: no justifica un framework. |
| SQL | Plano y versionado (`src/analytics/migrations/NNN_*.sql`) | Se aplica al arrancar; la tabla `schema_migrations` registra lo aplicado. |
| Pruebas | pytest 8.3.3, pytest-cov 5.0.0, ruff 0.6.9 | Dobles en `tests/fakes.py`; integración opcional con PostgreSQL real. |

## Estructura
| Módulo | Qué hace |
| :--- | :--- |
| `sanitize.py` | Contrato mínimo del evento y Privacy by Design (descarta texto libre y PII). |
| `kpis.py` | Funciones puras: `compute_room_kpis`, `reaction_heatmap`, `heatmap_density`, `reactions_by_emoji`, `timeline`. |
| `db.py` + `migrations/` | Migraciones, `EventStore` (escritura del consumidor) y `ReadRepository` (lecturas de la API). |
| `consumer.py` | `XREADGROUP` → `sanitize` → `INSERT … ON CONFLICT DO NOTHING` → `XACK`; mantenimiento horario (cierre por gracia, purga de 90 días, DAU/MAU). |
| `api.py` | API HTTP de solo lectura (`AnalyticsApi.handle` sin sockets + `create_server`). |
| `audit.py` | Auditoría de privacidad sobre la BD (`python -m analytics.audit`, solo lectura). |
| `config.py`, `__main__.py` | Variables de entorno; migra y arranca consumidor, mantenimiento y API en hilos; apagado con SIGTERM. |

## Responsabilidades
- Consumo asíncrono y sanitización de eventos (`sanitize.py`, `consumer.py`).
- Cálculo de KPIs consolidados por sala al recibir `room_closed` o al agotarse su periodo de gracia (`kpis.py`, `db.py`).
- Resumen diario de usuarios activos (DAU/MAU) a partir de `user_login`.
- Políticas de retención (90 días) y purga periódica (cada hora).
- API de lectura diferida de KPIs, heatmap de reacciones y línea de tiempo para el host de la sala.

## Límites de Dominio
- ❌ No bloquees ni llames de forma síncrona a `sync-core` o `social-core`: solo consumes el stream.
- ❌ No almacenes PII ni contenido de chat (Ley 1581 de 2012 — Habeas Data, Colombia).
- ❌ Solo lectura diferida de KPIs: **nunca** endpoints de tiempo real (WebSocket, SSE, polling de presencia) **ni de eventos crudos**. La API devuelve agregados de una sala a su host y, con la contraseña del equipo, el panel de negocio (también solo agregados: sin `user_id` ni títulos de sala).
- ❌ No emites tokens: el `analytics-ticket` lo firma identity-api; aquí solo se verifica.

## Modelo de Datos Involucrado
| Entidad | Almacén | Campos clave |
| :--- | :--- | :--- |
| `analytics:events` | Redis Stream (grupo `analytics-workers`) | Campos planos del [contrato](../../docs/contrato-eventos-analitica.md) |
| `schema_migrations` | PostgreSQL | `version` (PK), `applied_at` |
| `telemetry_events` | PostgreSQL | `event_id` (PK), `type`, `room_id` (NULL en `user_login`/`media_processed`), `user_id` (NULL sin actor), `source`, `occurred_at`, `received_at` (`timestamptz`), `payload` JSONB (evento sanitizado). Índices `(room_id, type)` y `(occurred_at)`. Retención 90 días. |
| `room_kpis` | PostgreSQL | `room_id` (PK), `peak_users`, `avg_users`, `avg_drift_ms`, `trivia_accuracy_pct`, `messages`, `reactions`, `playback_commands`, `buffering_events`, `avg_buffering_ms`, `avg_rtt_ms`, `p95_drift_ms`, `total_buffering_ms`, `close_reason` (`deleted`, `host_closed`, `grace_expired`), `closed_at`, `computed_at` |
| `room_heatmap` | PostgreSQL | `(room_id, bucket_start_ms)` (PK), `reactions`, `density` (0 a 1). Tramos de 5 s; se reemplaza al consolidar la sala. |
| `daily_active_users` | PostgreSQL | `day` (PK, día en `ANALYTICS_TIMEZONE`), `dau`, `mau` (30 días), `computed_at`. No se purga. |
| `token:revoked:{jti}` | Redis (escribe identity-api) | Solo lectura: revoca el `analytics-ticket` |

KPIs: `peak_users`/`avg_users` salen de `connected_users` de `presence` (promedio simple de las muestras); `avg_drift_ms` es el promedio de `|drift_ms|` de `drift_correction`; `trivia_accuracy_pct` de `trivia_answer.correct`; los conteos, del número de eventos de cada tipo; `avg_buffering_ms` y `total_buffering_ms`, de `buffering.duration_ms`; `avg_rtt_ms` y `p95_drift_ms`, de `rtt_ms` y `|drift_ms|` de `drift_correction`. QoS = RTT y drift; QoE = buffering. Los valores llegan de Redis como texto y se interpretan con tolerancia (`"3"`, `"true"`).

## API (solo lectura, puerto `ANALYTICS_PORT`, por defecto 8084)
Auth: `Authorization: Bearer <analytics-ticket>` (lo emite identity-api en `POST /api/v1/rooms/:id/analytics-ticket`). HS256 con `JWT_SECRET`, `iss` = `JWT_ISSUER`, `aud` = `JWT_AUDIENCE`; `exp` y `jti` obligatorios. `role` debe ser `host` y `room_id` igual al `{id}` de la ruta. Si existe `token:revoked:{jti}` → 401; si Redis no responde → 503 (**falla cerrado**).

Errores: `{ "error": "<mensaje>" }` con 400 (parámetro fuera de rango), 401 (sin token, firma inválida, expirado o revocado), 403 (rol o sala distintos), 404, 405 y 503 (Redis o PostgreSQL caídos). CORS según `ANALYTICS_ALLOWED_ORIGINS` (también en errores), con preflight `OPTIONS` que permite `Authorization`.

| Ruta | Respuesta |
| :--- | :--- |
| `GET /healthz` | `{"status":"ok"}` (sin token) |
| `GET /api/v1/rooms/{id}/kpis` | `{room_id, live, peak_users, avg_users, avg_drift_ms, trivia_accuracy_pct, messages, reactions, playback_commands, buffering_events, avg_buffering_ms, avg_rtt_ms, p95_drift_ms, total_buffering_ms, close_reason, closed_at, computed_at}`. `live: false` = fila de `room_kpis` (sala cerrada; un cierre `grace_expired` con actividad posterior no cuenta); `live: true` = calculado al vuelo sobre `telemetry_events` (`closed_at: null`). |
| `GET /api/v1/rooms/{id}/reactions/heatmap?bucket_ms=5000` | `{room_id, bucket_ms, buckets: [{bucket_start_ms, emoji, count}], density: [{bucket_start_ms, count, density}], by_emoji: [{emoji, count}]}`. `density` es el total del tramo entre el del tramo más activo (0 a 1). Tramos por `position_ms` del vídeo; `bucket_ms` entre 1000 y 60000. `buckets` ordenado por `bucket_start_ms` y `emoji`; `by_emoji` por `count` descendente. |
| `GET /api/v1/analytics/overview` | Panel de negocio (página `/analitica` de la web). Auth distinta: `Authorization: Bearer <ANALYTICS_ADMIN_PASSWORD>` (comparación en tiempo constante; 401 si no coincide). Sin la variable la ruta responde 404. `{generated_at, daily: [{day, dau, mau}] (30 días), events: {total, rooms, by_type: [{type, source, count}]}, rooms: [{room_id, …KPIs, close_reason, closed_at, computed_at, heatmap: [{bucket_start_ms, reactions, density}]}] (50 más recientes)}`. |
| `GET /api/v1/rooms/{id}/timeline?step_s=60` | `{room_id, step_s, points: [{t, connected_users, messages, reactions}]}`. Intervalos por `occurred_at` alineados a la época; `t` es el inicio del intervalo (RFC 3339 UTC con ms); `connected_users` es el último `presence` conocido al final del intervalo (se arrastra); `step_s` entre 10 y 3600. |

## Variables de entorno
| Variable | Defecto | Notas |
| :--- | :--- | :--- |
| `DATABASE_URL` | — (**obligatoria**) | Igual que media-worker. |
| `JWT_SECRET` | — (**obligatoria**) | El mismo de identity-api. Sin él no arranca. |
| `JWT_ISSUER` / `JWT_AUDIENCE` | `tint-identity` / `tint:room` | |
| `REDIS_URL` | `redis://localhost:6379` | |
| `ANALYTICS_PORT` | `8084` | |
| `ANALYTICS_ALLOWED_ORIGINS` | `http://localhost:5173` | Lista separada por comas, con esquema. |
| `ANALYTICS_CONSUMER` | hostname | Nombre estable por réplica para recuperar sus pendientes. |
| `ANALYTICS_ROOM_GRACE_HOURS` | `12` | Entero ≥ 0: horas sin actividad para consolidar una sala como `grace_expired` (REQ-07). |
| `ANALYTICS_TIMEZONE` | `America/Bogota` | Nombre IANA del corte del día en DAU/MAU. |
| `ANALYTICS_ADMIN_PASSWORD` | — (panel deshabilitado) | Contraseña compartida del panel de negocio. Es un control de acceso débil, pensado para el equipo: no hay usuarios ni límite de intentos. |

## Reglas de Dominio
1. **Privacy by Design (Ley 1581):** NUNCA analices o almacenes el texto plano de las conversaciones de chat. Registra únicamente `message_length` (se respeta el que envía el productor; solo se deriva si llegara texto). Se descartan también `nick`, `email` y nombres.
2. **Desacoplamiento:** Ingesta eventos asíncronamente para evitar que la telemetría bloquee la reproducción.
3. **Retención & KPIs:** Mantén la telemetría por 90 días (purga cada hora). Al recibir `room_closed`, calcula y guarda (upsert) en `room_kpis` los KPIs consolidados en la misma transacción del evento, junto con el heatmap normalizado en `room_heatmap`. Una sala sin `room_closed` se consolida igual cuando lleva `ANALYTICS_ROOM_GRACE_HOURS` sin eventos (`close_reason = grace_expired`); un cierre explícito nunca se pisa. `daily_active_users` se recalcula cada hora.
4. **Idempotencia:** Inserciones por `event_id` (`ON CONFLICT DO NOTHING`) y `XACK` solo tras el commit. Cada lote leído del stream (hasta 500 eventos) va en **una sola transacción**: es lo que permite ingerir 1.000 eventos/s ([prueba de carga](loadtest/README.md)). Un evento inválido se registra y se confirma (no envenena el stream); si PostgreSQL rechaza un dato, el lote se reintenta evento por evento para descartar solo ese; un fallo de infraestructura deja el lote pendiente y se reintenta.
5. **Falla cerrado** en la API: sin `JWT_SECRET` no arranca; sin Redis no se sirve nada autenticado (503).
6. **TDD:** Pruebas unitarias (prueba primero) de sanitización, KPIs, consumidor, SQL y API con `pytest-cov` **≥ 85 %**.

## Comandos
```bash
pip install -r requirements-dev.txt
ruff check . && ruff format --check .
pytest --cov=src --cov-fail-under=85
# Prueba de carga de la ingesta (ANA-TEST-01): 1.000 eventos/s; ver loadtest/README.md
k6 run loadtest/ingest.js
# Integración opcional con PostgreSQL real (usa un esquema temporal que se borra al terminar):
ANALYTICS_TEST_DATABASE_URL=postgresql://tint:tint@localhost:5432/tint pytest tests/test_db_integration.py tests/test_audit.py
# Auditoría de privacidad (Ley 1581) sobre la base real; sale con 1 si encuentra una violación:
DATABASE_URL=postgresql://tint:tint@localhost:5432/tint PYTHONPATH=src python -m analytics.audit
docker exec tint-analytics python -m analytics.audit   # contra el despliegue
```
