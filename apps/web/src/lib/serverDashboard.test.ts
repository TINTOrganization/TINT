import { describe, expect, it, vi, beforeEach } from 'vitest';
import {
  fetchDashboardData,
  formatNextScheduledEvent,
  extractAuthFromRequest,
  getInitialDashboardData,
  type DashboardData,
} from './serverDashboard';
import type { IncomingMessage } from 'node:http';

describe('serverDashboard', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  describe('formatNextScheduledEvent', () => {
    it('formatea fechas ISO válidas a formato legible en español', () => {
      const formatted = formatNextScheduledEvent('2026-11-04T20:00:00.000Z');
      expect(formatted).toBeTruthy();
      expect(typeof formatted).toBe('string');
      // Contiene número del día o mes
      expect(formatted).toMatch(/4|nov|2026/i);
    });

    it('devuelve el string directo si no es fecha ISO', () => {
      expect(formatNextScheduledEvent('Estreno Especial')).toBe('Estreno Especial');
    });

    it('formatea objetos con title y startTime', () => {
      const formatted = formatNextScheduledEvent({
        title: 'Maratón de Terror',
        startTime: '2026-11-04T20:00:00.000Z',
      });
      expect(formatted).toContain('Maratón de Terror');
    });

    it('devuelve cadena vacía si no hay evento', () => {
      expect(formatNextScheduledEvent(null)).toBe('');
      expect(formatNextScheduledEvent(undefined)).toBe('');
    });
  });

  describe('fetchDashboardData (AC1, AC2 & AC3)', () => {
    it('obtiene salas y eventos programados con éxito para un host (AC1)', async () => {
      const mockRooms = [
        {
          id: 'room-1',
          title: 'Sala de Cine Principal',
          status: 'active',
          scheduledStartTime: '2026-11-04T20:00:00.000Z',
          nextScheduledEvent: '2026-11-04T20:00:00.000Z',
        },
        {
          id: 'room-2',
          title: 'Directo Nocturno',
          status: 'disabled',
          kind: 'live',
          nextScheduledEvent: { title: 'Charla en Vivo' },
        },
      ];

      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ rooms: mockRooms }),
      });

      const data = await fetchDashboardData('token-host-123', {
        apiBaseUrl: 'http://test-api/api/v1',
        fetchFn: mockFetch as unknown as typeof fetch,
      });

      expect(data.rooms).toHaveLength(2);
      expect(data.rooms[0].title).toBe('Sala de Cine Principal');
      expect(data.rooms[0].status).toBe('active');
      expect(data.rooms[0].nextScheduledEvent).toBe('2026-11-04T20:00:00.000Z');
      expect(data.rooms[1].status).toBe('disabled');
      expect(data.isHost).toBe(true);
      expect(data.error).toBeNull();
      expect(mockFetch).toHaveBeenCalledWith(
        'http://test-api/api/v1/rooms',
        expect.objectContaining({
          headers: expect.objectContaining({
            Authorization: 'Bearer token-host-123',
          }),
        }),
      );
    });

    it('identifica a un participante sin salas y marca isHost=false (AC2)', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ rooms: [] }),
      });

      const data = await fetchDashboardData('token-participant-123', {
        apiBaseUrl: 'http://test-api/api/v1',
        fetchFn: mockFetch as unknown as typeof fetch,
        role: 'participant',
      });

      expect(data.rooms).toHaveLength(0);
      expect(data.isHost).toBe(false);
      expect(data.role).toBe('participant');
      expect(data.error).toBeNull();
    });

    it('maneja 401 Unauthorized devolviendo error de sesión expirada', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 401,
        json: async () => ({ error: 'Unauthorized' }),
      });

      const data = await fetchDashboardData('token-expired', {
        apiBaseUrl: 'http://test-api/api/v1',
        fetchFn: mockFetch as unknown as typeof fetch,
      });

      expect(data.isHost).toBe(false);
      expect(data.error).toMatch(/sesión no válida o expirada/i);
    });

    it('sin token no invoca la API y devuelve error null para diferir la autenticación al cliente (Fix SSR mismatch)', async () => {
      const mockFetch = vi.fn();
      const data = await fetchDashboardData(undefined, {
        fetchFn: mockFetch as unknown as typeof fetch,
      });

      expect(mockFetch).not.toHaveBeenCalled();
      expect(data.rooms).toHaveLength(0);
      expect(data.isHost).toBe(true);
      expect(data.error).toBeNull();
    });

    it('devuelve error si no hay función fetch disponible', async () => {
      const data = await fetchDashboardData('token', {
        fetchFn: null as unknown as typeof fetch,
      });
      expect(data.error).toBe('Entorno sin soporte de fetch.');
    });

    it('usa las variables de entorno para resolver la URL base por defecto', async () => {
      const origEnv = process.env;
      process.env = { ...origEnv, IDENTITY_API_URL: 'http://custom-api:9999/api/v1' };
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ rooms: [] }),
      });

      await fetchDashboardData('tok', { fetchFn: mockFetch as unknown as typeof fetch });
      expect(mockFetch).toHaveBeenCalledWith('http://custom-api:9999/api/v1/rooms', expect.anything());

      process.env = { ...origEnv, VITE_IDENTITY_API_URL: 'https://vite-api/api/v1' };
      delete process.env.IDENTITY_API_URL;
      await fetchDashboardData('tok', { fetchFn: mockFetch as unknown as typeof fetch });
      expect(mockFetch).toHaveBeenCalledWith('https://vite-api/api/v1/rooms', expect.anything());

      process.env = origEnv;
    });

    it('maneja 403 Forbidden marcando el rol como participante sin salas de host (AC2)', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 403,
        json: async () => ({ error: 'Forbidden' }),
      });

      const data = await fetchDashboardData('token-guest', {
        apiBaseUrl: 'http://test-api/api/v1',
        fetchFn: mockFetch as unknown as typeof fetch,
      });

      expect(data.rooms).toHaveLength(0);
      expect(data.isHost).toBe(false);
      expect(data.role).toBe('participant');
      expect(data.error).toBeNull();
    });

    it('responde con mensaje de error user-friendly si la identity API devuelve 500/503 (AC3)', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 503,
        json: async () => ({ error: 'Service Unavailable' }),
      });

      const data = await fetchDashboardData('token-host', {
        apiBaseUrl: 'http://test-api/api/v1',
        fetchFn: mockFetch as unknown as typeof fetch,
      });

      expect(data.rooms).toHaveLength(0);
      expect(data.error).toMatch(/servicio de identidad no está disponible/i);
    });

    it('responde con mensaje amigable ante fallo de red o timeout sin lanzar excepción (AC3)', async () => {
      const mockFetch = vi.fn().mockRejectedValue(new Error('Network error / connection refused'));

      const data = await fetchDashboardData('token-host', {
        apiBaseUrl: 'http://test-api/api/v1',
        fetchFn: mockFetch as unknown as typeof fetch,
        timeoutMs: 50,
      });

      expect(data.rooms).toHaveLength(0);
      expect(data.error).toMatch(/servicio de identidad no está disponible/i);
    });
  });

  describe('extractAuthFromRequest', () => {
    it('extrae Bearer token del header Authorization', () => {
      const req = {
        headers: {
          authorization: 'Bearer jwt-token-abc',
        },
      } as unknown as IncomingMessage;

      const auth = extractAuthFromRequest(req);
      expect(auth.token).toBe('jwt-token-abc');
      expect(auth.role).toBeUndefined();
    });

    it('extrae token y rol de las cookies', () => {
      const req = {
        headers: {
          cookie: 'tint_token=host-cookie-123; tint_role=host; other=value',
        },
      } as unknown as IncomingMessage;

      const auth = extractAuthFromRequest(req);
      expect(auth.token).toBe('host-cookie-123');
      expect(auth.role).toBe('host');
    });

    it('detecta rol participant de la cookie tint_guest_token', () => {
      const req = {
        headers: {
          cookie: 'tint_guest_token=guest-cookie-456',
        },
      } as unknown as IncomingMessage;

      const auth = extractAuthFromRequest(req);
      expect(auth.token).toBe('guest-cookie-456');
      expect(auth.guestToken).toBe('guest-cookie-456');
      expect(auth.role).toBe('participant');
    });

    it('extrae credenciales de headers personalizados x-tint-*', () => {
      const req = {
        headers: {
          'x-tint-token': 'custom-token-xyz',
          'x-tint-guest-token': 'guest-xyz',
          'x-tint-role': 'participant',
        },
      } as unknown as IncomingMessage;

      const auth = extractAuthFromRequest(req);
      expect(auth.token).toBe('custom-token-xyz');
      expect(auth.guestToken).toBe('guest-xyz');
      expect(auth.role).toBe('participant');
    });

    it('identifica rol participant cuando el JWT solo tiene sub guest:*', () => {
      const payload = Buffer.from(JSON.stringify({ sub: 'guest:uuid-999' })).toString('base64');
      const fakeJwt = `eyJhbGciOiJIUzI1NiJ9.${payload}.sig`;

      const req = {
        headers: {
          authorization: `Bearer ${fakeJwt}`,
        },
      } as unknown as IncomingMessage;

      const auth = extractAuthFromRequest(req);
      expect(auth.role).toBe('participant');
    });

    it('tolera tokens malformados sin lanzar error', () => {
      const req = {
        headers: {
          authorization: 'Bearer bad.token.format!',
        },
      } as unknown as IncomingMessage;

      const auth = extractAuthFromRequest(req);
      expect(auth.token).toBe('bad.token.format!');
      expect(auth.role).toBeUndefined();
    });

    it('decodifica el payload JWT para identificar rol de participante', () => {
      // {"sub":"guest:uuid-123","role":"participant"} en Base64Url
      const payload = Buffer.from(JSON.stringify({ sub: 'guest:uuid-123', role: 'participant' })).toString('base64');
      const fakeJwt = `eyJhbGciOiJIUzI1NiJ9.${payload}.signature`;

      const req = {
        headers: {
          authorization: `Bearer ${fakeJwt}`,
        },
      } as unknown as IncomingMessage;

      const auth = extractAuthFromRequest(req);
      expect(auth.token).toBe(fakeJwt);
      expect(auth.role).toBe('participant');
    });
  });

  describe('getInitialDashboardData', () => {
    it('devuelve null si no existe el elemento script', () => {
      document.body.innerHTML = '';
      expect(getInitialDashboardData()).toBeNull();
    });

    it('parsea correctamente el contenido serializado en el elemento script', () => {
      const mockData: DashboardData = {
        rooms: [{ id: 'r1', title: 'Sala 1', status: 'active' }],
        isHost: true,
        error: null,
      };
      const script = document.createElement('script');
      script.id = '__TINT_DASHBOARD_DATA__';
      script.type = 'application/json';
      script.textContent = JSON.stringify(mockData);
      document.body.appendChild(script);

      const parsed = getInitialDashboardData();
      expect(parsed).toEqual(mockData);
    });

    it('devuelve null si el contenido del script tiene JSON corrupto', () => {
      document.body.innerHTML = '';
      const script = document.createElement('script');
      script.id = '__TINT_DASHBOARD_DATA__';
      script.type = 'application/json';
      script.textContent = 'corrupted-json{{{';
      document.body.appendChild(script);

      expect(getInitialDashboardData()).toBeNull();
    });
  });
});
