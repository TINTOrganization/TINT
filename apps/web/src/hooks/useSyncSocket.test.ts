import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MockWebSocket } from '../test/mockWebSocket';
import { DEFAULT_SYNC_WS_URL, useSyncSocket, type UseSyncSocketOptions } from './useSyncSocket';
import { apiFetch } from '../lib/api';

vi.mock('../lib/api', () => ({ apiFetch: vi.fn() }));
const mockedApiFetch = vi.mocked(apiFetch);

const WS = 'ws://test/ws/sync';

const snapshot = {
  type: 'STATE',
  status: 'playing',
  position_ms: 10_000,
  updated_at_ms: 1_000,
  rate: 1,
  version: 5,
  server_time_ms: 1_200,
  online: true,
} as const;

function setup(opts: Partial<UseSyncSocketOptions> = {}) {
  return renderHook((props: UseSyncSocketOptions) => useSyncSocket(props), {
    initialProps: { roomId: 'r1', role: 'guest', url: WS, ...opts } as UseSyncSocketOptions,
  });
}

/** Deja correr microtareas (fetch del ticket) dentro de act. */
async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

beforeEach(() => {
  MockWebSocket.reset();
  vi.stubGlobal('WebSocket', MockWebSocket);
  localStorage.clear();
  mockedApiFetch.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('useSyncSocket — conexión', () => {
  it('enabled=false no pide ticket ni abre socket; al habilitarse conecta', async () => {
    mockedApiFetch.mockResolvedValue({ token: 'ticket-1', expiresAt: '' });
    const { rerender } = setup({ role: 'host', enabled: false });
    await flush();
    expect(mockedApiFetch).not.toHaveBeenCalled();
    expect(MockWebSocket.instances).toHaveLength(0);
    rerender({ roomId: 'r1', role: 'host', url: WS, enabled: true });
    await flush();
    expect(mockedApiFetch).toHaveBeenCalledTimes(1);
    expect(MockWebSocket.instances).toHaveLength(1);
  });

  it('guest conecta con su guest token en la URL', () => {
    localStorage.setItem('tint_guest_token', 'guest-jwt');
    const { result } = setup();
    expect(MockWebSocket.instances).toHaveLength(1);
    expect(MockWebSocket.last().url).toBe(`${WS}?room_id=r1&token=guest-jwt`);
    expect(result.current.connected).toBe(false);
    act(() => MockWebSocket.last().open());
    expect(result.current.connected).toBe(true);
    expect(mockedApiFetch).not.toHaveBeenCalled();
  });

  it('usa VITE_SYNC_WS_URL o el valor por defecto si no se pasa url', () => {
    localStorage.setItem('tint_guest_token', 'g');
    renderHook(() => useSyncSocket({ roomId: 'r1', role: 'guest' }));
    const expectedBase = import.meta.env.VITE_SYNC_WS_URL || DEFAULT_SYNC_WS_URL;
    expect(MockWebSocket.last().url).toBe(`${expectedBase}?room_id=r1&token=g`);
  });

  it('por defecto apunta a sync-core en el puerto 8083 del host (8082 es de social-core)', () => {
    expect(DEFAULT_SYNC_WS_URL).toBe('ws://localhost:8083/ws/sync');
  });

  it('guest sin token no conecta y reporta error', () => {
    const { result } = setup();
    expect(MockWebSocket.instances).toHaveLength(0);
    expect(result.current.lastError).toBe('NO_TOKEN');
  });

  it('host pide un sync-ticket y conecta con ese token', async () => {
    mockedApiFetch.mockResolvedValue({ token: 'ticket-1', expiresAt: 'x' });
    setup({ role: 'host' });
    await flush();
    expect(mockedApiFetch).toHaveBeenCalledWith('/rooms/r1/sync-ticket', { method: 'POST' });
    expect(MockWebSocket.last().url).toBe(`${WS}?room_id=r1&token=ticket-1`);
  });

  it('host pide un ticket nuevo en cada reconexión', async () => {
    vi.useFakeTimers();
    mockedApiFetch
      .mockResolvedValueOnce({ token: 't1', expiresAt: 'x' })
      .mockResolvedValueOnce({ token: 't2', expiresAt: 'x' });
    setup({ role: 'host' });
    await flush();
    act(() => MockWebSocket.last().open());
    act(() => MockWebSocket.last().close());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });
    expect(mockedApiFetch).toHaveBeenCalledTimes(2);
    expect(MockWebSocket.last().url).toContain('token=t2');
  });

  it('si falla el ticket reporta error y reintenta con backoff', async () => {
    vi.useFakeTimers();
    mockedApiFetch
      .mockRejectedValueOnce(new Error('401'))
      .mockResolvedValueOnce({ token: 'ok', expiresAt: 'x' });
    const { result } = setup({ role: 'host' });
    await flush();
    expect(result.current.lastError).toBe('TICKET');
    expect(MockWebSocket.instances).toHaveLength(0);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });
    expect(MockWebSocket.instances).toHaveLength(1);
  });

  it('no conecta si se desmonta antes de obtener el ticket', async () => {
    let resolve!: (v: unknown) => void;
    mockedApiFetch.mockReturnValue(new Promise((r) => (resolve = r)));
    const { unmount } = setup({ role: 'host' });
    unmount();
    resolve({ token: 'late', expiresAt: 'x' });
    await flush();
    expect(MockWebSocket.instances).toHaveLength(0);
  });
});

describe('useSyncSocket — reconexión', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    localStorage.setItem('tint_guest_token', 'g');
  });

  it('reintenta con backoff exponencial y se reinicia al abrir', () => {
    const { result } = setup();
    act(() => MockWebSocket.last().close());
    expect(result.current.connected).toBe(false);

    act(() => vi.advanceTimersByTime(499));
    expect(MockWebSocket.instances).toHaveLength(1);
    act(() => vi.advanceTimersByTime(1));
    expect(MockWebSocket.instances).toHaveLength(2);

    act(() => MockWebSocket.last().close());
    act(() => vi.advanceTimersByTime(999));
    expect(MockWebSocket.instances).toHaveLength(2);
    act(() => vi.advanceTimersByTime(1));
    expect(MockWebSocket.instances).toHaveLength(3);

    act(() => MockWebSocket.last().close());
    act(() => vi.advanceTimersByTime(2_000));
    expect(MockWebSocket.instances).toHaveLength(4);

    // Una conexión exitosa reinicia el backoff.
    act(() => MockWebSocket.last().open());
    act(() => MockWebSocket.last().close());
    act(() => vi.advanceTimersByTime(500));
    expect(MockWebSocket.instances).toHaveLength(5);
  });

  it('limita el backoff a 10 s', () => {
    setup();
    for (let i = 0; i < 6; i++) {
      act(() => MockWebSocket.last().close());
      act(() => vi.advanceTimersByTime(10_000));
    }
    const count = MockWebSocket.instances.length;
    act(() => MockWebSocket.last().close());
    act(() => vi.advanceTimersByTime(9_999));
    expect(MockWebSocket.instances).toHaveLength(count);
    act(() => vi.advanceTimersByTime(1));
    expect(MockWebSocket.instances).toHaveLength(count + 1);
  });

  it('no reconecta tras desmontar y cierra el socket', () => {
    const { unmount } = setup();
    const ws = MockWebSocket.last();
    act(() => ws.open());
    unmount();
    expect(ws.readyState).toBe(MockWebSocket.CLOSED);
    act(() => vi.advanceTimersByTime(30_000));
    expect(MockWebSocket.instances).toHaveLength(1);
  });

  it('un error de socket no rompe el hook', () => {
    const { result } = setup();
    act(() => MockWebSocket.last().onerror?.(new Event('error')));
    expect(result.current.connected).toBe(false);
  });
});

describe('useSyncSocket — mensajes', () => {
  beforeEach(() => {
    localStorage.setItem('tint_guest_token', 'g');
  });

  function connected(opts: Partial<UseSyncSocketOptions> = {}) {
    const hook = setup(opts);
    const ws = MockWebSocket.last();
    act(() => ws.open());
    return { ...hook, ws };
  }

  it('STATE guarda el snapshot y el estado del host', () => {
    const { result, ws } = connected({ now: () => 42 });
    act(() => ws.receive(snapshot));
    expect(result.current.state).toMatchObject({
      status: 'playing',
      position_ms: 10_000,
      version: 5,
      server_time_ms: 1_200,
      received_at_perf: 42,
    });
    expect(result.current.hostOnline).toBe(true);
  });

  it('aplica broadcasts solo si la versión es mayor', () => {
    const { result, ws } = connected();
    act(() => ws.receive(snapshot));
    act(() => ws.receive({ ...snapshot, type: 'PAUSE', status: 'paused', version: 5 }));
    expect(result.current.state?.status).toBe('playing');
    act(() => ws.receive({ ...snapshot, type: 'PAUSE', status: 'paused', version: 4 }));
    expect(result.current.state?.status).toBe('playing');
    act(() => ws.receive({ ...snapshot, type: 'PAUSE', status: 'paused', version: 6 }));
    expect(result.current.state?.status).toBe('paused');
    act(() => ws.receive({ ...snapshot, type: 'SEEK', status: 'paused', position_ms: 1, version: 7 }));
    expect(result.current.state?.position_ms).toBe(1);
    act(() => ws.receive({ ...snapshot, type: 'PLAY', version: 8 }));
    expect(result.current.state?.status).toBe('playing');
  });

  it('en la misma conexión, un STATE con versión menor no pisa el estado; igual o mayor sí', () => {
    const { result, ws } = connected();
    act(() => ws.receive({ ...snapshot, version: 9 }));
    act(() => ws.receive({ ...snapshot, version: 2, position_ms: 77 }));
    expect(result.current.state?.position_ms).toBe(10_000);
    expect(result.current.state?.version).toBe(9);
    act(() => ws.receive({ ...snapshot, version: 9, position_ms: 55 }));
    expect(result.current.state?.position_ms).toBe(55);
  });

  it('el primer STATE de una conexión nueva siempre aplica (sala reiniciada tras el TTL)', () => {
    vi.useFakeTimers();
    const { result, ws } = connected();
    act(() => ws.receive({ ...snapshot, version: 9 }));
    act(() => ws.close());
    act(() => vi.advanceTimersByTime(500));
    const ws2 = MockWebSocket.last();
    expect(ws2).not.toBe(ws);
    act(() => ws2.open());
    act(() => ws2.receive({ ...snapshot, version: 2, position_ms: 77 }));
    expect(result.current.state?.position_ms).toBe(77);
    // Y desde ahí se filtra por versión como siempre.
    act(() => ws2.receive({ ...snapshot, type: 'PLAY', version: 3, position_ms: 88 }));
    expect(result.current.state?.position_ms).toBe(88);
    act(() => ws2.receive({ ...snapshot, version: 1, position_ms: 1 }));
    expect(result.current.state?.position_ms).toBe(88);
  });

  it('SYNC_CHECK lleva la version del estado aplicado', () => {
    const { ws } = connected({ getPositionMs: () => 1_000 });
    act(() => ws.receive({ type: 'HEARTBEAT', server_time_ms: 1 }));
    expect(ws.sentJson()[0]).not.toHaveProperty('version');
    act(() => ws.receive(snapshot));
    act(() => ws.receive({ ...snapshot, type: 'SEEK', version: 6 }));
    act(() => ws.receive({ type: 'HEARTBEAT', server_time_ms: 2 }));
    expect(ws.sentJson()[1]).toMatchObject({ type: 'SYNC_CHECK', version: 6 });
  });

  it('responde HEARTBEAT con SYNC_CHECK usando la posición del getter', () => {
    const { ws } = connected({ getPositionMs: () => 4_321.7 });
    act(() => ws.receive({ type: 'HEARTBEAT', server_time_ms: 99_000 }));
    expect(ws.sentJson()).toEqual([
      expect.objectContaining({
        type: 'SYNC_CHECK',
        room_id: 'r1',
        position_ms: 4_322,
        echo_server_ts: 99_000,
        event_id: expect.any(String),
        occurred_at: expect.any(String),
      }),
    ]);
  });

  it('sin posición local usa la posición esperada del estado', () => {
    let perf = 0;
    const { ws } = connected({ getPositionMs: () => null, now: () => perf });
    act(() => ws.receive(snapshot));
    perf = 300;
    act(() => ws.receive({ type: 'HEARTBEAT', server_time_ms: 2_000 }));
    // 10_000 + (1_200 + 300 - 1_000) * 1
    expect(ws.sentJson()[0].position_ms).toBe(10_500);
  });

  it('sin posición ni estado responde 0', () => {
    const { ws } = connected();
    act(() => ws.receive({ type: 'HEARTBEAT', server_time_ms: 1 }));
    expect(ws.sentJson()[0].position_ms).toBe(0);
  });

  it('expone SYNC_CORRECTION con secuencia incremental e ignora versiones viejas', () => {
    const { result, ws } = connected();
    act(() => ws.receive(snapshot));
    const corr = { type: 'SYNC_CORRECTION', target_ms: 5_000, strategy: 'seek', drift_ms: 800, version: 5 };
    act(() => ws.receive(corr));
    expect(result.current.correction).toMatchObject({ seq: 1, target_ms: 5_000, strategy: 'seek' });
    act(() => ws.receive(corr));
    expect(result.current.correction?.seq).toBe(2);
    act(() => ws.receive({ ...corr, version: 4, target_ms: 1 }));
    expect(result.current.correction?.seq).toBe(2);
  });

  it('una SYNC_CORRECTION con status/rate reconcilia el estado (broadcast perdido)', () => {
    let perf = 0;
    const { result, ws } = connected({ now: () => perf });
    act(() => ws.receive(snapshot));
    perf = 1_000;
    act(() =>
      ws.receive({
        type: 'SYNC_CORRECTION',
        target_ms: 12_000,
        strategy: 'seek',
        drift_ms: -900,
        version: 7,
        status: 'paused',
        rate: 1.5,
        media_id: 'm2',
      }),
    );
    expect(result.current.state).toMatchObject({
      status: 'paused',
      rate: 1.5,
      media_id: 'm2',
      version: 7,
      position_ms: 12_000,
      received_at_perf: 1_000,
    });
    expect(result.current.correction).toMatchObject({ rate: 1.5, version: 7 });
    // El ancla usa el reloj de servidor estimado: la posición esperada es target_ms.
    expect(result.current.state?.server_time_ms).toBe(2_200);
    expect(result.current.state?.updated_at_ms).toBe(2_200);
    // El broadcast perdido que llega tarde con esa versión ya no cambia nada.
    act(() => ws.receive({ ...snapshot, type: 'PLAY', version: 7 }));
    expect(result.current.state?.status).toBe('paused');
  });

  it('una SYNC_CORRECTION sin status/rate (servidor previo) no toca el estado', () => {
    const { result, ws } = connected();
    act(() => ws.receive(snapshot));
    const before = result.current.state;
    act(() => ws.receive({ type: 'SYNC_CORRECTION', target_ms: 12_000, strategy: 'rate', drift_ms: -900, version: 7 }));
    expect(result.current.state).toBe(before);
    expect(result.current.correction?.rate).toBeUndefined();
  });

  it('una SYNC_CORRECTION que coincide con el estado no lo reemplaza', () => {
    const { result, ws } = connected();
    act(() => ws.receive({ ...snapshot, media_id: 'm1' }));
    const before = result.current.state;
    act(() =>
      ws.receive({
        type: 'SYNC_CORRECTION',
        target_ms: 12_000,
        strategy: 'rate',
        drift_ms: -900,
        version: 5,
        status: 'playing',
        rate: 1,
        media_id: 'm1',
      }),
    );
    expect(result.current.state).toBe(before);
  });

  it('devuelve el mismo objeto mientras nada cambie (props estables para el reproductor memo)', () => {
    const { result, rerender, ws } = connected();
    act(() => ws.receive(snapshot));
    const api = result.current;
    rerender({ roomId: 'r1', role: 'guest', url: WS });
    expect(result.current).toBe(api);
    act(() => ws.receive({ type: 'HOST_STATUS', online: false }));
    expect(result.current).not.toBe(api);
  });

  it('HOST_STATUS actualiza hostOnline', () => {
    const { result, ws } = connected();
    act(() => ws.receive({ type: 'HOST_STATUS', online: false }));
    expect(result.current.hostOnline).toBe(false);
    act(() => ws.receive({ type: 'HOST_STATUS', online: true }));
    expect(result.current.hostOnline).toBe(true);
  });

  it('ERROR expone el código y ACK lo limpia', () => {
    const { result, ws } = connected();
    act(() => ws.receive({ type: 'ERROR', code: 'FORBIDDEN', ref_event_id: 'e1' }));
    expect(result.current.lastError).toBe('FORBIDDEN');
    act(() => ws.receive({ type: 'ACK', ref_event_id: 'e2', version: 6 }));
    expect(result.current.lastError).toBeNull();
  });

  it('ignora mensajes malformados', () => {
    const { result, ws } = connected();
    act(() => ws.receive('basura'));
    expect(result.current.state).toBeNull();
    expect(ws.sent).toHaveLength(0);
  });
});

describe('useSyncSocket — comandos', () => {
  it('host envía PLAY/PAUSE/SEEK con el formato del protocolo', async () => {
    mockedApiFetch.mockResolvedValue({ token: 't', expiresAt: 'x' });
    const { result } = setup({ role: 'host' });
    await flush();
    const ws = MockWebSocket.last();
    act(() => ws.open());
    let id: string | null = null;
    act(() => {
      id = result.current.sendCommand('SEEK', 1_500.4);
    });
    expect(ws.sentJson()[0]).toEqual({
      event_id: id,
      type: 'SEEK',
      room_id: 'r1',
      position_ms: 1_500,
      occurred_at: expect.any(String),
    });
  });

  it('host no envía si el socket no está abierto', async () => {
    mockedApiFetch.mockResolvedValue({ token: 't', expiresAt: 'x' });
    const { result } = setup({ role: 'host' });
    await flush();
    expect(result.current.sendCommand('PLAY', 0)).toBeNull();
    expect(MockWebSocket.last().sent).toHaveLength(0);
  });

  it('participante nunca envía comandos', () => {
    localStorage.setItem('tint_guest_token', 'g');
    const { result } = setup();
    const ws = MockWebSocket.last();
    act(() => ws.open());
    expect(result.current.sendCommand('PLAY', 0)).toBeNull();
    expect(ws.sent).toHaveLength(0);
  });
});

describe('useSyncSocket — ticket rechazado de forma definitiva', () => {
  const httpError = (status: number) => Object.assign(new Error(`API error ${status}`), { status });

  it.each([
    [403, 'NOT_HOST'],
    [404, 'ROOM_GONE'],
    [410, 'ROOM_GONE'],
  ])('con %i deja de reintentar y expone fatalError=%s', async (status, code) => {
    vi.useFakeTimers();
    mockedApiFetch.mockRejectedValue(httpError(status));
    const { result } = setup({ role: 'host' });
    await flush();
    expect(result.current.fatalError).toBe(code);
    expect(result.current.reconnect).toBeNull();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(mockedApiFetch).toHaveBeenCalledTimes(1);
    expect(MockWebSocket.instances).toHaveLength(0);
  });

  it('un error transitorio (500) sigue reintentando sin fatalError', async () => {
    vi.useFakeTimers();
    mockedApiFetch.mockRejectedValueOnce(httpError(500)).mockResolvedValueOnce({ token: 'ok', expiresAt: 'x' });
    const { result } = setup({ role: 'host' });
    await flush();
    expect(result.current.fatalError).toBeNull();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });
    expect(MockWebSocket.instances).toHaveLength(1);
  });
});
