import { useCallback, useEffect, useRef, useState } from 'react';
import { apiFetch } from '../lib/api';
import { errorStatus } from '../lib/errorStatus';
import type { EnergySample } from '../lib/speaking';
import { VoiceMesh } from '../lib/voiceMesh';
import {
  buildHostMute,
  buildLeave,
  buildSelfMute,
  buildSignal,
  buildVoiceUrl,
  parseVoiceMessage,
  resolveVoiceWsUrl,
  voiceCloseNotice,
  voiceErrorMessage,
  type VoicePeer,
  type VoiceServerMessage,
} from '../lib/voiceProtocol';

export type VoiceStatus = 'idle' | 'joining' | 'connected' | 'reconnecting' | 'ended';

export interface UseVoiceChannelOptions {
  /** `host` → sync-ticket fresco en cada conexión; `guest` → `tint_guest_token`. */
  role: 'host' | 'guest';
  /** Inyectables para pruebas. */
  createSocket?: (url: string) => WebSocket;
  getUserMedia?: (constraints: MediaStreamConstraints) => Promise<MediaStream>;
  createPeerConnection?: (config: RTCConfiguration) => RTCPeerConnection;
  fetchHostTicket?: (roomId: string) => Promise<string>;
  baseUrl?: string;
  reconnectBaseMs?: number;
  reconnectMaxMs?: number;
}

export const VOICE_AUDIO_CONSTRAINTS: MediaStreamConstraints = {
  audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
};

/** Sync-ticket rechazado sin remedio: no es el dueño (403) o la sala no existe (404/410). */
const FATAL_TICKET_STATUS = [403, 404, 410];
const WS_OPEN = 1;

async function defaultHostTicket(roomId: string): Promise<string> {
  const ticket = (await apiFetch(`/rooms/${encodeURIComponent(roomId)}/sync-ticket`, { method: 'POST' })) as {
    token: string;
  };
  return ticket.token;
}

function without<T>(record: Record<string, T>, key: string): Record<string, T> {
  if (!(key in record)) return record;
  const next = { ...record };
  delete next[key];
  return next;
}

/**
 * Canal de Voz (voice-core `/ws/voice` + WebRTC P2P). Nada se conecta hasta `join()`, que
 * pide el micrófono. Reconecta con espera exponencial salvo en cierres terminales (4001
 * revocado, 4008 llena, 4003 de un invitado); al volver la red reinicia ICE.
 */
export function useVoiceChannel(roomId: string | undefined, opts: UseVoiceChannelOptions) {
  const optsRef = useRef(opts);
  optsRef.current = opts;
  const roomRef = useRef(roomId);
  roomRef.current = roomId;

  const [status, setStatus] = useState<VoiceStatus>('idle');
  const [notice, setNotice] = useState<string | null>(null);
  const [self, setSelf] = useState<VoicePeer | null>(null);
  const [peers, setPeers] = useState<VoicePeer[]>([]);
  const [remoteStreams, setRemoteStreams] = useState<Record<string, MediaStream>>({});
  const [connection, setConnection] = useState<Record<string, RTCPeerConnectionState>>({});
  const [localStream, setLocalStream] = useState<MediaStream | null>(null);
  const [muted, setMuted] = useState(false);
  const [hostMuted, setHostMuted] = useState(false);

  // Estado de la conexión fuera de React: los handlers del socket lo leen sin closures viejos.
  const rt = useRef({
    active: false,
    ws: null as WebSocket | null,
    mesh: null as VoiceMesh | null,
    stream: null as MediaStream | null,
    selfId: '',
    attempt: 0,
    timer: null as ReturnType<typeof setTimeout> | null,
    wantMuted: false,
    hostMuted: false,
  }).current;

  const send = (text: string) => {
    if (rt.ws && rt.ws.readyState === WS_OPEN) rt.ws.send(text);
  };

  const applySending = () => {
    void rt.mesh?.setSending(!rt.wantMuted && !rt.hostMuted);
  };

  const teardown = () => {
    if (rt.timer) clearTimeout(rt.timer);
    rt.timer = null;
    const ws = rt.ws;
    rt.ws = null;
    ws?.close();
    rt.mesh?.close();
    rt.mesh = null;
    rt.selfId = '';
    setSelf(null);
    setPeers([]);
    setRemoteStreams({});
    setConnection({});
  };

  const stopMic = () => {
    rt.stream?.getTracks().forEach((t) => t.stop());
    rt.stream = null;
    setLocalStream(null);
  };

  const finish = (next: VoiceStatus, text?: string) => {
    rt.active = false;
    teardown();
    stopMic();
    rt.wantMuted = false;
    rt.hostMuted = false;
    setMuted(false);
    setHostMuted(false);
    setStatus(next);
    if (text) setNotice(text);
  };

  const scheduleReconnect = () => {
    const { reconnectBaseMs = 500, reconnectMaxMs = 8000 } = optsRef.current;
    const delay = Math.min(reconnectBaseMs * 2 ** rt.attempt, reconnectMaxMs);
    rt.attempt += 1;
    setStatus('reconnecting');
    rt.timer = setTimeout(() => {
      rt.timer = null;
      void connect();
    }, delay);
  };

  const handleMessage = (msg: VoiceServerMessage) => {
    switch (msg.type) {
      case 'voice_state': {
        rt.attempt = 0;
        rt.selfId = msg.self.peer_id;
        rt.hostMuted = msg.self.host_muted;
        if (msg.self.host_muted) rt.wantMuted = true;
        const track = rt.stream?.getAudioTracks()[0] ?? null;
        const mesh = new VoiceMesh(msg.self.peer_id, msg.ice_servers, track, {
          createPeerConnection: optsRef.current.createPeerConnection ?? ((c) => new RTCPeerConnection(c)),
          sendSignal: (to, data) => send(buildSignal(to, data)),
          onRemoteStream: (peerId, stream) => setRemoteStreams((prev) => ({ ...prev, [peerId]: stream })),
          onConnectionState: (peerId, state) => setConnection((prev) => ({ ...prev, [peerId]: state })),
        });
        rt.mesh?.close();
        rt.mesh = mesh;
        applySending();
        // Quien llega ofrece a cada uno de los que ya estaban.
        for (const p of msg.peers) mesh.connectTo(p.peer_id);
        // El silencio propio no se guarda en el servidor: se repite tras reconectar.
        if (rt.wantMuted && !msg.self.muted) send(buildSelfMute(true));
        setSelf({ ...msg.self, muted: rt.wantMuted || msg.self.muted });
        setPeers(msg.peers);
        setMuted(rt.wantMuted);
        setHostMuted(rt.hostMuted);
        setStatus('connected');
        return;
      }
      case 'peer_joined':
        setPeers((prev) => [...prev.filter((p) => p.peer_id !== msg.peer.peer_id), msg.peer]);
        return;
      case 'peer_left':
        rt.mesh?.remove(msg.peer_id);
        setPeers((prev) => prev.filter((p) => p.peer_id !== msg.peer_id));
        setRemoteStreams((prev) => without(prev, msg.peer_id));
        setConnection((prev) => without(prev, msg.peer_id));
        return;
      case 'signal':
        rt.mesh?.handleSignal(msg.from, msg.data).catch(() => {
          // Un candidato tardío o inválido no debe tumbar la voz; ICE se reintenta solo.
        });
        return;
      case 'peer_muted': {
        const flags = { muted: msg.muted, host_muted: msg.host_muted };
        if (msg.peer_id === rt.selfId) {
          rt.wantMuted = msg.muted;
          rt.hostMuted = msg.host_muted;
          applySending();
          setMuted(msg.muted);
          setHostMuted(msg.host_muted);
          setSelf((prev) => (prev ? { ...prev, ...flags } : prev));
        } else {
          setPeers((prev) => prev.map((p) => (p.peer_id === msg.peer_id ? { ...p, ...flags } : p)));
        }
        return;
      }
      case 'error':
        setNotice(voiceErrorMessage(msg.code));
        return;
    }
  };

  const openSocket = (token: string) => {
    const { createSocket = (url: string) => new WebSocket(url), baseUrl } = optsRef.current;
    const ws = createSocket(buildVoiceUrl(resolveVoiceWsUrl(baseUrl), roomRef.current ?? '', token));
    rt.ws = ws;
    ws.onmessage = (ev: MessageEvent) => {
      const msg = parseVoiceMessage(String(ev.data));
      if (msg) handleMessage(msg);
    };
    ws.onclose = (ev: CloseEvent) => {
      // Solo el socket vigente decide: el cierre de uno viejo no toca al nuevo.
      if (rt.ws !== ws) return;
      rt.ws = null;
      rt.mesh?.close();
      rt.mesh = null;
      setPeers([]);
      setRemoteStreams({});
      setConnection({});
      if (!rt.active) return;
      const terminal = voiceCloseNotice(ev.code, optsRef.current.role === 'host');
      if (terminal) {
        finish('ended', terminal);
        return;
      }
      scheduleReconnect();
    };
    ws.onerror = () => ws.close();
  };

  const connect = async () => {
    const room = roomRef.current;
    if (!rt.active || !room) return;
    setStatus(rt.attempt === 0 ? 'joining' : 'reconnecting');
    if (optsRef.current.role !== 'host') {
      openSocket(localStorage.getItem('tint_guest_token') ?? '');
      return;
    }
    try {
      const token = await (optsRef.current.fetchHostTicket ?? defaultHostTicket)(room);
      if (rt.active) openSocket(token);
    } catch (err) {
      if (!rt.active) return;
      const code = errorStatus(err);
      if (code !== null && FATAL_TICKET_STATUS.includes(code)) {
        finish('ended', 'No se pudo entrar a la voz de esta sala.');
        return;
      }
      scheduleReconnect();
    }
  };

  const join = useCallback(async () => {
    if (rt.active) return;
    setNotice(null);
    const gum =
      optsRef.current.getUserMedia ??
      (typeof navigator !== 'undefined' && navigator.mediaDevices?.getUserMedia
        ? navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices)
        : undefined);
    if (!gum) {
      setNotice('Este navegador no permite usar el micrófono aquí (hace falta https o localhost).');
      return;
    }
    setStatus('joining');
    let stream: MediaStream;
    try {
      stream = await gum(VOICE_AUDIO_CONSTRAINTS);
    } catch (err) {
      setStatus('idle');
      setNotice(
        (err as { name?: string })?.name === 'NotAllowedError'
          ? 'Permite el micrófono en el navegador para unirte a la voz.'
          : 'No encontramos un micrófono disponible.',
      );
      return;
    }
    rt.stream = stream;
    setLocalStream(stream);
    rt.active = true;
    rt.attempt = 0;
    await connect();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- connect solo usa refs y setters estables
  }, []);

  const leave = useCallback(() => {
    send(buildLeave());
    finish('idle');
    // eslint-disable-next-line react-hooks/exhaustive-deps -- solo refs y setters estables
  }, []);

  const toggleMute = useCallback(() => {
    if (rt.hostMuted && rt.wantMuted) {
      setNotice(voiceErrorMessage('HOST_MUTED'));
      return;
    }
    rt.wantMuted = !rt.wantMuted;
    setMuted(rt.wantMuted);
    // Primero se corta (o se devuelve) la pista local: no se espera al servidor.
    applySending();
    send(buildSelfMute(rt.wantMuted));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- solo refs y setters estables
  }, []);

  const setHostMute = useCallback((userId: string, value: boolean) => {
    send(buildHostMute(userId, value));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- solo refs y setters estables
  }, []);

  const dismissNotice = useCallback(() => setNotice(null), []);

  /** Energía recibida de cada peer, para saber quién habla (`useSpeaking`). */
  const sampleEnergy = useCallback(
    async (): Promise<Record<string, EnergySample>> => (rt.mesh ? rt.mesh.energySamples() : {}),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- solo refs
    [],
  );

  // Cambio de red (HU-VOZ-05 AC3): reinicia ICE, o reconecta ya si el socket había caído.
  useEffect(() => {
    const onOnline = () => {
      if (!rt.active) return;
      if (rt.ws) {
        rt.mesh?.restartIce();
      } else if (rt.timer) {
        clearTimeout(rt.timer);
        rt.timer = null;
        void connect();
      }
    };
    window.addEventListener('online', onOnline);
    return () => window.removeEventListener('online', onOnline);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- solo refs
  }, []);

  useEffect(
    () => () => {
      rt.active = false;
      teardown();
      rt.stream?.getTracks().forEach((t) => t.stop());
      rt.stream = null;
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps -- limpieza al desmontar
    [],
  );

  return {
    status,
    notice,
    self,
    peers,
    remoteStreams,
    connection,
    localStream,
    muted,
    hostMuted,
    join,
    leave,
    toggleMute,
    setHostMute,
    dismissNotice,
    sampleEnergy,
  };
}

export type VoiceChannel = ReturnType<typeof useVoiceChannel>;
