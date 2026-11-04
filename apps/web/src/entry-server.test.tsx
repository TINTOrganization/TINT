import { describe, expect, it, vi } from 'vitest';
import { renderApp, renderPage, renderHtmlPage, isSsrRoute } from './entry-server';
import type { DashboardData } from './lib/serverDashboard';

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

    it('reconoce /dashboard como ruta SSR para renderizado de salas y eventos del host (AC1)', () => {
      expect(isSsrRoute('/dashboard')).toBe(true);
      expect(isSsrRoute('/dashboard?ref=login')).toBe(true);
    });

    it('reconoce /watch/:roomId como ruta SSR para la sala (AC1)', () => {
      expect(isSsrRoute('/watch/room-1')).toBe(true);
      expect(isSsrRoute('/watch/cine-123?ref=invite')).toBe(true);
    });

    it('no aplica SSR a salas live de streaming WebRTC ni a rutas privadas', () => {
      expect(isSsrRoute('/live/room-1')).toBe(false);
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

    it('pre-renderiza el HTML del dashboard con el nombre de cada sala, próximo evento y estado active/disabled (AC1)', () => {
      const dashboardData: DashboardData = {
        rooms: [
          {
            id: 'room-cine',
            title: 'Maratón de Cine Clásico',
            status: 'active',
            nextScheduledEvent: '2026-11-04T20:00:00.000Z',
          },
          {
            id: 'room-live',
            title: 'Charla en Vivo',
            status: 'disabled',
            nextScheduledEvent: { title: 'Q&A con Comunidad' },
          },
        ],
        isHost: true,
        error: null,
      };

      const html = renderApp('/dashboard', null, false, dashboardData);
      expect(html).toContain('Mis salas');
      expect(html).toContain('Maratón de Cine Clásico');
      expect(html).toContain('active');
      expect(html).toContain('Charla en Vivo');
      expect(html).toContain('disabled');
      expect(html).toContain('Próximo evento:');
      expect(html).toContain('Crear sala');
      expect(html).toContain('Gestionar');
      expect(html).toContain('Análisis');
      expect(html).toContain('Eliminar');
    });

    it('omite controles de gestión para un participante que no administra salas (AC2)', () => {
      const dashboardData: DashboardData = {
        rooms: [
          {
            id: 'room-view',
            title: 'Sala de Cine Invitado',
            status: 'active',
            nextScheduledEvent: '2026-11-04T20:00:00.000Z',
          },
        ],
        isHost: false,
        role: 'participant',
        error: null,
      };

      const html = renderApp('/dashboard', null, false, dashboardData);
      expect(html).toContain('Mis salas');
      expect(html).toContain('Sala de Cine Invitado');
      expect(html).toContain('active');
      expect(html).toContain('Abrir');
      // Omitir acciones de host (AC2)
      expect(html).not.toContain('Crear sala');
      expect(html).not.toContain('Gestionar');
      expect(html).not.toContain('Análisis');
      expect(html).not.toContain('Eliminar');
      expect(html).not.toContain('Generar en Gestionar');
    });

    it('renderiza mensaje de error user-friendly estilizado dentro del layout ante fallo upstream (AC3)', () => {
      const dashboardData: DashboardData = {
        rooms: [],
        isHost: true,
        error: 'El servicio de identidad no está disponible en este momento.',
      };

      const html = renderApp('/dashboard', null, false, dashboardData);
      expect(html).toContain('Mis salas');
      expect(html).toContain('El servicio de identidad no está disponible en este momento.');
      expect(html).toContain('role="alert"');
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

    it('devuelve metadatos y HTML pre-renderizado para el dashboard llamando a fetchDashboardData (AC1)', async () => {
      const mockFetchDashboard = vi.fn().mockResolvedValue({
        rooms: [
          {
            id: 'r1',
            title: 'Sala de Terror',
            status: 'active',
            nextScheduledEvent: '2026-11-04T20:00:00.000Z',
          },
        ],
        isHost: true,
        error: null,
      });

      const result = await renderPage('/dashboard', {
        fetchDashboardData: mockFetchDashboard,
        authToken: 'token-host-test',
      });

      expect(result.isSsrRoute).toBe(true);
      expect(result.title).toBe('Mis salas — TINT');
      expect(result.metaTags).toContain('Mis salas — TINT');
      expect(result.appHtml).toContain('Sala de Terror');
      expect(result.appHtml).toContain('active');
      expect(result.dashboardData?.rooms).toHaveLength(1);
      expect(mockFetchDashboard).toHaveBeenCalledWith('token-host-test', expect.anything());
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

    it('para rutas de streaming en vivo (/live), retorna appHtml vacío para hidratación en cliente', async () => {
      const result = await renderPage('/live/room-streaming-1');
      expect(result.isSsrRoute).toBe(false);
      expect(result.appHtml).toBe('');
      expect(result.title).toBe('TINT — Watch Party');
    });

    it('para la sala de visualización (/watch/:roomId), pre-renderiza la estructura HTML de la sala (AC1)', async () => {
      const result = await renderPage('/watch/room-streaming-1');
      expect(result.isSsrRoute).toBe(true);
      expect(result.title).toBe('Sala room-streaming-1 — TINT');
      expect(result.appHtml).toContain('data-room-shell="watch"');
    });
  });

  describe('renderHtmlPage', () => {
    const templateHtml = `<!doctype html>
<html lang="es">
  <head>
    <meta charset="UTF-8" />
    <title>TINT — Watch Party</title>
    <!--ssr-head-->
    <link rel="stylesheet" crossorigin href="/assets/index.css">
  </head>
  <body class="bg-tint-bg">
    <div id="root"><!--ssr-outlet--></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>`;

    it('pre-renderiza /dashboard e inyecta la serialización de hidratación __TINT_DASHBOARD_DATA__ (AC1)', async () => {
      const mockFetchDashboard = vi.fn().mockResolvedValue({
        rooms: [
          {
            id: 'room-pre',
            title: 'Sala Premiere',
            status: 'active',
            nextScheduledEvent: '2026-11-05T18:00:00.000Z',
          },
        ],
        isHost: true,
        error: null,
      });

      const { html, statusCode, dashboardData } = await renderHtmlPage(
        templateHtml,
        '/dashboard',
        { fetchDashboardData: mockFetchDashboard },
      );

      expect(statusCode).toBe(200);
      expect(html).toContain('Sala Premiere');
      expect(html).toContain('active');
      expect(html).toContain('<link rel="stylesheet" crossorigin href="/assets/index.css">');
      expect(html).toContain('id="__TINT_DASHBOARD_DATA__"');
      expect(html).toContain('Sala Premiere');
      expect(dashboardData?.rooms[0].title).toBe('Sala Premiere');
    });

    it('genera la respuesta HTML completa con contenido y metadatos pre-renderizados para invitaciones', async () => {
      const { html, statusCode } = await renderHtmlPage(templateHtml, '/invite/PARTY777', {
        roomTitle: 'Anime Night',
      });

      expect(statusCode).toBe(200);
      expect(html).toContain('<title>Anime Night — TINT</title>');
      expect(html).toContain('<meta property="og:title" content="Anime Night — TINT" />');
      expect(html).toContain('<div id="root">');
      expect(html).toContain('Te invitaron a ver algo juntos');
      expect(html).toContain('PARTY777');
      expect(html).toContain('/src/main.tsx');
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
