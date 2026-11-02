import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { resolve, extname } from 'node:path';
import { render, DEFAULT_HTML_TEMPLATE } from './entry-server';

export interface ServerOptions {
  port?: number;
  host?: string;
  templateHtml?: string;
  fetcher?: typeof fetch | null;
  apiUrl?: string;
  publicDir?: string;
}

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
};

/**
 * Procesa peticiones entrantes: resuelve healthcheck, archivos estáticos
 * o renderizado SSR para landing e invitaciones.
 */
export async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  options?: ServerOptions,
): Promise<void> {
  const url = req.url || '/';
  const cleanPath = url.split('?')[0].split('#')[0] || '/';

  // 1. Health check
  if (cleanPath === '/healthz') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', service: 'web-ssr' }));
    return;
  }

  // 2. Archivos estáticos
  const ext = extname(cleanPath).toLowerCase();
  if (ext) {
    const publicDir = options?.publicDir || resolve(process.cwd(), 'apps/web/public');
    const localPublicDir = existsSync(publicDir) ? publicDir : resolve(__dirname, '../public');
    const targetFile = resolve(localPublicDir, cleanPath.replace(/^\//, ''));

    if (existsSync(targetFile)) {
      const mime = MIME_TYPES[ext] || 'application/octet-stream';
      const fileData = readFileSync(targetFile);
      res.writeHead(200, {
        'Content-Type': mime,
        'Cache-Control': 'public, max-age=3600',
      });
      res.end(fileData);
      return;
    }
  }

  // 3. Rutas de Server-Side Rendering (Landing, Invitaciones, etc.)
  try {
    let templateHtml = options?.templateHtml;
    if (!templateHtml) {
      const indexHtmlPath = resolve(process.cwd(), 'apps/web/index.html');
      const localIndexPath = existsSync(indexHtmlPath) ? indexHtmlPath : resolve(__dirname, '../index.html');
      if (existsSync(localIndexPath)) {
        templateHtml = readFileSync(localIndexPath, 'utf8');
      } else {
        templateHtml = DEFAULT_HTML_TEMPLATE;
      }
    }

    const host = req.headers.host || `localhost:${options?.port || 5173}`;
    const protocol = (req.headers['x-forwarded-proto'] as string) || 'http';
    const origin = `${protocol}://${host}`;

    const ssrResult = await render(url, {
      templateHtml,
      origin,
      apiUrl: options?.apiUrl,
      fetcher: options?.fetcher,
    });

    res.writeHead(ssrResult.statusCode, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': cleanPath === '/login' || cleanPath === '/' ? 'public, max-age=60' : 'no-cache',
    });
    res.end(ssrResult.html);
  } catch (err) {
    console.error('[SSR Error]', err);
    res.writeHead(500, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end('<!DOCTYPE html><html><body><h1>Internal Server Error</h1></body></html>');
  }
}

/**
 * Crea la instancia del servidor HTTP Node con soporte para SSR e hidratación.
 */
export function createAppServer(options?: ServerOptions): Server {
  return createServer((req, res) => {
    void handleRequest(req, res, options);
  });
}

/**
 * Inicia el servidor HTTP Node.
 */
export function startServer(options?: ServerOptions): Server {
  const port = options?.port || Number(process.env.PORT) || 5173;
  const host = options?.host || process.env.HOST || '0.0.0.0';
  const server = createAppServer(options);

  server.listen(port, host, () => {
    console.log(`[TINT SSR] Servidor iniciado en http://${host}:${port}`);
  });

  return server;
}
