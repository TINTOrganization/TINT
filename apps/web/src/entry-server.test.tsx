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
        }),
      });

      const result = await render('/invite/ABC123XYZ', {
        fetcher: mockFetcher as unknown as typeof fetch,
        origin: 'https://tint.stream',
      });

      expect(result.statusCode).toBe(200);

      // AC1: Contenido inicial completo sin JS
      expect(result.appHtml).toContain('Te invitaron a ver algo juntos');
      expect(result.appHtml).toContain('Unirse a la sala');
      expect(result.appHtml).toContain('ABC123XYZ');
      expect(result.appHtml).toContain('Nick');
      expect(result.appHtml).toContain('Noche de Pelis Clásicas');

      // AC2: Dynamic meta tags con el título de la sala para scrapers de chat
      expect(result.html).toContain('<title>Noche de Pelis Clásicas — TINT</title>');
      expect(result.html).toContain('property="og:title" content="Te invitaron a Noche de Pelis Clásicas — TINT"');
      expect(result.html).toContain('property="og:description" content="Te invitaron a ver algo juntos en TINT. Elige un nick y entra a la sala."');
      expect(result.html).toContain('property="og:url" content="https://tint.stream/invite/ABC123XYZ"');

      // AC3: Script de initialData para hidratación sin fisuras
      expect(result.html).toContain('id="__TINT_SSR_DATA__"');
      expect(result.html).toContain('Noche de Pelis Clásicas');
      expect(result.initialData?.roomTitle).toBe('Noche de Pelis Clásicas');
    });

    it('pre-renderiza ruta de invitación con fallback si no se puede obtener el título de la sala', async () => {
      const mockFetcher = vi.fn().mockResolvedValue({
        ok: false,
        status: 404,
      });

      const result = await render('/invite/NOEXISTE', {
        fetcher: mockFetcher as unknown as typeof fetch,
      });

      expect(result.statusCode).toBe(200);
      expect(result.appHtml).toContain('Te invitaron a ver algo juntos');
      expect(result.appHtml).toContain('Unirse a la sala');
      expect(result.html).toContain('<title>Te invitaron a ver algo juntos — TINT</title>');
      expect(result.html).toContain('property="og:title" content="Te invitaron a ver algo juntos — TINT"');
      expect(result.html).toContain('property="og:description" content="Elige un nick y entra como participante. Sin cuenta, sin fricción."');
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
