import { describe, it, expect, vi, afterAll, beforeAll } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { createAppServer } from './server';

describe('SSR HTTP Server', () => {
  let server: Server;
  let baseUrl: string;

  beforeAll(async () => {
    const mockFetcher = vi.fn().mockImplementation((url: string, init?: RequestInit) => {
      if (url.includes('/invitations/TEST999')) {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            code: 'TEST999',
            roomTitle: 'Sala de Ensayo SSR',
            roomId: 'r-999',
          }),
        });
      }

      if (url.includes('/rooms')) {
        const headers = init?.headers as Record<string, string> | undefined;
        const auth = headers?.Authorization || headers?.authorization;
        if (auth && auth.includes('timeout-token')) {
          const abortError = new Error('AbortError');
          abortError.name = 'AbortError';
          return Promise.reject(abortError);
        }

        return Promise.resolve({
          ok: true,
          json: async () => ({
            rooms: [
              {
                id: 'room-server-1',
                title: 'Sala Principal en Vivo',
                status: 'active',
                nextScheduledEvent: {
                  title: 'Gran Premiere',
                  scheduledStartTime: '2026-11-20T21:00:00.000Z',
                },
              },
            ],
          }),
        });
      }

      return Promise.resolve({ ok: false, status: 404 });
    });

    server = createAppServer({
      fetcher: mockFetcher as unknown as typeof fetch,
    });

    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', () => resolve());
    });

    const addr = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${addr.port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  });

  it('GET /healthz responde con 200 y status ok', async () => {
    const res = await fetch(`${baseUrl}/healthz`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; service: string };
    expect(body.status).toBe('ok');
    expect(body.service).toBe('web-ssr');
  });

  it('GET /login devuelve HTML pre-renderizado con meta tags (AC1)', async () => {
    const res = await fetch(`${baseUrl}/login`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');

    const html = await res.text();
    // AC1: HTML inicial visible sin JavaScript
    expect(html).toContain('Mira junto, siente al mismo tiempo');
    expect(html).toContain('Iniciar sesión con Google');
    expect(html).toContain('Continuar sin cuenta');
    // AC1: Meta tags
    expect(html).toContain('<title>TINT — Mira junto, siente al mismo tiempo</title>');
    expect(html).toContain('property="og:title"');
  });

  it('GET / devuelve HTML pre-renderizado de la landing', async () => {
    const res = await fetch(`${baseUrl}/`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('Mira junto, siente al mismo tiempo');
  });

  it('GET /invite/:code devuelve HTML pre-renderizado con título dinámico de la sala (AC1 & AC2)', async () => {
    const res = await fetch(`${baseUrl}/invite/TEST999`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');

    const html = await res.text();
    // AC1: Visible sin JS
    expect(html).toContain('Te invitaron a ver algo juntos');
    expect(html).toContain('Unirse a la sala');
    expect(html).toContain('TEST999');

    // AC2: Dynamic Meta Tags con el título de la sala para scrapers de chat
    expect(html).toContain('<title>Sala de Ensayo SSR — TINT</title>');
    expect(html).toContain('content="Te invitaron a Sala de Ensayo SSR — TINT"');
    expect(html).toContain('property="og:description"');

    // AC3: Contenedor para hidratación limpia
    expect(html).toContain('<div id="root">');
    expect(html).toContain('id="__TINT_SSR_DATA__"');
    expect(html).toContain('Sala de Ensayo SSR');
  });

  it('GET /dashboard devuelve HTML pre-renderizado con salas, evento programado y estado (AC1)', async () => {
    const res = await fetch(`${baseUrl}/dashboard`, {
      headers: {
        Authorization: 'Bearer valid-host-token',
      },
    });

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');

    const html = await res.text();
    expect(html).toContain('Sala Principal en Vivo');
    expect(html).toContain('Gran Premiere');
    expect(html).toContain('active');
    expect(html).toContain('<title>Mis salas — TINT</title>');
    expect(html).toContain('Crear sala');
    expect(html).toContain('Gestionar');
    expect(html).toContain('Análisis');
    expect(html).toContain('Eliminar');
  });

  it('GET /dashboard con rol de participante oculta controles de gestión del host (AC2)', async () => {
    const res = await fetch(`${baseUrl}/dashboard`, {
      headers: {
        Authorization: 'Bearer participant-token',
        'x-user-role': 'participant',
      },
    });

    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('Sala Principal en Vivo');
    expect(html).toContain('Gran Premiere');
    expect(html).toContain('Abrir');

    // Controles de host ocultos (AC2)
    expect(html).not.toContain('Crear sala');
    expect(html).not.toContain('Gestionar');
    expect(html).not.toContain('Análisis');
    expect(html).not.toContain('Eliminar');
  });

  it('GET /dashboard con timeout en identity-api renderiza error en la vista sin crash (AC3)', async () => {
    const res = await fetch(`${baseUrl}/dashboard`, {
      headers: {
        Authorization: 'Bearer timeout-token',
      },
    });

    expect(res.status).toBe(503);
    const html = await res.text();
    expect(html).toContain('<div id="root">');
    expect(html).toMatch(/tiempo de espera agotado|demasiado en responder/i);
    expect(html).toContain('Mis salas');
  });

  it('GET de archivo estático en public (favicon.svg) se sirve correctamente', async () => {
    const res = await fetch(`${baseUrl}/favicon.svg`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('image/svg+xml');
  });
});
