import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, apiFetch } from './api';
import { endEventErrorMessage, endLiveEvent, livePath, roomKindOf, roomPath, startLiveEvent, watchPath } from './rooms';

vi.mock('./api', async (orig) => ({ ...(await orig<typeof import('./api')>()), apiFetch: vi.fn() }));
const mockedApi = vi.mocked(apiFetch);

beforeEach(() => mockedApi.mockReset());

describe('rooms', () => {
  it('kind desconocido o ausente es watch', () => {
    expect(roomKindOf('live')).toBe('live');
    expect(roomKindOf('watch')).toBe('watch');
    expect(roomKindOf(undefined)).toBe('watch');
    expect(roomKindOf('cine')).toBe('watch');
  });

  it('la ruta depende del tipo de sala', () => {
    expect(roomPath({ id: 'r1', kind: 'live' })).toBe('/live/r1');
    expect(roomPath({ id: 'r 2' })).toBe('/watch/r%202');
    expect(livePath('a')).toBe('/live/a');
    expect(watchPath('a')).toBe('/watch/a');
  });

  it('startLiveEvent crea el evento con kind live', async () => {
    mockedApi.mockResolvedValueOnce({ room: { id: 'r1', kind: 'live' }, invitation: { code: 'C', link: '/invite/C' } });
    const res = await startLiveEvent('Directo');
    expect(mockedApi).toHaveBeenCalledWith('/events/start', {
      method: 'POST',
      body: JSON.stringify({ title: 'Directo', kind: 'live' }),
    });
    expect(res.room.id).toBe('r1');
  });

  it('endLiveEvent hace POST /rooms/{id}/end con la sesión de host', async () => {
    mockedApi.mockResolvedValueOnce({ room_id: 'r1', status: 'disabled' });
    await expect(endLiveEvent('r1')).resolves.toBe('ended');
    expect(mockedApi).toHaveBeenCalledWith('/rooms/r1/end', { method: 'POST' }, 'host');
  });

  it('409 AlreadyDisabled cuenta como terminado; otros errores se propagan', async () => {
    mockedApi.mockRejectedValueOnce(new ApiError(409, 'AlreadyDisabled'));
    await expect(endLiveEvent('r1')).resolves.toBe('ended');
    mockedApi.mockRejectedValueOnce(new ApiError(503, 'x'));
    await expect(endLiveEvent('r1')).rejects.toBeInstanceOf(ApiError);
  });

  it('mensajes de error del fin del evento', () => {
    expect(endEventErrorMessage(new ApiError(403, 'Forbidden'))).toMatch(/dueño/);
    expect(endEventErrorMessage(new ApiError(410, 'Deleted'))).toMatch(/ya no existe/);
    expect(endEventErrorMessage(new ApiError(409, 'NotLive'))).toMatch(/no es una transmisión/);
    expect(endEventErrorMessage(new ApiError(503, 'x'))).toMatch(/intenta de nuevo/i);
    expect(endEventErrorMessage(null)).toMatch(/intenta de nuevo/i);
  });
});
