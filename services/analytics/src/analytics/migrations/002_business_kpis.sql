-- 002_business_kpis: QoS/QoE y razón de cierre en room_kpis, heatmap normalizado por sala
-- y usuarios activos por día (DAU/MAU).

ALTER TABLE room_kpis
    ADD COLUMN IF NOT EXISTS avg_rtt_ms DOUBLE PRECISION NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS p95_drift_ms DOUBLE PRECISION NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS total_buffering_ms BIGINT NOT NULL DEFAULT 0,
    -- deleted | host_closed | grace_expired (NULL en cierres anteriores a esta migración)
    ADD COLUMN IF NOT EXISTS close_reason TEXT NULL;

-- Reacciones por tramo de 5 s de la posición del vídeo; density = reactions / máximo de la sala.
CREATE TABLE IF NOT EXISTS room_heatmap (
    room_id TEXT NOT NULL,
    bucket_start_ms BIGINT NOT NULL,
    reactions INTEGER NOT NULL,
    density DOUBLE PRECISION NOT NULL,   -- 0 a 1
    PRIMARY KEY (room_id, bucket_start_ms)
);

-- Resumen de negocio: no se purga (la telemetría cruda sí, a los 90 días).
CREATE TABLE IF NOT EXISTS daily_active_users (
    day DATE PRIMARY KEY,                -- día local (ANALYTICS_TIMEZONE)
    dau INTEGER NOT NULL,                -- usuarios distintos con user_login ese día
    mau INTEGER NOT NULL,                -- usuarios distintos en los 30 días que terminan ese día
    computed_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS telemetry_events_type_occurred_idx
    ON telemetry_events (type, occurred_at);
