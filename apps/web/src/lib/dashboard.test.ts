import { describe, it, expect, vi } from 'vitest';
import {
  fetchDashboardData,
  formatNextScheduledEvent,
  type DashboardScheduledEvent,
} from './dashboard';

describe('dashboard library', () => {
  describe('formatNextScheduledEvent', () => {
    it('retorna null para null o undefined o vacío', () => {
      expect(formatNextScheduledEvent(null)).toBeNull();
      expect(formatNextScheduledEvent(undefined)).toBeNull();
      expect(formatNextScheduledEvent('')).toBeNull();
      expect(formatNextScheduledEvent('   ')).toBeNull();
    });

    it('formatea string si es fecha ISO', () => {
      const formatted = formatNextScheduledEvent('2026-11-20T21:00:00.000Z');
      expect(formatted).toMatch(/2026/);
    });

    it('retorna el texto si es string plano descriptivo', () => {
      expect(formatNextScheduledEvent('Noche de Cine')).toBe('Noche de Cine');
    });

    it('formatea objeto con title y scheduledStartTime', () => {
      const event: DashboardScheduledEvent = {
        title: 'Estreno VIP',
        scheduledStartTime: '2026-12-01T20:00:00.000Z',
      };
      const formatted = formatNextScheduledEvent(event);
      expect(formatted).toContain('Estreno VIP');
      expect(formatted).toMatch(/2026/);
    });

    it('formatea objeto solo con title o solo con time', () => {
      expect(formatNextScheduledEvent({ title: 'Solo Título' })).toBe('Solo Título');
      expect(formatNextScheduledEvent({ name: 'Solo Nombre' })).toBe('Solo Nombre');
      expect(formatNextScheduledEvent({ scheduledStartTime: '2026-12-01T20:00:00.000Z' })).toMatch(/2026/);
      expect(formatNextScheduledEvent({})).toBeNull();
    });
  });

  describe('fetchDashboardData', () => {
    it('consulta salas y eventos programados exitosamente', async () => {
      const mockFetcher = vi.fn().mockImplementation((url: string) => {
        if (url.includes('/rooms')) {
          return Promise.resolve({
            ok: true,
            json: async () => ({
              rooms: [
                {
                  id: 'r1',
                  title: 'Sala Épica',
                  status: 'active',
                  nextScheduledEvent: {
                    title: 'Maratón Lord of the Rings',
                    scheduledStartTime: '2026-11-25T18:00:00.000Z',
                  },
                },
                {
                  id: 'r2',
                  name: 'Sala Secundaria',
                  status: 'disabled',
                },
              ],
            }),
          });
        }
        return Promise.resolve({ ok: false });
      });

      const res = await fetchDashboardData({
        fetcher: mockFetcher as unknown as typeof fetch,
        token: 'host-tok',
      });

      expect(res.valid).toBe(true);
      expect(res.error).toBeNull();
      expect(res.isHost).toBe(true);
      expect(res.rooms).toHaveLength(2);
      expect(res.rooms[0].title).toBe('Sala Épica');
      expect(res.rooms[0].status).toBe('active');
      expect(res.rooms[0].nextScheduledEvent).toEqual({
        title: 'Maratón Lord of the Rings',
        scheduledStartTime: '2026-11-25T18:00:00.000Z',
      });
      expect(res.rooms[1].title).toBe('Sala Secundaria');
      expect(res.rooms[1].status).toBe('disabled');
    });

    it('asocia eventos de la ruta /events cuando la sala no los incluye directamente', async () => {
      const mockFetcher = vi.fn().mockImplementation((url: string) => {
        if (url.includes('/rooms')) {
          return Promise.resolve({
            ok: true,
            json: async () => ({
              rooms: [{ id: 'r10', title: 'Sala Cinema' }],
            }),
          });
        }
        if (url.includes('/events')) {
          return Promise.resolve({
            ok: true,
            json: async () => ({
              events: [{ id: 'e1', roomId: 'r10', title: 'Noche de Terror' }],
            }),
          });
        }
        return Promise.resolve({ ok: false });
      });

      const res = await fetchDashboardData({
        fetcher: mockFetcher as unknown as typeof fetch,
      });

      expect(res.valid).toBe(true);
      expect(res.rooms[0].nextScheduledEvent).toEqual({
        id: 'e1',
        roomId: 'r10',
        title: 'Noche de Terror',
      });
    });

    it('respeta rol de participante (isHost = false) para control de accesos', async () => {
      const mockFetcher = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ rooms: [] }),
      });

      const res = await fetchDashboardData({
        fetcher: mockFetcher as unknown as typeof fetch,
        role: 'participant',
      });

      expect(res.isHost).toBe(false);
      expect(res.role).toBe('participant');
    });

    it('maneja respuestas con error HTTP del identity-api', async () => {
      const mockFetcher = vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        json: async () => ({ error: 'Error interno en identity' }),
      });

      const res = await fetchDashboardData({
        fetcher: mockFetcher as unknown as typeof fetch,
      });

      expect(res.valid).toBe(false);
      expect(res.rooms).toHaveLength(0);
      expect(res.error).toBe('Error interno en identity');
    });

    it('maneja timeouts del identity-api con mensaje amigable (AC3)', async () => {
      const abortError = new Error('AbortError');
      abortError.name = 'AbortError';
      const mockFetcher = vi.fn().mockRejectedValue(abortError);

      const res = await fetchDashboardData({
        fetcher: mockFetcher as unknown as typeof fetch,
      });

      expect(res.valid).toBe(false);
      expect(res.error).toMatch(/tiempo de espera agotado|demasiado en responder/i);
    });

    it('maneja fallas de red del identity-api con mensaje amigable (AC3)', async () => {
      const mockFetcher = vi.fn().mockRejectedValue(new Error('Connection refused'));

      const res = await fetchDashboardData({
        fetcher: mockFetcher as unknown as typeof fetch,
      });

      expect(res.valid).toBe(false);
      expect(res.error).toMatch(/No se pudo conectar con el servicio de identidad/i);
    });

    it('retorna error si no hay fetcher disponible', async () => {
      const res = await fetchDashboardData({
        fetcher: null,
      });
      expect(res.valid).toBe(false);
      expect(res.error).toContain('No se pudo inicializar');
    });
  });
});
