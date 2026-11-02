import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildSceneMessage,
  formatBitrate,
  isSceneName,
  isTerminalStreamError,
  mungeOpusStereo,
  parseIceServers,
  parseStreamEvent,
  resolveStreamApiUrl,
  sessionUrl,
  StreamError,
  streamErrorFrom,
  streamErrorMessage,
  streamRoomUrl,
} from './streamProtocol';
import { fakeResponse } from '../test/fakeLiveStream';

afterEach(() => vi.unstubAllEnvs());

describe('URLs', () => {
  it('la base sale de VITE_STREAM_API_URL (sin barra final) o del puerto local 8086', () => {
    vi.stubEnv('VITE_STREAM_API_URL', 'https://gw.test/');
    expect(resolveStreamApiUrl()).toBe('https://gw.test');
    vi.stubEnv('VITE_STREAM_API_URL', '');
    expect(resolveStreamApiUrl()).toBe('http://localhost:8086');
    expect(resolveStreamApiUrl('http://x:1')).toBe('http://x:1');
  });

  it('arma las rutas de sala y resuelve el Location', () => {
    expect(streamRoomUrl('https://b', 'r 1', 'whep')).toBe('https://b/api/v1/stream/rooms/r%201/whep');
    expect(sessionUrl('https://b', '/api/v1/stream/sessions/s1')).toBe('https://b/api/v1/stream/sessions/s1');
    expect(sessionUrl('https://b', 'api/x')).toBe('https://b/api/x');
    expect(sessionUrl('https://b', 'https://o/s')).toBe('https://o/s');
  });
});

describe('mungeOpusStereo', () => {
  it('añade estéreo y 128 kbps al fmtp existente de Opus', () => {
    const sdp = 'm=audio 9 UDP/TLS/RTP/SAVPF 111\r\na=rtpmap:111 opus/48000/2\r\na=fmtp:111 minptime=10;useinbandfec=1;stereo=0\r\n';
    const out = mungeOpusStereo(sdp);
    expect(out).toContain('a=fmtp:111 minptime=10;useinbandfec=1;stereo=1;sprop-stereo=1;maxaveragebitrate=128000');
    expect(out).not.toContain('stereo=0');
  });

  it('crea el fmtp si no existe y no toca un SDP sin Opus', () => {
    const sdp = 'a=rtpmap:109 opus/48000/2\r\na=other\r\n';
    expect(mungeOpusStereo(sdp)).toContain('a=rtpmap:109 opus/48000/2\r\na=fmtp:109 stereo=1;sprop-stereo=1;maxaveragebitrate=128000\r\n');
    expect(mungeOpusStereo('v=0\r\n')).toBe('v=0\r\n');
  });
});

describe('errores', () => {
  it('lee el código del cuerpo JSON', async () => {
    const err = await streamErrorFrom(fakeResponse({ status: 409, json: { error: 'ROOM_FULL', message: 'x' } }));
    expect(err).toBeInstanceOf(StreamError);
    expect(err.code).toBe('ROOM_FULL');
    expect(err.message).toMatch(/llena/);
  });

  it.each([
    [401, 'UNAUTHORIZED'],
    [403, 'FORBIDDEN'],
    [404, 'STREAM_NOT_FOUND'],
    [409, 'ROOM_FULL'],
    [410, 'ROOM_DISABLED'],
    [415, 'UNSUPPORTED_MEDIA_TYPE'],
    [502, 'UNAVAILABLE'],
    [418, 'HTTP_418'],
  ])('sin cuerpo, %i → %s', async (status, code) => {
    const err = await streamErrorFrom(fakeResponse({ status, body: '' }));
    expect(err.code).toBe(code);
  });

  it('mensajes claros en español y genérico para lo desconocido', () => {
    expect(streamErrorMessage('ROOM_DISABLED')).toMatch(/el evento terminó/i);
    expect(streamErrorMessage('FORBIDDEN_ROLE')).toMatch(/solo el host/i);
    expect(streamErrorMessage('INVALID_SDP')).toMatch(/VP8/);
    expect(streamErrorMessage('???')).toMatch(/algo salió mal/i);
  });

  it('terminales: 4xx salvo 429; no lo son la red ni los 5xx', () => {
    expect(isTerminalStreamError(new StreamError(409, 'ROOM_FULL', ''))).toBe(true);
    expect(isTerminalStreamError(new StreamError(429, 'X', ''))).toBe(false);
    expect(isTerminalStreamError(new StreamError(503, 'UNAVAILABLE', ''))).toBe(false);
    expect(isTerminalStreamError(new StreamError(0, 'NETWORK', ''))).toBe(false);
  });
});

describe('parseIceServers', () => {
  it('acepta urls string o lista y descarta lo inválido', () => {
    expect(
      parseIceServers({
        ice_servers: [
          { urls: 'stun:s' },
          { urls: ['turn:t'], username: 'u', credential: 'p' },
          { urls: 3 },
          null,
        ],
      }),
    ).toEqual([{ urls: 'stun:s' }, { urls: ['turn:t'], username: 'u', credential: 'p' }]);
    expect(parseIceServers(null)).toEqual([]);
    expect(parseIceServers({ ice_servers: 'x' })).toEqual([]);
  });
});

describe('parseStreamEvent', () => {
  it('stream_state con reason y grace_deadline_ms válidos', () => {
    expect(parseStreamEvent(JSON.stringify({ type: 'stream_state', state: 'ended', reason: 'grace_expired' }))).toEqual({
      type: 'stream_state',
      state: 'ended',
      reason: 'grace_expired',
    });
    expect(
      parseStreamEvent(JSON.stringify({ type: 'stream_state', state: 'reconnecting', grace_deadline_ms: 5, reason: 'x' })),
    ).toEqual({ type: 'stream_state', state: 'reconnecting', grace_deadline_ms: 5 });
  });

  it('host_stats normaliza las capas', () => {
    const ev = parseStreamEvent(
      JSON.stringify({
        type: 'host_stats',
        layers: [
          { rid: 'h', bitrate_bps: 2_400_000, active: true, viewers: 3 },
          { rid: 'x' },
          { rid: 'l', bitrate_bps: 'mucho' },
        ],
        nacks: 4,
      }),
    );
    expect(ev).toEqual({
      type: 'host_stats',
      layers: [
        { rid: 'h', bitrate_bps: 2_400_000, active: true, viewers: 3 },
        { rid: 'l', bitrate_bps: 0, active: false, viewers: 0 },
      ],
      nacks: 4,
      plis: 0,
    });
    expect(parseStreamEvent(JSON.stringify({ type: 'host_stats' }))).toBeNull();
  });

  it('descarta lo inválido', () => {
    for (const bad of [
      42,
      'no json',
      'null',
      JSON.stringify({ type: 'scene', name: 'otra' }),
      JSON.stringify({ type: 'viewer_count', count: -1 }),
      JSON.stringify({ type: 'nada' }),
    ]) {
      expect(parseStreamEvent(bad)).toBeNull();
    }
    expect(parseStreamEvent(JSON.stringify({ type: 'scene', name: 'brb' }))).toEqual({ type: 'scene', name: 'brb' });
  });
});

describe('utilidades', () => {
  it('buildSceneMessage lleva type, event_id y name', () => {
    const msg = JSON.parse(buildSceneMessage('starting_soon'));
    expect(msg).toEqual({ type: 'scene', event_id: expect.any(String), name: 'starting_soon' });
    expect(isSceneName('brb')).toBe(true);
    expect(isSceneName('x')).toBe(false);
  });

  it('formatBitrate', () => {
    expect(formatBitrate(2_500_000)).toBe('2,5 Mbps');
    expect(formatBitrate(800_000)).toBe('800 kbps');
    expect(formatBitrate(0)).toBe('0 kbps');
  });
});
