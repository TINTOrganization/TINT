export interface MetaTagOptions {
  title: string;
  description: string;
  url?: string;
  type?: string;
}

/**
 * Escapa caracteres especiales de HTML para atributos y texto en el <head>.
 */
export function escapeHtml(str: string): string {
  if (!str) return '';
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Metadatos por defecto para la página principal / landing de login.
 */
export function getLandingMetaTags(): MetaTagOptions {
  return {
    title: 'TINT — Watch Party',
    description:
      'Mira junto, siente al mismo tiempo. Crea una sala, invita con un link y mantén a todos en el mismo segundo.',
    type: 'website',
  };
}

/**
 * Metadatos para una página de invitación a sala, incorporando el título dinámico si existe.
 */
export function getInviteMetaTags(code: string, roomTitle?: string | null): MetaTagOptions {
  const cleanTitle = roomTitle?.trim();
  const title = cleanTitle ? `${cleanTitle} — TINT` : 'Invitación a sala — TINT';
  const description = cleanTitle
    ? `Te invitaron a ver "${cleanTitle}" juntos en TINT. Elige un nick y entra sin cuenta.`
    : 'Te invitaron a ver algo juntos en TINT. Elige un nick y entra como participante sin cuenta.';

  return {
    title,
    description,
    url: `/invite/${encodeURIComponent(code)}`,
    type: cleanTitle ? 'video.other' : 'website',
  };
}

/**
 * Renderiza el bloque de etiquetas Open Graph, Twitter Card y description.
 */
export function generateMetaTags(options: MetaTagOptions): string {
  const escapedTitle = escapeHtml(options.title);
  const escapedDesc = escapeHtml(options.description);
  const escapedType = escapeHtml(options.type || 'website');
  const escapedUrl = options.url ? escapeHtml(options.url) : null;

  const tags = [
    `<meta name="description" content="${escapedDesc}" />`,
    `<meta property="og:title" content="${escapedTitle}" />`,
    `<meta property="og:description" content="${escapedDesc}" />`,
    `<meta property="og:type" content="${escapedType}" />`,
    `<meta property="og:site_name" content="TINT" />`,
    ...(escapedUrl ? [`<meta property="og:url" content="${escapedUrl}" />`] : []),
    `<meta name="twitter:card" content="summary_large_image" />`,
    `<meta name="twitter:title" content="${escapedTitle}" />`,
    `<meta name="twitter:description" content="${escapedDesc}" />`,
  ];

  return tags.join('\n    ');
}

/**
 * Inyecta o reemplaza el <title> y añade las etiquetas meta dentro del <head>.
 */
export function injectHeadMeta(html: string, metaHtml: string, title?: string): string {
  let updated = html;

  if (title) {
    const escapedTitle = escapeHtml(title);
    if (/<title>[\s\S]*?<\/title>/i.test(updated)) {
      updated = updated.replace(/<title>[\s\S]*?<\/title>/i, `<title>${escapedTitle}</title>`);
    } else {
      updated = updated.replace(/<\/head>/i, `    <title>${escapedTitle}</title>\n  </head>`);
    }
  }

  // Si existe el placeholder <!--ssr-head-->, se reemplaza ahí.
  if (updated.includes('<!--ssr-head-->')) {
    return updated.replace('<!--ssr-head-->', metaHtml);
  }

  // De lo contrario, se inserta justo antes de </head>.
  return updated.replace(/<\/head>/i, `    ${metaHtml}\n  </head>`);
}
