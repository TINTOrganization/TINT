import { renderToString } from 'react-dom/server';
import App, { type AppInitialData } from './App';
import { fetchInviteRoomDetails, parseInviteCode } from './lib/invite';

export interface PageMeta {
  title: string;
  description: string;
  ogTitle?: string;
  ogDescription?: string;
  ogType?: string;
  ogUrl?: string;
  ogImage?: string;
  twitterCard?: string;
  twitterTitle?: string;
  twitterDescription?: string;
  twitterImage?: string;
}

export interface SSRRenderOptions {
  templateHtml?: string;
  roomTitle?: string | null;
  apiUrl?: string;
  fetcher?: typeof fetch | null;
  timeoutMs?: number;
  origin?: string;
}

export interface SSRRenderResult {
  html: string;
  appHtml: string;
  meta: PageMeta;
  statusCode: number;
  initialData?: AppInitialData | null;
}

export const DEFAULT_HTML_TEMPLATE = `<!doctype html>
<html lang="es">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <link rel="icon" type="image/svg+xml" href="/favicon.svg" />
    <link rel="apple-touch-icon" href="/apple-touch-icon.png" />
    <link rel="manifest" href="/manifest.webmanifest" />
    <meta name="theme-color" content="#1E1F22" />
    <link rel="preconnect" href="https://fonts.googleapis.com" />
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
    <link
      rel="stylesheet"
      href="https://fonts.googleapis.com/css2?family=Outfit:wght@300;400;500;600;700&display=swap"
    />
    <title>TINT — Watch Party</title>
  </head>
  <body class="bg-tint-bg">
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>`;

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Genera el bloque de meta tags para el <head> con metadatos Open Graph y Twitter Cards.
 */
export function generateMetaTags(meta: PageMeta): string {
  const ogTitle = meta.ogTitle ?? meta.title;
  const ogDesc = meta.ogDescription ?? meta.description;
  const ogType = meta.ogType ?? 'website';
  const twitterCard = meta.twitterCard ?? 'summary_large_image';
  const twitterTitle = meta.twitterTitle ?? ogTitle;
  const twitterDesc = meta.twitterDescription ?? ogDesc;

  const tags: string[] = [
    `<title>${escapeHtml(meta.title)}</title>`,
    `<meta name="description" content="${escapeHtml(meta.description)}" />`,
    `<meta property="og:title" content="${escapeHtml(ogTitle)}" />`,
    `<meta property="og:description" content="${escapeHtml(ogDesc)}" />`,
    `<meta property="og:type" content="${escapeHtml(ogType)}" />`,
  ];

  if (meta.ogUrl) {
    tags.push(`<meta property="og:url" content="${escapeHtml(meta.ogUrl)}" />`);
  }
  if (meta.ogImage) {
    tags.push(`<meta property="og:image" content="${escapeHtml(meta.ogImage)}" />`);
  }

  tags.push(
    `<meta name="twitter:card" content="${escapeHtml(twitterCard)}" />`,
    `<meta name="twitter:title" content="${escapeHtml(twitterTitle)}" />`,
    `<meta name="twitter:description" content="${escapeHtml(twitterDesc)}" />`,
  );

  if (meta.twitterImage ?? meta.ogImage) {
    tags.push(`<meta name="twitter:image" content="${escapeHtml((meta.twitterImage ?? meta.ogImage)!)}" />`);
  }

  return tags.join('\n    ');
}

/**
 * Inyecta el HTML pre-renderizado, las meta tags y la información inicial en la plantilla HTML.
 */
export function injectIntoTemplate(
  templateHtml: string,
  appHtml: string,
  metaTags: string,
  initialData?: unknown,
): string {
  let html = templateHtml;

  // Reemplazar o inyectar title y meta tags en <head>
  if (/<title>.*?<\/title>/i.test(html)) {
    html = html.replace(/<title>.*?<\/title>/i, metaTags);
  } else if (/<\/head>/i.test(html)) {
    html = html.replace(/<\/head>/i, `    ${metaTags}\n  </head>`);
  }

  // Serializar datos iniciales para hidratación sin fisuras en cliente
  const dataScript =
    initialData !== undefined
      ? `\n    <script id="__TINT_SSR_DATA__" type="application/json">${JSON.stringify(initialData).replace(/</g, '\\u003c')}</script>`
      : '';

  // Inyectar appHtml dentro de <div id="root">
  if (/<div id="root"><\/div>/i.test(html)) {
    html = html.replace(/<div id="root"><\/div>/i, `<div id="root">${appHtml}</div>${dataScript}`);
  } else if (/<div id="root">/i.test(html)) {
    html = html.replace(/<div id="root">[\s\S]*?<\/div>/i, `<div id="root">${appHtml}</div>${dataScript}`);
  }

  return html;
}

/**
 * Renderiza en el servidor una ruta específica (landing o invitación), retornando el HTML
 * completo con meta tags dinámicos y HTML pre-renderizado listo para hidratación.
 */
export async function render(url: string, options?: SSRRenderOptions): Promise<SSRRenderResult> {
  const origin = options?.origin || 'http://localhost:5173';
  const cleanUrl = url.split('?')[0].split('#')[0] || '/';

  // 1. Resolver ruta y metadatos dinámicos
  let meta: PageMeta;
  let initialData: AppInitialData | null = null;
  let locationForApp = cleanUrl;

  if (cleanUrl === '/' || cleanUrl === '/login') {
    locationForApp = '/login';
    meta = {
      title: 'TINT — Mira junto, siente al mismo tiempo',
      description: 'Crea una sala, invita con un link y mantén a todos en el mismo segundo.',
      ogTitle: 'TINT — Mira junto, siente al mismo tiempo',
      ogDescription: 'Crea una sala, invita con un link y mantén a todos en el mismo segundo.',
      ogType: 'website',
      ogUrl: `${origin}/login`,
      ogImage: 'https://picsum.photos/seed/tint-cinema/1200/1400',
      twitterCard: 'summary_large_image',
    };
  } else if (cleanUrl.startsWith('/invite/')) {
    const rawCode = cleanUrl.replace(/^\/invite\//, '');
    const code = parseInviteCode(rawCode) ?? rawCode;

    // AC2: Obtener detalles de la sala para la invitación
    let roomTitle: string | null = options?.roomTitle ?? null;
    let roomId: string | null = null;

    if (roomTitle === null && options?.roomTitle === undefined) {
      const details = await fetchInviteRoomDetails(code, {
        apiUrl: options?.apiUrl,
        fetcher: options?.fetcher,
        timeoutMs: options?.timeoutMs,
      });
      roomTitle = details.roomTitle;
      roomId = details.roomId;
    }

    initialData = { code, roomTitle, roomId };

    if (roomTitle) {
      meta = {
        title: `${roomTitle} — TINT`,
        ogTitle: `Te invitaron a ${roomTitle} — TINT`,
        description: 'Te invitaron a ver algo juntos en TINT. Elige un nick y entra a la sala.',
        ogDescription: 'Te invitaron a ver algo juntos en TINT. Elige un nick y entra a la sala.',
        ogType: 'website',
        ogUrl: `${origin}/invite/${code}`,
        ogImage: 'https://picsum.photos/seed/tint-guest/1200/1400',
        twitterCard: 'summary_large_image',
      };
    } else {
      meta = {
        title: 'Te invitaron a ver algo juntos — TINT',
        ogTitle: 'Te invitaron a ver algo juntos — TINT',
        description: 'Elige un nick y entra como participante. Sin cuenta, sin fricción.',
        ogDescription: 'Elige un nick y entra como participante. Sin cuenta, sin fricción.',
        ogType: 'website',
        ogUrl: `${origin}/invite/${code}`,
        ogImage: 'https://picsum.photos/seed/tint-guest/1200/1400',
        twitterCard: 'summary_large_image',
      };
    }
  } else {
    // Rutas protegidas o SPA regulares
    meta = {
      title: 'TINT — Watch Party',
      description: 'Salas sincronizadas para ver streaming juntos.',
      ogTitle: 'TINT — Watch Party',
      ogDescription: 'Salas sincronizadas para ver streaming juntos.',
      ogType: 'website',
      ogUrl: `${origin}${cleanUrl}`,
      ogImage: 'https://picsum.photos/seed/tint-cinema/1200/1400',
      twitterCard: 'summary_large_image',
    };
  }

  // 2. Pre-renderizado de componentes a cadena HTML (AC1)
  const appHtml = renderToString(<App location={locationForApp} initialData={initialData} />);

  // 3. Generación e inyección en plantilla
  const metaTags = generateMetaTags(meta);
  const templateHtml = options?.templateHtml || DEFAULT_HTML_TEMPLATE;
  const html = injectIntoTemplate(templateHtml, appHtml, metaTags, initialData);

  return {
    html,
    appHtml,
    meta,
    statusCode: 200,
    initialData,
  };
}
