/**
 * Protocolo del "Canal Sync" (WebSocket /ws/sync de sync-core).
 *
 * Todos los mensajes son objetos planos (JSON o, opcionalmente, MessagePack con las mismas
 * claves; ver `syncCodec.ts`). El servidor (Go) es la fuente de verdad: este módulo solo
 * tipa los mensajes, construye los comandos del cliente y estima la posición maestra a
 * partir del último snapshot recibido. Incluye las extensiones del contrato v2
 * (RATE/LOAD, CONTROL, `media_id`, `can_control`, `rtt_ms`/`drift_ms` en HEARTBEAT) y los
 * controles del host VOLUME/QUALITY (`volume` 0..1 y `quality` en cada snapshot).
 */

export type PlaybackStatus = 'playing' | 'paused';
export type CommandType = 'PLAY' | 'PAUSE' | 'SEEK' | 'RATE' | 'LOAD' | 'VOLUME' | 'QUALITY';
/** Calidad maestra pedida por el host; `auto` deja que cada cliente elija. */
export type QualityPref = 'auto' | 'source' | '720p' | '360p';

export const QUALITY_PREFS: readonly QualityPref[] = ['auto', 'source', '720p', '360p'];
/** Volumen maestro cuando el servidor no lo informa (servidores previos a VOLUME). */
export const DEFAULT_VOLUME = 1;
export const DEFAULT_QUALITY: QualityPref = 'auto';

export function isQualityPref(value: unknown): value is QualityPref {
  return typeof value === 'string' && (QUALITY_PREFS as readonly string[]).includes(value);
}

/** Volumen del servidor acotado a [0, 1]; 1 si falta o no es un número finito. */
export function normalizeVolume(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULT_VOLUME;
  return Math.min(1, Math.max(0, value));
}

/** Calidad del servidor; `auto` si falta o es desconocida. */
export function normalizeQuality(value: unknown): QualityPref {
  return isQualityPref(value) ? value : DEFAULT_QUALITY;
}
export type CorrectionStrategy = 'rate' | 'seek';
export type ServerErrorCode = 'FORBIDDEN' | 'INVALID' | 'RATE_LIMITED' | 'INTERNAL';

/** Estado maestro de reproducción tal como lo emite sync-core. */
export interface SyncState {
  status: PlaybackStatus;
  position_ms: number;
  /** Unix ms (reloj del servidor) del ancla `position_ms`. */
  updated_at_ms: number;
  rate: number;
  version: number;
  /** Unix ms (reloj del servidor) en que se envió el mensaje. */
  server_time_ms: number;
  /** v2: vídeo actual de la sala (= mediaId de identity-api); vacío/ausente si no hay. */
  media_id?: string;
  /** Volumen maestro 0..1 (ausente → 1). */
  volume?: number;
  /** Calidad maestra (ausente → 'auto'). */
  quality?: QualityPref;
}

/** Snapshot local: estado maestro + instante local (performance.now) de recepción. */
export interface SyncSnapshot extends SyncState {
  /** Normalizado: '' si el servidor no informó vídeo. */
  media_id: string;
  received_at_perf: number;
}

export interface StateMessage extends SyncState {
  type: 'STATE';
  online?: boolean;
  /** v2: si ESTE cliente puede emitir comandos. */
  can_control?: boolean;
}

export interface BroadcastMessage extends SyncState {
  type: CommandType;
  event_id?: string;
  room_id?: string;
  occurred_at?: string;
  received_at?: string;
}

export interface HeartbeatMessage {
  type: 'HEARTBEAT';
  server_time_ms: number;
  /** v2: RTT suavizado que el servidor midió para este cliente. */
  rtt_ms?: number;
  /** v2: último drift medido para este cliente (se omite si es 0). */
  drift_ms?: number;
}

/** v2: cambio de delegación de control para este cliente. */
export interface ControlMessage {
  type: 'CONTROL';
  can_control: boolean;
  version?: number;
}

export interface CorrectionMessage {
  type: 'SYNC_CORRECTION';
  target_ms: number;
  strategy: CorrectionStrategy;
  drift_ms: number;
  version: number;
  /** Volumen/calidad maestros vigentes (servidores con VOLUME/QUALITY). */
  volume?: number;
  quality?: QualityPref;
  /** Estado de la sala en esa `version` (opcionales): reconcilian un broadcast perdido. */
  status?: PlaybackStatus;
  /** Velocidad de la sala (no la de corrección). */
  rate?: number;
  media_id?: string;
}

export interface HostStatusMessage {
  type: 'HOST_STATUS';
  online: boolean;
}

export interface AckMessage {
  type: 'ACK';
  ref_event_id: string;
  version: number;
  duplicate?: boolean;
}

export interface ErrorMessage {
  type: 'ERROR';
  ref_event_id?: string;
  code: ServerErrorCode;
}

export type ServerMessage =
  | StateMessage
  | BroadcastMessage
  | HeartbeatMessage
  | CorrectionMessage
  | HostStatusMessage
  | ControlMessage
  | AckMessage
  | ErrorMessage;

/** Campos extra de los comandos v2: `rate` (RATE), `media_id` (LOAD), `volume` (VOLUME), `quality` (QUALITY). */
export interface CommandExtra {
  rate?: number;
  media_id?: string;
  volume?: number;
  quality?: QualityPref;
}

export interface ClientCommand extends CommandExtra {
  event_id: string;
  type: CommandType;
  room_id: string;
  position_ms: number;
  occurred_at: string;
}

export interface SyncCheckMessage {
  event_id: string;
  type: 'SYNC_CHECK';
  room_id: string;
  position_ms: number;
  occurred_at: string;
  echo_server_ts: number;
  /**
   * `version` del estado aplicado por el cliente (ausente antes del primer STATE). sync-core
   * no corrige a un cliente con una versión más vieja que la de la sala: su broadcast está
   * en camino y corregirlo contra el estado nuevo provocaría un salto doble.
   */
  version?: number;
}

/**
 * Fin de un stall de reproducción (cliente → servidor). Solo alimenta la analítica:
 * sync-core no responde ACK ni lo difunde; lo puede enviar cualquier participante.
 */
export interface BufferingMessage {
  event_id: string;
  type: 'BUFFERING';
  room_id: string;
  /** Posición del vídeo (ms) al reanudar. */
  position_ms: number;
  /** Duración del stall (ms): de `waiting` al siguiente `playing`. */
  duration_ms: number;
  occurred_at: string;
}

const SERVER_TYPES = new Set<string>([
  'STATE',
  'PLAY',
  'PAUSE',
  'SEEK',
  'RATE',
  'LOAD',
  'VOLUME',
  'QUALITY',
  'CONTROL',
  'HEARTBEAT',
  'SYNC_CORRECTION',
  'HOST_STATUS',
  'ACK',
  'ERROR',
]);

/** Valida un mensaje ya decodificado (JSON o MessagePack); null si no es conocido. */
export function toServerMessage(data: unknown): ServerMessage | null {
  if (typeof data !== 'object' || data === null) return null;
  const type = (data as { type?: unknown }).type;
  if (typeof type !== 'string' || !SERVER_TYPES.has(type)) return null;
  return data as ServerMessage;
}

/** Parsea un frame JSON del servidor; devuelve null si no es un mensaje conocido. */
export function parseServerMessage(raw: string): ServerMessage | null {
  try {
    return toServerMessage(JSON.parse(raw));
  } catch {
    return null;
  }
}

/** Estima el reloj del servidor ahora, a partir del snapshot y el reloj monotónico local. */
export function estimateServerNow(
  snapshot: Pick<SyncSnapshot, 'server_time_ms' | 'received_at_perf'>,
  perfNowMs: number,
): number {
  return snapshot.server_time_ms + (perfNowMs - snapshot.received_at_perf);
}

/** Posición maestra esperada (ms) para el instante de servidor `serverNowMs`. */
export function expectedPosition(state: SyncState, serverNowMs: number): number {
  if (state.status !== 'playing') return state.position_ms;
  const elapsed = Math.max(0, serverNowMs - state.updated_at_ms);
  return state.position_ms + elapsed * state.rate;
}

export function buildCommand(
  type: CommandType,
  roomId: string,
  positionMs: number,
  now: Date = new Date(),
  extra: CommandExtra = {},
): ClientCommand {
  const cmd: ClientCommand = {
    event_id: crypto.randomUUID(),
    type,
    room_id: roomId,
    position_ms: Math.round(positionMs),
    occurred_at: now.toISOString(),
  };
  if (extra.rate !== undefined) cmd.rate = extra.rate;
  if (extra.media_id !== undefined) cmd.media_id = extra.media_id;
  if (extra.volume !== undefined) cmd.volume = extra.volume;
  if (extra.quality !== undefined) cmd.quality = extra.quality;
  return cmd;
}

export function buildSyncCheck(
  roomId: string,
  positionMs: number,
  echoServerTs: number,
  now: Date = new Date(),
  version?: number,
): SyncCheckMessage {
  const msg: SyncCheckMessage = {
    event_id: crypto.randomUUID(),
    type: 'SYNC_CHECK',
    room_id: roomId,
    position_ms: Math.round(positionMs),
    occurred_at: now.toISOString(),
    echo_server_ts: echoServerTs,
  };
  if (version !== undefined) msg.version = version;
  return msg;
}

export function buildBuffering(
  roomId: string,
  positionMs: number,
  durationMs: number,
  now: Date = new Date(),
): BufferingMessage {
  return {
    event_id: crypto.randomUUID(),
    type: 'BUFFERING',
    room_id: roomId,
    position_ms: Math.max(0, Math.round(positionMs)),
    duration_ms: Math.round(durationMs),
    occurred_at: now.toISOString(),
  };
}

export function buildSyncUrl(baseUrl: string, roomId: string, token: string): string {
  return `${baseUrl}?room_id=${encodeURIComponent(roomId)}&token=${encodeURIComponent(token)}`;
}

export const BACKOFF_BASE_MS = 500;
export const BACKOFF_MAX_MS = 10_000;

/** Backoff exponencial de reconexión: 500 ms, 1 s, 2 s, ... hasta 10 s. */
export function backoffDelay(attempt: number): number {
  return Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** attempt);
}

/** Código de cierre de sync-core cuando identity-api revoca el token (no reconectar). */
export const CLOSE_REVOKED = 4001;

/** Código de cierre de sync-core cuando el token (firma válida) ya caducó. */
export const CLOSE_EXPIRED = 4003;

/** Velocidades ofrecidas en la UI (el servidor acepta [0.25, 4]). */
export const RATE_OPTIONS = [0.5, 0.75, 1, 1.25, 1.5, 2] as const;

/** Siguiente velocidad de `RATE_OPTIONS` en la dirección dada, partiendo de la más cercana. */
export function stepRate(current: number, direction: 1 | -1): number {
  let nearest = 0;
  RATE_OPTIONS.forEach((r, i) => {
    if (Math.abs(r - current) < Math.abs(RATE_OPTIONS[nearest] - current)) nearest = i;
  });
  const next = Math.min(RATE_OPTIONS.length - 1, Math.max(0, nearest + direction));
  return RATE_OPTIONS[next];
}
