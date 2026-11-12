# Prueba de carga de la ingesta de analítica (ANA-TEST-01)

Script [k6](https://k6.io) que publica **1.000 eventos de telemetría por segundo** en `analytics:events` (con `XADD`, igual que los productores reales) y comprueba las dos mitades del desacoplamiento:

- que **publicar no le cuesta nada** a quien publica (lo único que la telemetría le añade a un play, un mensaje o una reacción), y
- que el **worker de Python se pone al día**: al terminar la ráfaga el grupo `analytics-workers` queda con `lag = 0` y sin pendientes.

Los eventos cumplen el [contrato](../../../docs/contrato-eventos-analitica.md) (sin texto ni PII) y mezclan `drift_correction` (40 %), `reaction` (30 %), `chat_message` (20 %) y `presence` (10 %), todos en una sala `loadtest-<timestamp>`.

## Cómo ejecutarla

```bash
# 1. Infraestructura y analytics (desde la raíz del monorepo)
docker compose up -d postgres redis analytics

# 2. Prueba completa: 1.000 eventos/s durante 60 s
k6 run services/analytics/loadtest/ingest.js

# Humo rápido
k6 run -e RATE=200 -e DURATION=5s services/analytics/loadtest/ingest.js

# Sin k6 instalado
docker run --rm --network host -v "$PWD/services/analytics/loadtest:/lt:ro" \
  grafana/k6:0.54.0 run /lt/ingest.js
```

> Úsala contra un entorno local o desechable, no contra el despliegue: deja decenas de miles de filas en `telemetry_events`. Para limpiarlas: `DELETE FROM telemetry_events WHERE room_id LIKE 'loadtest-%';` (y lo mismo en `room_kpis` y `room_heatmap` si la sala llegó a consolidarse).

### Variables (`-e NOMBRE=valor`)

| Variable | Por defecto | Descripción |
| :--- | :--- | :--- |
| `REDIS_URL` | `redis://localhost:6379` | El Redis que lee analytics. |
| `RATE` | `1000` | Eventos por segundo. |
| `DURATION` | `60s` | Duración de la ráfaga (`ms`, `s`, `m`, `h`). |
| `ROOM_ID` | `loadtest-<timestamp>` | Sala de los eventos. |
| `DRAIN_TIMEOUT_S` | `120` | Tope de espera a que el worker quede al día. |
| `MAX_VUS` | `200` | Tope de VUs que k6 puede crear para sostener la tasa. |
| `STREAM` / `GROUP` | `analytics:events` / `analytics-workers` | Deben coincidir con el servicio. |

## Cómo leer los resultados

| Métrica | Qué mide | Umbral |
| :--- | :--- | :--- |
| `analytics_xadd_ms` | Duración de cada `XADD` visto por el productor. | `p(95) < 20`, `p(99) < 50` |
| `analytics_xadd_errors` | `XADD` fallidos. | `count == 0` |
| `dropped_iterations` | Iteraciones que k6 no pudo lanzar: si sube, no se sostuvo la tasa pedida. | `< 1 %` |
| `analytics_drain_s` | Segundos entre el fin de la ráfaga y `lag = 0` con `pending = 0` en `XINFO GROUPS`. | `max < DRAIN_TIMEOUT_S` |
| `analytics_lag_after_drain` | Eventos sin consumir o sin confirmar al terminar la espera. | `max == 0` |
| `analytics_events_published` | Total publicado (etiqueta `type`). | informativo |

k6 marca con ✓/✗ cada umbral y termina con código distinto de 0 si alguno falla. Para confirmar que no se perdió nada:

```sql
SELECT count(*) FROM telemetry_events WHERE room_id = 'loadtest-…';  -- = analytics_events_published
```

Si falla:

- **`analytics_drain_s` en el tope y `lag` > 0:** el worker no da abasto. Revisa que siga insertando por lotes (`DEFAULT_COUNT` en `consumer.py`, una transacción por lote) y la latencia de commit de PostgreSQL. Ojo: el stream se recorta a ~100.000 entradas (`MAXLEN ~`), así que un atraso sostenido termina **perdiendo eventos**.
- **`lag = -1`:** el grupo `analytics-workers` no existe: analytics no ha arrancado contra ese Redis.
- **`analytics_xadd_ms` alto:** Redis saturado; no depende de analytics.

## Aislamiento respecto al Canal Sync

Para comprobar que la ingesta no degrada la reproducción, corre a la vez la prueba de [sync-core](../../sync-core/loadtest/README.md) contra el mismo Redis y verifica que sus umbrales siguen pasando:

```bash
k6 run -e DURATION=30s services/analytics/loadtest/ingest.js &
k6 run -e VUS=200 -e DURATION=30s -e ROOM_ID=sala-aislamiento services/sync-core/loadtest/sync.js
```

## Resultados medidos (2026-10-12)

Un portátil de 12 hilos con Redis 7, PostgreSQL 16, analytics y k6 0.54 en la misma máquina.

| Corrida | Publicado | `XADD` p95 | Al día tras la ráfaga | Persistido |
| :--- | :--- | :--- | :--- | :--- |
| 1.000/s × 60 s, una transacción **por evento** (antes) | 60.000 | 1 ms | No: `lag` 18.219 a los 120 s (~230 eventos/s) | 42.995 a los 120 s |
| 1.000/s × 60 s, una transacción **por lote** | 60.000 | 1 ms | 0,5 s | 60.000 |
| 5.000/s × 20 s, por lote | 100.000 | 2 ms | 24,6 s (~2.240 eventos/s sostenidos) | — |

Aislamiento (200 conexiones al Canal Sync durante 30 s): `sync_broadcast_latency_ms` p95 de 75 ms sin ingesta y de 13 ms con 1.000 eventos/s a la vez; todos los umbrales de sync-core pasan en ambos casos, así que la diferencia es ruido entre corridas y no un efecto de la ingesta.
