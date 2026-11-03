import { describe, expect, it, vi } from 'vitest';
import { renderApp, renderPage, renderHtmlPage, isSsrRoute } from './entry-server';

describe('entry-server', () => {
  describe('isSsrRoute', () => {
    it('reconoce / y /login como rutas SSR de la landing page', () => {
      expect(isSsrRoute('/')).toBe(true);
      expect(isSsrRoute('/login')).toBe(true);
      expect(isSsrRoute('/login?next=/dashboard')).toBe(true);
    });

    it('reconoce rutas /invite/:code como rutas SSR', () => {
      expect(isSsrRoute('/invite/ABC123XYZ')).toBe(true);
      expect(isSsrRoute('/invite/12345')).toBe(true);
    });

    it('no aplica SSR a rutas interactivas de streaming ni a rutas privadas', () => {
      expect(isSsrRoute('/watch/room-1')).toBe(false);
      expect(isSsrRoute('/live/room-1')).toBe(false);
      expect(isSsrRoute('/dashboard')).toBe(false);
      expect(isSsrRoute('/rooms/new')).toBe(false);
      expect(isSsrRoute('/test-me')).toBe(false);
    });
  });

  describe('renderApp', () => {
    it('pre-renderiza el HTML completo para la landing page /login (AC1)', () => {
      const html = renderApp('/login');
      expect(html).toContain('Mira junto, siente al mismo tiempo');
      expect(html).toContain('Bienvenido de nuevo');
      expect(html).toContain('Iniciar sesión con Google');
      expect(html).toContain('Continuar sin cuenta');
    });

    it('pre-renderiza el HTML completo para la landing page / (AC1)', () => {
      const html = renderApp('/');
      expect(html).toContain('Mira junto, siente al mismo tiempo');
      expect(html).toContain('Iniciar sesión con Google');
    });

    it('pre-renderiza el HTML completo para la ruta de invitación /invite/:code (AC1)', () => {
      const html = renderApp('/invite/ABC999');
      expect(html).toContain('Te invitaron a ver algo juntos');
      expect(html).toContain('Unirse a la sala');
      expect(html).toContain('ABC999');
      expect(html).toContain('Nick');
      expect(html).toContain('Unirse');
    });
  });

  describe('renderPage', () => {
    it('devuelve metadatos y HTML pre-renderizado para la landing page', async () => {
      const result = await renderPage('/login');
      expect(result.isSsrRoute).toBe(true);
      expect(result.title).toBe('TINT — Watch Party');
      expect(result.metaTags).toContain('og:title');
      expect(result.metaTags).toContain('TINT — Watch Party');
      expect(result.appHtml).toContain('Mira junto, siente al mismo tiempo');
    });

    it('inyecta dinámicamente el título de la sala en los metadatos Open Graph de invitaciones (AC2)', async () => {
      const mockFetchDetails = vi.fn().mockResolvedValue({
        code: 'INVITE123',
        roomId: 'room-abc',
        roomTitle: 'Maratón de Cine de Terror',
        roomKind: 'watch',
      });

      const result = await renderPage('/invite/INVITE123', {
        fetchRoomDetails: mockFetchDetails,
      });

      expect(result.isSsrRoute).toBe(true);
      expect(result.title).toBe('Maratón de Cine de Terror — TINT');
      expect(result.metaTags).toContain('content="Maratón de Cine de Terror — TINT"');
      expect(result.metaTags).toContain('Maratón de Cine de Terror');
      expect(result.roomDetails?.roomTitle).toBe('Maratón de Cine de Terror');
      expect(result.appHtml).toContain('INVITE123');
    });

    it('renderiza página de error de invitación no válida si la consulta falla o es null (AC2)', async () => {
      const mockFetchDetails = vi.fn().mockResolvedValue(null);

      const result = await renderPage('/invite/UNKNOWN', {
        fetchRoomDetails: mockFetchDetails,
      });

      expect(result.isSsrRoute).toBe(true);
      expect(result.title).toBe('Invitación a sala — TINT');
      expect(result.metaTags).toContain('content="Invitación a sala — TINT"');
      expect(result.appHtml).toContain('Invitación no válida');
    });

    it('utiliza metadatos por defecto si la sala no tiene título propio', async () => {
      const mockFetchDetails = vi.fn().mockResolvedValue({
        code: 'DEF123',
        roomId: 'room-1',
        roomTitle: null,
        roomKind: 'watch',
      });

      const result = await renderPage('/invite/DEF123', {
        fetchRoomDetails: mockFetchDetails,
      });

      expect(result.isSsrRoute).toBe(true);
      expect(result.title).toBe('Invitación a sala — TINT');
      expect(result.appHtml).toContain('DEF123');
    });

    it('para rutas de streaming concurrentes (watch/live), retorna appHtml vacío para hidratación en cliente', async () => {
      const result = await renderPage('/watch/room-streaming-1');
      expect(result.isSsrRoute).toBe(false);
      expect(result.appHtml).toBe('');
      expect(result.title).toBe('TINT — Watch Party');
    });
  });

  describe('renderHtmlPage', () => {
    const templateHtml = `<!doctype html>
<html lang="es">
  <head>
    <meta charset="UTF-8" />
    <title>TINT — Watch Party</title>
    <!--ssr-head-->
  </head>
  <body class="bg-tint-bg">
    <div id="root"><!--ssr-outlet--></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>`;

    it('genera la respuesta HTML completa con contenido y metadatos pre-renderizados', async () => {
      const { html, statusCode } = await renderHtmlPage(templateHtml, '/invite/PARTY777', {
        roomTitle: 'Anime Night',
      });

      expect(statusCode).toBe(200);
      expect(html).toContain('<title>Anime Night — TINT</title>');
      expect(html).toContain('<meta property="og:title" content="Anime Night — TINT" />');
      expect(html).toContain('<div id="root">');
      expect(html).toContain('Te invitaron a ver algo juntos');
      expect(html).toContain('PARTY777');
      // Debe conservar los scripts para permitir la hidratación en cliente
      expect(html).toContain('/src/main.tsx');
    });

    it('funciona también si la plantilla usa <div id="root"></div> sin el comentario <!--ssr-outlet-->', async () => {
      const plainTemplate = `<html><head><title>Original</title></head><body><div id="root"></div></body></html>`;
      const { html } = await renderHtmlPage(plainTemplate, '/login');

      expect(html).toContain('Mira junto, siente al mismo tiempo');
      expect(html).toContain('<title>TINT — Watch Party</title>');
    });

    it('devuelve statusCode 404 y vista de error para una invitación inválida o revocada (AC2)', async () => {
      const { html, statusCode } = await renderHtmlPage(templateHtml, '/invite/BADCODE', {
        fetchRoomDetails: vi.fn().mockResolvedValue(null),
      });

      expect(statusCode).toBe(404);
      expect(html).toContain('Invitación no válida');
    });
  });
});
