import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { apiFetch } from '../lib/api';
import { errorStatus } from '../lib/errorStatus';
import type { Correction } from '../lib/drift';
import {
  decodeFrame,
  encodeFrame,
  MSGPACK_SUBPROTOCOL,
  resolveEncoding,
  type SyncEncoding,
} from '../lib/syncCodec';
import {
  backoffDelay,
  buildBuffering,
  buildCommand,
  buildSyncCheck,
  buildSyncUrl,
  CLOSE_EXPIRED,
  CLOSE_REVOKED,
  estimateServerNow,
  expectedPosition,
  isQualityPref,
  normalizeQuality,
  normalizeVolume,
  toServerMessage,
  DEFAULT_QUALITY,
  DEFAULT_VOLUME,
  type CommandExtra,
  type CommandType,
  type CorrectionMessage,
  type QualityPref,
  type SyncSnapshot,
  type SyncState,
} from '../lib/syncProtocol';
import { MIN_STALL_MS } from '../lib/stallTracker';

export const DEFAULT_SYNC_WS_URL = 'ws://localhost:8083/ws/sync';

/** Longitud máxima de `media_id` aceptada por sync-core (contrato v2 §2). */
const MAX_MEDIA_ID = 128;
/** Cuántos event_id propios recordamos para reconocer sus broadcasts. */
const OWN_EVENTS_MEMORY = 50;

export type SyncRole = 'host' | 'guest';

export type SyncFatalError = 'NOT_HOST' | 'ROOM_GONE';

function fatalTicketError(status: number | null): SyncFatalError | null {
  if (status === 403) return 'NOT_HOST';
  if (status === 404 || status === 410) return 'ROOM_GONE';
  return null;
}

export interface UseSyncSocketOptions {
  roomId: string;
  /** host → pide un sync-ticket en identity-api; guest → usa tint_guest_token. */
  role: SyncRole;
  /** Posición local actual en ms (p. ej. del <video>); null si no hay reproductor. */
  getPositionMs?: () => number | null;
  /** URL base del canal; por defecto VITE_SYNC_WS_URL. */
  url?: string;
  /** Reloj monotónico local (inyectable para pruebas). */
  now?: () => number;
  /** Codificación pedida al servidor; por defecto VITE_SYNC_ENCODING (json). */
  encoding?: SyncEncoding;
  /** false → no pide ticket ni abre socket (p. ej. sin sesión). Por defecto true. */
  enabled?: boolean;
}

export interface SyncCorrection extends Correction {
  /** Secuencia local: cambia en cada corrección recibida, aunque se repitan valores. */
  seq: number;
  version: number;
}

/** Último broadcast de comando aceptado (para avisos y marcadores de saltos). */
export interface SyncBroadcast {
  seq: number;
  type: CommandType;
  event_id?: string;
  position_ms: number;
  rate: number;
  media_id: string;
  /** Volumen maestro tras el comando (VOLUME). */
  volume?: number;
  /** Calidad maestra tras el comando (QUALITY). */
  quality?: QualityPref;
  /** true si lo emitió este cliente (event_id devuelto por sendCommand). */
  own: boolean;
}

export interface ReconnectInfo {
  /** Número del próximo intento (1, 2, 3…). */
  attempt: number;
  /** Instante (Date.now) del próximo intento. */
  nextRetryAt: number;
}

export interface SyncSocketApi {
  connected: boolean;
  state: SyncSnapshot | null;
  hostOnline: boolean | null;
  /** Código del último error (ERROR del servidor, 'TICKET' o 'NO_TOKEN'). */
  lastError: string | null;
  correction: SyncCorrection | null;
  /** Si este cliente puede emitir comandos (STATE.can_control / CONTROL; host antes del 1.er STATE). */
  canControl: boolean;
  /** RTT suavizado medido por el servidor (HEARTBEAT.rtt_ms). */
  rttMs: number | null;
  /** Último drift conocido (HEARTBEAT.drift_ms o SYNC_CORRECTION). */
  driftMs: number | null;
  /** El token fue revocado por el host (cierre 4001): no se reconecta. */
  revoked: boolean;
  /**
   * El token caducó (cierre 4003): el invitado no reconecta y borra `tint_guest_token`;
   * el host pide un sync-ticket nuevo una vez y, si vuelve a pasar, se rinde.
   */
  expired: boolean;
  /**
   * El host no puede sincronizar y reintentar no lo arregla: el sync-ticket respondió
   * 403 (`NOT_HOST`, no es el dueño) o 404/410 (`ROOM_GONE`, sala inexistente o borrada).
   */
  fatalError: SyncFatalError | null;
  /** Reintento programado, o null si conectado / sin reintento. */
  reconnect: ReconnectInfo | null;
  lastBroadcast: SyncBroadcast | null;
  /** Volumen maestro 0..1 (STATE/broadcasts/SYNC_CORRECTION; 1 si el servidor no lo informa). */
  volume: number;
  /** Calidad maestra ('auto' si el servidor no la informa). */
  quality: QualityPref;
  /**
   * Envía PLAY/PAUSE/SEEK/RATE/LOAD/VOLUME/QUALITY si este cliente tiene el control.
   * Devuelve el event_id o null si no se envió.
   */
  sendCommand: (type: CommandType, positionMs: number, extra?: CommandExtra) => string | null;
  /**
   * Reporta el fin de un stall (BUFFERING, solo analítica). Cualquier rol puede enviarlo;
   * devuelve false si el socket no está abierto o el stall es trivial (< 100 ms).
   */
  sendBuffering: (positionMs: number, durationMs: number) => boolean;
}

interface SyncTicket {
  token: string;
  expiresAt: string;
}

const defaultNow = () => performance.now();

function validExtra(type: CommandType, extra: CommandExtra): boolean {
  if (type === 'RATE') return typeof extra.rate === 'number' && Number.isFinite(extra.rate);
  if (type === 'LOAD') {
    return typeof extra.media_id === 'string' && extra.media_id.length > 0 && extra.media_id.length <= MAX_MEDIA_ID;
  }
  if (type === 'VOLUME') {
    return typeof extra.volume === 'number' && Number.isFinite(extra.volume) && extra.volume >= 0 && extra.volume <= 1;
  }
  if (type === 'QUALITY') return isQualityPref(extra.quality);
  return true;
}

/**
 * Cliente del Canal Sync (/ws/sync de sync-core). Solo refleja el estado maestro:
 * filtra broadcasts por versión, responde heartbeats y expone las correcciones que
 * decide el servidor. Reconecta con backoff exponencial mientras esté montado, salvo
 * si el servidor cierra con 4001 (token revocado).
 */
export function useSyncSocket({
  roomId,
  role,
  getPositionMs,
  url,
  now,
  encoding,
  enabled = true,
}: UseSyncSocketOptions): SyncSocketApi {
  const [connected, setConnected] = useState(false);
  const [state, setState] = useState<SyncSnapshot | null>(null);
  const [hostOnline, setHostOnline] = useState<boolean | null>(null);
  const [lastError, setLastError] = useState<string | null>(null);
  const [correction, setCorrection] = useState<SyncCorrection | null>(null);
  // Respaldo antes del primer STATE: el host controla; luego decide el servidor.
  const [canControl, setCanControl] = useState(role === 'host');
  const [rttMs, setRttMs] = useState<number | null>(null);
  const [driftMs, setDriftMs] = useState<number | null>(null);
  const [revoked, setRevoked] = useState(false);
  const [fatalError, setFatalError] = useState<SyncFatalError | null>(null);
  const [expired, setExpired] = useState(false);
  const [reconnect, setReconnect] = useState<ReconnectInfo | null>(null);
  const [lastBroadcast, setLastBroadcast] = useState<SyncBroadcast | null>(null);
  const [volume, setVolume] = useState(DEFAULT_VOLUME);
  const [quality, setQuality] = useState<QualityPref>(DEFAULT_QUALITY);

  const wsRef = useRef<WebSocket | null>(null);
  /** Codificación negociada con el socket actual (json si el servidor no aceptó msgpack). */
  const wireRef = useRef<SyncEncoding>('json');
  const stateRef = useRef<SyncSnapshot | null>(null);
  const canControlRef = useRef(canControl);
  const ownEventsRef = useRef<string[]>([]);
  const seqRef = useRef(0);
  const broadcastSeqRef = useRef(0);
  const getPositionRef = useRef(getPositionMs);
  const nowRef = useRef(now ?? defaultNow);

  useEffect(() => {
    getPositionRef.current = getPositionMs;
    nowRef.current = now ?? defaultNow;
  });

  const baseUrl = url || import.meta.env.VITE_SYNC_WS_URL || DEFAULT_SYNC_WS_URL;
  const requested = encoding ?? resolveEncoding(import.meta.env.VITE_SYNC_ENCODING);

  useEffect(() => {
    let disposed = false;
    let attempt = 0;
    /** El host ya reintentó con un ticket nuevo tras un 4003 (se rearma con el STATE). */
    let renewedAfterExpiry = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let socket: WebSocket | null = null;
    /**
     * El socket actual aún no recibió su primer STATE. Ese siempre aplica (la sala pudo
     * reiniciarse, p. ej. tras el TTL de Redis, con una versión menor); los siguientes STATE
     * de la misma conexión con versión menor a la aplicada se descartan.
     */
    let awaitingFirstState = true;

    const applyControl = (value: boolean) => {
      canControlRef.current = value;
      setCanControl(value);
    };
    applyControl(role === 'host');

    const acceptState = (s: SyncState) => {
      // Servidores previos a VOLUME/QUALITY no los envían: volumen 1 y calidad auto.
      const masterVolume = normalizeVolume(s.volume);
      const masterQuality = normalizeQuality(s.quality);
      const snapshot: SyncSnapshot = {
        status: s.status,
        position_ms: s.position_ms,
        updated_at_ms: s.updated_at_ms,
        rate: s.rate,
        version: s.version,
        server_time_ms: s.server_time_ms,
        media_id: s.media_id ?? '',
        volume: masterVolume,
        quality: masterQuality,
        received_at_perf: nowRef.current(),
      };
      stateRef.current = snapshot;
      setState(snapshot);
      setVolume(masterVolume);
      setQuality(masterQuality);
      return snapshot;
    };

    /**
     * Una corrección con `status` y `rate` describe el estado de la sala en su `version`: si
     * difiere del aplicado (p. ej. se perdió un PAUSE o un RATE), se adopta. El ancla queda en
     * `target_ms` "ahora" según el reloj de servidor estimado, así `SyncedPlayer` no hace un
     * seek extra (la corrección ya posiciona y el estado cae dentro de su tolerancia).
     */
    const reconcileFromCorrection = (msg: CorrectionMessage) => {
      const prev = stateRef.current;
      if (!prev || (msg.status !== 'playing' && msg.status !== 'paused')) return;
      if (typeof msg.rate !== 'number' || !Number.isFinite(msg.rate)) return;
      const mediaId = typeof msg.media_id === 'string' ? msg.media_id : prev.media_id;
      const differs =
        msg.version > prev.version || msg.status !== prev.status || msg.rate !== prev.rate || mediaId !== prev.media_id;
      if (!differs) return;
      const perfNow = nowRef.current();
      const serverNow = estimateServerNow(prev, perfNow);
      const snapshot: SyncSnapshot = {
        ...prev,
        status: msg.status,
        rate: msg.rate,
        media_id: mediaId,
        version: msg.version,
        position_ms: msg.target_ms,
        updated_at_ms: serverNow,
        server_time_ms: serverNow,
        received_at_perf: perfNow,
        volume: msg.volume !== undefined ? normalizeVolume(msg.volume) : prev.volume,
        quality: msg.quality !== undefined ? normalizeQuality(msg.quality) : prev.quality,
      };
      stateRef.current = snapshot;
      setState(snapshot);
    };

    const currentPosition = (): number => {
      const local = getPositionRef.current?.() ?? null;
      if (local !== null) return local;
      const snap = stateRef.current;
      if (!snap) return 0;
      return expectedPosition(snap, estimateServerNow(snap, nowRef.current()));
    };

    const handleMessage = (ws: WebSocket, data: unknown) => {
      const msg = toServerMessage(decodeFrame(data));
      if (!msg) return;
      switch (msg.type) {
        case 'STATE':
          // Snapshot completo: el primero de cada conexión siempre reemplaza (p. ej. tras
          // reconectar); después, uno con versión menor llegó tarde y no pisa el estado.
          if (!awaitingFirstState && stateRef.current && msg.version < stateRef.current.version) break;
          awaitingFirstState = false;
          acceptState(msg);
          renewedAfterExpiry = false;
          if (typeof msg.online === 'boolean') setHostOnline(msg.online);
          if (typeof msg.can_control === 'boolean') applyControl(msg.can_control);
          break;
        case 'PLAY':
        case 'PAUSE':
        case 'SEEK':
        case 'RATE':
        case 'LOAD':
        case 'VOLUME':
        case 'QUALITY': {
          if (stateRef.current && msg.version <= stateRef.current.version) break;
          const snap = acceptState(msg);
          broadcastSeqRef.current += 1;
          setLastBroadcast({
            seq: broadcastSeqRef.current,
            type: msg.type,
            event_id: msg.event_id,
            position_ms: snap.position_ms,
            rate: snap.rate,
            media_id: snap.media_id,
            volume: snap.volume,
            quality: snap.quality,
            own: !!msg.event_id && ownEventsRef.current.includes(msg.event_id),
          });
          break;
        }
        case 'CONTROL':
          applyControl(msg.can_control);
          break;
        case 'HEARTBEAT':
          if (typeof msg.rtt_ms === 'number') {
            setRttMs(msg.rtt_ms);
            // v2 omite drift_ms cuando vale 0.
            setDriftMs(typeof msg.drift_ms === 'number' ? msg.drift_ms : 0);
          }
          ws.send(
            encodeFrame(
              buildSyncCheck(roomId, currentPosition(), msg.server_time_ms, new Date(), stateRef.current?.version),
              wireRef.current,
            ),
          );
          break;
        case 'SYNC_CORRECTION':
          if (stateRef.current && msg.version < stateRef.current.version) break;
          seqRef.current += 1;
          setDriftMs(msg.drift_ms);
          // Las correcciones son parciales: solo pisan volumen/calidad si los traen.
          if (msg.volume !== undefined) setVolume(normalizeVolume(msg.volume));
          if (msg.quality !== undefined) setQuality(normalizeQuality(msg.quality));
          reconcileFromCorrection(msg);
          setCorrection({
            seq: seqRef.current,
            target_ms: msg.target_ms,
            strategy: msg.strategy,
            drift_ms: msg.drift_ms,
            version: msg.version,
            ...(typeof msg.rate === 'number' && Number.isFinite(msg.rate) ? { rate: msg.rate } : {}),
          });
          break;
        case 'HOST_STATUS':
          setHostOnline(msg.online);
          break;
        case 'ACK':
          setLastError(null);
          break;
        case 'ERROR':
          setLastError(msg.code);
          break;
      }
    };

    const scheduleReconnect = () => {
      if (disposed) return;
      const delay = backoffDelay(attempt);
      attempt += 1;
      setReconnect({ attempt, nextRetryAt: Date.now() + delay });
      timer = setTimeout(connect, delay);
    };

    const connect = () => {
      if (role === 'guest') {
        // El guest token ya está en localStorage: conexión síncrona.
        openSocket(localStorage.getItem('tint_guest_token'));
        return;
      }
      // Ticket fresco en cada (re)conexión: son de vida corta.
      apiFetch(`/rooms/${encodeURIComponent(roomId)}/sync-ticket`, { method: 'POST' })
        .then((ticket: SyncTicket) => {
          if (!disposed) openSocket(ticket.token);
        })
        .catch((err: unknown) => {
          if (disposed) return;
          const fatal = fatalTicketError(errorStatus(err));
          if (fatal) {
            // No es el dueño o la sala ya no existe: reintentar no lo arregla.
            setFatalError(fatal);
            setReconnect(null);
            return;
          }
          setLastError('TICKET');
          scheduleReconnect();
        });
    };

    const openSocket = (token: string | null) => {
      if (!token) {
        setLastError('NO_TOKEN');
        setReconnect(null);
        return;
      }
      const target = buildSyncUrl(baseUrl, roomId, token);
      const ws = requested === 'msgpack' ? new WebSocket(target, [MSGPACK_SUBPROTOCOL]) : new WebSocket(target);
      if (requested === 'msgpack') ws.binaryType = 'arraybuffer';
      socket = ws;
      wsRef.current = ws;
      wireRef.current = 'json';
      awaitingFirstState = true;
      ws.onopen = () => {
        // Si el servidor no aceptó el subprotocolo, seguimos en JSON.
        wireRef.current = ws.protocol === MSGPACK_SUBPROTOCOL ? 'msgpack' : 'json';
        attempt = 0;
        setConnected(true);
        setReconnect(null);
        setLastError(null);
      };
      ws.onmessage = (ev: MessageEvent) => handleMessage(ws, ev.data);
      // El cierre posterior se encarga de reconectar.
      ws.onerror = () => {};
      ws.onclose = (ev: CloseEvent) => {
        if (wsRef.current === ws) wsRef.current = null;
        setConnected(false);
        if (ev.code === CLOSE_REVOKED) {
          // El host retiró a este participante: no reconectar nunca.
          if (role === 'guest') localStorage.removeItem('tint_guest_token');
          setRevoked(true);
          setReconnect(null);
          return;
        }
        if (ev.code === CLOSE_EXPIRED) {
          // Token caducado: el invitado no puede renovarlo; el host pide un ticket nuevo una vez.
          if (role === 'host' && !renewedAfterExpiry) {
            renewedAfterExpiry = true;
            connect();
            return;
          }
          if (role === 'guest') localStorage.removeItem('tint_guest_token');
          setExpired(true);
          setReconnect(null);
          return;
        }
        scheduleReconnect();
      };
    };

    if (enabled) connect();

    return () => {
      disposed = true;
      clearTimeout(timer);
      if (socket) {
        socket.onclose = null;
        socket.onmessage = null;
        socket.onopen = null;
        socket.close();
      }
      wsRef.current = null;
    };
  }, [roomId, role, baseUrl, requested, enabled]);

  const sendCommand = useCallback(
    (type: CommandType, positionMs: number, extra: CommandExtra = {}): string | null => {
      if (!canControlRef.current) return null;
      if (!validExtra(type, extra)) return null;
      const ws = wsRef.current;
      if (!ws || ws.readyState !== WebSocket.OPEN) return null;
      const cmd = buildCommand(type, roomId, positionMs, new Date(), extra);
      ws.send(encodeFrame(cmd, wireRef.current));
      ownEventsRef.current = [...ownEventsRef.current.slice(-(OWN_EVENTS_MEMORY - 1)), cmd.event_id];
      return cmd.event_id;
    },
    [roomId],
  );

  const sendBuffering = useCallback(
    (positionMs: number, durationMs: number): boolean => {
      if (durationMs < MIN_STALL_MS) return false;
      const ws = wsRef.current;
      if (!ws || ws.readyState !== WebSocket.OPEN) return false;
      ws.send(encodeFrame(buildBuffering(roomId, positionMs, durationMs), wireRef.current));
      return true;
    },
    [roomId],
  );

  // Objeto estable mientras nada cambie: `SyncedPlayer` es memo y lo recibe entero.
  return useMemo(
    () => ({
      connected,
      state,
      hostOnline,
      lastError,
      correction,
      canControl,
      rttMs,
      driftMs,
      revoked,
      expired,
      fatalError,
      reconnect,
      lastBroadcast,
      volume,
      quality,
      sendCommand,
      sendBuffering,
    }),
    [
      connected,
      state,
      hostOnline,
      lastError,
      correction,
      canControl,
      rttMs,
      driftMs,
      revoked,
      expired,
      fatalError,
      reconnect,
      lastBroadcast,
      volume,
      quality,
      sendCommand,
      sendBuffering,
    ],
  );
}
