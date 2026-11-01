/**
 * Protocolo del Canal de Voz (voice-core, `/ws/voice`). El servidor solo autoriza, lleva la
 * membresía y reenvía la señalización; el audio va P2P entre navegadores (WebRTC, mesh).
 * Contrato: services/voice-core/AGENTS.md § Protocolo del Canal de Voz.
 */

export const VOICE_CLOSE = { NORMAL: 1000, REVOKED: 4001, EXPIRED: 4003, FULL: 4008 } as const;

export interface VoicePeer {
  peer_id: string;
  user_id: string;
  nick: string;
  role: string;
  muted: boolean;
  host_muted: boolean;
}

export interface VoiceIceServer {
  urls: string | string[];
  username?: string;
  credential?: string;
}

/** Datos de `signal`: opacos para el servidor. */
export type SignalData =
  | { description: { type: RTCSdpType; sdp: string } }
  | { candidate: RTCIceCandidateInit | null };

export type VoiceServerMessage =
  | {
      type: 'voice_state';
      room_id: string;
      self: VoicePeer;
      peers: VoicePeer[];
      ice_servers: VoiceIceServer[];
      max_members: number;
    }
  | { type: 'peer_joined'; peer: VoicePeer }
  | { type: 'peer_left'; peer_id: string }
  | { type: 'signal'; from: string; data: SignalData }
  | { type: 'peer_muted'; peer_id: string; user_id: string; muted: boolean; host_muted: boolean }
  | { type: 'error'; code: string; event_id_ref?: string };

export function resolveVoiceWsUrl(override?: string): string {
  if (override) return override;
  return import.meta.env.VITE_VOICE_WS_URL || 'ws://localhost:8085/ws/voice';
}

export function buildVoiceUrl(base: string, roomId: string, token: string): string {
  const query = new URLSearchParams({ room_id: roomId, token });
  return `${base}?${query.toString()}`;
}

function eventId(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `v-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
}

function clientMessage(type: string, fields: Record<string, unknown> = {}): string {
  return JSON.stringify({ type, event_id: eventId(), occurred_at: Date.now(), ...fields });
}

export const buildSignal = (to: string, data: SignalData) => clientMessage('signal', { to, data });
export const buildSelfMute = (muted: boolean) => clientMessage('self_mute', { muted });
export const buildHostMute = (userId: string, muted: boolean) =>
  clientMessage('host_mute', { user_id: userId, muted });
export const buildLeave = () => clientMessage('leave');

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const isStr = (v: unknown): v is string => typeof v === 'string' && v.length > 0;

function parsePeer(v: unknown): VoicePeer | null {
  if (!isObj(v) || !isStr(v.peer_id) || !isStr(v.user_id)) return null;
  return {
    peer_id: v.peer_id,
    user_id: v.user_id,
    nick: typeof v.nick === 'string' ? v.nick : '',
    role: typeof v.role === 'string' ? v.role : 'participant',
    muted: v.muted === true,
    host_muted: v.host_muted === true,
  };
}

function parseIceServer(v: unknown): VoiceIceServer | null {
  if (!isObj(v)) return null;
  const urls = v.urls;
  const validUrls = isStr(urls) || (Array.isArray(urls) && urls.length > 0 && urls.every(isStr));
  if (!validUrls) return null;
  const server: VoiceIceServer = { urls: urls as string | string[] };
  if (isStr(v.username)) server.username = v.username;
  if (isStr(v.credential)) server.credential = v.credential;
  return server;
}

/** Parseo defensivo de un mensaje del servidor; null si no es válido. */
export function parseVoiceMessage(text: string): VoiceServerMessage | null {
  let j: unknown;
  try {
    j = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isObj(j)) return null;
  switch (j.type) {
    case 'voice_state': {
      const self = parsePeer(j.self);
      if (!self) return null;
      const peers = Array.isArray(j.peers) ? j.peers.map(parsePeer).filter((p): p is VoicePeer => p !== null) : [];
      const ice = Array.isArray(j.ice_servers)
        ? j.ice_servers.map(parseIceServer).filter((s): s is VoiceIceServer => s !== null)
        : [];
      return {
        type: 'voice_state',
        room_id: typeof j.room_id === 'string' ? j.room_id : '',
        self,
        peers,
        ice_servers: ice,
        max_members: typeof j.max_members === 'number' ? j.max_members : 0,
      };
    }
    case 'peer_joined': {
      const p = parsePeer(j.peer);
      return p ? { type: 'peer_joined', peer: p } : null;
    }
    case 'peer_left':
      return isStr(j.peer_id) ? { type: 'peer_left', peer_id: j.peer_id } : null;
    case 'signal':
      return isStr(j.from) && isObj(j.data) ? { type: 'signal', from: j.from, data: j.data as SignalData } : null;
    case 'peer_muted':
      return isStr(j.peer_id) && typeof j.muted === 'boolean' && typeof j.host_muted === 'boolean'
        ? {
            type: 'peer_muted',
            peer_id: j.peer_id,
            user_id: typeof j.user_id === 'string' ? j.user_id : '',
            muted: j.muted,
            host_muted: j.host_muted,
          }
        : null;
    case 'error':
      if (!isStr(j.code)) return null;
      return isStr(j.event_id_ref)
        ? { type: 'error', code: j.code, event_id_ref: j.event_id_ref }
        : { type: 'error', code: j.code };
    default:
      return null;
  }
}

/** Host y cohost moderan la voz (igual que el chat). Solo UI: autoriza voice-core. */
export function canModerate(role: string): boolean {
  return role === 'host' || role === 'cohost';
}

const ERROR_TEXT: Record<string, string> = {
  HOST_MUTED: 'El host te silenció. Podrás hablar cuando te lo permita.',
  VOICE_FULL: 'La voz está llena. Intenta cuando alguien salga.',
  FORBIDDEN: 'Solo el host puede silenciar a otras personas.',
  UNAVAILABLE: 'No se pudo guardar el cambio. Intenta de nuevo en un momento.',
};

export function voiceErrorMessage(code: string): string {
  return ERROR_TEXT[code] ?? 'Algo salió mal con la voz. Intenta de nuevo.';
}

/** Texto de un cierre sin reintento, o null si conviene reconectar. */
export function voiceCloseNotice(code: number, isHost: boolean): string | null {
  if (code === VOICE_CLOSE.REVOKED) return 'Ya no tienes acceso a esta sala.';
  if (code === VOICE_CLOSE.FULL) return ERROR_TEXT.VOICE_FULL;
  // El host pide un sync-ticket nuevo en cada intento; el invitado no puede renovar el suyo.
  if (code === VOICE_CLOSE.EXPIRED && !isHost) return 'Tu invitación caducó. Pide al host un link nuevo.';
  return null;
}
