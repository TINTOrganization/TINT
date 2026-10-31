import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AnalyticsError } from './analytics';
import { fetchBusinessOverview, formatDay, type BusinessOverview } from './businessAnalytics';

const overview: BusinessOverview = {
  generated_at: '2026-10-12T20:00:00.000Z',
  daily: [{ day: '2026-10-12', dau: 3, mau: 4 }],
  events: { total: 10, rooms: 2, by_type: [{ type: 'reaction', source: 'social-core', count: 10 }] },
  rooms: [],
};

function jsonResponse(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('fetchBusinessOverview', () => {
  it('envía la contraseña como Bearer a /analytics/overview', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, overview));
    await expect(fetchBusinessOverview('clave', 'http://api.test/api/v1')).resolves.toEqual(overview);
    expect(fetchMock).toHaveBeenCalledWith('http://api.test/api/v1/analytics/overview', {
      headers: { Authorization: 'Bearer clave', Accept: 'application/json' },
    });
  });

  it('usa VITE_ANALYTICS_API_URL y, si falta, el puerto local', async () => {
    fetchMock.mockImplementation(() => Promise.resolve(jsonResponse(200, overview)));
    vi.stubEnv('VITE_ANALYTICS_API_URL', '/api/v1');
    await fetchBusinessOverview('clave');
    expect(fetchMock).toHaveBeenLastCalledWith('/api/v1/analytics/overview', expect.anything());
    vi.stubEnv('VITE_ANALYTICS_API_URL', '');
    await fetchBusinessOverview('clave');
    expect(fetchMock).toHaveBeenLastCalledWith('http://localhost:8084/api/v1/analytics/overview', expect.anything());
  });

  it('convierte los errores HTTP en AnalyticsError con el mensaje del servicio', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(401, { error: 'contraseña incorrecta' }));
    await expect(fetchBusinessOverview('mala')).rejects.toMatchObject({ status: 401, message: 'contraseña incorrecta' });
    fetchMock.mockResolvedValueOnce(new Response('<html>', { status: 502 }));
    await expect(fetchBusinessOverview('clave')).rejects.toMatchObject({ status: 502, message: 'Analytics error 502' });
  });

  it('un fallo de red es un AnalyticsError con status 0', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    const error = await fetchBusinessOverview('clave').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AnalyticsError);
    expect((error as AnalyticsError).status).toBe(0);
  });
});

describe('formatDay', () => {
  it('formatea el día sin desplazarlo por la zona horaria', () => {
    expect(formatDay('2026-10-12')).toBe('12 oct');
    expect(formatDay('2026-01-01')).toBe('1 ene');
  });

  it('devuelve el texto tal cual si no es una fecha', () => {
    expect(formatDay('ayer')).toBe('ayer');
  });
});
