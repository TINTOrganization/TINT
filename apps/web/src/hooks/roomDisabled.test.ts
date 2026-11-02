/**
 * Cierre de sala (ADR 0019) en los canales de la web: 4010 y `410 {error:"Disabled"}` son
 * terminales (no reconectan) y se distinguen de 4001/4003 y del `410 Deleted`.
 */
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, apiFetch } from '../lib/api';
import { MockWebSocket } from '../test/mockWebSocket';
import { FakePeerConnection, FakeStream } from '../test/fakeWebRtc';
import { useSocialSocket } from './useSocialSocket';
import { useSyncSocket } from './useSyncSocket';
import { useRoomPlayback } from './useRoomPlayback';
import { useVoiceChannel, type UseVoiceChannelOptions } from './useVoiceChannel';
import { voiceCloseNotice } from '../lib/voiceProtocol';

vi.mock('../lib/api', async (orig) => ({
  ...(await orig<typeof import('../lib/api')>()),
  apiFetch: vi.fn(),
}));
const mockedApi = vi.mocked(apiFetch);
const DISABLED = () => new ApiError(410, 'Disabled', { error: 'Disabled' });

async function flush() {
  await act(async () => {
    for (let i = 0; i < 5; i += 1) await Promise.resolve();
  });
}

beforeEach(() => {
  MockWebSocket.reset();
  vi.stubGlobal('WebSocket', MockWebSocket);
  localStorage.clear();
  mockedApi.mockReset();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const createSocket = (url: string) => new MockWebSocket(url) as unknown as WebSocket;

describe('useSocialSocket — sala deshabilitada', () => {
  it('4010: disabled y sin reconexión', async () => {
    localStorage.setItem('tint_guest_token', 'g');
    const { result } = renderHook(() => useSocialSocket('r1', { createSocket, role: 'guest', reconnectBaseMs: 10 }));
    act(() => MockWebSocket.last().open());
    act(() => MockWebSocket.last().close(4010, 'ROOM_DISABLED'));
    expect(result.current.disabled).toBe(true);
    expect(result.current.revoked).toBe(false);
    expect(result.current.status).toBe('closed');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(MockWebSocket.instances).toHaveLength(1);
    // El guest token se conserva: no es una expulsión.
    expect(localStorage.getItem('tint_guest_token')).toBe('g');
  });

  it('host: sync-ticket con 410 Disabled → disabled; con 410 Deleted no', async () => {
    mockedApi.mockRejectedValueOnce(DISABLED());
    const a = renderHook(() => useSocialSocket('r1', { createSocket, role: 'host' }));
    await flush();
    expect(a.result.current.disabled).toBe(true);
    mockedApi.mockRejectedValueOnce(new ApiError(410, 'Deleted', { error: 'Deleted' }));
    const b = renderHook(() => useSocialSocket('r2', { createSocket, role: 'host' }));
    await flush();
    expect(b.result.current.disabled).toBe(false);
    expect(b.result.current.status).toBe('closed');
  });
});

describe('useSyncSocket — sala deshabilitada', () => {
  it('4010: disabled y sin reconexión', async () => {
    localStorage.setItem('tint_guest_token', 'g');
    const { result } = renderHook(() => useSyncSocket({ roomId: 'r1', role: 'guest', url: 'ws://s', encoding: 'json' }));
    act(() => MockWebSocket.last().open());
    act(() => MockWebSocket.last().close(4010));
    expect(result.current.disabled).toBe(true);
    expect(result.current.reconnect).toBeNull();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(20_000);
    });
    expect(MockWebSocket.instances).toHaveLength(1);
  });

  it('host: sync-ticket con 410 Disabled → fatalError ROOM_DISABLED', async () => {
    mockedApi.mockRejectedValueOnce(DISABLED());
    const { result } = renderHook(() => useSyncSocket({ roomId: 'r1', role: 'host', url: 'ws://s', encoding: 'json' }));
    await flush();
    expect(result.current.fatalError).toBe('ROOM_DISABLED');
    expect(result.current.disabled).toBe(true);
  });
});

describe('useRoomPlayback — sala deshabilitada', () => {
  it('410 Disabled → disabled; no se toma como revocación', async () => {
    mockedApi.mockRejectedValueOnce(DISABLED());
    localStorage.setItem('tint_guest_token', 'g');
    const { result } = renderHook(() => useRoomPlayback('r1', undefined, { role: 'guest' }));
    await flush();
    expect(result.current.disabled).toBe(true);
    expect(result.current.revoked).toBe(false);
    expect(localStorage.getItem('tint_guest_token')).toBe('g');
  });
});

describe('useVoiceChannel — escenario y sala deshabilitada', () => {
  function options(extra: Partial<UseVoiceChannelOptions> = {}): UseVoiceChannelOptions {
    return {
      role: 'guest',
      baseUrl: 'ws://voz/ws/voice',
      createSocket,
      getUserMedia: (async () => new FakeStream()) as unknown as UseVoiceChannelOptions['getUserMedia'],
      createPeerConnection: (c) => new FakePeerConnection(c) as unknown as RTCPeerConnection,
      reconnectBaseMs: 10,
      ...extra,
    };
  }

  it('4009: notOnStage, aviso del escenario y sin reconexión', async () => {
    localStorage.setItem('tint_guest_token', 'g');
    const { result } = renderHook(() => useVoiceChannel('r1', options()));
    await act(async () => {
      await result.current.join();
    });
    act(() => MockWebSocket.last().close(4009, 'NOT_ON_STAGE'));
    expect(result.current.notOnStage).toBe(true);
    expect(result.current.status).toBe('ended');
    expect(result.current.notice).toMatch(/escenario/);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(MockWebSocket.instances).toHaveLength(1);
    // Volver a intentar limpia el estado del escenario.
    await act(async () => {
      await result.current.join();
    });
    expect(result.current.notOnStage).toBe(false);
  });

  it('4010: roomDisabled con el aviso de fin', async () => {
    localStorage.setItem('tint_guest_token', 'g');
    const { result } = renderHook(() => useVoiceChannel('r1', options()));
    await act(async () => {
      await result.current.join();
    });
    act(() => MockWebSocket.last().close(4010));
    expect(result.current.roomDisabled).toBe(true);
    expect(result.current.notice).toMatch(/el evento terminó/i);
  });

  it('host: sync-ticket con 410 Disabled → roomDisabled', async () => {
    const { result } = renderHook(() =>
      useVoiceChannel('r1', options({ role: 'host', fetchHostTicket: () => Promise.reject(DISABLED()) })),
    );
    await act(async () => {
      await result.current.join();
    });
    expect(result.current.roomDisabled).toBe(true);
    expect(result.current.status).toBe('ended');
  });

  it('voiceCloseNotice distingue 4009 y 4010', () => {
    expect(voiceCloseNotice(4009, false)).toMatch(/escenario/);
    expect(voiceCloseNotice(4010, true)).toMatch(/el evento terminó/i);
  });
});
