/**
 * Cliente de la API de transmisión de stream-core (docs/dominio-transmision.md §3, §4, §6.1):
 * señalización WHIP/WHEP por HTTP (`/api/v1/stream/*`) y mensajes del DataChannel
 * `stream-events`. Todo lo que viene del servidor se parsea a la defensiva.
 */

export const STREAM_EVENTS_LABEL = 'stream-events';
/** DataChannel negociado: id fijo 0, creado antes de `createOffer` (§4). */
export const STREAM_EVENTS_INIT: RTCDataChannelInit = { negotiated: true, id: 0 };

/** stream-core directo, para `npm run dev` sin la variable definida. */
export const DEFAULT_STREAM_API_URL = 'http://localhost:8086';

/**
 * Origen de stream-core o del gateway; las rutas cuelgan de `/api/v1/stream`.
 * - variable sin definir → `http://localhost:8086` (desarrollo con Vite);
 * - variable vacía → `''`: **mismo origen** (la web servida por el gateway; Caddy enruta
 *   `/api/v1/stream/*` a stream-core);
 * - cualquier otro valor → ese origen.
 */
export function resolveStreamApiUrl(override?: string): string {
  const configured = override ?? import.meta.env.VITE_STREAM_API_URL;
  const base = configured === undefined ? DEFAULT_STREAM_API_URL : configured.trim();
  return base.replace(/\/+$/, '');
}

export const streamRoomUrl = (base: string, roomId: string, suffix: string) =>
  `${base}/api/v1/stream/rooms/${encodeURIComponent(roomId)}/${suffix}`;

/** `Location` relativo (`/api/v1/stream/sessions/{sid}`) → URL absoluta contra la base. */
export function sessionUrl(base: string, location: string): string {
  if (/^https?:\/\//i.test(location)) return location;
  return `${base}${location.startsWith('/') ? '' : '/'}${location}`;
}

/**
 * Simulcast VP8 del host: tres capas desde una captura de 1080p30 (§7: 2.5 + 0.8 + 0.25 Mbps).
 * `h` 1080p30, `m` 720p30, `l` 360p15. El orden lo fija el contrato de la prueba (h, m, l).
 */
export const SIMULCAST_ENCODINGS: RTCRtpEncodingParameters[] = [
  { rid: 'h', scaleResolutionDownBy: 1, maxBitrate: 2_500_000, maxFramerate: 30 },
  { rid: 'm', scaleResolutionDownBy: 1.5, maxBitrate: 800_000, maxFramerate: 30 },
  { rid: 'l', scaleResolutionDownBy: 3, maxBitrate: 250_000, maxFramerate: 15 },
];

/** Opus estéreo a 128 kbps (HU-LIVE-01b AC3). */
export const OPUS_BITRATE = 128_000;
export const AUDIO_ENCODINGS: RTCRtpEncodingParameters[] = [{ maxBitrate: OPUS_BITRATE }];

/**
 * Activa estéreo y 128 kbps en el `fmtp` de Opus de la oferta. Chrome ofrece Opus en mono
 * por defecto; sin esto la música del PC llegaría a los viewers colapsada.
 */
export function mungeOpusStereo(sdp: string): string {
  const pt = /a=rtpmap:(\d+) opus\/48000/i.exec(sdp)?.[1];
  if (!pt) return sdp;
  const params = `stereo=1;sprop-stereo=1;maxaveragebitrate=${OPUS_BITRATE}`;
  const fmtp = new RegExp(`a=fmtp:${pt} ([^\\r\\n]*)`);
  if (fmtp.test(sdp)) {
    return sdp.replace(fmtp, (_line, existing: string) => {
      const kept = existing
        .split(';')
        .map((p) => p.trim())
        .filter((p) => p && !/^(stereo|sprop-stereo|maxaveragebitrate)=/i.test(p));
      return `a=fmtp:${pt} ${[...kept, params].join(';')}`;
    });
  }
  return sdp.replace(new RegExp(`(a=rtpmap:${pt} opus/48000[^\\r\\n]*)(\\r?\\n)`, 'i'), `$1$2a=fmtp:${pt} ${params}$2`);
}

// --- Errores HTTP ---

/** Error de stream-core: `{error:"UPPER_SNAKE", message}` (§6.1); `status` 0 = red. */
export class StreamError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'StreamError';
    this.status = status;
    this.code = code;
  }
}

const STREAM_ERROR_TEXT: Record<string, string> = {
  SCREEN_DENIED: 'No se compartió la pantalla. Para transmitir, elige una pantalla, ventana o pestaña y acepta el permiso.',
  SCREEN_UNSUPPORTED: 'Este navegador no puede compartir la pantalla aquí (hace falta https o localhost en Chrome, Edge o Firefox).',
  ROOM_FULL: 'La transmisión está llena (50 espectadores). Intenta de nuevo en un rato.',
  ROOM_DISABLED: 'El evento terminó y la sala fue deshabilitada.',
  FORBIDDEN_ROLE: 'Solo el host puede transmitir en esta sala.',
  FORBIDDEN: 'No tienes acceso a la transmisión de esta sala.',
  STREAM_NOT_FOUND: 'Esta sala no tiene transmisión en vivo.',
  INVALID_SDP: 'Tu navegador no pudo negociar el vídeo (hace falta VP8 y Opus). Prueba con Chrome o Edge actualizados.',
  DATACHANNEL_REQUIRED: 'Tu navegador no pudo abrir el canal de eventos de la transmisión.',
  UNSUPPORTED_MEDIA_TYPE: 'No se pudo negociar la transmisión. Recarga la página.',
  UNAUTHORIZED: 'Tu acceso a la transmisión no es válido. Vuelve a entrar a la sala.',
  TOKEN_EXPIRED: 'Tu acceso a la transmisión caducó. Vuelve a entrar a la sala.',
  TOKEN_REVOKED: 'Ya no tienes acceso a esta sala.',
  UNAVAILABLE: 'La transmisión no está disponible en este momento. Reintentando…',
  NETWORK: 'No se pudo conectar con el servidor de la transmisión. Revisa tu conexión.',
  WEBRTC_UNSUPPORTED: 'Este navegador no permite ver transmisiones en vivo (WebRTC).',
};

export function streamErrorMessage(code: string): string {
  return STREAM_ERROR_TEXT[code] ?? 'Algo salió mal con la transmisión. Intenta de nuevo.';
}

/** Lee el `{error, message}` de una respuesta fallida (o deduce el código por el estado). */
export async function streamErrorFrom(res: Response): Promise<StreamError> {
  let code = '';
  try {
    const body = (await res.json()) as { error?: unknown } | null;
    if (body && typeof body.error === 'string') code = body.error;
  } catch {
    // Cuerpo vacío o no JSON (p. ej. un 502 del gateway).
  }
  if (!code) {
    code =
      res.status === 401
        ? 'UNAUTHORIZED'
        : res.status === 403
          ? 'FORBIDDEN'
          : res.status === 404
            ? 'STREAM_NOT_FOUND'
            : res.status === 409
              ? 'ROOM_FULL'
              : res.status === 410
                ? 'ROOM_DISABLED'
                : res.status === 415
                  ? 'UNSUPPORTED_MEDIA_TYPE'
                  : res.status >= 500
                    ? 'UNAVAILABLE'
                    : `HTTP_${res.status}`;
  }
  return new StreamError(res.status, code, streamErrorMessage(code));
}

/** Errores en los que reintentar no sirve. */
export function isTerminalStreamError(err: StreamError): boolean {
  return err.status !== 0 && err.status < 500 && err.status !== 429;
}

// --- ICE ---

export function parseIceServers(body: unknown): RTCIceServer[] {
  const list = (body as { ice_servers?: unknown } | null)?.ice_servers;
  if (!Array.isArray(list)) return [];
  const out: RTCIceServer[] = [];
  for (const s of list) {
    if (typeof s !== 'object' || s === null) continue;
    const { urls, username, credential } = s as Record<string, unknown>;
    const valid = typeof urls === 'string' || (Array.isArray(urls) && urls.every((u) => typeof u === 'string'));
    if (!valid) continue;
    const server: RTCIceServer = { urls: urls as string | string[] };
    if (typeof username === 'string') server.username = username;
    if (typeof credential === 'string') server.credential = credential;
    out.push(server);
  }
  return out;
}

// --- DataChannel `stream-events` (§4) ---

export type StreamState = 'waiting' | 'live' | 'reconnecting' | 'ended';
export type SceneName = 'live' | 'starting_soon' | 'brb';
export type EndReason = 'host_ended' | 'grace_expired';

export interface HostLayerStats {
  rid: 'h' | 'm' | 'l';
  bitrate_bps: number;
  active: boolean;
  viewers: number;
}

export interface HostStats {
  layers: HostLayerStats[];
  nacks: number;
  plis: number;
}

export type StreamEvent =
  | { type: 'stream_state'; state: StreamState; reason?: EndReason; grace_deadline_ms?: number }
  | { type: 'viewer_count'; count: number }
  | { type: 'scene'; name: SceneName }
  | ({ type: 'host_stats' } & HostStats);

const STATES: readonly StreamState[] = ['waiting', 'live', 'reconnecting', 'ended'];
export const SCENES: readonly SceneName[] = ['live', 'starting_soon', 'brb'];
const RIDS = ['h', 'm', 'l'] as const;

const isCount = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0;

export function isSceneName(v: unknown): v is SceneName {
  return typeof v === 'string' && (SCENES as readonly string[]).includes(v);
}

export function parseStreamEvent(data: unknown): StreamEvent | null {
  if (typeof data !== 'string') return null;
  let j: unknown;
  try {
    j = JSON.parse(data);
  } catch {
    return null;
  }
  if (typeof j !== 'object' || j === null) return null;
  const m = j as Record<string, unknown>;
  switch (m.type) {
    case 'stream_state': {
      if (!(STATES as readonly unknown[]).includes(m.state)) return null;
      const ev: StreamEvent = { type: 'stream_state', state: m.state as StreamState };
      if (m.reason === 'host_ended' || m.reason === 'grace_expired') ev.reason = m.reason;
      if (isCount(m.grace_deadline_ms)) ev.grace_deadline_ms = m.grace_deadline_ms;
      return ev;
    }
    case 'viewer_count':
      return isCount(m.count) ? { type: 'viewer_count', count: m.count } : null;
    case 'scene':
      return isSceneName(m.name) ? { type: 'scene', name: m.name } : null;
    case 'host_stats': {
      if (!Array.isArray(m.layers)) return null;
      const layers: HostLayerStats[] = [];
      for (const l of m.layers) {
        const x = l as Record<string, unknown> | null;
        if (!x || !(RIDS as readonly unknown[]).includes(x.rid)) continue;
        layers.push({
          rid: x.rid as HostLayerStats['rid'],
          bitrate_bps: isCount(x.bitrate_bps) ? x.bitrate_bps : 0,
          active: x.active === true,
          viewers: isCount(x.viewers) ? x.viewers : 0,
        });
      }
      return {
        type: 'host_stats',
        layers,
        nacks: isCount(m.nacks) ? m.nacks : 0,
        plis: isCount(m.plis) ? m.plis : 0,
      };
    }
    default:
      return null;
  }
}

function newEventId(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `s-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
}

/** C → S (solo el host, por su DataChannel de vídeo): `{type:"scene", event_id, name}`. */
export function buildSceneMessage(name: SceneName): string {
  return JSON.stringify({ type: 'scene', event_id: newEventId(), name });
}

export const SCENE_LABELS: Record<SceneName, string> = {
  live: 'En vivo',
  starting_soon: 'Empezamos pronto',
  brb: 'Ya volvemos',
};

export const LAYER_LABELS: Record<HostLayerStats['rid'], string> = {
  h: 'Alta · 1080p',
  m: 'Media · 720p',
  l: 'Baja · 360p',
};

/** "2,5 Mbps", "800 kbps", "0 kbps". */
export function formatBitrate(bps: number): string {
  if (bps >= 1_000_000) return `${(bps / 1_000_000).toLocaleString('es', { maximumFractionDigits: 1 })} Mbps`;
  return `${Math.round(bps / 1000)} kbps`;
}
