/**
 * Cliente de la API de lectura de Analítica (services/analytics, puerto 8084).
 *
 * El host pide un analytics-ticket a identity-api (JWT HS256 de vida corta, role=host,
 * room_id de la sala) y lo usa como Bearer contra la API de analytics. Si analytics
 * responde 401 (ticket caducado o revocado) se pide un ticket nuevo UNA vez y se
 * reintenta; si vuelve a fallar, el error sube a la página.
 */
import { apiFetch } from './api';

export const DEFAULT_ANALYTICS_API_URL = 'http://localhost:8084/api/v1';

export interface AnalyticsTicket {
  token: string;
  expiresAt: string;
}

/** GET /rooms/{id}/kpis. `live` = calculado al vuelo (sala no cerrada). */
export interface RoomKpis {
  room_id: string;
  live: boolean;
  peak_users: number;
  avg_users: number;
  avg_drift_ms: number;
  trivia_accuracy_pct: number;
  messages: number;
  reactions: number;
  playback_commands: number;
  buffering_events: number;
  avg_buffering_ms: number;
  /** QoS: latencia de red promedio (ida y vuelta) medida en las correcciones de drift. */
  avg_rtt_ms: number;
  /** QoS: el 95 % de los desfases corregidos quedó por debajo de este valor. */
  p95_drift_ms: number;
  /** QoE: tiempo total que la audiencia pasó recargando el vídeo. */
  total_buffering_ms: number;
  /** `deleted`, `host_closed` o `grace_expired` (inactividad); null si la sala sigue abierta. */
  close_reason: string | null;
  closed_at: string | null;
  computed_at: string;
}

export interface HeatmapBucket {
  bucket_start_ms: number;
  emoji: string;
  count: number;
}

/** Reacciones de un tramo (todos los emojis) y su densidad normalizada de 0 a 1. */
export interface HeatmapDensity {
  bucket_start_ms: number;
  count: number;
  density: number;
}

export interface EmojiCount {
  emoji: string;
  count: number;
}

/** GET /rooms/{id}/reactions/heatmap. */
export interface ReactionHeatmap {
  room_id: string;
  bucket_ms: number;
  /** Ordenado por bucket_start_ms, emoji. */
  buckets: HeatmapBucket[];
  /** Un punto por tramo con reacciones, ordenado por bucket_start_ms. */
  density: HeatmapDensity[];
  /** Ordenado por count descendente. */
  by_emoji: EmojiCount[];
}

export interface TimelinePoint {
  /** ISO del inicio del intervalo. */
  t: string;
  connected_users: number;
  messages: number;
  reactions: number;
}

/** GET /rooms/{id}/timeline. */
export interface RoomTimeline {
  room_id: string;
  step_s: number;
  points: TimelinePoint[];
}

/** Error de la API de analytics (status 0 = fallo de red). */
export class AnalyticsError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'AnalyticsError';
    this.status = status;
  }
}

export function getAnalyticsTicket(roomId: string): Promise<AnalyticsTicket> {
  return apiFetch(`/rooms/${encodeURIComponent(roomId)}/analytics-ticket`, { method: 'POST' });
}

export interface AnalyticsClient {
  kpis(): Promise<RoomKpis>;
  heatmap(bucketMs?: number): Promise<ReactionHeatmap>;
  timeline(stepS?: number): Promise<RoomTimeline>;
}

export interface AnalyticsClientOptions {
  /** Base de la API; por defecto VITE_ANALYTICS_API_URL o el puerto 8084 local. */
  baseUrl?: string;
}

export function createAnalyticsClient(roomId: string, options: AnalyticsClientOptions = {}): AnalyticsClient {
  const base = options.baseUrl || import.meta.env.VITE_ANALYTICS_API_URL || DEFAULT_ANALYTICS_API_URL;
  const room = encodeURIComponent(roomId);
  let ticket: Promise<string> | null = null;

  const currentTicket = (): Promise<string> => {
    if (!ticket) {
      const pending = getAnalyticsTicket(roomId).then((t) => t.token);
      ticket = pending;
      // Un ticket fallido no se cachea: el siguiente intento pide otro.
      pending.catch(() => {
        if (ticket === pending) ticket = null;
      });
    }
    return ticket;
  };

  /** Invalida `used` (si sigue vigente) para que las peticiones paralelas compartan el nuevo. */
  const renewTicket = (used: Promise<string>): Promise<string> => {
    if (ticket === used) ticket = null;
    return currentTicket();
  };

  const send = async (path: string, token: string): Promise<Response> => {
    try {
      return await fetch(`${base}/rooms/${room}${path}`, {
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
      });
    } catch {
      throw new AnalyticsError(0, 'No se pudo contactar el servicio de analítica');
    }
  };

  const get = async <T>(path: string): Promise<T> => {
    const used = currentTicket();
    let res = await send(path, await used);
    if (res.status === 401) {
      res = await send(path, await renewTicket(used));
    }
    if (!res.ok) {
      const data = (await res.json().catch(() => null)) as { error?: string } | null;
      throw new AnalyticsError(res.status, data?.error || `Analytics error ${res.status}`);
    }
    return (await res.json()) as T;
  };

  return {
    kpis: () => get<RoomKpis>('/kpis'),
    heatmap: (bucketMs = 5_000) => get<ReactionHeatmap>(`/reactions/heatmap?bucket_ms=${bucketMs}`),
    timeline: (stepS = 60) => get<RoomTimeline>(`/timeline?step_s=${stepS}`),
  };
}
