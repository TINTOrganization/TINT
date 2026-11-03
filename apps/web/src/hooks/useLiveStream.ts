import { useCallback, useEffect, useRef, useState } from 'react';
import { apiFetch } from '../lib/api';
import { errorStatus } from '../lib/errorStatus';
import { isRoomDisabledError } from '../lib/roomClosed';
import { AudioMixer, MIXER_SOURCES, type MixerSourceId } from '../lib/audioMixer';
import { canComposite, SceneCompositor } from '../lib/sceneCompositor';
import {
  AUDIO_ENCODINGS,
  buildSceneMessage,
  isTerminalStreamError,
  mungeOpusStereo,
  parseIceServers,
  parseStreamEvent,
  resolveStreamApiUrl,
  sessionUrl,
  SIMULCAST_ENCODINGS,
  STREAM_EVENTS_INIT,
  STREAM_EVENTS_LABEL,
  StreamError,
  streamErrorFrom,
  streamErrorMessage,
  streamRoomUrl,
  type EndReason,
  type HostStats,
  type SceneName,
  type StreamEvent,
  type StreamState,
} from '../lib/streamProtocol';

/**
 * Transmisión en vivo (docs/dominio-transmision.md §3–§5).
 *
 * - **Host** (`publish`): captura la pantalla (con audio del sistema), la compone en un canvas
 *   (cámara opcional en PiP y escenas) y publica dos sesiones WHIP: `?kind=video` (VP8 simulcast
 *   h/m/l + DataChannel `stream-events`) y `?kind=audio` (la mezcla del `AudioMixer`, Opus
 *   estéreo). Credencial: un sync-ticket de identity-api.
 * - **Viewer** (`watch`): una sesión WHEP `recvonly` (vídeo + audio + DataChannel) con el guest
 *   token. Si la PeerConnection se cae y el stream sigue, reconecta con espera creciente.
 *
 * El estado lo dicta el servidor por el DataChannel (`stream_state`, `viewer_count`, `scene`,
 * `host_stats`). `ended` (por `stream_state` o `410 ROOM_DISABLED`) es terminal.
 */

export type LiveStatus = 'idle' | 'connecting' | 'waiting' | 'live' | 'reconnecting' | 'ended' | 'error';

export interface LiveError {
  code: string;
  message: string;
}

export interface MixerSourceView {
  available: boolean;
  gain: number;
  muted: boolean;
}

export type MixerView = Record<MixerSourceId, MixerSourceView>;

export interface StopOptions {
  /** `false`: no hace DELETE de las sesiones (el servidor ya las cerró). Por defecto `true`. */
  remote?: boolean;
}

export interface UseLiveStreamOptions {
  role: 'host' | 'guest';
  /** Título de la sala para las escenas del compositor. */
  title?: string;
  /** Origen de la API (por defecto `VITE_STREAM_API_URL`). */
  baseUrl?: string;
  /** Inyectable para pruebas: sync-ticket del host. */
  fetchHostTicket?: (roomId: string) => Promise<string>;
  /** Espera base de la reconexión (se duplica hasta `reconnectMaxMs`). */
  reconnectBaseMs?: number;
  reconnectMaxMs?: number;
}

/** Restricciones de la captura (HU-LIVE-01b AC1/AC5): audio del sistema sin procesar ni eco local. */
export const DISPLAY_MEDIA_OPTIONS = {
  video: { frameRate: { ideal: 30, max: 30 }, width: { ideal: 1920 }, height: { ideal: 1080 } },
  audio: {
    echoCancellation: false,
    noiseSuppression: false,
    autoGainControl: false,
    suppressLocalAudioPlayback: true,
    restrictOwnAudio: true,
  },
  systemAudio: 'include',
  selfBrowserSurface: 'exclude',
  surfaceSwitching: 'include',
} as const;

export const MIC_CONSTRAINTS: MediaStreamConstraints = {
  audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
};

export const CAMERA_CONSTRAINTS: MediaStreamConstraints = {
  video: { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } },
  audio: false,
};

/** Espera de la recolección de candidatos antes del POST (§7: ≤ 1,5 s). */
const ICE_GATHER_TIMEOUT_MS = 1500;

const EMPTY_MIXER: MixerView = {
  pc: { available: false, gain: 1, muted: false },
  mic: { available: false, gain: 1, muted: false },
  stage: { available: false, gain: 1, muted: false },
};

async function defaultHostTicket(roomId: string): Promise<string> {
  const ticket = (await apiFetch(`/rooms/${encodeURIComponent(roomId)}/sync-ticket`, { method: 'POST' })) as {
    token: string;
  };
  return ticket.token;
}

function toLiveError(err: unknown): LiveError {
  if (err instanceof StreamError) return { code: err.code, message: err.message };
  if (isRoomDisabledError(err)) return { code: 'ROOM_DISABLED', message: streamErrorMessage('ROOM_DISABLED') };
  const status = errorStatus(err);
  const code = status === 403 ? 'FORBIDDEN_ROLE' : status === 404 || status === 410 ? 'STREAM_NOT_FOUND' : 'UNAVAILABLE';
  return { code, message: streamErrorMessage(code) };
}

function supportsLocalPlaybackSuppression(): boolean {
  try {
    const c = navigator.mediaDevices?.getSupportedConstraints?.() as Record<string, boolean> | undefined;
    return !!c?.suppressLocalAudioPlayback;
  } catch {
    return false;
  }
}

function waitIceGathering(pc: RTCPeerConnection): Promise<void> {
  if (pc.iceGatheringState === 'complete') return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      pc.removeEventListener('icegatheringstatechange', onChange);
      resolve();
    };
    const onChange = () => {
      if (pc.iceGatheringState === 'complete') done();
    };
    const timer = setTimeout(done, ICE_GATHER_TIMEOUT_MS);
    pc.addEventListener('icegatheringstatechange', onChange);
  });
}

/** Prefiere VP8 (lo único que reenvía stream-core) si el navegador permite elegir códec. */
function preferVp8(transceiver: RTCRtpTransceiver) {
  const caps = (globalThis as { RTCRtpSender?: typeof RTCRtpSender }).RTCRtpSender?.getCapabilities?.('video');
  if (!caps || typeof transceiver.setCodecPreferences !== 'function') return;
  const vp8 = caps.codecs.filter((c) => /vp8/i.test(c.mimeType));
  const rest = caps.codecs.filter((c) => /rtx|red|ulpfec/i.test(c.mimeType));
  if (vp8.length) {
    try {
      transceiver.setCodecPreferences([...vp8, ...rest]);
    } catch {
      // Algunos navegadores rechazan la lista: se negocia con la oferta por defecto (incluye VP8).
    }
  }
}

export function useLiveStream(roomId: string | undefined, opts: UseLiveStreamOptions) {
  const optsRef = useRef(opts);
  optsRef.current = opts;
  const roomRef = useRef(roomId);
  roomRef.current = roomId;

  const [status, setStatus] = useState<LiveStatus>('idle');
  const [publishing, setPublishing] = useState(false);
  const [error, setError] = useState<LiveError | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [systemAudioUnavailable, setSystemAudioUnavailable] = useState(false);
  const [echoHint, setEchoHint] = useState(false);
  const [viewerCount, setViewerCount] = useState<number | null>(null);
  const [scene, setSceneState] = useState<SceneName | null>(null);
  const [hostStats, setHostStats] = useState<HostStats | null>(null);
  const [endedReason, setEndedReason] = useState<EndReason | null>(null);
  const [remoteStream, setRemoteStream] = useState<MediaStream | null>(null);
  const [previewStream, setPreviewStream] = useState<MediaStream | null>(null);
  const [cameraOn, setCameraOn] = useState(false);
  const [screenSharing, setScreenSharing] = useState(false);
  const [mixerView, setMixerView] = useState<MixerView>(EMPTY_MIXER);

  // Estado de la conexión fuera de React: los callbacks asíncronos no leen closures viejos.
  const rt = useRef({
    active: false,
    gen: 0,
    token: '',
    sessions: [] as string[],
    pcs: [] as RTCPeerConnection[],
    dc: null as RTCDataChannel | null,
    screen: null as MediaStream | null,
    mic: null as MediaStream | null,
    camera: null as MediaStream | null,
    mixer: null as AudioMixer | null,
    compositor: null as SceneCompositor | null,
    videoTrack: null as MediaStreamTrack | null,
    videoSender: null as RTCRtpSender | null,
    attempt: 0,
    timer: null as ReturnType<typeof setTimeout> | null,
    serverState: null as StreamState | null,
    ended: false,
  }).current;

  const base = () => resolveStreamApiUrl(optsRef.current.baseUrl);
  const isHost = () => optsRef.current.role === 'host';

  const syncMixerView = () => {
    const mixer = rt.mixer;
    if (!mixer) {
      setMixerView(EMPTY_MIXER);
      return;
    }
    const view = {} as MixerView;
    for (const id of MIXER_SOURCES) {
      view[id] = { available: mixer.hasSource(id), gain: mixer.getGain(id), muted: mixer.isMuted(id) };
    }
    setMixerView(view);
  };

  const getToken = async (): Promise<string> => {
    const room = roomRef.current ?? '';
    if (isHost()) return (optsRef.current.fetchHostTicket ?? defaultHostTicket)(room);
    const token = localStorage.getItem('tint_guest_token');
    if (!token) throw new StreamError(401, 'UNAUTHORIZED', streamErrorMessage('UNAUTHORIZED'));
    return token;
  };

  const request = async (url: string, init: RequestInit): Promise<Response> => {
    try {
      return await fetch(url, init);
    } catch {
      throw new StreamError(0, 'NETWORK', streamErrorMessage('NETWORK'));
    }
  };

  const fetchIce = async (token: string): Promise<RTCIceServer[]> => {
    const res = await request(streamRoomUrl(base(), roomRef.current ?? '', 'ice-servers'), {
      method: 'GET',
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) {
      const err = await streamErrorFrom(res);
      // Sin TURN se intenta igual por la ruta directa (HU-LIVE-03 AC2); un 4xx sí es definitivo.
      if (isTerminalStreamError(err)) throw err;
      return [];
    }
    return parseIceServers(await res.json().catch(() => null));
  };

  const negotiate = async (pc: RTCPeerConnection, url: string, token: string, stereo = false): Promise<string> => {
    const offer = await pc.createOffer();
    const sdp = stereo && offer.sdp ? mungeOpusStereo(offer.sdp) : offer.sdp;
    await pc.setLocalDescription({ type: 'offer', sdp });
    await waitIceGathering(pc);
    const res = await request(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/sdp', Authorization: `Bearer ${token}` },
      body: pc.localDescription?.sdp ?? sdp,
    });
    if (res.status !== 201 && !res.ok) throw await streamErrorFrom(res);
    const answer = await res.text();
    const location = res.headers.get('Location');
    await pc.setRemoteDescription({ type: 'answer', sdp: answer });
    return location ? sessionUrl(base(), location) : '';
  };

  const deleteSessions = (sessions: string[], token: string) =>
    Promise.allSettled(
      sessions
        .filter(Boolean)
        .map((url) =>
          fetch(url, { method: 'DELETE', headers: { Authorization: `Bearer ${token}` }, keepalive: true }),
        ),
    );

  const closeConnections = () => {
    for (const pc of rt.pcs) {
      pc.onconnectionstatechange = null;
      pc.close();
    }
    rt.pcs = [];
    rt.dc = null;
    rt.videoSender = null;
  };

  const releaseMedia = () => {
    for (const s of [rt.screen, rt.mic, rt.camera]) s?.getTracks().forEach((t) => t.stop());
    rt.screen = null;
    rt.mic = null;
    rt.camera = null;
    rt.compositor?.dispose();
    rt.compositor = null;
    rt.mixer?.dispose();
    rt.mixer = null;
    rt.videoTrack = null;
    setPreviewStream(null);
    setCameraOn(false);
    setScreenSharing(false);
    syncMixerView();
  };

  const clearTimer = () => {
    if (rt.timer) clearTimeout(rt.timer);
    rt.timer = null;
  };

  /** Fin del evento: terminal, sin DELETE (el servidor ya cerró todo). */
  const finishEnded = (reason?: EndReason) => {
    rt.active = false;
    rt.ended = true;
    rt.gen += 1;
    clearTimer();
    closeConnections();
    releaseMedia();
    rt.sessions = [];
    setPublishing(false);
    setRemoteStream(null);
    if (reason) setEndedReason(reason);
    setStatus('ended');
  };

  const fail = (err: unknown) => {
    const e = toLiveError(err);
    setError(e);
    if (e.code === 'ROOM_DISABLED') {
      finishEnded();
      return;
    }
    const sessions = rt.sessions;
    rt.sessions = [];
    void deleteSessions(sessions, rt.token);
    rt.active = false;
    rt.gen += 1;
    clearTimer();
    closeConnections();
    releaseMedia();
    setPublishing(false);
    setStatus('error');
  };

  const handleEvent = (ev: StreamEvent) => {
    switch (ev.type) {
      case 'stream_state':
        rt.serverState = ev.state;
        if (ev.state === 'ended') {
          finishEnded(ev.reason);
          return;
        }
        setStatus(ev.state);
        return;
      case 'viewer_count':
        setViewerCount(ev.count);
        return;
      case 'scene':
        setSceneState(ev.name);
        return;
      case 'host_stats':
        setHostStats({ layers: ev.layers, nacks: ev.nacks, plis: ev.plis });
        return;
    }
  };

  const attachChannel = (dc: RTCDataChannel) => {
    rt.dc = dc;
    dc.addEventListener('message', (e: MessageEvent) => {
      const ev = parseStreamEvent(e.data);
      if (ev) handleEvent(ev);
    });
  };

  const scheduleReconnect = (run: () => void) => {
    const { reconnectBaseMs = 1000, reconnectMaxMs = 10_000 } = optsRef.current;
    const delay = Math.min(reconnectBaseMs * 2 ** rt.attempt, reconnectMaxMs);
    rt.attempt += 1;
    setStatus('reconnecting');
    clearTimer();
    rt.timer = setTimeout(() => {
      rt.timer = null;
      run();
    }, delay);
  };

  // PeerConnection caída: el viewer vuelve a hacer WHEP; el host repite el WHIP (reemplaza su sesión).
  const watchConnection = (pc: RTCPeerConnection, gen: number) => {
    pc.onconnectionstatechange = () => {
      if (gen !== rt.gen || !rt.active) return;
      if (pc.connectionState === 'connected' && rt.serverState) setStatus(rt.serverState);
      if (pc.connectionState === 'failed') {
        rt.gen += 1;
        const old = rt.sessions;
        rt.sessions = [];
        closeConnections();
        // El viewer libera su lugar en el cupo; el host no: su WHIP nuevo reemplaza la sesión.
        if (!isHost()) void deleteSessions(old, rt.token);
        scheduleReconnect(() => void (isHost() ? connectHost() : connectViewer()));
      }
    };
  };

  // --- Host ---

  const connectHost = async () => {
    const gen = rt.gen;
    try {
      rt.token = await getToken();
      const iceServers = await fetchIce(rt.token);
      if (gen !== rt.gen) return;
      const config: RTCConfiguration = { iceServers, bundlePolicy: 'max-bundle' };

      const vpc = new RTCPeerConnection(config);
      rt.pcs.push(vpc);
      attachChannel(vpc.createDataChannel(STREAM_EVENTS_LABEL, STREAM_EVENTS_INIT));
      const video = vpc.addTransceiver(rt.videoTrack as MediaStreamTrack, {
        direction: 'sendonly',
        sendEncodings: SIMULCAST_ENCODINGS.map((e) => ({ ...e })),
      });
      preferVp8(video);
      rt.videoSender = video.sender;
      watchConnection(vpc, gen);
      const videoSession = await negotiate(vpc, `${streamRoomUrl(base(), roomRef.current ?? '', 'whip')}?kind=video`, rt.token);
      if (gen !== rt.gen) return;
      rt.sessions.push(videoSession);

      const audioTrack = rt.mixer?.output.getAudioTracks()[0] ?? null;
      if (audioTrack) {
        const apc = new RTCPeerConnection(config);
        rt.pcs.push(apc);
        apc.addTransceiver(audioTrack, { direction: 'sendonly', sendEncodings: AUDIO_ENCODINGS.map((e) => ({ ...e })) });
        watchConnection(apc, gen);
        const audioSession = await negotiate(
          apc,
          `${streamRoomUrl(base(), roomRef.current ?? '', 'whip')}?kind=audio`,
          rt.token,
          true,
        );
        if (gen !== rt.gen) return;
        rt.sessions.push(audioSession);
      }
      rt.attempt = 0;
      setPublishing(true);
      setStatus(rt.serverState && rt.serverState !== 'reconnecting' ? rt.serverState : 'live');
    } catch (err) {
      if (gen !== rt.gen) return;
      // Reintenta solo una reconexión con un error pasajero; el primer intento falla en claro.
      if (rt.attempt > 0 && err instanceof StreamError && !isTerminalStreamError(err)) {
        rt.gen += 1;
        closeConnections();
        scheduleReconnect(() => void connectHost());
        return;
      }
      fail(err);
    }
  };

  const onScreenEnded = () => {
    if (!rt.active) return;
    rt.compositor?.setScreen(null);
    setScreenSharing(false);
    setNotice(
      rt.compositor
        ? 'Dejaste de compartir la pantalla. Los espectadores ven «Volvemos enseguida»; pulsa «Cambiar pantalla» para volver.'
        : 'Dejaste de compartir la pantalla. Pulsa «Cambiar pantalla» para volver a transmitir.',
    );
  };

  const adoptScreen = (screen: MediaStream) => {
    const track = screen.getVideoTracks()[0];
    rt.screen = screen;
    track?.addEventListener('ended', onScreenEnded);
    setScreenSharing(true);
    const mixer = rt.mixer;
    if (mixer) {
      mixer.addSource('pc', screen);
      setSystemAudioUnavailable(mixer.systemAudioUnavailable);
      if (mixer.systemAudioMessage) setNotice(mixer.systemAudioMessage);
      syncMixerView();
    }
    return track ?? null;
  };

  const captureScreen = async (): Promise<MediaStream> => {
    const md = navigator.mediaDevices;
    if (!md?.getDisplayMedia) throw new StreamError(0, 'SCREEN_UNSUPPORTED', streamErrorMessage('SCREEN_UNSUPPORTED'));
    try {
      return await md.getDisplayMedia(DISPLAY_MEDIA_OPTIONS as unknown as DisplayMediaStreamOptions);
    } catch (err) {
      const name = (err as { name?: string })?.name;
      const code = name === 'NotAllowedError' || name === 'AbortError' ? 'SCREEN_DENIED' : 'SCREEN_UNSUPPORTED';
      throw new StreamError(0, code, streamErrorMessage(code));
    }
  };

  const addMic = async (): Promise<boolean> => {
    try {
      const mic = await navigator.mediaDevices.getUserMedia(MIC_CONSTRAINTS);
      rt.mic?.getTracks().forEach((t) => t.stop());
      rt.mic = mic;
      rt.mixer?.addSource('mic', mic);
      syncMixerView();
      return true;
    } catch {
      return false;
    }
  };

  const publish = useCallback(async () => {
    if (rt.active || rt.ended) return;
    setError(null);
    setNotice(null);
    let screen: MediaStream;
    try {
      screen = await captureScreen();
    } catch (err) {
      // Sin pantalla no hay transmisión: no se hace ningún POST (HU-LIVE-01 AC3).
      setError(toLiveError(err));
      return;
    }
    rt.active = true;
    rt.attempt = 0;
    rt.serverState = null;
    setStatus('connecting');
    try {
      rt.mixer = new AudioMixer();
    } catch {
      rt.mixer = null;
    }
    const screenTrack = adoptScreen(screen);
    const audioWarning = rt.mixer?.systemAudioMessage ?? null;
    if (!(await addMic())) {
      setNotice(
        audioWarning
          ? 'No llegó el audio del PC ni el micrófono: la transmisión va sin sonido. Revisa los permisos del micrófono.'
          : 'No pudimos usar el micrófono. La transmisión sigue con el audio del PC.',
      );
    }
    setEchoHint(!supportsLocalPlaybackSuppression());
    await rt.mixer?.resume().catch(() => {});
    if (canComposite()) {
      try {
        rt.compositor = new SceneCompositor({ title: optsRef.current.title });
        rt.compositor.setScreen(screenTrack);
      } catch {
        rt.compositor = null;
      }
    }
    rt.videoTrack = rt.compositor?.track ?? screenTrack;
    if (rt.videoTrack && !rt.compositor) rt.videoTrack.contentHint = 'motion';
    if (rt.videoTrack) setPreviewStream(new MediaStream([rt.videoTrack]));
    setSceneState('live');
    await connectHost();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- solo refs y setters estables
  }, []);

  /** Cambia la pantalla compartida sin renegociar (el compositor o replaceTrack). */
  const replaceScreen = useCallback(async () => {
    if (!rt.active || !isHost()) return;
    let screen: MediaStream;
    try {
      screen = await captureScreen();
    } catch {
      setNotice(rt.screen ? 'Seguimos con la pantalla anterior.' : 'No se compartió ninguna pantalla.');
      return;
    }
    const old = rt.screen;
    const track = adoptScreen(screen);
    if (!rt.mixer?.systemAudioMessage) setNotice(null);
    old?.getTracks().forEach((t) => t.stop());
    if (rt.compositor) {
      rt.compositor.setScreen(track);
    } else if (track) {
      track.contentHint = 'motion';
      rt.videoTrack = track;
      await rt.videoSender?.replaceTrack(track);
      setPreviewStream(new MediaStream([track]));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- solo refs y setters estables
  }, []);

  const setCameraEnabled = useCallback(async (on: boolean) => {
    if (!rt.active || !isHost()) return;
    if (!on) {
      rt.camera?.getTracks().forEach((t) => t.stop());
      rt.camera = null;
      rt.compositor?.setCamera(null);
      setCameraOn(false);
      return;
    }
    let camera: MediaStream;
    try {
      camera = await navigator.mediaDevices.getUserMedia(CAMERA_CONSTRAINTS);
    } catch {
      setNotice('No pudimos usar la cámara. La transmisión sigue solo con la pantalla.');
      return;
    }
    if (!rt.active || !rt.compositor) {
      camera.getTracks().forEach((t) => t.stop());
      if (rt.active) setNotice('Este navegador no puede combinar la cámara con la pantalla; la transmisión sigue sin cámara.');
      return;
    }
    rt.camera?.getTracks().forEach((t) => t.stop());
    rt.camera = camera;
    rt.compositor.setCamera(camera.getVideoTracks()[0] ?? null);
    setCameraOn(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- solo refs y setters estables
  }, []);

  /** Reintenta el micrófono (si se negó al empezar). */
  const enableMic = useCallback(async () => {
    if (!rt.active || !rt.mixer) return;
    if (await addMic()) setNotice(null);
    else setNotice('No pudimos usar el micrófono. Revisa el permiso en el navegador.');
    // eslint-disable-next-line react-hooks/exhaustive-deps -- solo refs y setters estables
  }, []);

  /** Escena para todos: se dibuja en el canvas y se avisa por el DataChannel (§4). */
  const setScene = useCallback((name: SceneName) => {
    if (!isHost()) return;
    rt.compositor?.setScene(name);
    setSceneState(name);
    const dc = rt.dc;
    if (dc && dc.readyState === 'open') dc.send(buildSceneMessage(name));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- solo refs y setters estables
  }, []);

  const setGain = useCallback((id: MixerSourceId, value: number) => {
    rt.mixer?.setGain(id, value);
    syncMixerView();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- solo refs y setters estables
  }, []);

  const setMuted = useCallback((id: MixerSourceId, muted: boolean) => {
    rt.mixer?.setMuted(id, muted);
    syncMixerView();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- solo refs y setters estables
  }, []);

  /** Nivel actual (0..1) de cada fuente, para los vúmetros (se consulta por animación). */
  const levels = useCallback((): Record<MixerSourceId, number> => {
    const m = rt.mixer;
    return { pc: m?.level('pc') ?? 0, mic: m?.level('mic') ?? 0, stage: m?.level('stage') ?? 0 };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- solo refs
  }, []);

  /** Voces del escenario (voz de la sala) que el host mezcla en la transmisión. */
  const setStageStreams = useCallback((streams: MediaStream[]) => {
    const mixer = rt.mixer;
    if (!mixer) return;
    const tracks = streams.flatMap((s) => s.getAudioTracks());
    if (tracks.length === 0) mixer.removeSource('stage');
    else mixer.addSource('stage', new MediaStream(tracks));
    syncMixerView();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- solo refs y setters estables
  }, []);

  // --- Viewer ---

  const connectViewer = async () => {
    const gen = rt.gen;
    try {
      rt.token = await getToken();
      const iceServers = await fetchIce(rt.token);
      if (gen !== rt.gen) return;
      const pc = new RTCPeerConnection({ iceServers, bundlePolicy: 'max-bundle' });
      rt.pcs.push(pc);
      attachChannel(pc.createDataChannel(STREAM_EVENTS_LABEL, STREAM_EVENTS_INIT));
      pc.addTransceiver('video', { direction: 'recvonly' });
      pc.addTransceiver('audio', { direction: 'recvonly' });
      const tracks: MediaStreamTrack[] = [];
      pc.addEventListener('track', (ev: RTCTrackEvent) => {
        if (gen !== rt.gen || tracks.includes(ev.track)) return;
        tracks.push(ev.track);
        setRemoteStream(new MediaStream([...tracks]));
      });
      watchConnection(pc, gen);
      const session = await negotiate(pc, streamRoomUrl(base(), roomRef.current ?? '', 'whep'), rt.token);
      if (gen !== rt.gen) return;
      rt.sessions = [session];
      rt.attempt = 0;
      setError(null);
    } catch (err) {
      if (gen !== rt.gen) return;
      if (err instanceof StreamError && !isTerminalStreamError(err)) {
        // Red o 5xx: el stream puede seguir; se reintenta con espera creciente.
        rt.gen += 1;
        closeConnections();
        setError(toLiveError(err));
        scheduleReconnect(() => void connectViewer());
        return;
      }
      fail(err);
    }
  };

  const watch = useCallback(async () => {
    if (rt.active || rt.ended) return;
    if (typeof RTCPeerConnection === 'undefined') {
      setError({ code: 'WEBRTC_UNSUPPORTED', message: streamErrorMessage('WEBRTC_UNSUPPORTED') });
      setStatus('error');
      return;
    }
    rt.active = true;
    rt.attempt = 0;
    rt.serverState = null;
    setError(null);
    setStatus('connecting');
    await connectViewer();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- solo refs y setters estables
  }, []);

  /**
   * Deja de publicar o de ver: DELETE de cada sesión y libera pistas. Con `remote: false` solo
   * libera lo local: tras `POST /rooms/{id}/end` stream-core ya cerró las sesiones (un DELETE daría 404).
   */
  const stop = useCallback(async ({ remote = true }: StopOptions = {}) => {
    const sessions = rt.sessions;
    rt.sessions = [];
    rt.active = false;
    rt.gen += 1;
    clearTimer();
    closeConnections();
    releaseMedia();
    setPublishing(false);
    setRemoteStream(null);
    if (!rt.ended) setStatus('idle');
    if (remote) await deleteSessions(sessions, rt.token);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- solo refs y setters estables
  }, []);

  const dismissNotice = useCallback(() => setNotice(null), []);

  // Al cerrar la pestaña o desmontar se liberan las sesiones (DELETE con keepalive).
  useEffect(() => {
    const onHide = () => {
      if (rt.active) void stop();
    };
    window.addEventListener('pagehide', onHide);
    return () => {
      window.removeEventListener('pagehide', onHide);
      if (rt.active) void stop();
    };
  }, [rt, stop]);

  return {
    status,
    publishing,
    error,
    notice,
    systemAudioUnavailable,
    echoHint,
    viewerCount,
    scene,
    hostStats,
    endedReason,
    remoteStream,
    previewStream,
    cameraOn,
    screenSharing,
    mixer: mixerView,
    publish,
    watch,
    stop,
    replaceScreen,
    setCameraEnabled,
    enableMic,
    setScene,
    setGain,
    setMuted,
    levels,
    setStageStreams,
    dismissNotice,
  };
}

export type LiveStream = ReturnType<typeof useLiveStream>;
