/** useLiveStream: reconexión, escenas, cámara con compositor, mezclador y cierre. */
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useLiveStream, type UseLiveStreamOptions } from './useLiveStream';
import { ApiError } from '../lib/api';
import {
  FakeAudioContext,
  FakeMediaStream,
  FakeMediaTrack,
  FakeStreamPeerConnection,
  fakeResponse,
  flushLive,
  sdpCreated,
  streamError,
} from '../test/fakeLiveStream';

const BASE = 'https://stream.test';
let screenVideo: FakeMediaTrack;
let getDisplayMedia: ReturnType<typeof vi.fn>;
let getUserMedia: ReturnType<typeof vi.fn>;
let fetchMock: ReturnType<typeof vi.fn>;
let responses: Record<string, () => Response | Promise<Response>>;
let compositorTrack: FakeMediaTrack;

function routeFetch(input: RequestInfo | URL, init?: RequestInit) {
  const url = String(input);
  const method = (init?.method ?? 'GET').toUpperCase();
  if (method === 'DELETE') return Promise.resolve(fakeResponse({ status: 200 }));
  if (url.includes('/ice-servers')) return Promise.resolve(responses.ice());
  if (url.includes('/whip?kind=video')) return Promise.resolve(responses['whip:video']());
  if (url.includes('/whip?kind=audio')) return Promise.resolve(responses['whip:audio']());
  if (url.includes('/whep')) return Promise.resolve(responses.whep());
  return Promise.reject(new Error(`no simulada ${url}`));
}

const calls = (fragment: string, method = 'POST') =>
  fetchMock.mock.calls.filter(
    ([u, i]) => String(u).includes(fragment) && ((i as RequestInit | undefined)?.method ?? 'GET') === method,
  );

const hostOpts = (extra: Partial<UseLiveStreamOptions> = {}): UseLiveStreamOptions => ({
  role: 'host',
  fetchHostTicket: async () => 'host-ticket',
  reconnectBaseMs: 100,
  ...extra,
});

async function run(fn: () => Promise<unknown> | unknown) {
  await act(async () => {
    await fn();
    await flushLive();
  });
}

beforeEach(() => {
  FakeStreamPeerConnection.reset();
  FakeAudioContext.reset();
  localStorage.clear();
  vi.stubEnv('VITE_STREAM_API_URL', BASE);
  screenVideo = new FakeMediaTrack('video', 'screen');
  getDisplayMedia = vi.fn(async () => new FakeMediaStream([screenVideo, new FakeMediaTrack('audio', 'system')]));
  getUserMedia = vi.fn(async (c: MediaStreamConstraints) =>
    new FakeMediaStream(c.video ? [new FakeMediaTrack('video', 'camera')] : [new FakeMediaTrack('audio', 'mic')]),
  );
  Object.defineProperty(navigator, 'mediaDevices', {
    configurable: true,
    value: { getDisplayMedia, getUserMedia, getSupportedConstraints: () => ({ suppressLocalAudioPlayback: true }) },
  });
  vi.stubGlobal('RTCPeerConnection', FakeStreamPeerConnection);
  vi.stubGlobal('AudioContext', FakeAudioContext);
  vi.stubGlobal('MediaStream', FakeMediaStream);
  responses = {
    ice: () => fakeResponse({ status: 200, json: { ice_servers: [{ urls: 'turn:t', username: 'u', credential: 'c' }] } }),
    'whip:video': () => sdpCreated('s-video'),
    'whip:audio': () => sdpCreated('s-audio'),
    whep: () => sdpCreated('s-view'),
  };
  fetchMock = vi.fn(routeFetch);
  vi.stubGlobal('fetch', fetchMock);
  compositorTrack = new FakeMediaTrack('video', 'canvas');
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  delete (HTMLCanvasElement.prototype as { captureStream?: unknown }).captureStream;
});

/** Habilita el compositor en jsdom con un canvas 2D falso. */
function enableCompositor() {
  const ctx = new Proxy({}, { get: (_t, k) => (k === 'createRadialGradient' ? () => ({ addColorStop() {} }) : () => {}) });
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(ctx as unknown as CanvasRenderingContext2D);
  (HTMLCanvasElement.prototype as { captureStream?: unknown }).captureStream = () => new FakeMediaStream([compositorTrack]);
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined);
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});
  // jsdom no acepta un MediaStream falso como srcObject.
  Object.defineProperty(HTMLMediaElement.prototype, 'srcObject', { configurable: true, writable: true, value: null });
}

describe('host', () => {
  it('usa los ICE servers del servidor y publica el audio en estéreo', async () => {
    const { result } = renderHook(() => useLiveStream('r1', hostOpts()));
    await run(() => result.current.publish());
    const pcs = FakeStreamPeerConnection.instances;
    expect(pcs[0].config?.iceServers).toEqual([{ urls: 'turn:t', username: 'u', credential: 'c' }]);
    expect(result.current.mixer.pc.available).toBe(true);
    expect(result.current.mixer.mic.available).toBe(true);
    expect(result.current.echoHint).toBe(false);
    expect(result.current.previewStream).not.toBeNull();
  });

  it('un ICE con 5xx no impide transmitir (ruta directa); un 410 sí termina', async () => {
    responses.ice = () => fakeResponse({ status: 503, body: '' });
    const a = renderHook(() => useLiveStream('r1', hostOpts()));
    await run(() => a.result.current.publish());
    expect(a.result.current.publishing).toBe(true);
    responses.ice = () => streamError(410, 'ROOM_DISABLED');
    const b = renderHook(() => useLiveStream('r1', hostOpts()));
    await run(() => b.result.current.publish());
    expect(b.result.current.status).toBe('ended');
  });

  it('el ticket con 410 Disabled termina; con 403 es FORBIDDEN_ROLE', async () => {
    const a = renderHook(() =>
      useLiveStream('r1', hostOpts({ fetchHostTicket: () => Promise.reject(new ApiError(410, 'Disabled', { error: 'Disabled' })) })),
    );
    await run(() => a.result.current.publish());
    expect(a.result.current.status).toBe('ended');
    const b = renderHook(() => useLiveStream('r1', hostOpts({ fetchHostTicket: () => Promise.reject(new ApiError(403, 'Forbidden')) })));
    await run(() => b.result.current.publish());
    expect(b.result.current.error?.code).toBe('FORBIDDEN_ROLE');
    expect(screenVideo.stopped).toBe(true);
  });

  it('sin getDisplayMedia: error claro de navegador', async () => {
    Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: {} });
    const { result } = renderHook(() => useLiveStream('r1', hostOpts()));
    await run(() => result.current.publish());
    expect(result.current.error?.code).toBe('SCREEN_UNSUPPORTED');
    expect(result.current.status).toBe('idle');
  });

  it('sin micrófono avisa y sigue; enableMic lo reintenta', async () => {
    getUserMedia.mockRejectedValueOnce(new DOMException('no', 'NotAllowedError'));
    const { result } = renderHook(() => useLiveStream('r1', hostOpts()));
    await run(() => result.current.publish());
    expect(result.current.notice).toMatch(/micrófono/);
    expect(result.current.publishing).toBe(true);
    await run(() => result.current.enableMic());
    expect(result.current.mixer.mic.available).toBe(true);
    expect(result.current.notice).toBeNull();
    getUserMedia.mockRejectedValueOnce(new Error('x'));
    await run(() => result.current.enableMic());
    expect(result.current.notice).toMatch(/micrófono/);
  });

  it('sin audio del PC ni micrófono: aviso de transmisión sin sonido', async () => {
    getDisplayMedia.mockResolvedValueOnce(new FakeMediaStream([screenVideo]));
    getUserMedia.mockRejectedValueOnce(new Error('no'));
    const { result } = renderHook(() => useLiveStream('r1', hostOpts()));
    await run(() => result.current.publish());
    expect(result.current.notice).toMatch(/sin sonido/);
  });

  it('ganancia, silencio y escenario se reflejan en el mezclador', async () => {
    const { result } = renderHook(() => useLiveStream('r1', hostOpts()));
    await run(() => result.current.publish());
    act(() => result.current.setGain('pc', 0.5));
    act(() => result.current.setMuted('mic', true));
    expect(result.current.mixer.pc.gain).toBe(0.5);
    expect(result.current.mixer.mic.muted).toBe(true);
    const voice = new FakeMediaStream([new FakeMediaTrack('audio', 'ana')]);
    act(() => result.current.setStageStreams([voice as unknown as MediaStream]));
    expect(result.current.mixer.stage.available).toBe(true);
    act(() => result.current.setStageStreams([]));
    expect(result.current.mixer.stage.available).toBe(false);
    expect(result.current.levels()).toEqual({ pc: 0, mic: 0, stage: 0 });
  });

  it('la escena se envía por el DataChannel del vídeo', async () => {
    const { result } = renderHook(() => useLiveStream('r1', hostOpts()));
    await run(() => result.current.publish());
    act(() => result.current.setScene('brb'));
    const dc = FakeStreamPeerConnection.instances[0].eventsChannel!;
    expect(JSON.parse(dc.sent[0])).toEqual({ type: 'scene', event_id: expect.any(String), name: 'brb' });
    expect(result.current.scene).toBe('brb');
  });

  it('host_stats y viewer_count llegan al host', async () => {
    const { result } = renderHook(() => useLiveStream('r1', hostOpts()));
    await run(() => result.current.publish());
    const dc = FakeStreamPeerConnection.instances[0].eventsChannel!;
    act(() => dc.emit({ type: 'host_stats', layers: [{ rid: 'h', bitrate_bps: 1, active: true, viewers: 2 }], nacks: 1, plis: 2 }));
    expect(result.current.hostStats?.layers[0].viewers).toBe(2);
    act(() => dc.emit({ type: 'stream_state', state: 'ended', reason: 'host_ended' }));
    expect(result.current.status).toBe('ended');
    expect(result.current.endedReason).toBe('host_ended');
    expect(screenVideo.stopped).toBe(true);
    // Terminal: publicar de nuevo no hace nada.
    await run(() => result.current.publish());
    expect(getDisplayMedia).toHaveBeenCalledTimes(1);
  });

  it('dejar de compartir avisa; cambiar pantalla reemplaza la pista sin renegociar', async () => {
    const { result } = renderHook(() => useLiveStream('r1', hostOpts()));
    await run(() => result.current.publish());
    expect(result.current.screenSharing).toBe(true);
    act(() => screenVideo.end());
    expect(result.current.screenSharing).toBe(false);
    expect(result.current.notice).toMatch(/Dejaste de compartir/);
    const next = new FakeMediaTrack('video', 'screen2');
    getDisplayMedia.mockResolvedValueOnce(new FakeMediaStream([next, new FakeMediaTrack('audio')]));
    await run(() => result.current.replaceScreen());
    const sender = FakeStreamPeerConnection.instances[0].transceivers[0].sender;
    expect(sender.track).toBe(next);
    expect(next.contentHint).toBe('motion');
    expect(result.current.screenSharing).toBe(true);
    expect(calls('/whip')).toHaveLength(2);
    getDisplayMedia.mockRejectedValueOnce(new DOMException('no', 'NotAllowedError'));
    await run(() => result.current.replaceScreen());
    expect(result.current.notice).toMatch(/pantalla anterior/);
  });

  it('sin compositor la cámara se libera con un aviso', async () => {
    const { result } = renderHook(() => useLiveStream('r1', hostOpts()));
    await run(() => result.current.publish());
    await run(() => result.current.setCameraEnabled(true));
    expect(result.current.cameraOn).toBe(false);
    expect(result.current.notice).toMatch(/cámara/);
  });

  it('con compositor: transmite el canvas y la cámara entra y sale en vivo', async () => {
    enableCompositor();
    const { result } = renderHook(() => useLiveStream('r1', hostOpts({ title: 'Directo' })));
    await run(() => result.current.publish());
    const sender = FakeStreamPeerConnection.instances[0].transceivers[0].sender;
    expect(sender.track).toBe(compositorTrack);
    await run(() => result.current.setCameraEnabled(true));
    expect(result.current.cameraOn).toBe(true);
    await run(() => result.current.setCameraEnabled(false));
    expect(result.current.cameraOn).toBe(false);
    act(() => screenVideo.end());
    expect(result.current.notice).toMatch(/Volvemos enseguida/);
    const next = new FakeMediaTrack('video', 'screen2');
    getDisplayMedia.mockResolvedValueOnce(new FakeMediaStream([next]));
    await run(() => result.current.replaceScreen());
    expect(sender.track).toBe(compositorTrack);
    await run(() => result.current.stop());
    expect(compositorTrack.stopped).toBe(true);
  });

  it('si la PC del host falla, repite el WHIP sin DELETE', async () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useLiveStream('r1', hostOpts()));
    await run(() => result.current.publish());
    act(() => FakeStreamPeerConnection.instances[0].setConnectionState('failed'));
    expect(result.current.status).toBe('reconnecting');
    await run(() => vi.advanceTimersByTimeAsync(100));
    expect(calls('/whip?kind=video')).toHaveLength(2);
    expect(calls('/sessions/', 'DELETE')).toHaveLength(0);
    expect(result.current.status).toBe('live');
  });

  it('en la reconexión un 503 vuelve a esperar en vez de fallar', async () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useLiveStream('r1', hostOpts()));
    await run(() => result.current.publish());
    responses['whip:video'] = () => fakeResponse({ status: 503, body: '' });
    act(() => FakeStreamPeerConnection.instances[0].setConnectionState('failed'));
    await run(() => vi.advanceTimersByTimeAsync(100));
    expect(result.current.status).toBe('reconnecting');
    responses['whip:video'] = () => sdpCreated('s2');
    await run(() => vi.advanceTimersByTimeAsync(200));
    expect(result.current.status).toBe('live');
  });

  it('al desmontar libera las sesiones', async () => {
    const { result, unmount } = renderHook(() => useLiveStream('r1', hostOpts()));
    await run(() => result.current.publish());
    unmount();
    await flushLive();
    expect(calls('/sessions/', 'DELETE')).toHaveLength(2);
  });

  it('un error de red al publicar es NETWORK', async () => {
    fetchMock.mockImplementation((u: string, i?: RequestInit) =>
      String(u).includes('/whip') ? Promise.reject(new TypeError('fail')) : routeFetch(u, i),
    );
    const { result } = renderHook(() => useLiveStream('r1', hostOpts()));
    await run(() => result.current.publish());
    expect(result.current.error?.code).toBe('NETWORK');
  });
});

describe('viewer', () => {
  beforeEach(() => localStorage.setItem('tint_guest_token', 'g'));

  it('sin guest token: UNAUTHORIZED', async () => {
    localStorage.clear();
    const { result } = renderHook(() => useLiveStream('r1', { role: 'guest' }));
    await run(() => result.current.watch());
    expect(result.current.error?.code).toBe('UNAUTHORIZED');
  });

  it('sin WebRTC: error claro', async () => {
    vi.stubGlobal('RTCPeerConnection', undefined);
    const { result } = renderHook(() => useLiveStream('r1', { role: 'guest' }));
    await run(() => result.current.watch());
    expect(result.current.error?.code).toBe('WEBRTC_UNSUPPORTED');
  });

  it('si la PC se cae y el stream sigue, reconecta (DELETE de la vieja y WHEP nuevo)', async () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useLiveStream('r1', { role: 'guest', reconnectBaseMs: 100 }));
    await run(() => result.current.watch());
    const first = FakeStreamPeerConnection.instances[0];
    act(() => first.eventsChannel!.emit({ type: 'stream_state', state: 'live' }));
    act(() => first.setConnectionState('failed'));
    expect(result.current.status).toBe('reconnecting');
    expect(first.closed).toBe(true);
    await run(() => vi.advanceTimersByTimeAsync(100));
    expect(calls('/whep')).toHaveLength(2);
    expect(calls('/sessions/s-view', 'DELETE')).toHaveLength(1);
    const second = FakeStreamPeerConnection.instances[1];
    act(() => second.setConnectionState('connected'));
    expect(result.current.status).toBe('live');
  });

  it('un 503 del WHEP reintenta con espera; un 404 es definitivo', async () => {
    vi.useFakeTimers();
    responses.whep = () => fakeResponse({ status: 503, body: '' });
    const { result } = renderHook(() => useLiveStream('r1', { role: 'guest', reconnectBaseMs: 100 }));
    await run(() => result.current.watch());
    expect(result.current.status).toBe('reconnecting');
    expect(result.current.error?.code).toBe('UNAVAILABLE');
    responses.whep = () => streamError(404, 'STREAM_NOT_FOUND');
    await run(() => vi.advanceTimersByTimeAsync(100));
    expect(result.current.status).toBe('error');
    expect(result.current.error?.code).toBe('STREAM_NOT_FOUND');
  });

  it('una pista repetida no duplica el stream; stop vuelve a idle', async () => {
    const { result } = renderHook(() => useLiveStream('r1', { role: 'guest' }));
    await run(() => result.current.watch());
    const pc = FakeStreamPeerConnection.instances[0];
    const t = new FakeMediaTrack('video');
    act(() => pc.emitTrack(t));
    const first = result.current.remoteStream;
    act(() => pc.emitTrack(t));
    expect(result.current.remoteStream).toBe(first);
    act(() => pc.emitTrack(new FakeMediaTrack('audio')));
    expect(result.current.remoteStream?.getTracks()).toHaveLength(2);
    await run(() => result.current.stop());
    expect(result.current.status).toBe('idle');
    expect(result.current.remoteStream).toBeNull();
  });

  it('el viewer no publica ni cambia escenas', async () => {
    const { result } = renderHook(() => useLiveStream('r1', { role: 'guest' }));
    await run(() => result.current.watch());
    act(() => result.current.setScene('brb'));
    await run(() => result.current.setCameraEnabled(true));
    await run(() => result.current.replaceScreen());
    expect(FakeStreamPeerConnection.instances[0].eventsChannel!.sent).toHaveLength(0);
    expect(getUserMedia).not.toHaveBeenCalled();
    act(() => result.current.dismissNotice());
  });
});
