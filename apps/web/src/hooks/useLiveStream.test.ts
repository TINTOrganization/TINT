/**
 * Pruebas rojas de `useLiveStream` (docs/dominio-transmision.md §1, §3 y §4).
 *
 * Contrato que especifican (el módulo aún no existe):
 *   const live = useLiveStream(roomId, { role: 'host' | 'guest' });
 *   live.publish(): Promise<void>        // host: captura + WHIP vídeo y audio
 *   live.watch(): Promise<void>          // viewer: WHEP recvonly + DataChannel
 *   live.stop(): Promise<void>           // DELETE de cada sesión (Location) y libera pistas
 *   live.setCameraEnabled(on): Promise<void>
 *   live.status: 'idle' | 'connecting' | 'waiting' | 'live' | 'reconnecting' | 'ended' | 'error'
 *   live.publishing: boolean
 *   live.error: { code: 'SCREEN_DENIED' | 'ROOM_FULL' | 'ROOM_DISABLED' | string; message: string } | null
 *   live.notice: string | null           // avisos que no bloquean (cámara, audio del PC)
 *   live.systemAudioUnavailable: boolean
 *   live.viewerCount: number | null; live.scene: 'live' | 'starting_soon' | 'brb' | null
 *   live.remoteStream: MediaStream | null
 *
 * Dependencias de plataforma: navigator.mediaDevices, RTCPeerConnection, AudioContext y fetch
 * globales; base `VITE_STREAM_API_URL`; ticket del host con POST /rooms/:id/sync-ticket (apiFetch).
 */
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useLiveStream } from './useLiveStream';
import { apiFetch } from '../lib/api';
import {
  FakeAudioContext,
  FakeMediaStream,
  FakeMediaTrack,
  FakeStreamPeerConnection,
  fakeResponse,
  flushLive,
  headersOf,
  sdpCreated,
  streamError,
} from '../test/fakeLiveStream';

vi.mock('../lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/api')>()),
  apiFetch: vi.fn(),
}));
const mockedApi = vi.mocked(apiFetch);

const BASE = 'https://stream.test';

let screenVideo: FakeMediaTrack;
let screenAudio: FakeMediaTrack;
let getDisplayMedia: ReturnType<typeof vi.fn>;
let getUserMedia: ReturnType<typeof vi.fn>;
let fetchMock: ReturnType<typeof vi.fn>;
/** Respuestas por clave: `whip:video`, `whip:audio`, `whep`. */
let responses: Record<string, () => Response>;

function routeFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const url = String(input);
  const method = (init?.method ?? 'GET').toUpperCase();
  if (method === 'DELETE') return Promise.resolve(fakeResponse({ status: 200 }));
  if (method === 'PATCH') return Promise.resolve(fakeResponse({ status: 204 }));
  if (url.includes('/ice-servers')) return Promise.resolve(fakeResponse({ status: 200, json: { ice_servers: [] } }));
  if (url.includes('/whip?kind=video')) return Promise.resolve(responses['whip:video']());
  if (url.includes('/whip?kind=audio')) return Promise.resolve(responses['whip:audio']());
  if (url.includes('/whep')) return Promise.resolve(responses.whep());
  return Promise.reject(new Error(`ruta no simulada ${method} ${url}`));
}

function callsTo(fragment: string, method = 'POST') {
  return fetchMock.mock.calls.filter(
    ([u, init]) => String(u).includes(fragment) && ((init as RequestInit | undefined)?.method ?? 'GET').toUpperCase() === method,
  ) as Array<[string, RequestInit]>;
}

function pcSending(kind: 'audio' | 'video') {
  return FakeStreamPeerConnection.instances.find((pc) => pc.sends(kind) && (kind === 'audio' ? !pc.sends('video') : true));
}

async function publish(hook: { current: ReturnType<typeof useLiveStream> }) {
  await act(async () => {
    await hook.current.publish();
    await flushLive();
  });
}

async function watch(hook: { current: ReturnType<typeof useLiveStream> }) {
  await act(async () => {
    await hook.current.watch();
    await flushLive();
  });
}

function domError(name: string) {
  return new DOMException('denegado', name);
}

beforeEach(() => {
  FakeStreamPeerConnection.reset();
  FakeAudioContext.reset();
  localStorage.clear();
  vi.stubEnv('VITE_STREAM_API_URL', BASE);
  screenVideo = new FakeMediaTrack('video', 'screen');
  screenAudio = new FakeMediaTrack('audio', 'system');
  getDisplayMedia = vi.fn(async () => new FakeMediaStream([screenVideo, screenAudio]));
  getUserMedia = vi.fn(async (c: MediaStreamConstraints) =>
    new FakeMediaStream(c.video ? [new FakeMediaTrack('video', 'camera')] : [new FakeMediaTrack('audio', 'mic')]),
  );
  Object.defineProperty(navigator, 'mediaDevices', {
    configurable: true,
    value: { getDisplayMedia, getUserMedia, enumerateDevices: vi.fn(async () => []) },
  });
  vi.stubGlobal('RTCPeerConnection', FakeStreamPeerConnection);
  vi.stubGlobal('AudioContext', FakeAudioContext);
  vi.stubGlobal('MediaStream', FakeMediaStream);
  responses = {
    'whip:video': () => sdpCreated('s-video'),
    'whip:audio': () => sdpCreated('s-audio'),
    whep: () => sdpCreated('s-view'),
  };
  fetchMock = vi.fn(routeFetch);
  vi.stubGlobal('fetch', fetchMock);
  mockedApi.mockReset();
  mockedApi.mockImplementation((async (path: string) => {
    if (path.endsWith('/sync-ticket')) return { token: 'host-ticket', expiresAt: '2099-01-01T00:00:00Z' };
    throw new Error(`ruta no simulada ${path}`);
  }) as typeof apiFetch);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('useLiveStream — host: captura (HU-LIVE-01 AC3, HU-LIVE-01b AC1)', () => {
  it('pide la pantalla con audio del sistema', async () => {
    localStorage.setItem('tint_token', 'host');
    const { result } = renderHook(() => useLiveStream('r1', { role: 'host' }));
    await publish(result);
    expect(getDisplayMedia).toHaveBeenCalledTimes(1);
    const arg = getDisplayMedia.mock.calls[0][0] as DisplayMediaStreamOptions & { systemAudio?: string };
    expect(arg.video).toBeTruthy();
    expect(arg.audio === true || typeof arg.audio === 'object').toBe(true);
    expect(arg.systemAudio).toBe('include');
  });

  it.each(['NotAllowedError', 'AbortError'])(
    'si el host niega o cancela la pantalla (%s): error claro y ningún POST WHIP',
    async (name) => {
      localStorage.setItem('tint_token', 'host');
      getDisplayMedia.mockRejectedValueOnce(domError(name));
      const { result } = renderHook(() => useLiveStream('r1', { role: 'host' }));
      await publish(result);
      expect(result.current.error?.code).toBe('SCREEN_DENIED');
      expect(result.current.error?.message).toMatch(/pantalla/i);
      expect(result.current.publishing).toBe(false);
      expect(callsTo('/whip')).toHaveLength(0);
      expect(FakeStreamPeerConnection.instances).toHaveLength(0);
    },
  );

  it('por defecto transmite solo la pantalla: no pide la cámara', async () => {
    localStorage.setItem('tint_token', 'host');
    const { result } = renderHook(() => useLiveStream('r1', { role: 'host' }));
    await publish(result);
    const cameraCalls = getUserMedia.mock.calls.filter(([c]) => !!(c as MediaStreamConstraints).video);
    expect(cameraCalls).toHaveLength(0);
    expect(result.current.publishing).toBe(true);
  });

  it('la cámara se activa en vivo pidiendo getUserMedia con vídeo', async () => {
    localStorage.setItem('tint_token', 'host');
    const { result } = renderHook(() => useLiveStream('r1', { role: 'host' }));
    await publish(result);
    await act(async () => {
      await result.current.setCameraEnabled(true);
      await flushLive();
    });
    const cameraCalls = getUserMedia.mock.calls.filter(([c]) => !!(c as MediaStreamConstraints).video);
    expect(cameraCalls).toHaveLength(1);
    expect(result.current.publishing).toBe(true);
  });

  it('si se niega la cámara: aviso que no bloquea y el stream sigue', async () => {
    localStorage.setItem('tint_token', 'host');
    getUserMedia.mockImplementation(async (c: MediaStreamConstraints) => {
      if (c.video) throw domError('NotAllowedError');
      return new FakeMediaStream([new FakeMediaTrack('audio', 'mic')]);
    });
    const { result } = renderHook(() => useLiveStream('r1', { role: 'host' }));
    await publish(result);
    await act(async () => {
      await result.current.setCameraEnabled(true);
      await flushLive();
    });
    expect(result.current.notice).toMatch(/cámara/i);
    expect(result.current.error).toBeNull();
    expect(result.current.publishing).toBe(true);
    expect(callsTo('/api/v1/stream/sessions/', 'DELETE')).toHaveLength(0);
  });

  it('sin pista de audio del sistema: aviso claro y la transmisión sigue (HU-LIVE-01b AC4)', async () => {
    localStorage.setItem('tint_token', 'host');
    getDisplayMedia.mockResolvedValueOnce(new FakeMediaStream([screenVideo]));
    const { result } = renderHook(() => useLiveStream('r1', { role: 'host' }));
    await publish(result);
    expect(result.current.systemAudioUnavailable).toBe(true);
    expect(result.current.notice).toMatch(/audio/i);
    expect(result.current.error).toBeNull();
    expect(result.current.publishing).toBe(true);
    expect(callsTo('/whip?kind=video')).toHaveLength(1);
  });
});

describe('useLiveStream — host: WHIP (HU-LIVE-01 AC1, §3)', () => {
  it('publica vídeo y audio en dos sesiones WHIP con SDP y el ticket del host', async () => {
    localStorage.setItem('tint_token', 'host');
    const { result } = renderHook(() => useLiveStream('r1', { role: 'host' }));
    await publish(result);
    const video = callsTo('/whip?kind=video');
    const audio = callsTo('/whip?kind=audio');
    expect(video).toHaveLength(1);
    expect(audio).toHaveLength(1);
    expect(video[0][0]).toBe(`${BASE}/api/v1/stream/rooms/r1/whip?kind=video`);
    expect(audio[0][0]).toBe(`${BASE}/api/v1/stream/rooms/r1/whip?kind=audio`);
    for (const [, init] of [...video, ...audio]) {
      expect(headersOf(init).get('Content-Type')).toBe('application/sdp');
      expect(headersOf(init).get('Authorization')).toBe('Bearer host-ticket');
    }
    expect(mockedApi).toHaveBeenCalledWith('/rooms/r1/sync-ticket', expect.objectContaining({ method: 'POST' }));
  });

  it('el vídeo va en simulcast VP8 con las capas h, m y l', async () => {
    localStorage.setItem('tint_token', 'host');
    const { result } = renderHook(() => useLiveStream('r1', { role: 'host' }));
    await publish(result);
    const pc = pcSending('video');
    expect(pc).toBeDefined();
    const t = pc!.transceivers.find((x) => x.kind === 'video' && x.sender.track);
    expect(t?.direction).toBe('sendonly');
    expect(t?.init?.sendEncodings).toEqual([
      expect.objectContaining({ rid: 'h', scaleResolutionDownBy: 1, maxBitrate: 2_500_000 }),
      expect.objectContaining({ rid: 'm', scaleResolutionDownBy: 1.5, maxBitrate: 800_000 }),
      expect.objectContaining({ rid: 'l', scaleResolutionDownBy: 3, maxBitrate: 250_000 }),
    ]);
    // La oferta del PeerConnection de vídeo es la que viaja a ?kind=video.
    const [, init] = callsTo('/whip?kind=video')[0];
    expect(init.body).toBe(pc!.localDescription?.sdp);
  });

  it('el audio mezclado viaja en su propio PeerConnection a ?kind=audio', async () => {
    localStorage.setItem('tint_token', 'host');
    const { result } = renderHook(() => useLiveStream('r1', { role: 'host' }));
    await publish(result);
    const pc = pcSending('audio');
    expect(pc).toBeDefined();
    expect(pc!.sends('video')).toBe(false);
    const [, init] = callsTo('/whip?kind=audio')[0];
    expect(init.body).toBe(pc!.localDescription?.sdp);
  });

  it('crea el DataChannel negociado stream-events (id 0) antes de createOffer', async () => {
    localStorage.setItem('tint_token', 'host');
    const { result } = renderHook(() => useLiveStream('r1', { role: 'host' }));
    await publish(result);
    const pc = pcSending('video')!;
    const dc = pc.eventsChannel;
    expect(dc).not.toBeNull();
    expect(dc!.init).toEqual(expect.objectContaining({ negotiated: true, id: 0 }));
    expect(pc.calls.indexOf('createDataChannel')).toBeGreaterThanOrEqual(0);
    expect(pc.calls.indexOf('createDataChannel')).toBeLessThan(pc.calls.indexOf('createOffer'));
  });

  it('con 201 aplica la respuesta SDP y al parar hace DELETE a cada Location', async () => {
    localStorage.setItem('tint_token', 'host');
    const { result } = renderHook(() => useLiveStream('r1', { role: 'host' }));
    await publish(result);
    const vpc = pcSending('video')!;
    const apc = pcSending('audio')!;
    expect(vpc.remoteDescription).toEqual({ type: 'answer', sdp: 'v=0\r\ns=answer-s-video\r\n' });
    expect(apc.remoteDescription).toEqual({ type: 'answer', sdp: 'v=0\r\ns=answer-s-audio\r\n' });
    await act(async () => {
      await result.current.stop();
      await flushLive();
    });
    const deletes = callsTo('/api/v1/stream/sessions/', 'DELETE').map(([u]) => u);
    expect(deletes).toEqual(
      expect.arrayContaining([`${BASE}/api/v1/stream/sessions/s-video`, `${BASE}/api/v1/stream/sessions/s-audio`]),
    );
    for (const [, init] of callsTo('/api/v1/stream/sessions/', 'DELETE')) {
      expect(headersOf(init).get('Authorization')).toBe('Bearer host-ticket');
    }
    expect(screenVideo.stopped).toBe(true);
    expect(vpc.closed && apc.closed).toBe(true);
    expect(result.current.publishing).toBe(false);
  });

  it('409 ROOM_FULL y 410 ROOM_DISABLED son estados distintos', async () => {
    localStorage.setItem('tint_token', 'host');
    responses['whip:video'] = () => streamError(409, 'ROOM_FULL');
    const full = renderHook(() => useLiveStream('r1', { role: 'host' }));
    await publish(full.result);
    expect(full.result.current.error?.code).toBe('ROOM_FULL');
    expect(full.result.current.status).toBe('error');
    expect(full.result.current.publishing).toBe(false);

    responses['whip:video'] = () => streamError(410, 'ROOM_DISABLED');
    const disabled = renderHook(() => useLiveStream('r1', { role: 'host' }));
    await publish(disabled.result);
    expect(disabled.result.current.error?.code).toBe('ROOM_DISABLED');
    expect(disabled.result.current.status).toBe('ended');
    expect(disabled.result.current.publishing).toBe(false);
  });
});

describe('useLiveStream — viewer: WHEP y DataChannel (HU-LIVE-02, §4)', () => {
  beforeEach(() => {
    localStorage.setItem('tint_guest_token', 'guest-token');
  });

  it('hace WHEP recvonly de vídeo y audio con el guest token', async () => {
    const { result } = renderHook(() => useLiveStream('r1', { role: 'guest' }));
    await watch(result);
    const whep = callsTo('/whep');
    expect(whep).toHaveLength(1);
    expect(whep[0][0]).toBe(`${BASE}/api/v1/stream/rooms/r1/whep`);
    expect(headersOf(whep[0][1]).get('Content-Type')).toBe('application/sdp');
    expect(headersOf(whep[0][1]).get('Authorization')).toBe('Bearer guest-token');
    expect(getDisplayMedia).not.toHaveBeenCalled();
    const pc = FakeStreamPeerConnection.instances[0];
    const kinds = pc.transceivers.map((t) => `${t.kind}:${t.direction}`).sort();
    expect(kinds).toEqual(['audio:recvonly', 'video:recvonly']);
    expect(pc.remoteDescription).toEqual({ type: 'answer', sdp: 'v=0\r\ns=answer-s-view\r\n' });
  });

  it('crea el DataChannel negociado antes de createOffer', async () => {
    const { result } = renderHook(() => useLiveStream('r1', { role: 'guest' }));
    await watch(result);
    const pc = FakeStreamPeerConnection.instances[0];
    expect(pc.eventsChannel?.init).toEqual(expect.objectContaining({ negotiated: true, id: 0 }));
    expect(pc.calls.indexOf('createDataChannel')).toBeGreaterThanOrEqual(0);
    expect(pc.calls.indexOf('createDataChannel')).toBeLessThan(pc.calls.indexOf('createOffer'));
  });

  it('expone el stream remoto al llegar las pistas', async () => {
    const { result } = renderHook(() => useLiveStream('r1', { role: 'guest' }));
    await watch(result);
    expect(result.current.remoteStream).toBeNull();
    act(() => FakeStreamPeerConnection.instances[0].emitTrack(new FakeMediaTrack('video')));
    expect(result.current.remoteStream).not.toBeNull();
  });

  it('refleja stream_state, viewer_count y scene del DataChannel', async () => {
    const { result } = renderHook(() => useLiveStream('r1', { role: 'guest' }));
    await watch(result);
    const dc = FakeStreamPeerConnection.instances[0].eventsChannel!;
    act(() => dc.emit({ type: 'stream_state', state: 'waiting' }));
    expect(result.current.status).toBe('waiting');
    act(() => dc.emit({ type: 'stream_state', state: 'live' }));
    expect(result.current.status).toBe('live');
    act(() => dc.emit({ type: 'viewer_count', count: 12 }));
    expect(result.current.viewerCount).toBe(12);
    act(() => dc.emit({ type: 'scene', name: 'brb' }));
    expect(result.current.scene).toBe('brb');
    act(() => dc.emit({ type: 'stream_state', state: 'reconnecting', grace_deadline_ms: 60_000 }));
    expect(result.current.status).toBe('reconnecting');
  });

  it('ignora mensajes inválidos del DataChannel sin romper el estado', async () => {
    const { result } = renderHook(() => useLiveStream('r1', { role: 'guest' }));
    await watch(result);
    const dc = FakeStreamPeerConnection.instances[0].eventsChannel!;
    act(() => dc.emit({ type: 'stream_state', state: 'live' }));
    act(() => dc.emit('no es json'));
    act(() => dc.emit({ type: 'stream_state', state: 'bailando' }));
    act(() => dc.emit({ type: 'viewer_count', count: 'muchos' }));
    expect(result.current.status).toBe('live');
    expect(result.current.viewerCount).toBeNull();
  });

  it('stream_state ended deja la sala en ended', async () => {
    const { result } = renderHook(() => useLiveStream('r1', { role: 'guest' }));
    await watch(result);
    const dc = FakeStreamPeerConnection.instances[0].eventsChannel!;
    act(() => dc.emit({ type: 'stream_state', state: 'live' }));
    act(() => dc.emit({ type: 'stream_state', state: 'ended', reason: 'host_closed' }));
    expect(result.current.status).toBe('ended');
  });

  it('WHEP 410 ROOM_DISABLED → ended; 409 ROOM_FULL → error de cupo', async () => {
    responses.whep = () => streamError(410, 'ROOM_DISABLED');
    const disabled = renderHook(() => useLiveStream('r1', { role: 'guest' }));
    await watch(disabled.result);
    expect(disabled.result.current.status).toBe('ended');
    expect(disabled.result.current.error?.code).toBe('ROOM_DISABLED');

    responses.whep = () => streamError(409, 'ROOM_FULL');
    const full = renderHook(() => useLiveStream('r1', { role: 'guest' }));
    await watch(full.result);
    expect(full.result.current.status).toBe('error');
    expect(full.result.current.error?.code).toBe('ROOM_FULL');
  });
});
