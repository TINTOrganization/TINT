import { renderToString } from 'react-dom/server';
import App, { type AppInitialData } from './App';
import { fetchInviteRoomDetails, parseInviteCode } from './lib/invite';
import { fetchDashboardData, type DashboardRoom } from './lib/dashboard';

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
  token?: string | null;
  userRole?: string | null;
  isHost?: boolean;
  initialData?: AppInitialData | null;
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

    let roomTitle: string | null = options?.roomTitle ?? null;
    let hostName: string | null = null;
    let scheduledStartTime: string | null = null;
    let roomId: string | null = null;
    let valid = true;

    if (roomTitle === null && options?.roomTitle === undefined) {
      const details = await fetchInviteRoomDetails(code, {
        apiUrl: options?.apiUrl,
        fetcher: options?.fetcher,
        timeoutMs: options?.timeoutMs,
      });
      roomTitle = details.roomTitle;
      roomId = details.roomId;
      hostName = details.hostName;
      scheduledStartTime = details.scheduledStartTime;
      valid = details.valid;
    }

    initialData = { code, roomTitle, hostName, scheduledStartTime, roomId, valid };

    if (!valid) {
      meta = {
        title: 'Invitación no válida — TINT',
        ogTitle: 'Invitación no válida — TINT',
        description: 'Esta invitación no es válida, ha expirado o fue revocada por el host.',
        ogDescription: 'Esta invitación no es válida, ha expirado o fue revocada por el host.',
        ogType: 'website',
        ogUrl: `${origin}/invite/${code}`,
        ogImage: 'https://picsum.photos/seed/tint-guest/1200/1400',
        twitterCard: 'summary_large_image',
      };

      const appHtml = renderToString(<App location={locationForApp} initialData={initialData} />);
      const metaTags = generateMetaTags(meta);
      const templateHtml = options?.templateHtml || DEFAULT_HTML_TEMPLATE;
      const html = injectIntoTemplate(templateHtml, appHtml, metaTags, initialData);

      return {
        html,
        appHtml,
        meta,
        statusCode: 404,
        initialData,
      };
    }

    if (roomTitle) {
      meta = {
        title: `${roomTitle} — TINT`,
        ogTitle: `Te invitaron a ${roomTitle} — TINT`,
        description: hostName
          ? `Te invitaron a la sala de ${hostName} en TINT. Únete a la sala.`
          : 'Te invitaron a ver algo juntos en TINT. Elige un nick y entra a la sala.',
        ogDescription: hostName
          ? `Te invitaron a la sala de ${hostName} en TINT. Únete a la sala.`
          : 'Te invitaron a ver algo juntos en TINT. Elige un nick y entra a la sala.',
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
  } else if (cleanUrl === '/dashboard') {
    locationForApp = '/dashboard';
    meta = {
      title: 'Mis salas — TINT',
      description: 'Gestiona tus salas de watch party y eventos programados.',
      ogTitle: 'Mis salas — TINT',
      ogDescription: 'Gestiona tus salas de watch party y eventos programados.',
      ogType: 'website',
      ogUrl: `${origin}/dashboard`,
      ogImage: 'https://picsum.photos/seed/tint-cinema/1200/1400',
      twitterCard: 'summary_large_image',
    };

    let rooms: DashboardRoom[] | null = (options?.initialData?.rooms as DashboardRoom[]) ?? null;
    let isHost = options?.isHost ?? (options?.initialData?.isHost as boolean | undefined);
    let role = options?.userRole ?? (options?.initialData?.role as string | undefined);
    let error: string | null = (options?.initialData?.error as string) ?? null;

    if (rooms === null && error === null) {
      const dashboardResult = await fetchDashboardData({
        apiUrl: options?.apiUrl,
        fetcher: options?.fetcher,
        timeoutMs: options?.timeoutMs,
        token: options?.token,
        isHost,
        role,
      });

      rooms = dashboardResult.rooms;
      isHost = dashboardResult.isHost;
      role = dashboardResult.role;
      error = dashboardResult.error;
    }

    initialData = {
      rooms,
      isHost,
      role,
      error,
      isAuthenticated: true,
      token: options?.token,
    };

    const appHtml = renderToString(<App location={locationForApp} initialData={initialData} />);
    const metaTags = generateMetaTags(meta);
    const templateHtml = options?.templateHtml || DEFAULT_HTML_TEMPLATE;
    const html = injectIntoTemplate(templateHtml, appHtml, metaTags, initialData);

    return {
      html,
      appHtml,
      meta,
      statusCode: error ? 503 : 200,
      initialData,
    };
  } else if (cleanUrl.startsWith('/watch/')) {
    const rawRoomId = cleanUrl.replace(/^\/watch\//, '').split('/')[0].split('?')[0];
    const roomId = decodeURIComponent(rawRoomId);
    locationForApp = `/watch/${roomId}`;

    let roomTitle: string | null = options?.roomTitle ?? (options?.initialData?.roomTitle as string | undefined) ?? null;
    let hostName: string | null = (options?.initialData?.hostName as string | undefined) ?? null;

    if (!roomTitle && options?.apiUrl && options?.fetcher) {
      try {
        const timeoutMs = options.timeoutMs ?? 5000;
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        const headers: Record<string, string> = {};
        if (options.token) headers['Authorization'] = `Bearer ${options.token}`;
        const res = await options.fetcher(`${options.apiUrl}/rooms/${encodeURIComponent(roomId)}`, {
          signal: controller.signal,
          headers,
        });
        clearTimeout(timer);
        if (res.ok) {
          const data = (await res.json()) as { room?: { title?: string; hostName?: string } };
          roomTitle = data.room?.title ?? null;
          hostName = data.room?.hostName ?? null;
        }
      } catch {
        // Fallback silencioso
      }
    }

    initialData = {
      roomId,
      roomTitle,
      hostName,
      isHost: options?.isHost,
      role: options?.userRole ?? (options?.isHost ? 'host' : 'guest'),
      token: options?.token,
      isAuthenticated: !!options?.token,
    };

    const displayTitle = roomTitle ? `${roomTitle} — TINT` : `Sala ${roomId} — TINT`;
    meta = {
      title: displayTitle,
      description: hostName
        ? `Te invitaron a la sala de ${hostName} en TINT.`
        : 'Sala sincronizada para ver streaming juntos en TINT.',
      ogTitle: displayTitle,
      ogDescription: hostName
        ? `Te invitaron a la sala de ${hostName} en TINT.`
        : 'Sala sincronizada para ver streaming juntos en TINT.',
      ogType: 'video.other',
      ogUrl: `${origin}/watch/${roomId}`,
      ogImage: 'https://picsum.photos/seed/tint-cinema/1200/1400',
      twitterCard: 'summary_large_image',
    };
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
