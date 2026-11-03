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

export interface RenderOptions {
  roomTitle?: string | null;
  fetchRoomDetails?: (code: string) => Promise<RoomDetails | null>;
  apiBaseUrl?: string;
}

export interface PageRenderResult {
  appHtml: string;
  metaTags: string;
  title: string;
  headHtml: string;
  roomDetails: RoomDetails | null;
  isSsrRoute: boolean;
}

export interface HtmlPageResult {
  html: string;
  statusCode: number;
  roomDetails: RoomDetails | null;
}

const INVITE_ROUTE_REGEX = /^\/invite\/([^/?#]+)/i;

/**
 * Determina si una ruta debe procesarse con SSR o delegarse a renderizado en cliente (CSR).
 * Se habilita SSR para la landing page ('/' y '/login') y las páginas de invitación ('/invite/:code').
 * Las páginas de streaming interactivo ('/watch/*', '/live/*') y privadas se reservan para el cliente
 * para no interferir con WebSockets ni flujos de WebRTC concurrentes.
 */
export function isSsrRoute(url: string): boolean {
  const pathname = url.split('?')[0].split('#')[0];
  if (pathname === '/' || pathname === '/login') return true;
  if (INVITE_ROUTE_REGEX.test(pathname)) return true;
  return false;
}

/**
 * Renderiza síncronamente el componente React principal a string HTML usando StaticRouter.
 */
export function renderApp(url: string, roomDetails?: RoomDetails | null, isInvalid?: boolean): string {
  const effectiveUrl = url === '/' ? '/login' : url;
  return renderToString(<App url={effectiveUrl} roomDetails={roomDetails} isInvalid={isInvalid} />);
}

/**
 * Procesa la ruta, recopila metadatos (consultando identity-api si es invitación)
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
      isSsrRoute: false,
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
  const { appHtml, metaTags, title, roomDetails } = await renderPage(url, options);

  let html = injectHeadMeta(templateHtml, metaTags, title);

  if (html.includes('<!--ssr-outlet-->')) {
    html = html.replace('<!--ssr-outlet-->', appHtml);
  } else if (/<div id="root">[\s\S]*?<\/div>/i.test(html)) {
    html = html.replace(/<div id="root">[\s\S]*?<\/div>/i, `<div id="root">${appHtml}</div>`);
  }

  const isInvite = INVITE_ROUTE_REGEX.test(url.split('?')[0].split('#')[0]);
  const statusCode = isInvite && !roomDetails ? 404 : 200;

  return {
    html,
    statusCode,
    roomDetails,
  };
}
