/**
 * Calidades de reproducción (`GET /rooms/:id/playback` → `qualities`) y resolución de la
 * calidad maestra del Canal Sync (`auto` → cada cliente elige con una heurística simple).
 */
import type { QualityPref } from './syncProtocol';

export type QualityId = Exclude<QualityPref, 'auto'>;

export interface PlaybackQuality {
  id: QualityId;
  label: string;
  /** GET prefirmado de esa versión del vídeo. */
  url: string;
}

const QUALITY_IDS: readonly string[] = ['source', '720p', '360p'];

/** Etiquetas de la UI por preferencia (incluye `auto`). */
export const QUALITY_LABELS: Record<QualityPref, string> = {
  auto: 'Auto',
  source: 'Original',
  '720p': '720p',
  '360p': '360p',
};

function toQuality(value: unknown): PlaybackQuality | null {
  if (typeof value !== 'object' || value === null) return null;
  const { id, label, url } = value as { id?: unknown; label?: unknown; url?: unknown };
  if (typeof id !== 'string' || !QUALITY_IDS.includes(id)) return null;
  if (typeof url !== 'string' || url.length === 0) return null;
  const qid = id as QualityId;
  return { id: qid, label: typeof label === 'string' && label ? label : QUALITY_LABELS[qid], url };
}

/**
 * Normaliza `qualities` de identity-api. Un servidor previo no lo envía: entonces la única
 * calidad es el original (`url`). Si la lista no trae el original pero hay `url`, se añade.
 */
export function normalizeQualities(raw: unknown, url: string | null): PlaybackQuality[] {
  const list = Array.isArray(raw) ? raw.map(toQuality).filter((q): q is PlaybackQuality => q !== null) : [];
  if (url && !list.some((q) => q.id === 'source')) list.push({ id: 'source', label: QUALITY_LABELS.source, url });
  return list;
}

export interface NetworkHints {
  /** `navigator.connection.effectiveType` (Network Information API). */
  effectiveType?: string;
  saveData?: boolean;
  /** `navigator.connection.downlink`: ancho de banda estimado en Mbps. */
  downlink?: number;
  viewportWidth?: number;
}

interface NavigatorConnection {
  effectiveType?: string;
  saveData?: boolean;
  downlink?: number;
}

export function readNetworkHints(): NetworkHints {
  const connection = (navigator as Navigator & { connection?: NavigatorConnection }).connection;
  return {
    effectiveType: connection?.effectiveType,
    saveData: connection?.saveData,
    downlink: connection?.downlink,
    viewportWidth: window.innerWidth,
  };
}

const SLOW_CONNECTIONS = ['slow-2g', '2g', '3g'];
/** Por debajo de este ancho (px) basta 720p. */
const NARROW_VIEWPORT_PX = 640;
/** Ancho de banda (Mbps) a partir del cual `auto` elige el original. */
export const SOURCE_MIN_DOWNLINK_MBPS = 10;

/**
 * `auto`: 360p con conexión lenta o ahorro de datos; 720p en pantallas estrechas; el original
 * solo si la red informa ≥ 10 Mbps (`downlink`); si no (o sin Network Information API), 720p,
 * que arranca antes y evita los cortes por búfer. Si la elegida no existe, `resolveQuality`
 * cae al original.
 */
export function autoQuality(hints: NetworkHints): QualityId {
  if (hints.saveData || (hints.effectiveType && SLOW_CONNECTIONS.includes(hints.effectiveType))) return '360p';
  if (hints.viewportWidth !== undefined && hints.viewportWidth < NARROW_VIEWPORT_PX) return '720p';
  if (typeof hints.downlink === 'number' && hints.downlink >= SOURCE_MIN_DOWNLINK_MBPS) return 'source';
  return '720p';
}

/**
 * Versión a reproducir para la preferencia maestra. Si la pedida no existe (p. ej. el
 * worker aún no la generó) cae al original y, sin él, a la primera disponible.
 */
export function resolveQuality(
  pref: QualityPref,
  qualities: readonly PlaybackQuality[],
  hints: NetworkHints = readNetworkHints(),
): PlaybackQuality | null {
  if (qualities.length === 0) return null;
  const wanted = pref === 'auto' ? autoQuality(hints) : pref;
  return qualities.find((q) => q.id === wanted) ?? qualities.find((q) => q.id === 'source') ?? qualities[0];
}
