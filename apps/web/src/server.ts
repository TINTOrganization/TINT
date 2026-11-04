import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Duplex } from 'node:stream';
import { renderHtmlPage, isSsrRoute, type RenderOptions } from './entry-server';
import type { RoomDetails } from './lib/serverInvite';
import {
  extractAuthFromRequest,
  type DashboardData,
  type FetchDashboardOptions,
} from './lib/serverDashboard';

export interface StaticFileMock {
  content: string | Buffer;
  contentType: string;
}

export interface ProxyTargets {
  api?: string;
  sync?: string;
  social?: string;
  voice?: string;
  stream?: string;
  analytics?: string;
}

export interface RequestHandlerOptions {
  templateHtml?: string;
  distDir?: string;
  staticFiles?: Record<string, StaticFileMock>;
  fetchRoomDetails?: (code: string) => Promise<RoomDetails | null>;
  fetchDashboardData?: (token?: string, options?: FetchDashboardOptions) => Promise<DashboardData>;
  apiBaseUrl?: string;
  proxyTargets?: ProxyTargets;
}

export const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
};

const ANALYTICS_REGEX = /^\/api\/v1\/rooms\/[^/]+\/(kpis|reactions\/heatmap|timeline)/;
const STREAM_REGEX = /^\/api\/v1\/stream(\/|$)/;
const VOICE_REGEX = /^\/api\/v1\/voice(\/|$)/;
const SOCIAL_REGEX = /^\/api\/v1\/social(\/|$)/;

/**
 * Resuelve las direcciones de destino para proxy inverso de API y WebSockets.
 */
export function resolveProxyTargets(custom?: ProxyTargets): Required<ProxyTargets> {
  const env = process.env;
  return {
    api: custom?.api ?? env.API_PROXY_TARGET ?? env.VITE_PROXY_API_TARGET ?? 'http://localhost:8081',
    sync: custom?.sync ?? env.SYNC_PROXY_TARGET ?? 'ws://localhost:8083',
    social: custom?.social ?? env.SOCIAL_PROXY_TARGET ?? 'ws://localhost:8082',
    voice: custom?.voice ?? env.VOICE_PROXY_TARGET ?? 'ws://localhost:8085',
    stream: custom?.stream ?? env.STREAM_PROXY_TARGET ?? 'http://localhost:8086',
    analytics: custom?.analytics ?? env.ANALYTICS_PROXY_TARGET ?? 'http://localhost:8084',
  };
}

/**
 * Determina el target del backend según la ruta solicitada.
 */
export function getHttpProxyTarget(pathname: string, targets: Required<ProxyTargets>): string {
  if (ANALYTICS_REGEX.test(pathname) && targets.analytics) {
    return targets.analytics;
  }
  if (STREAM_REGEX.test(pathname) && targets.stream) {
    return targets.stream;
  }
  if (VOICE_REGEX.test(pathname) && targets.voice) {
    return targets.voice;
  }
  if (SOCIAL_REGEX.test(pathname) && targets.social) {
    return targets.social;
  }
  return targets.api;
}

/**
 * Reenvía una petición HTTP a un microservicio backend preservando método, cuerpo y cabeceras.
 */
export function proxyHttpRequest(
  req: IncomingMessage,
  res: ServerResponse,
  targetUrlStr: string,
): void {
  const parsedTarget = new URL(targetUrlStr);
  const isHttps = parsedTarget.protocol === 'https:';
  const transport = isHttps ? https : http;

  const targetPath = parsedTarget.pathname.replace(/\/$/, '') + (req.url || '');

  // Filtrar cabeceras hop-by-hop
  const headers = { ...req.headers };
  delete headers['connection'];
  delete headers['keep-alive'];
  delete headers['transfer-encoding'];
  headers.host = parsedTarget.host;

  const clientIp = req.socket?.remoteAddress;
  if (clientIp) {
    const existingXff = req.headers['x-forwarded-for'];
    headers['x-forwarded-for'] = existingXff ? `${existingXff}, ${clientIp}` : clientIp;
  }
  headers['x-forwarded-proto'] = isHttps ? 'https' : 'http';
  headers['x-forwarded-host'] = req.headers.host || '';

  const proxyReq = transport.request(
    {
      hostname: parsedTarget.hostname,
      port: parsedTarget.port || (isHttps ? 443 : 80),
      path: targetPath,
      method: req.method,
      headers,
    },
    (proxyRes) => {
      res.statusCode = proxyRes.statusCode || 500;
      res.writeHead(res.statusCode, proxyRes.headers);
      proxyRes.pipe(res);
    },
  );

  proxyReq.on('error', (err) => {
    if (!res.headersSent) {
      res.statusCode = 502;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.end(JSON.stringify({ error: 'bad_gateway', message: err.message }));
    }
  });

  req.on('aborted', () => {
    proxyReq.destroy();
  });

  req.pipe(proxyReq);
}

/**
 * Genera el manejador del evento `upgrade` para proxy de WebSockets (/ws/*).
 */
export function createWebSocketProxyHandler(targets: Required<ProxyTargets>) {
  return function handleUpgrade(req: IncomingMessage, clientSocket: Duplex, head: Buffer): void {
    const rawUrl = req.url || '';
    const pathname = rawUrl.split('?')[0].split('#')[0];

    let targetWsUrl: string | undefined;
    if (pathname === '/ws/sync' || pathname.startsWith('/ws/sync/')) {
      targetWsUrl = targets.sync;
    } else if (pathname === '/ws/social' || pathname.startsWith('/ws/social/')) {
      targetWsUrl = targets.social;
    } else if (pathname === '/ws/voice' || pathname.startsWith('/ws/voice/')) {
      targetWsUrl = targets.voice;
    }

    if (!targetWsUrl) {
      clientSocket.destroy();
      return;
    }

    const parsed = new URL(targetWsUrl.replace(/^ws:/, 'http:').replace(/^wss:/, 'https:'));
    const isWss = targetWsUrl.startsWith('wss:');
    const transport = isWss ? https : http;

    const proxyReq = transport.request({
      hostname: parsed.hostname,
      port: parsed.port || (isWss ? 443 : 80),
      path: req.url,
      method: 'GET',
      headers: {
        ...req.headers,
        host: parsed.host,
      },
    });

    proxyReq.on('upgrade', (proxyRes, targetSocket, proxyHead) => {
      const responseHeaders = [
        'HTTP/1.1 101 Switching Protocols',
        ...Object.entries(proxyRes.headers).map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(', ') : v}`),
      ];
      clientSocket.write(responseHeaders.join('\r\n') + '\r\n\r\n');
      if (proxyHead && proxyHead.length) clientSocket.write(proxyHead);
      if (head && head.length) targetSocket.write(head);

      targetSocket.pipe(clientSocket);
      clientSocket.pipe(targetSocket);

      clientSocket.on('error', () => targetSocket.destroy());
      targetSocket.on('error', () => clientSocket.destroy());
    });

    proxyReq.on('error', () => {
      clientSocket.destroy();
    });

    proxyReq.end();
  };
}

/**
 * Determina si una ruta corresponde a un archivo o recurso estático y no a una ruta de aplicación.
 */
export function isStaticAssetPath(pathname: string): boolean {
  if (pathname === '/assets' || pathname.startsWith('/assets/')) {
    return true;
  }
  const ext = path.extname(pathname).toLowerCase();
  if (!ext || ext === '.html') {
    return false;
  }
  return ext in MIME_TYPES;
}

/**
 * Resuelve de forma robusta e independiente del CWD la carpeta de salida `dist/`.
 * Funciona tanto al ejecutarse desde la raíz del monorepo como desde `apps/web`.
 */
export function resolveDistDir(customDir?: string): string | undefined {
  if (customDir !== undefined) {
    if (customDir && fs.existsSync(customDir)) {
      try {
        if (fs.statSync(customDir).isDirectory()) {
          return path.resolve(customDir);
        }
      } catch {
        return undefined;
      }
    }
    return undefined;
  }

  if (process.env.DIST_DIR) {
    if (fs.existsSync(process.env.DIST_DIR)) {
      try {
        if (fs.statSync(process.env.DIST_DIR).isDirectory()) {
          return path.resolve(process.env.DIST_DIR);
        }
      } catch {
        return undefined;
      }
    }
    return undefined;
  }

  const currentFileDir = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.resolve(currentFileDir, '../dist'),
    path.resolve(process.cwd(), 'apps/web/dist'),
    path.resolve(process.cwd(), 'dist'),
  ];

  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate) && fs.statSync(candidate).isDirectory()) {
        return candidate;
      }
    } catch {
      // Ignorar errores de acceso
    }
  }

  return undefined;
}

/**
 * Obtiene la plantilla HTML base. Prioriza `dist/index.html` compilado para conservar
 * los enlaces a CSS (<link rel="stylesheet">) y el script del cliente con hash.
 */
export function getTemplateHtml(distDir?: string): string {
  const resolved = resolveDistDir(distDir);
  if (resolved) {
    const indexPath = path.join(resolved, 'index.html');
    if (fs.existsSync(indexPath)) {
      return fs.readFileSync(indexPath, 'utf-8');
    }
  }

  // Fallbacks para desarrollo o pruebas sin build
  const currentFileDir = path.dirname(fileURLToPath(import.meta.url));
  const candidateIndexFiles = [
    path.resolve(process.cwd(), 'apps/web/index.html'),
    path.resolve(process.cwd(), 'index.html'),
    path.resolve(currentFileDir, '../index.html'),
  ];

  for (const candidate of candidateIndexFiles) {
    if (fs.existsSync(candidate)) {
      return fs.readFileSync(candidate, 'utf-8');
    }
  }

  return `<!doctype html><html><head><meta charset="utf-8"/><title>TINT — Watch Party</title><!--ssr-head--></head><body class="bg-tint-bg"><div id="root"><!--ssr-outlet--></div><script type="module" src="/src/main.tsx"></script></body></html>`;
}

/**
 * Limpia los marcadores de SSR para las rutas del cliente (SPA fallback).
 */
export function cleanTemplate(html: string): string {
  return html.replace('<!--ssr-outlet-->', '').replace('<!--ssr-head-->', '');
}

/**
 * Crea el manejador de peticiones HTTP para SSR y contenido estático de TINT.
 */
export function createRequestHandler(options: RequestHandlerOptions = {}) {
  const distDir = resolveDistDir(options.distDir);
  const templateHtml = options.templateHtml ?? getTemplateHtml(distDir);
  const proxyTargets = resolveProxyTargets(options.proxyTargets);

  return async function requestHandler(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const rawUrl = req.url || '/';
    const method = req.method?.toUpperCase() || 'GET';
    const urlObj = new URL(rawUrl, 'http://localhost');
    const pathname = urlObj.pathname;

    // 1. Health check del contenedor (ADR 0021)
    if (pathname === '/healthz') {
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ status: 'ok', service: 'web' }));
      return;
    }

    // 2. Proxy inverso de API (/api/*): admite POST, GET, PUT, DELETE, PATCH, OPTIONS, etc.
    if (pathname === '/api' || pathname.startsWith('/api/')) {
      const target = getHttpProxyTarget(pathname, proxyTargets);
      proxyHttpRequest(req, res, target);
      return;
    }

    // 3. Para rutas estáticas y SSR, solo admitimos GET y HEAD
    if (method !== 'GET' && method !== 'HEAD') {
      res.statusCode = 405;
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.end('Method Not Allowed');
      return;
    }

    // 4. Archivos estáticos en memoria (tests o pre-cargados)
    if (options.staticFiles && options.staticFiles[pathname]) {
      const file = options.staticFiles[pathname];
      res.statusCode = 200;
      res.setHeader('Content-Type', file.contentType);
      if (pathname.startsWith('/assets/')) {
        res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
      } else {
        res.setHeader('Cache-Control', 'public, max-age=3600');
      }
      res.end(method === 'HEAD' ? undefined : file.content);
      return;
    }

    // 5. Archivos estáticos en disco (en producción bajo distDir)
    if (distDir && pathname !== '/' && pathname !== '/index.html') {
      let decodedUrl: string;
      try {
        decodedUrl = decodeURIComponent(rawUrl.split('?')[0].split('#')[0]);
      } catch {
        decodedUrl = pathname;
      }

      // Prevenir directory traversal si se detecta '..' en la URL o ruta
      if (decodedUrl.includes('..') || pathname.includes('..')) {
        res.statusCode = 403;
        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
        res.end('Forbidden');
        return;
      }

      const filePath = path.join(distDir, pathname);
      const relative = path.relative(distDir, filePath);
      const isInsideDist = !relative.startsWith('..') && !path.isAbsolute(relative);

      if (!isInsideDist) {
        res.statusCode = 403;
        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
        res.end('Forbidden');
        return;
      }

      if (fs.existsSync(filePath)) {
        let stat: fs.Stats;
        try {
          stat = fs.statSync(filePath);
        } catch {
          stat = undefined as unknown as fs.Stats;
        }

        if (stat && stat.isFile()) {
          const ext = path.extname(filePath).toLowerCase();
          const contentType = MIME_TYPES[ext] || 'application/octet-stream';
          res.statusCode = 200;
          res.setHeader('Content-Type', contentType);
          if (pathname.startsWith('/assets/')) {
            res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
          } else {
            res.setHeader('Cache-Control', 'public, max-age=3600');
          }
          if (method === 'HEAD') {
            res.end();
            return;
          }
          const stream = fs.createReadStream(filePath);
          stream.on('error', () => {
            if (!res.headersSent) {
              res.statusCode = 500;
              res.setHeader('Content-Type', 'text/plain; charset=utf-8');
              res.end('Internal Server Error');
            }
          });
          stream.pipe(res);
          return;
        }
      }
    }

    // 6. Si la ruta solicitada es un archivo estático y no existe en disco/memoria,
    // responder 404 de inmediato para NO caer en el fallback HTML de SPA.
    if (isStaticAssetPath(pathname)) {
      res.statusCode = 404;
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.end('Not Found');
      return;
    }

    // 7. Rutas con Server-Side Rendering (Landing y Room Invitations)
    if (isSsrRoute(pathname)) {
      try {
        const renderOpts: RenderOptions = {
          fetchRoomDetails: options.fetchRoomDetails,
          fetchDashboardData: options.fetchDashboardData,
          authToken: extractAuthFromRequest(req).token,
          userRole: extractAuthFromRequest(req).role,
          apiBaseUrl: options.apiBaseUrl,
        };
        const { html, statusCode } = await renderHtmlPage(templateHtml, rawUrl, renderOpts);
        res.statusCode = statusCode;
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.setHeader('Cache-Control', 'no-cache');
        res.end(method === 'HEAD' ? undefined : html);
        return;
      } catch (err) {
        console.error('[tint-web] Fallo inesperado en renderizado SSR para %s:', rawUrl, err);
        // Ante cualquier fallo inesperado de SSR, fallback al index.html del cliente
        res.statusCode = 200;
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.end(method === 'HEAD' ? undefined : cleanTemplate(templateHtml));
        return;
      }
    }

    // 8. Rutas de cliente (SPA fallback: /watch/:id, /live/:id, /dashboard, etc.)
    res.statusCode = 200;
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.end(method === 'HEAD' ? undefined : cleanTemplate(templateHtml));
  };
}

/**
 * Inicia el servidor HTTP de producción / desarrollo con soporte para SSR y proxy de WebSockets.
 */
export function startServer(
  port = Number(process.env.PORT || 80),
  distDir?: string,
  proxyTargets?: ProxyTargets,
): http.Server {
  const resolvedDist = resolveDistDir(distDir);
  const resolvedTargets = resolveProxyTargets(proxyTargets);
  const handler = createRequestHandler({
    distDir: resolvedDist,
    proxyTargets: resolvedTargets,
  });

  const server = http.createServer((req, res) => {
    void handler(req, res);
  });

  server.on('upgrade', createWebSocketProxyHandler(resolvedTargets));

  server.listen(port, () => {
    console.log(`[tint-web] Servidor SSR escuchando en http://0.0.0.0:${port}`);
  });

  return server;
}

// Ejecución directa si se invoca con `node dist-server/server.js` o `tsx src/server.ts`
/* v8 ignore next 3 */
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  startServer();
}
