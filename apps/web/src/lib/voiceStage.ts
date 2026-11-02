import { apiFetch } from './api';
import { resolveVoiceWsUrl } from './voiceProtocol';

/**
 * Voz en modo escenario (ADR 0019): en una sala `live` solo entran a voice-core el host y quienes
 * él invita. El host invita o retira con `PUT/DELETE /api/v1/voice/rooms/{id}/stage/{user_id}`
 * (204) usando su sync-ticket; retirar cierra con `4009` la voz de esa persona.
 */

/** Origen HTTP de voice-core: `VITE_VOICE_API_URL` o el del WebSocket de voz (ws→http). */
export function resolveVoiceApiUrl(override?: string): string {
  const explicit = override || import.meta.env.VITE_VOICE_API_URL;
  if (explicit) return explicit.replace(/\/+$/, '');
  const wsEnv = import.meta.env.VITE_VOICE_WS_URL;
  if (typeof wsEnv === 'string' && wsEnv.trim().length > 0) {
    const trimmed = wsEnv.trim();
    if (!/^wss?:\/\//i.test(trimmed) && !trimmed.startsWith('/')) return 'http://localhost:8085';
  }
  try {
    const ws = new URL(resolveVoiceWsUrl());
    ws.protocol = ws.protocol === 'wss:' ? 'https:' : 'http:';
    return ws.origin;
  } catch {
    return 'http://localhost:8085';
  }
}

export class StageError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = 'StageError';
    this.status = status;
  }
}

export function stageErrorMessage(status: number): string {
  if (status === 401 || status === 403) return 'Solo el host puede invitar o bajar a alguien del escenario.';
  if (status === 0) return 'No se pudo conectar con la voz. Revisa tu conexión.';
  return 'No se pudo cambiar el escenario. Intenta de nuevo en un momento.';
}

async function hostTicket(roomId: string): Promise<string> {
  const t = (await apiFetch(`/rooms/${encodeURIComponent(roomId)}/sync-ticket`, { method: 'POST' })) as { token: string };
  return t.token;
}

export interface StageOptions {
  baseUrl?: string;
  fetchHostTicket?: (roomId: string) => Promise<string>;
}

async function stageRequest(method: 'PUT' | 'DELETE', roomId: string, userId: string, opts: StageOptions) {
  const token = await (opts.fetchHostTicket ?? hostTicket)(roomId);
  const url = `${resolveVoiceApiUrl(opts.baseUrl)}/api/v1/voice/rooms/${encodeURIComponent(roomId)}/stage/${encodeURIComponent(userId)}`;
  let res: Response;
  try {
    res = await fetch(url, { method, headers: { Authorization: `Bearer ${token}` } });
  } catch {
    throw new StageError(0, stageErrorMessage(0));
  }
  if (!res.ok) throw new StageError(res.status, stageErrorMessage(res.status));
}

export const inviteToStage = (roomId: string, userId: string, opts: StageOptions = {}) =>
  stageRequest('PUT', roomId, userId, opts);

export const removeFromStage = (roomId: string, userId: string, opts: StageOptions = {}) =>
  stageRequest('DELETE', roomId, userId, opts);
