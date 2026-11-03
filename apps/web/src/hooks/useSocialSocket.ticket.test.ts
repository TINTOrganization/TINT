import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, apiFetch } from '../lib/api';
import { useSocialSocket } from './useSocialSocket';

vi.mock('../lib/api', async (orig) => ({
  ...(await orig<typeof import('../lib/api')>()),
  apiFetch: vi.fn(),
}));
const mockedApiFetch = vi.mocked(apiFetch);

class FakeSocket {
  static instances: FakeSocket[] = [];
  url: string;
  readyState = 0;
  onopen: ((e: unknown) => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onclose: ((e: { code: number }) => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(url: string) {
    this.url = url;
    FakeSocket.instances.push(this);
  }
  open() {
    this.readyState = 1;
    this.onopen?.({});
  }
  send() {}
  close() {
    this.readyState = 3;
    this.onclose?.({ code: 1006 });
  }
}

const create = (url: string) => new FakeSocket(url) as unknown as WebSocket;
const last = () => FakeSocket.instances[FakeSocket.instances.length - 1];

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

beforeEach(() => {
  FakeSocket.instances = [];
  localStorage.clear();
  localStorage.setItem('tint_token', 'firebase-id-token');
  mockedApiFetch.mockReset();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('useSocialSocket — host con sync-ticket', () => {
  it('el host abre el canal con un sync-ticket (no con el ID token de Firebase)', async () => {
    mockedApiFetch.mockResolvedValue({ token: 'ticket-1', expiresAt: 'x' });
    renderHook(() => useSocialSocket('r 1', { createSocket: create, role: 'host' }));
    expect(FakeSocket.instances).toHaveLength(0);
    await flush();
    expect(mockedApiFetch).toHaveBeenCalledWith('/rooms/r%201/sync-ticket', { method: 'POST' });
    expect(last().url).toContain('token=ticket-1');
    expect(last().url).not.toContain('firebase');
  });

  it('pide un ticket nuevo en cada reconexión', async () => {
    mockedApiFetch.mockResolvedValueOnce({ token: 't1' }).mockResolvedValueOnce({ token: 't2' });
    const { result } = renderHook(() =>
      useSocialSocket('r1', { createSocket: create, role: 'host', reconnectBaseMs: 100 }),
    );
    await flush();
    act(() => last().open());
    act(() => last().close());
    expect(result.current.status).toBe('reconnecting');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });
    expect(mockedApiFetch).toHaveBeenCalledTimes(2);
    expect(last().url).toContain('token=t2');
  });

  it('si el ticket falla reintenta con backoff', async () => {
    mockedApiFetch.mockRejectedValueOnce(new Error('red')).mockResolvedValueOnce({ token: 't2' });
    const { result } = renderHook(() =>
      useSocialSocket('r1', { createSocket: create, role: 'host', reconnectBaseMs: 100 }),
    );
    await flush();
    expect(result.current.status).toBe('reconnecting');
    expect(FakeSocket.instances).toHaveLength(0);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });
    expect(last().url).toContain('token=t2');
  });

  it.each([403, 404, 410])('ticket con %i: deja de reintentar', async (status) => {
    mockedApiFetch.mockRejectedValue(new ApiError(status, 'no'));
    const { result } = renderHook(() =>
      useSocialSocket('r1', { createSocket: create, role: 'host', reconnectBaseMs: 100 }),
    );
    await flush();
    expect(result.current.status).toBe('closed');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(mockedApiFetch).toHaveBeenCalledTimes(1);
  });

  it('un ticket que llega tras desmontar no abre socket', async () => {
    let resolve: (v: unknown) => void = () => {};
    mockedApiFetch.mockReturnValue(new Promise((r) => (resolve = r)));
    const { unmount } = renderHook(() => useSocialSocket('r1', { createSocket: create, role: 'host' }));
    unmount();
    resolve({ token: 't' });
    await flush();
    expect(FakeSocket.instances).toHaveLength(0);
  });

  it('el invitado usa tint_guest_token aunque haya restos de sesión de host', () => {
    localStorage.setItem('tint_guest_token', 'g1');
    renderHook(() => useSocialSocket('r1', { createSocket: create, role: 'guest' }));
    expect(mockedApiFetch).not.toHaveBeenCalled();
    expect(last().url).toContain('token=g1');
  });
});
