import { renderToString } from 'react-dom/server';
import App from './App';
import {
  generateMetaTags,
  getLandingMetaTags,
  getInviteMetaTags,
  injectHeadMeta,
  type MetaTagOptions,
} from './lib/metaTags';
import { fetchRoomDetails, type RoomDetails } from './lib/serverInvite';
import {
  fetchDashboardData,
  type DashboardData,
  type FetchDashboardOptions,
} from './lib/serverDashboard';

export interface RenderOptions {
  roomTitle?: string | null;
  fetchRoomDetails?: (code: string) => Promise<RoomDetails | null>;
  apiBaseUrl?: string;
  authToken?: string | null;
  userRole?: 'host' | 'participant';
  dashboardData?: DashboardData | null;
  fetchDashboardData?: (
    token?: string,
    options?: FetchDashboardOptions,
  ) => Promise<DashboardData>;
  timeoutMs?: number;
}

export interface PageRenderResult {
  appHtml: string;
  metaTags: string;
  title: string;
  headHtml: string;
  roomDetails: RoomDetails | null;
  dashboardData: DashboardData | null;
  isSsrRoute: boolean;
}

export interface HtmlPageResult {
  html: string;
  statusCode: number;
  roomDetails: RoomDetails | null;
  dashboardData?: DashboardData | null;
}

const INVITE_ROUTE_REGEX = /^\/invite\/([^/?#]+)/i;
const WATCH_ROUTE_REGEX = /^\/watch\/([^/?#]+)/i;

/**
 * Determina si una ruta debe procesarse con SSR o delegarse a renderizado en cliente (CSR).
 * Se habilita SSR para la landing page ('/' y '/login'), páginas de invitación ('/invite/:code')
 * y el panel principal del host ('/dashboard').
 * Las páginas de streaming interactivo ('/watch/*', '/live/*') y secundarias se reservan para el cliente
 * para no interferir con WebSockets ni flujos de WebRTC concurrentes.
 */
export function isSsrRoute(url: string): boolean {
  const pathname = url.split('?')[0].split('#')[0];
  if (pathname === '/' || pathname === '/login' || pathname === '/dashboard') return true;
  if (INVITE_ROUTE_REGEX.test(pathname)) return true;
  if (WATCH_ROUTE_REGEX.test(pathname)) return true;
  return false;
}

/**
 * Renderiza síncronamente el componente React principal a string HTML usando StaticRouter.
 */
export function renderApp(
  url: string,
  roomDetails?: RoomDetails | null,
  isInvalid?: boolean,
  dashboardData?: DashboardData | null,
): string {
  const effectiveUrl = url === '/' ? '/login' : url;
  return renderToString(
    <App
      url={effectiveUrl}
      roomDetails={roomDetails}
      isInvalid={isInvalid}
      dashboardData={dashboardData}
    />,
  );
}

/**
 * Procesa la ruta, recopila metadatos (consultando identity-api si es invitación o dashboard)
 * y genera el HTML inicial y las etiquetas de cabecera.
 */
export async function renderPage(url: string, options?: RenderOptions): Promise<PageRenderResult> {
  const pathname = url.split('?')[0].split('#')[0];
  const ssrActive = isSsrRoute(url);

  if (!ssrActive) {
    const defaultMeta = getLandingMetaTags();
    const metaTags = generateMetaTags(defaultMeta);
    return {
      appHtml: '',
      metaTags,
      title: defaultMeta.title,
      headHtml: metaTags,
      roomDetails: null,
      dashboardData: null,
      isSsrRoute: false,
    };
  }

  // Dashboard de host y participantes: /dashboard
  if (pathname === '/dashboard') {
    let dashboardData: DashboardData | null = null;
    if (options?.dashboardData !== undefined) {
      dashboardData = options.dashboardData;
    } else if (options?.fetchDashboardData || options?.authToken) {
      const fetchFn = options?.fetchDashboardData ?? fetchDashboardData;
      dashboardData = await fetchFn(options?.authToken ?? undefined, {
        apiBaseUrl: options?.apiBaseUrl,
        role: options?.userRole,
        timeoutMs: options?.timeoutMs,
      });
    }

    const title = 'Mis salas — TINT';
    const metaOptions: MetaTagOptions = {
      title,
      description: 'Gestiona tus salas de reproducción y eventos en vivo en TINT.',
    };
    const metaTags = generateMetaTags(metaOptions);
    const appHtml = renderApp(url, null, false, dashboardData);

    return {
      appHtml,
      metaTags,
      title,
      headHtml: metaTags,
      roomDetails: null,
      dashboardData,
      isSsrRoute: true,
    };
  }

  // Ruta de invitación: /invite/:code
  const inviteMatch = pathname.match(INVITE_ROUTE_REGEX);
  if (inviteMatch) {
    const code = decodeURIComponent(inviteMatch[1]);
    let roomDetails: RoomDetails | null = null;

    if (options?.roomTitle !== undefined) {
      roomDetails = {
        code,
        roomId: '',
        roomTitle: options.roomTitle,
      };
    } else {
      try {
        const fetchFn = options?.fetchRoomDetails ?? fetchRoomDetails;
        roomDetails = await fetchFn(code, { apiBaseUrl: options?.apiBaseUrl });
      } catch {
        roomDetails = null;
      }
    }

    const metaOptions: MetaTagOptions = getInviteMetaTags(code, roomDetails?.roomTitle);
    const metaTags = generateMetaTags(metaOptions);
    const isInvalid = !roomDetails;
    const appHtml = renderApp(url, roomDetails, isInvalid);

    return {
      appHtml,
      metaTags,
      title: metaOptions.title,
      headHtml: metaTags,
      roomDetails,
      dashboardData: null,
      isSsrRoute: true,
    };
  }

  // Sala de visualización: /watch/:roomId (AC1)
  const watchMatch = pathname.match(WATCH_ROUTE_REGEX);
  if (watchMatch) {
    const roomId = decodeURIComponent(watchMatch[1]);
    const title = options?.roomTitle ? `${options.roomTitle} — TINT` : `Sala ${roomId} — TINT`;
    const metaOptions: MetaTagOptions = {
      title,
      description: 'Disfruta de streaming sincronizado, chat en vivo y reacciones en tiempo real en TINT.',
    };
    const metaTags = generateMetaTags(metaOptions);
    const appHtml = renderApp(url);

    return {
      appHtml,
      metaTags,
      title,
      headHtml: metaTags,
      roomDetails: null,
      dashboardData: null,
      isSsrRoute: true,
    };
  }

  // Landing page: / o /login
  const landingMeta = getLandingMetaTags();
  const metaTags = generateMetaTags(landingMeta);
  const appHtml = renderApp(url);

  return {
    appHtml,
    metaTags,
    title: landingMeta.title,
    headHtml: metaTags,
    roomDetails: null,
    dashboardData: null,
    isSsrRoute: true,
  };
}

/**
 * Inyecta el contenido pre-renderizado y los metadatos en la plantilla HTML de Vite.
 */
export async function renderHtmlPage(
  templateHtml: string,
  url: string,
  options?: RenderOptions,
): Promise<HtmlPageResult> {
  const { appHtml, metaTags, title, roomDetails, dashboardData } = await renderPage(url, options);

  let html = injectHeadMeta(templateHtml, metaTags, title);

  if (html.includes('<!--ssr-outlet-->')) {
    html = html.replace('<!--ssr-outlet-->', appHtml);
  } else if (/<div id="root">[\s\S]*?<\/div>/i.test(html)) {
    html = html.replace(/<div id="root">[\s\S]*?<\/div>/i, `<div id="root">${appHtml}</div>`);
  }

  // Serializar estado de hidratación del dashboard de forma limpia y segura (AC1)
  if (dashboardData) {
    const serialized = JSON.stringify(dashboardData).replace(/</g, '\\u003c');
    const scriptTag = `<script id="__TINT_DASHBOARD_DATA__" type="application/json">${serialized}</script>`;
    if (html.includes('</body>')) {
      html = html.replace('</body>', `${scriptTag}</body>`);
    } else {
      html += scriptTag;
    }
  }

  // Inyectar script de captura temprana para resiliencia pre-hidratación (AC2)
  if (WATCH_ROUTE_REGEX.test(url.split('?')[0].split('#')[0])) {
    const preHydrationScript = `<script id="__TINT_PRE_HYDRATION__">window.__TINT_PRE_HYDRATION_QUEUE__=window.__TINT_PRE_HYDRATION_QUEUE__||[];document.addEventListener('click',function(e){if(!window.__TINT_HYDRATED__){var t=e.target&&e.target.closest('button,[data-action],input[type="submit"],[role="button"]');if(t){e.preventDefault();e.stopPropagation();window.__TINT_PRE_HYDRATION_QUEUE__.push({type:e.type,action:t.getAttribute('data-action')||t.getAttribute('aria-label')||t.id||'',target:t,timeStamp:Date.now()});}}},true);</script>`;
    if (html.includes('</head>')) {
      html = html.replace('</head>', `${preHydrationScript}</head>`);
    } else {
      html = `${preHydrationScript}${html}`;
    }
  }

  const isInvite = INVITE_ROUTE_REGEX.test(url.split('?')[0].split('#')[0]);
  const statusCode = isInvite && !roomDetails ? 404 : 200;

  return {
    html,
    statusCode,
    roomDetails,
    dashboardData,
  };
}
