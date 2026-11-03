import { describe, expect, it, vi, beforeEach } from 'vitest';
import { fetchRoomDetails } from './serverInvite';

describe('serverInvite - fetchRoomDetails', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('retorna los detalles de la sala cuando la respuesta es 200', async () => {
    const inviteCode = 'invite-1';
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () =>
        Promise.resolve({
          code: inviteCode,
          roomId: 'room-1',
          roomTitle: 'Película de Viernes',
          roomKind: 'watch',
        }),
    });

    const result = await fetchRoomDetails(inviteCode, {
      apiBaseUrl: 'http://identity-api/api/v1',
      fetchFn: mockFetch,
    });

    expect(result).toEqual({
      code: inviteCode,
      roomId: 'room-1',
      roomTitle: 'Película de Viernes',
      roomKind: 'watch',
    });
    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining(`/invitations/${inviteCode}`),
      expect.objectContaining({
        method: 'GET',
        headers: { Accept: 'application/json' },
      }),
    );
  });

  it('retorna roomTitle null si la API devuelve roomTitle null', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () =>
        Promise.resolve({
          code: 'ABC123XYZ',
          roomId: 'room-1',
          roomTitle: null,
          roomKind: 'watch',
        }),
    });

    const result = await fetchRoomDetails('ABC123XYZ', {
      apiBaseUrl: 'http://identity-api/api/v1',
      fetchFn: mockFetch,
    });

    expect(result).toEqual({
      code: 'ABC123XYZ',
      roomId: 'room-1',
      roomTitle: null,
      roomKind: 'watch',
    });
  });

  it('retorna null cuando la invitación no existe (404)', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 404,
    });

    const result = await fetchRoomDetails('INVALID', {
      fetchFn: mockFetch,
    });

    expect(result).toBeNull();
  });

  it('retorna null cuando la invitación expiró o fue deshabilitada (410)', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 410,
    });

    const result = await fetchRoomDetails('EXPIRED', {
      fetchFn: mockFetch,
    });

    expect(result).toBeNull();
  });

  it('retorna null ante error 500 del servidor', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
    });

    const result = await fetchRoomDetails('ERR', {
      fetchFn: mockFetch,
    });

    expect(result).toBeNull();
  });

  it('retorna null ante fallos de red o excepciones lanzadas por fetch', async () => {
    const mockFetch = vi.fn().mockRejectedValue(new Error('Network error'));

    const result = await fetchRoomDetails('ABC', {
      fetchFn: mockFetch,
    });

    expect(result).toBeNull();
  });

  it('retorna null ante timeout', async () => {
    const mockFetch = vi.fn().mockImplementation((_url, init) => {
      return new Promise((_resolve, reject) => {
        if (init?.signal) {
          init.signal.addEventListener('abort', () => {
            reject(new Error('The operation was aborted'));
          });
        }
      });
    });

    const result = await fetchRoomDetails('TIMEOUT', {
      timeoutMs: 10,
      fetchFn: mockFetch,
    });

    expect(result).toBeNull();
  });

  it('utiliza la URL por defecto cuando no se provee apiBaseUrl', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () =>
        Promise.resolve({
          code: 'DEF',
          roomId: 'r1',
          roomTitle: 'Default',
        }),
    });

    await fetchRoomDetails('DEF', { fetchFn: mockFetch });
    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining('/invitations/DEF'),
      expect.anything(),
    );
  });
});
