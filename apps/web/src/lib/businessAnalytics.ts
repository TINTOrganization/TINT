/**
 * Panel de negocio de Analítica (`GET /analytics/overview` en services/analytics).
 *
 * Solo agregados: usuarios activos por día, volumen de eventos y KPIs de las salas
 * cerradas. Se protege con una contraseña compartida (ANALYTICS_ADMIN_PASSWORD) que se
 * envía como Bearer; no usa la sesión de host ni el analytics-ticket.
 */
import { AnalyticsError, DEFAULT_ANALYTICS_API_URL } from './analytics';

export interface DailyUsers {
  /** Día local del servidor (YYYY-MM-DD). */
  day: string;
  dau: number;
  /** Usuarios distintos en los 30 días que terminan ese día. */
  mau: number;
}

export interface EventTypeCount {
  type: string;
  source: string;
  count: number;
}

export interface RoomHeatmapBucket {
  bucket_start_ms: number;
  reactions: number;
  /** Reacciones del tramo entre las del tramo más activo de la sala (0 a 1). */
  density: number;
}

export interface ClosedRoom {
  room_id: string;
  peak_users: number;
  avg_users: number;
  avg_drift_ms: number;
  trivia_accuracy_pct: number;
  messages: number;
  reactions: number;
  playback_commands: number;
  buffering_events: number;
  avg_buffering_ms: number;
  avg_rtt_ms: number;
  p95_drift_ms: number;
  total_buffering_ms: number;
  close_reason: string | null;
  closed_at: string | null;
  computed_at: string;
  heatmap: RoomHeatmapBucket[];
}

export interface BusinessOverview {
  generated_at: string;
  /** Ordenado por día ascendente. */
  daily: DailyUsers[];
  events: { total: number; rooms: number; by_type: EventTypeCount[] };
  /** Las salas cerradas más recientes primero. */
  rooms: ClosedRoom[];
}

export async function fetchBusinessOverview(password: string, baseUrl?: string): Promise<BusinessOverview> {
  const base = baseUrl || import.meta.env.VITE_ANALYTICS_API_URL || DEFAULT_ANALYTICS_API_URL;
  let res: Response;
  try {
    res = await fetch(`${base}/analytics/overview`, {
      headers: { Authorization: `Bearer ${password}`, Accept: 'application/json' },
    });
  } catch {
    throw new AnalyticsError(0, 'No se pudo contactar el servicio de analítica');
  }
  if (!res.ok) {
    const data = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new AnalyticsError(res.status, data?.error || `Analytics error ${res.status}`);
  }
  return (await res.json()) as BusinessOverview;
}

const dayFormat = new Intl.DateTimeFormat('es', { day: 'numeric', month: 'short', timeZone: 'UTC' });

/** "2026-10-12" → "12 oct"; si no es una fecha, el texto tal cual. */
export function formatDay(day: string): string {
  const d = new Date(`${day}T00:00:00Z`);
  return Number.isNaN(d.getTime()) ? day : dayFormat.format(d);
}
