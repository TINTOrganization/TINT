import { describe, it, expect, vi } from 'vitest';
import {
  render,
  generateMetaTags,
  injectIntoTemplate,
  DEFAULT_HTML_TEMPLATE,
  type PageMeta,
} from './entry-server';

describe('entry-server SSR', () => {
  describe('render (AC1 & AC2)', () => {
    it('pre-renderiza la landing page con contenido inicial completo y meta tags (AC1)', async () => {
      const result = await render('/login');

      expect(result.statusCode).toBe(200);
      // AC1: El contenido inicial debe estar presente en el HTML renderizado por el servidor
      expect(result.appHtml).toContain('Mira junto, siente al mismo tiempo');
      expect(result.appHtml).toContain('Iniciar sesión con Google');
      expect(result.appHtml).toContain('Continuar sin cuenta');
      expect(result.appHtml).toContain('Salas sincronizadas');

      // AC1 & AC2: Meta tags en el documento
      expect(result.html).toContain('<title>TINT — Mira junto, siente al mismo tiempo</title>');
      expect(result.html).toContain('property="og:title" content="TINT — Mira junto, siente al mismo tiempo"');
      expect(result.html).toContain('property="og:description" content="Crea una sala, invita con un link y mantén a todos en el mismo segundo."');
      expect(result.html).toContain('property="og:type" content="website"');
      expect(result.html).toContain('name="twitter:card" content="summary_large_image"');
      expect(result.html).toContain('<div id="root">');
      expect(result.html).toContain('Mira junto, siente al mismo tiempo');
    });

    it('pre-renderiza / como redirección a la landing con contenido de login', async () => {
      const result = await render('/');
      expect(result.statusCode).toBe(200);
      expect(result.appHtml).toContain('Mira junto, siente al mismo tiempo');
      expect(result.meta.title).toBe('TINT — Mira junto, siente al mismo tiempo');
    });

    it('pre-renderiza ruta de invitación con el título dinámico de la sala en meta tags (AC1 & AC2)', async () => {
      const mockFetcher = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          code: 'ABC123XYZ',
          roomTitle: 'Noche de Pelis Clásicas',
          roomId: 'room-42',
          hostName: 'Carlos Host',
          scheduledStartTime: '2026-11-15T20:00:00.000Z',
        }),
      });

      const result = await render('/invite/ABC123XYZ', {
        fetcher: mockFetcher as unknown as typeof fetch,
        origin: 'https://tint.stream',
      });

      expect(result.statusCode).toBe(200);

      // AC1: Contenido inicial completo sin JS con título, host y hora programada
      expect(result.appHtml).toContain('Te invitaron a ver algo juntos');
      expect(result.appHtml).toContain('Unirse a la sala');
      expect(result.appHtml).toContain('ABC123XYZ');
      expect(result.appHtml).toContain('Noche de Pelis Clásicas');
      expect(result.appHtml).toContain('Carlos Host');
      expect(result.appHtml).toContain('Join');

      // Dynamic meta tags con el título de la sala para scrapers de chat
      expect(result.html).toContain('<title>Noche de Pelis Clásicas — TINT</title>');
      expect(result.html).toContain('property="og:title" content="Te invitaron a Noche de Pelis Clásicas — TINT"');
      expect(result.html).toContain('property="og:url" content="https://tint.stream/invite/ABC123XYZ"');

      // Script de initialData para hidratación sin fisuras
      expect(result.html).toContain('id="__TINT_SSR_DATA__"');
      expect(result.html).toContain('Noche de Pelis Clásicas');
      expect(result.initialData?.roomTitle).toBe('Noche de Pelis Clásicas');
      expect(result.initialData?.hostName).toBe('Carlos Host');
      expect(result.initialData?.scheduledStartTime).toBe('2026-11-15T20:00:00.000Z');
    });

    it('devuelve status 404 y renderiza página de invitación no válida si el link es inválido, expirado o revocado (AC2)', async () => {
      const mockFetcher = vi.fn().mockResolvedValue({
        ok: false,
        status: 404,
      });

      const result = await render('/invite/NOEXISTE', {
        fetcher: mockFetcher as unknown as typeof fetch,
      });

      expect(result.statusCode).toBe(404);
      expect(result.appHtml).toContain('Invitación no válida');
      expect(result.appHtml).toContain('Error 404');
      expect(result.appHtml).toContain('Esta invitación no existe, ha expirado o fue revocada por el host.');
      expect(result.html).toContain('<title>Invitación no válida — TINT</title>');
      expect(result.html).toContain('property="og:title" content="Invitación no válida — TINT"');
    });

    it('respeta roomTitle provisto directamente en opciones', async () => {
      const result = await render('/invite/CODE123', {
        roomTitle: 'Maratón Star Wars',
      });

      expect(result.meta.title).toBe('Maratón Star Wars — TINT');
      expect(result.html).toContain('Maratón Star Wars');
    });

    it('permite inyectar en una plantilla HTML personalizada', async () => {
      const customTemplate = `<!DOCTYPE html><html><head><title>Original</title></head><body><div id="root"></div></body></html>`;
      const result = await render('/login', {
        templateHtml: customTemplate,
      });

      expect(result.html).toContain('<title>TINT — Mira junto, siente al mismo tiempo</title>');
      expect(result.html).toContain('property="og:title"');
      expect(result.html).toContain('Mira junto, siente al mismo tiempo');
    });

    it('AC1: pre-renderiza el dashboard del host con salas, próximo evento y estado actual', async () => {
      const mockFetcher = vi.fn().mockImplementation((url: string) => {
        if (url.includes('/rooms')) {
          return Promise.resolve({
            ok: true,
            json: async () => ({
              rooms: [
                {
                  id: 'ssr-room-1',
                  title: 'Cine Club Fin de Semana',
                  status: 'active',
                  nextScheduledEvent: {
                    title: 'Interstellar 4K',
                    scheduledStartTime: '2026-11-20T21:00:00.000Z',
                  },
                },
                {
                  id: 'ssr-room-2',
                  title: 'Sala Deshabilitada',
                  status: 'disabled',
                  nextScheduledEvent: null,
                },
              ],
            }),
          });
        }
        return Promise.resolve({ ok: false });
      });

      const result = await render('/dashboard', {
        fetcher: mockFetcher as unknown as typeof fetch,
        token: 'host-bearer-token',
        origin: 'https://tint.stream',
      });

      expect(result.statusCode).toBe(200);

      // AC1: En el HTML inicial (appHtml y html)
      // Nombres de las salas
      expect(result.appHtml).toContain('Cine Club Fin de Semana');
      expect(result.appHtml).toContain('Sala Deshabilitada');

      // Próximos eventos
      expect(result.appHtml).toContain('Interstellar 4K');
      expect(result.appHtml).toContain('Sin eventos programados');

      // Estados actuales (active o disabled)
      expect(result.appHtml).toContain('active');
      expect(result.appHtml).toContain('disabled');

      // Meta tags del dashboard
      expect(result.html).toContain('<title>Mis salas — TINT</title>');
      expect(result.html).toContain('property="og:title" content="Mis salas — TINT"');
      expect(result.html).toContain('id="__TINT_SSR_DATA__"');
    });

    it('AC2: oculta los controles y acciones de gestión del host para participantes regulares', async () => {
      const mockFetcher = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          rooms: [
            {
              id: 'room-guest-1',
              title: 'Sala de Invitado',
              status: 'active',
              nextScheduledEvent: 'Noche de Anime',
            },
          ],
        }),
      });

      const result = await render('/dashboard', {
        fetcher: mockFetcher as unknown as typeof fetch,
        userRole: 'participant',
        token: 'participant-token',
      });

      expect(result.statusCode).toBe(200);
      expect(result.appHtml).toContain('Sala de Invitado');
      expect(result.appHtml).toContain('Noche de Anime');
      expect(result.appHtml).toContain('Abrir');

      // AC2: Acciones exclusivas de gestión del host quedan ocultas
      expect(result.appHtml).not.toContain('Crear sala');
      expect(result.appHtml).not.toContain('Gestionar');
      expect(result.appHtml).not.toContain('Análisis');
      expect(result.appHtml).not.toContain('Eliminar');
    });

    it('AC3: maneja timeout en identity-api renderizando un mensaje amigable sin crash', async () => {
      const abortError = new Error('The operation was aborted');
      abortError.name = 'AbortError';
      const mockFetcher = vi.fn().mockRejectedValue(abortError);

      const result = await render('/dashboard', {
        fetcher: mockFetcher as unknown as typeof fetch,
        timeoutMs: 1000,
        token: 'host-token',
      });

      // No falla con excepción no capturada ni devuelve pantalla en blanco
      expect(result.statusCode).toBe(503);
      expect(result.appHtml).toContain('Mis salas');
      expect(result.appHtml).toMatch(/tiempo de espera agotado|demasiado en responder/i);
      expect(result.html).toContain('<div id="root">');
      expect(result.html).toMatch(/tiempo de espera agotado|demasiado en responder/i);
    });

    it('AC3: maneja falla de servicio identity-api no disponible renderizando mensaje de error', async () => {
      const mockFetcher = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));

      const result = await render('/dashboard', {
        fetcher: mockFetcher as unknown as typeof fetch,
        token: 'host-token',
      });

      expect(result.statusCode).toBe(503);
      expect(result.appHtml).toContain('Mis salas');
      expect(result.appHtml).toMatch(/No se pudo conectar con el servicio de identidad/i);
      expect(result.html).toContain('<div id="root">');
    });

    it('pre-renderiza /watch/:roomId con título por defecto y metadata (AC1)', async () => {
      const result = await render('/watch/r123');

      expect(result.statusCode).toBe(200);
      expect(result.html).toContain('<title>Sala r123 — TINT</title>');
      expect(result.html).toContain('property="og:title" content="Sala r123 — TINT"');
      expect(result.initialData?.roomId).toBe('r123');
    });

    it('pre-renderiza /watch/:roomId con roomTitle provisto y initialData para SSR seguro', async () => {
      const result = await render('/watch/sala-cine', {
        roomTitle: 'Gran Noche de Cine',
        origin: 'https://tint.stream',
      });

      expect(result.statusCode).toBe(200);
      expect(result.html).toContain('<title>Gran Noche de Cine — TINT</title>');
      expect(result.html).toContain('property="og:title" content="Gran Noche de Cine — TINT"');
      expect(result.html).toContain('id="__TINT_SSR_DATA__"');
      expect(result.initialData?.roomTitle).toBe('Gran Noche de Cine');
      expect(result.initialData?.roomId).toBe('sala-cine');
    });
  });

  describe('generateMetaTags', () => {
    it('escapa caracteres especiales para prevenir inyección HTML', () => {
      const meta: PageMeta = {
        title: 'Sala <Script> "Hack" & Fun',
        description: 'Descripción con <b>HTML</b> & "comillas"',
        ogTitle: 'OG <Title>',
        ogDescription: 'OG <Desc>',
        ogImage: 'https://example.com/img.png?a=1&b=2',
        ogUrl: 'https://example.com/invite/<evil>',
      };

      const tags = generateMetaTags(meta);
      expect(tags).not.toContain('<Script>');
      expect(tags).toContain('&lt;Script&gt;');
      expect(tags).toContain('&amp; Fun');
      expect(tags).toContain('&quot;Hack&quot;');
      expect(tags).toContain('content="https://example.com/img.png?a=1&amp;b=2"');
    });
  });

  describe('injectIntoTemplate', () => {
    it('inyecta appHtml y metaTags en la plantilla por defecto', () => {
      const metaTags = '<title>Custom</title><meta property="og:title" content="Custom" />';
      const appHtml = '<div data-testid="app">Contenido</div>';
      const initialData = { roomTitle: 'Sala 1', code: 'ABC' };

      const html = injectIntoTemplate(DEFAULT_HTML_TEMPLATE, appHtml, metaTags, initialData);

      expect(html).toContain(metaTags);
      expect(html).toContain('<div id="root"><div data-testid="app">Contenido</div></div>');
      expect(html).toContain('id="__TINT_SSR_DATA__"');
      expect(html).toContain('Sala 1');
    });

    it('sin initialData omite el tag __TINT_SSR_DATA__', () => {
      const html = injectIntoTemplate(DEFAULT_HTML_TEMPLATE, '<p>OK</p>', '<title>T</title>');
      expect(html).not.toContain('__TINT_SSR_DATA__');
      expect(html).toContain('<div id="root"><p>OK</p></div>');
    });
  });
});
