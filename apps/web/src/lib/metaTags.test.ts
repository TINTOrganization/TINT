import { describe, expect, it } from 'vitest';
import {
  generateMetaTags,
  getLandingMetaTags,
  getInviteMetaTags,
  injectHeadMeta,
  escapeHtml,
} from './metaTags';

describe('metaTags', () => {
  describe('escapeHtml', () => {
    it('escapa caracteres especiales para prevenir XSS', () => {
      expect(escapeHtml('<script>alert("xss") & \'foo\'</script>')).toBe(
        '&lt;script&gt;alert(&quot;xss&quot;) &amp; &#39;foo&#39;&lt;/script&gt;',
      );
    });

    it('devuelve cadena vacía si se pasa un valor falsy', () => {
      expect(escapeHtml('')).toBe('');
      expect(escapeHtml(undefined as unknown as string)).toBe('');
    });
  });

  describe('getLandingMetaTags', () => {
    it('devuelve los metadatos de la landing page', () => {
      const meta = getLandingMetaTags();
      expect(meta.title).toBe('TINT — Watch Party');
      expect(meta.description).toContain('Mira junto, siente al mismo tiempo');
      expect(meta.type).toBe('website');
    });
  });

  describe('getInviteMetaTags', () => {
    it('genera metadatos con el título de la sala cuando está disponible', () => {
      const meta = getInviteMetaTags('ABC123XYZ', 'Noche de Cine');
      expect(meta.title).toBe('Noche de Cine — TINT');
      expect(meta.description).toContain('Noche de Cine');
      expect(meta.url).toBe('/invite/ABC123XYZ');
      expect(meta.type).toBe('video.other');
    });

    it('genera metadatos genéricos de invitación si no hay título de sala', () => {
      const meta = getInviteMetaTags('ABC123XYZ', null);
      expect(meta.title).toBe('Invitación a sala — TINT');
      expect(meta.description).toContain('Te invitaron a ver algo juntos en TINT');
      expect(meta.url).toBe('/invite/ABC123XYZ');
    });

    it('genera metadatos genéricos si el título está vacío o solo tiene espacios', () => {
      const meta = getInviteMetaTags('ABC123XYZ', '   ');
      expect(meta.title).toBe('Invitación a sala — TINT');
    });
  });

  describe('generateMetaTags', () => {
    it('genera etiquetas Open Graph y Twitter Cards', () => {
      const tags = generateMetaTags({
        title: 'Mi Sala — TINT',
        description: 'Descripción de prueba',
        url: '/invite/123',
        type: 'video.other',
      });

      expect(tags).toContain('<meta property="og:title" content="Mi Sala — TINT" />');
      expect(tags).toContain('<meta property="og:description" content="Descripción de prueba" />');
      expect(tags).toContain('<meta property="og:type" content="video.other" />');
      expect(tags).toContain('<meta property="og:url" content="/invite/123" />');
      expect(tags).toContain('<meta property="og:site_name" content="TINT" />');
      expect(tags).toContain('<meta name="twitter:card" content="summary_large_image" />');
      expect(tags).toContain('<meta name="twitter:title" content="Mi Sala — TINT" />');
      expect(tags).toContain('<meta name="twitter:description" content="Descripción de prueba" />');
    });

    it('omite og:url si no se proporciona', () => {
      const tags = generateMetaTags({
        title: 'TINT',
        description: 'Desc',
      });
      expect(tags).not.toContain('og:url');
    });
  });

  describe('injectHeadMeta', () => {
    const htmlTemplate = `<!doctype html>
<html lang="es">
  <head>
    <meta charset="UTF-8" />
    <title>TINT — Watch Party</title>
  </head>
  <body>
    <div id="root"></div>
  </body>
</html>`;

    it('reemplaza la etiqueta <title> existente y añade las etiquetas meta en <head>', () => {
      const metaHtml = '<meta property="og:title" content="Sala Especial — TINT" />';
      const result = injectHeadMeta(htmlTemplate, metaHtml, 'Sala Especial — TINT');

      expect(result).toContain('<title>Sala Especial — TINT</title>');
      expect(result).not.toContain('<title>TINT — Watch Party</title>');
      expect(result).toContain('<meta property="og:title" content="Sala Especial — TINT" />');
      expect(result).toContain('</head>');
    });

    it('añade <title> si no existía previamente en <head>', () => {
      const templateWithoutTitle = '<html><head><meta charset="utf-8" /></head><body></body></html>';
      const metaHtml = '<meta property="og:title" content="Título" />';
      const result = injectHeadMeta(templateWithoutTitle, metaHtml, 'Título Nuevo');

      expect(result).toContain('<title>Título Nuevo</title>');
      expect(result).toContain('<meta property="og:title" content="Título" />');
    });
  });
});
