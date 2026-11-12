import { apiFetch } from './api';
import { getAnalyticsTicket } from './analytics';
import { isRoomDisabledError } from './roomClosed';
import { parseSocialMessage, type ChatMessage } from './socialSocket';

/**
 * Historial del chat de una sala (HU-LIVE-09 AC3): `GET /api/v1/social/rooms/{id}/chat` en
 * social-core, también con la sala deshabilitada (mientras duren las claves de Redis: 12 h).
 *
 * Credencial: el sync-ticket del host (HS256, `role: host`, `room_id`), que identity-api emite
 * también con la sala `disabled`. Respaldo para una identity-api anterior que aún responda
 * `410 Disabled` al sync-ticket: el `analytics-ticket`, que sale del mismo generador.
 */

/** Origen HTTP de social-core: el de `VITE_SOCIAL_WS_URL` (ws→http, wss→https). */
export function resolveSocialApiUrl(override?: string): string {
  if (override !== undefined) return override.replace(/\/+$/, '');
  const ws = import.meta.env.VITE_SOCIAL_WS_URL || 'ws://localhost:8082/ws/social';
  try {
    const url = new URL(ws, typeof window !== 'undefined' ? window.location.href : undefined);
    url.protocol = url.protocol === 'wss:' || url.protocol === 'https:' ? 'https:' : 'http:';
    return url.origin;
  } catch {
    return 'http://localhost:8082';
  }
}

export class ChatHistoryError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = 'ChatHistoryError';
    this.status = status;
  }
}

export function chatHistoryErrorMessage(status: number): string {
  if (status === 401) return 'Tu acceso al historial caducó. Vuelve a intentarlo.';
  if (status === 403) return 'Solo el host de la sala puede leer el chat del evento.';
  if (status === 404 || status === 410) return 'Esta sala ya no existe.';
  if (status === 0) return 'No se pudo conectar. Revisa tu conexión.';
  return 'El historial del chat no está disponible ahora. Intenta en un momento.';
}

export interface ChatHistoryOptions {
  baseUrl?: string;
  /** Ticket HS256 de host de la sala (por defecto, el sync-ticket). */
  fetchTicket?: (roomId: string) => Promise<string>;
}

export async function hostHistoryTicket(roomId: string): Promise<string> {
  try {
    const t = (await apiFetch(`/rooms/${encodeURIComponent(roomId)}/sync-ticket`, { method: 'POST' })) as { token: string };
    return t.token;
  } catch (err) {
    if (!isRoomDisabledError(err)) throw err;
    return (await getAnalyticsTicket(roomId)).token;
  }
}

const defaultTicket = hostHistoryTicket;

/** Mensajes del chat del más antiguo al más nuevo (máx. 100); los inválidos se descartan. */
export async function fetchChatHistory(roomId: string, opts: ChatHistoryOptions = {}): Promise<ChatMessage[]> {
  let token: string;
  try {
    token = await (opts.fetchTicket ?? defaultTicket)(roomId);
  } catch (err) {
    const status = (err as { status?: unknown })?.status;
    const code = typeof status === 'number' ? status : 0;
    throw new ChatHistoryError(code, chatHistoryErrorMessage(code));
  }
  const url = `${resolveSocialApiUrl(opts.baseUrl)}/api/v1/social/rooms/${encodeURIComponent(roomId)}/chat`;
  let res: Response;
  try {
    res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  } catch {
    throw new ChatHistoryError(0, chatHistoryErrorMessage(0));
  }
  if (!res.ok) throw new ChatHistoryError(res.status, chatHistoryErrorMessage(res.status));
  const body = (await res.json().catch(() => null)) as { messages?: unknown } | null;
  const list = Array.isArray(body?.messages) ? body.messages : [];
  const out: ChatMessage[] = [];
  for (const raw of list) {
    const msg = parseSocialMessage(JSON.stringify(raw));
    if (msg?.type !== 'chat_message') continue;
    const { event_id, user_id, text } = msg as Partial<ChatMessage>;
    if (typeof event_id !== 'string' || typeof user_id !== 'string' || typeof text !== 'string') continue;
    out.push({ ...msg, nick: typeof msg.nick === 'string' ? msg.nick : '' });
  }
  return out;
}
