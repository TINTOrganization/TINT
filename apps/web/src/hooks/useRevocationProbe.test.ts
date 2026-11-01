import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { apiFetch } from '../lib/api';
import { useRevocationProbe } from './useRevocationProbe';

vi.mock('../lib/api', () => ({ apiFetch: vi.fn() }));
const mockedApiFetch = vi.mocked(apiFetch);

const httpError = (status: number) => Object.assign(new Error(`HTTP ${status}`), { status });
const flush = () => act(async () => { await Promise.resolve(); await Promise.resolve(); });

beforeEach(() => {
  vi.useFakeTimers();
  localStorage.clear();
  localStorage.setItem('tint_guest_token', 'guest-jwt');
  mockedApiFetch.mockReset();
});
afterEach(() => vi.useRealTimers());

describe('useRevocationProbe', () => {
  it('no consulta nada mientras la conexión va bien (active = false) ni para el host', async () => {
    renderHook(() => useRevocationProbe({ roomId: 'r1', role: 'guest', active: false }));
    renderHook(() => useRevocationProbe({ roomId: 'r1', role: 'host', active: true }));
    await act(() => vi.advanceTimersByTimeAsync(20_000));
    expect(mockedApiFetch).not.toHaveBeenCalled();
  });

  it('al empezar a reconectar consulta de inmediato y un 401 lo marca como expulsado (sin depender del código de cierre)', async () => {
    mockedApiFetch.mockRejectedValue(httpError(401));
    const { result } = renderHook(() => useRevocationProbe({ roomId: 'r 1', role: 'guest', active: true }));
    await flush();
    expect(mockedApiFetch).toHaveBeenCalledWith('/rooms/r%201/playback');
    expect(result.current.revoked).toBe(true);
    expect(localStorage.getItem('tint_guest_token')).toBeNull();
    await act(() => vi.advanceTimersByTimeAsync(20_000));
    expect(mockedApiFetch).toHaveBeenCalledTimes(1); // ya no insiste
  });

  it('un 403 también cuenta como expulsión', async () => {
    mockedApiFetch.mockRejectedValue(httpError(403));
    const { result } = renderHook(() => useRevocationProbe({ roomId: 'r1', role: 'guest', active: true }));
    await flush();
    expect(result.current.revoked).toBe(true);
  });

  it('si la API responde bien o falla por red/5xx no expulsa y vuelve a comprobar cada intervalo', async () => {
    mockedApiFetch.mockResolvedValueOnce({}).mockRejectedValueOnce(httpError(503)).mockRejectedValueOnce(new Error('network'));
    const { result } = renderHook(() => useRevocationProbe({ roomId: 'r1', role: 'guest', active: true, intervalMs: 1000 }));
    await flush();
    await act(() => vi.advanceTimersByTimeAsync(1000));
    await act(() => vi.advanceTimersByTimeAsync(1000));
    expect(mockedApiFetch).toHaveBeenCalledTimes(3);
    expect(result.current.revoked).toBe(false);
    expect(localStorage.getItem('tint_guest_token')).toBe('guest-jwt');
  });

  it('deja de consultar cuando la conexión se recupera (active vuelve a false)', async () => {
    mockedApiFetch.mockResolvedValue({});
    const { rerender } = renderHook(({ active }) => useRevocationProbe({ roomId: 'r1', role: 'guest', active, intervalMs: 1000 }), {
      initialProps: { active: true },
    });
    await flush();
    rerender({ active: false });
    await act(() => vi.advanceTimersByTimeAsync(10_000));
    expect(mockedApiFetch).toHaveBeenCalledTimes(1);
  });
});
