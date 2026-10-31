import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { apiFetch, ApiError } from './api';
import {
  AnalyticsError,
  createAnalyticsClient,
  DEFAULT_ANALYTICS_API_URL,
  getAnalyticsTicket,
  type RoomKpis,
} from './analytics';

vi.mock('./api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./api')>();
  return { ...actual, apiFetch: vi.fn() };
});

const mockedApi = vi.mocked(apiFetch);
const BASE = 'http://analytics.test/api/v1';

const kpis: RoomKpis = {
  room_id: 'r1',
  live: true,
  peak_users: 4,
  avg_users: 2.5,
  avg_drift_ms: 120.4,
  trivia_accuracy_pct: 50,
  messages: 10,
  reactions: 7,
  playback_commands: 3,
  buffering_events: 2,
  avg_buffering_ms: 640,
  avg_rtt_ms: 40,
  p95_drift_ms: 800,
  total_buffering_ms: 1280,
  close_reason: null,
  closed_at: null,
  computed_at: '2026-10-11T04:00:00.000Z',
};

function jsonResponse(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.clearAllMocks();
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

function ticket(token: string) {
  return { token, expiresAt: '2026-10-11T05:00:00.000Z' };
}

describe('getAnalyticsTicket', () => {
  it('pide el ticket a identity-api con POST', async () => {
    mockedApi.mockResolvedValueOnce(ticket('t1'));
    await expect(getAnalyticsTicket('sala 1')).resolves.toEqual(ticket('t1'));
    expect(mockedApi).toHaveBeenCalledWith('/rooms/sala%201/analytics-ticket', { method: 'POST' });
  });
});

describe('createAnalyticsClient', () => {
  it('usa VITE_ANALYTICS_API_URL o el puerto 8084 por defecto', async () => {
    expect(DEFAULT_ANALYTICS_API_URL).toBe('http://localhost:8084/api/v1');
    mockedApi.mockResolvedValue(ticket('t1'));
    fetchMock.mockImplementation(() => Promise.resolve(jsonResponse(200, kpis)));

    await createAnalyticsClient('r1').kpis();
    expect(fetchMock.mock.calls[0][0]).toBe('http://localhost:8084/api/v1/rooms/r1/kpis');

    vi.stubEnv('VITE_ANALYTICS_API_URL', 'http://env.test/api/v1');
    await createAnalyticsClient('r1').kpis();
    expect(fetchMock.mock.calls[1][0]).toBe('http://env.test/api/v1/rooms/r1/kpis');
  });

  it('envía el ticket como Bearer y devuelve los KPIs', async () => {
    mockedApi.mockResolvedValueOnce(ticket('t1'));
    fetchMock.mockResolvedValueOnce(jsonResponse(200, kpis));
    const client = createAnalyticsClient('r1', { baseUrl: BASE });
    await expect(client.kpis()).resolves.toEqual(kpis);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${BASE}/rooms/r1/kpis`);
    expect(new Headers(init.headers).get('Authorization')).toBe('Bearer t1');
  });

  it('reutiliza el ticket entre peticiones', async () => {
    mockedApi.mockResolvedValueOnce(ticket('t1'));
    fetchMock
      .mockResolvedValueOnce(jsonResponse(200, { room_id: 'r1', bucket_ms: 5000, buckets: [], by_emoji: [] }))
      .mockResolvedValueOnce(jsonResponse(200, { room_id: 'r1', step_s: 60, points: [] }));
    const client = createAnalyticsClient('r1', { baseUrl: BASE });
    await Promise.all([client.heatmap(10_000), client.timeline(30)]);
    expect(mockedApi).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls.map((c) => c[0])).toEqual([
      `${BASE}/rooms/r1/reactions/heatmap?bucket_ms=10000`,
      `${BASE}/rooms/r1/timeline?step_s=30`,
    ]);
  });

  it('usa los parámetros por defecto del contrato', async () => {
    mockedApi.mockResolvedValueOnce(ticket('t1'));
    fetchMock
      .mockResolvedValueOnce(jsonResponse(200, { room_id: 'r1', bucket_ms: 5000, buckets: [], by_emoji: [] }))
      .mockResolvedValueOnce(jsonResponse(200, { room_id: 'r1', step_s: 60, points: [] }));
    const client = createAnalyticsClient('r1', { baseUrl: BASE });
    await client.heatmap();
    await client.timeline();
    expect(fetchMock.mock.calls.map((c) => c[0])).toEqual([
      `${BASE}/rooms/r1/reactions/heatmap?bucket_ms=5000`,
      `${BASE}/rooms/r1/timeline?step_s=60`,
    ]);
  });

  it('ante un 401 pide un ticket nuevo una sola vez y reintenta', async () => {
    mockedApi.mockResolvedValueOnce(ticket('viejo')).mockResolvedValueOnce(ticket('nuevo'));
    fetchMock.mockResolvedValueOnce(jsonResponse(401, { error: 'expired' })).mockResolvedValueOnce(jsonResponse(200, kpis));
    const client = createAnalyticsClient('r1', { baseUrl: BASE });
    await expect(client.kpis()).resolves.toEqual(kpis);
    expect(mockedApi).toHaveBeenCalledTimes(2);
    const retry = fetchMock.mock.calls[1][1] as RequestInit;
    expect(new Headers(retry.headers).get('Authorization')).toBe('Bearer nuevo');
  });

  it('peticiones paralelas con 401 comparten el ticket renovado', async () => {
    mockedApi.mockResolvedValueOnce(ticket('viejo')).mockResolvedValueOnce(ticket('nuevo'));
    fetchMock
      .mockResolvedValueOnce(jsonResponse(401, { error: 'expired' }))
      .mockResolvedValueOnce(jsonResponse(401, { error: 'expired' }))
      .mockResolvedValueOnce(jsonResponse(200, kpis))
      .mockResolvedValueOnce(jsonResponse(200, kpis));
    const client = createAnalyticsClient('r1', { baseUrl: BASE });
    await Promise.all([client.kpis(), client.kpis()]);
    expect(mockedApi).toHaveBeenCalledTimes(2);
  });

  it('si el reintento vuelve a dar 401 falla con AnalyticsError', async () => {
    mockedApi.mockResolvedValueOnce(ticket('a')).mockResolvedValueOnce(ticket('b'));
    fetchMock
      .mockResolvedValueOnce(jsonResponse(401, { error: 'revoked' }))
      .mockResolvedValueOnce(jsonResponse(401, { error: 'revoked' }));
    const client = createAnalyticsClient('r1', { baseUrl: BASE });
    const err = await client.kpis().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AnalyticsError);
    expect(err).toMatchObject({ status: 401, message: 'revoked' });
    expect(mockedApi).toHaveBeenCalledTimes(2);
  });

  it('un 403 no reintenta y conserva el mensaje del servidor', async () => {
    mockedApi.mockResolvedValueOnce(ticket('t1'));
    fetchMock.mockResolvedValueOnce(jsonResponse(403, { error: 'room mismatch' }));
    const client = createAnalyticsClient('r1', { baseUrl: BASE });
    await expect(client.kpis()).rejects.toMatchObject({ name: 'AnalyticsError', status: 403, message: 'room mismatch' });
    expect(mockedApi).toHaveBeenCalledTimes(1);
  });

  it('sin cuerpo JSON usa un mensaje genérico', async () => {
    mockedApi.mockResolvedValueOnce(ticket('t1'));
    fetchMock.mockResolvedValueOnce(new Response('boom', { status: 503 }));
    const client = createAnalyticsClient('r1', { baseUrl: BASE });
    await expect(client.kpis()).rejects.toMatchObject({ status: 503, message: 'Analytics error 503' });
  });

  it('un fallo de red se informa como AnalyticsError con status 0', async () => {
    mockedApi.mockResolvedValueOnce(ticket('t1'));
    fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    const client = createAnalyticsClient('r1', { baseUrl: BASE });
    await expect(client.kpis()).rejects.toMatchObject({ status: 0 });
  });

  it('propaga el ApiError del ticket (p. ej. 403 si no es el dueño)', async () => {
    mockedApi.mockRejectedValueOnce(new ApiError(403, 'Forbidden'));
    const client = createAnalyticsClient('r1', { baseUrl: BASE });
    await expect(client.kpis()).rejects.toMatchObject({ status: 403 });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('si falla el ticket, el siguiente intento pide uno nuevo', async () => {
    mockedApi.mockRejectedValueOnce(new ApiError(500, 'x')).mockResolvedValueOnce(ticket('t2'));
    fetchMock.mockResolvedValueOnce(jsonResponse(200, kpis));
    const client = createAnalyticsClient('r1', { baseUrl: BASE });
    await expect(client.kpis()).rejects.toMatchObject({ status: 500 });
    await expect(client.kpis()).resolves.toEqual(kpis);
  });
});
