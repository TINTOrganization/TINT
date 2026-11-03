import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import { EventEmitter } from 'node:events';
import { Readable, Writable, Duplex } from 'node:stream';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  createRequestHandler,
  resolveDistDir,
  isStaticAssetPath,
  getTemplateHtml,
  cleanTemplate,
  startServer,
  resolveProxyTargets,
  getHttpProxyTarget,
  createWebSocketProxyHandler,
} from './server';

function createMockReqRes(
  url: string,
  method = 'GET',
  bodyContent?: string,
  headers: Record<string, string> = {},
) {
  let isRead = false;
  const req = new Readable({
    read() {
      if (!isRead && bodyContent !== undefined) {
        isRead = true;
        this.push(Buffer.from(bodyContent));
        this.push(null);
      } else if (!isRead) {
        isRead = true;
        this.push(null);
      }
    },
  }) as unknown as IncomingMessage;

  let statusCode = 200;
  const resHeaders: Record<string, string> = {};
  let body = '';

  const res = new Writable({
    write(chunk, _encoding, callback) {
      body += chunk.toString();
      callback();
    },
  }) as unknown as ServerResponse & {
    getBody: () => string;
    getHeaders: () => Record<string, string>;
    waitFinish: () => Promise<void>;
  };

  const finishPromise = new Promise<void>((resolve) => {
    res.once('finish', resolve);
  });

  Object.assign(req, {
    url,
    method,
    headers: { ...headers },
    socket: {
      remoteAddress: '127.0.0.1',
    },
  });

  Object.defineProperty(res, 'statusCode', {
    get() {
      return statusCode;
    },
    set(code: number) {
      statusCode = code;
    },
    configurable: true,
  });

  Object.assign(res, {
    setHeader: vi.fn((key: string, value: string) => {
      resHeaders[key.toLowerCase()] = value;
    }),
    getHeader: vi.fn((key: string) => resHeaders[key.toLowerCase()]),
    writeHead: vi.fn((code: number, hdrs?: Record<string, string>) => {
      statusCode = code;
      if (hdrs) {
        for (const [k, v] of Object.entries(hdrs)) {
          resHeaders[k.toLowerCase()] = v;
        }
      }
    }),
    getBody: () => body,
    getHeaders: () => resHeaders,
    waitFinish: async () => {
      if (res.writableEnded) return;
      await finishPromise;
    },
  });

  return { req, res };
}

function createMockClientRequest(onFinish?: (body: string) => void) {
  let requestBody = '';
  const clientReq = new Writable({
    write(chunk, _encoding, callback) {
      requestBody += chunk.toString();
      callback();
    },
    final(callback) {
      if (onFinish) onFinish(requestBody);
      callback();
    },
  }) as unknown as http.ClientRequest;

  Object.assign(clientReq, {
    abort: vi.fn(),
    destroy: vi.fn(),
  });

  return { clientReq, getRequestBody: () => requestBody };
}

function createMockProxyResponse(statusCode: number, headers: Record<string, string>, body = '') {
  let isPushed = false;
  const proxyRes = new Readable({
    read() {
      if (!isPushed) {
        isPushed = true;
        if (body) this.push(Buffer.from(body));
        this.push(null);
      }
    },
  }) as unknown as http.IncomingMessage;

  Object.assign(proxyRes, {
    statusCode,
    headers,
  });

  return proxyRes;
}

const mockTemplate = `<!doctype html>
<html>
  <head>
    <title>TINT — Watch Party</title>
    <!--ssr-head-->
    <link rel="stylesheet" crossorigin href="/assets/index-Bk5t10yA.css">
    <script type="module" crossorigin src="/assets/index-IjWPezpJ.js"></script>
  </head>
  <body>
    <div id="root"><!--ssr-outlet--></div>
  </body>
</html>`;

describe('server - createRequestHandler', () => {
  let mockFetchRoom: ReturnType<typeof vi.fn>;
  let tempDir: string | null = null;

  beforeEach(() => {
    mockFetchRoom = vi.fn().mockResolvedValue({
      code: 'VIP777',
      roomId: 'room-1',
      roomTitle: 'Película de Gala',
      roomKind: 'watch',
    });
  });

  afterEach(() => {
    if (tempDir && fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
      tempDir = null;
    }
  });

  it('responde 200 con JSON en /healthz (ADR 0021)', async () => {
    const handler = createRequestHandler({
      templateHtml: mockTemplate,
      distDir: '',
    });
    const { req, res } = createMockReqRes('/healthz');

    await handler(req, res);

    expect(res.statusCode).toBe(200);
    expect(res.getHeader('content-type')).toContain('application/json');
    expect(JSON.parse(res.getBody())).toEqual({ status: 'ok', service: 'web' });
  });

  it('devuelve HTML pre-renderizado para la landing page / preservando estilos y scripts (AC1 & AC3)', async () => {
    const handler = createRequestHandler({
      templateHtml: mockTemplate,
      distDir: '',
    });
    const { req, res } = createMockReqRes('/');

    await handler(req, res);

    expect(res.statusCode).toBe(200);
    expect(res.getHeader('content-type')).toContain('text/html');
    const body = res.getBody();
    expect(body).toContain('Mira junto, siente al mismo tiempo');
    expect(body).toContain('<title>TINT — Watch Party</title>');
    expect(body).toContain('<meta property="og:title" content="TINT — Watch Party" />');
    expect(body).toContain('<link rel="stylesheet" crossorigin href="/assets/index-Bk5t10yA.css">');
    expect(body).toContain('<script type="module" crossorigin src="/assets/index-IjWPezpJ.js"></script>');
  });

  it('devuelve HTML pre-renderizado para /login (AC1)', async () => {
    const handler = createRequestHandler({
      templateHtml: mockTemplate,
      distDir: '',
    });
    const { req, res } = createMockReqRes('/login');

    await handler(req, res);

    expect(res.statusCode).toBe(200);
    expect(res.getHeader('content-type')).toContain('text/html');
    const body = res.getBody();
    expect(body).toContain('Iniciar sesión con Google');
    expect(body).toContain('Bienvenido de nuevo');
    expect(body).toContain('/assets/index-Bk5t10yA.css');
  });

  it('devuelve HTML pre-renderizado y dynamic meta tags con el título de la sala para /invite/:code (AC1 & AC2)', async () => {
    const handler = createRequestHandler({
      templateHtml: mockTemplate,
      distDir: '',
      fetchRoomDetails: mockFetchRoom,
    });
    const { req, res } = createMockReqRes('/invite/VIP777');

    await handler(req, res);

    expect(res.statusCode).toBe(200);
    expect(res.getHeader('content-type')).toContain('text/html');
    const body = res.getBody();
    expect(body).toContain('VIP777');
    expect(body).toContain('Te invitaron a ver algo juntos');
    expect(body).toContain('<title>Película de Gala — TINT</title>');
    expect(body).toContain('<meta property="og:title" content="Película de Gala — TINT" />');
    expect(body).toContain('Película de Gala');
    expect(body).toContain('/assets/index-Bk5t10yA.css');
    expect(mockFetchRoom).toHaveBeenCalledWith('VIP777', expect.anything());
  });

  it('devuelve la plantilla SPA para rutas de streaming sin romper los flujos cliente', async () => {
    const handler = createRequestHandler({
      templateHtml: mockTemplate,
      distDir: '',
    });
    const { req, res } = createMockReqRes('/watch/room-99');

    await handler(req, res);

    expect(res.statusCode).toBe(200);
    expect(res.getHeader('content-type')).toContain('text/html');
    const body = res.getBody();
    expect(body).toContain('<div id="root"></div>');
    expect(body).toContain('/assets/index-IjWPezpJ.js');
    expect(body).toContain('/assets/index-Bk5t10yA.css');
  });

  it('sirve archivos estáticos simulados cuando existen en staticFiles', async () => {
    const handler = createRequestHandler({
      templateHtml: mockTemplate,
      distDir: '',
      staticFiles: {
        '/favicon.svg': {
          content: '<svg></svg>',
          contentType: 'image/svg+xml',
        },
        '/assets/main.js': {
          content: 'console.log("tint");',
          contentType: 'application/javascript; charset=utf-8',
        },
      },
    });

    const { req, res } = createMockReqRes('/favicon.svg');
    await handler(req, res);

    expect(res.statusCode).toBe(200);
    expect(res.getHeader('content-type')).toBe('image/svg+xml');
    expect(res.getBody()).toBe('<svg></svg>');
  });

  it('devuelve 404 text/plain para recursos estáticos inexistentes (/assets/*, favicon, etc.) evitando el fallback SPA', async () => {
    const handler = createRequestHandler({
      templateHtml: mockTemplate,
      distDir: '',
    });

    const { req: req1, res: res1 } = createMockReqRes('/assets/nonexistent.css');
    await handler(req1, res1);
    expect(res1.statusCode).toBe(404);
    expect(res1.getHeader('content-type')).toBe('text/plain; charset=utf-8');
    expect(res1.getBody()).toBe('Not Found');

    const { req: req2, res: res2 } = createMockReqRes('/favicon.ico');
    await handler(req2, res2);
    expect(res2.statusCode).toBe(404);
    expect(res2.getHeader('content-type')).toBe('text/plain; charset=utf-8');
    expect(res2.getBody()).toBe('Not Found');
  });

  it('sirve archivos reales desde distDir con tipos MIME y Cache-Control adecuados', async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tint-dist-test-'));
    const assetsDir = path.join(tempDir, 'assets');
    fs.mkdirSync(assetsDir);

    const cssContent = 'body { background: #000; }';
    const jsContent = 'console.log("tint loaded");';
    const svgContent = '<svg><circle /></svg>';

    fs.writeFileSync(path.join(assetsDir, 'index-test.css'), cssContent);
    fs.writeFileSync(path.join(assetsDir, 'index-test.js'), jsContent);
    fs.writeFileSync(path.join(tempDir, 'favicon.svg'), svgContent);
    fs.writeFileSync(path.join(tempDir, 'index.html'), mockTemplate);

    const handler = createRequestHandler({
      distDir: tempDir,
    });

    const { req: reqCss, res: resCss } = createMockReqRes('/assets/index-test.css');
    await handler(reqCss, resCss);
    await resCss.waitFinish();
    expect(resCss.statusCode).toBe(200);
    expect(resCss.getHeader('content-type')).toBe('text/css; charset=utf-8');
    expect(resCss.getHeader('cache-control')).toBe('public, max-age=31536000, immutable');
    expect(resCss.getBody()).toBe(cssContent);

    const { req: reqJs, res: resJs } = createMockReqRes('/assets/index-test.js');
    await handler(reqJs, resJs);
    await resJs.waitFinish();
    expect(resJs.statusCode).toBe(200);
    expect(resJs.getHeader('content-type')).toBe('application/javascript; charset=utf-8');
    expect(resJs.getHeader('cache-control')).toBe('public, max-age=31536000, immutable');
    expect(resJs.getBody()).toBe(jsContent);

    const { req: reqSvg, res: resSvg } = createMockReqRes('/favicon.svg');
    await handler(reqSvg, resSvg);
    await resSvg.waitFinish();
    expect(resSvg.statusCode).toBe(200);
    expect(resSvg.getHeader('content-type')).toBe('image/svg+xml');
    expect(resSvg.getHeader('cache-control')).toBe('public, max-age=3600');
    expect(resSvg.getBody()).toBe(svgContent);

    const { req: reqHead, res: resHead } = createMockReqRes('/assets/index-test.js', 'HEAD');
    await handler(reqHead, resHead);
    expect(resHead.statusCode).toBe(200);
    expect(resHead.getHeader('content-type')).toBe('application/javascript; charset=utf-8');
    expect(resHead.getBody()).toBe('');
  });

  it('bloquea intentos de Directory Traversal en distDir devolviendo 403 Forbidden', async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tint-dist-test-'));
    const handler = createRequestHandler({
      distDir: tempDir,
    });

    const { req, res } = createMockReqRes('/../../package.json');
    await handler(req, res);

    expect(res.statusCode).toBe(403);
    expect(res.getBody()).toBe('Forbidden');
  });

  it('maneja métodos no soportados como POST en rutas no API', async () => {
    const handler = createRequestHandler({
      templateHtml: mockTemplate,
      distDir: '',
    });
    const { req, res } = createMockReqRes('/login', 'POST');

    await handler(req, res);

    expect(res.statusCode).toBe(405);
  });

  it('maneja peticiones HEAD para rutas SSR y SPA', async () => {
    const handler = createRequestHandler({
      templateHtml: mockTemplate,
      distDir: '',
    });
    const { req, res } = createMockReqRes('/', 'HEAD');

    await handler(req, res);

    expect(res.statusCode).toBe(200);
    expect(res.getHeader('content-type')).toContain('text/html');
    expect(res.getBody()).toBe('');
  });

  it('no sirve index.html como archivo estático crudo sino que aplica SSR o SPA', async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tint-index-html-test-'));
    fs.writeFileSync(path.join(tempDir, 'index.html'), mockTemplate);

    const handler = createRequestHandler({
      distDir: tempDir,
    });

    const { req, res } = createMockReqRes('/index.html');
    await handler(req, res);

    expect(res.statusCode).toBe(200);
    expect(res.getHeader('content-type')).toContain('text/html');
  });

  it('maneja URLs con codificación percent inválida sin caerse', async () => {
    const handler = createRequestHandler({
      templateHtml: mockTemplate,
      distDir: '',
    });
    const { req, res } = createMockReqRes('/%FF%FF');

    await handler(req, res);

    expect(res.statusCode).toBe(200);
  });

  it('responde 404 y renderiza error de invitación no válida cuando el fetch de sala falla o devuelve null (AC2)', async () => {
    mockFetchRoom.mockRejectedValue(new Error('Fallo crítico en backend'));
    const handler = createRequestHandler({
      templateHtml: mockTemplate,
      distDir: '',
      fetchRoomDetails: mockFetchRoom,
    });
    const { req, res } = createMockReqRes('/invite/FAIL123');

    await handler(req, res);

    expect(res.statusCode).toBe(404);
    expect(res.getHeader('content-type')).toContain('text/html');
    const body = res.getBody();
    expect(body).toContain('Invitación no válida');
  });

  it('responde 500 si el stream de lectura de archivo emite un error', async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tint-stream-err-'));
    const filePath = path.join(tempDir, 'error.txt');
    fs.writeFileSync(filePath, 'test');

    const handler = createRequestHandler({
      distDir: tempDir,
    });

    const mockStream = new EventEmitter() as unknown as fs.ReadStream;
    mockStream.pipe = vi.fn() as unknown as typeof mockStream.pipe;
    vi.spyOn(fs, 'createReadStream').mockReturnValueOnce(mockStream);

    const { req, res } = createMockReqRes('/error.txt');
    await handler(req, res);

    mockStream.emit('error', new Error('Disk read error'));

    expect(res.statusCode).toBe(500);
    expect(res.getBody()).toBe('Internal Server Error');
  });

  it('no sirve directorios como archivos sino que responde 404', async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tint-dir-test-'));
    fs.mkdirSync(path.join(tempDir, 'assets'));

    const handler = createRequestHandler({
      distDir: tempDir,
    });

    const { req, res } = createMockReqRes('/assets');
    await handler(req, res);

    expect(res.statusCode).toBe(404);
  });
});

describe('server - proxy inverso de API y WebSockets', () => {
  it('enruta correctamente getHttpProxyTarget según la ruta solicitada', () => {
    const targets = {
      api: 'http://localhost:8081',
      sync: 'ws://localhost:8083',
      social: 'ws://localhost:8082',
      voice: 'ws://localhost:8085',
      stream: 'http://localhost:8086',
      analytics: 'http://localhost:8084',
    };

    expect(getHttpProxyTarget('/api/v1/auth/verify', targets)).toBe('http://localhost:8081');
    expect(getHttpProxyTarget('/api/v1/rooms', targets)).toBe('http://localhost:8081');
    expect(getHttpProxyTarget('/api/v1/rooms/room-1/kpis', targets)).toBe('http://localhost:8084');
    expect(getHttpProxyTarget('/api/v1/rooms/room-1/reactions/heatmap', targets)).toBe('http://localhost:8084');
    expect(getHttpProxyTarget('/api/v1/rooms/room-1/timeline', targets)).toBe('http://localhost:8084');
    expect(getHttpProxyTarget('/api/v1/stream/session', targets)).toBe('http://localhost:8086');
    expect(getHttpProxyTarget('/api/v1/voice/rooms/r1/stage/u1', targets)).toBe('ws://localhost:8085');
    expect(getHttpProxyTarget('/api/v1/social/rooms/r1/chat', targets)).toBe('ws://localhost:8082');
  });

  it('hace proxy exitoso de POST /api/v1/auth/verify hacia el backend sin devolver 405', async () => {
    let capturedOptions: http.RequestOptions | undefined;
    const requestPayload = JSON.stringify({ idToken: 'firebase-mock-id-token' });
    const responsePayload = JSON.stringify({ user: { id: 'u1', sub: 'google-sub-123' }, isRegistered: true });

    const { clientReq } = createMockClientRequest((receivedBody) => {
      expect(receivedBody).toBe(requestPayload);
    });

    const requestSpy = vi.spyOn(http, 'request').mockImplementation((...args: unknown[]) => {
      capturedOptions = args[0] as http.RequestOptions;
      const callback = args[1] as ((res: http.IncomingMessage) => void) | undefined;
      const proxyRes = createMockProxyResponse(200, { 'content-type': 'application/json' }, responsePayload);
      if (callback) {
        setImmediate(() => {
          callback(proxyRes);
        });
      }
      return clientReq;
    });

    const handler = createRequestHandler({
      templateHtml: mockTemplate,
      distDir: '',
      proxyTargets: {
        api: 'http://127.0.0.1:8081',
      },
    });

    const { req, res } = createMockReqRes(
      '/api/v1/auth/verify',
      'POST',
      requestPayload,
      {
        authorization: 'Bearer firebase-mock-id-token',
        'content-type': 'application/json',
      },
    );

    await handler(req, res);
    await res.waitFinish();

    expect(res.statusCode).toBe(200);
    expect(res.getHeader('content-type')).toContain('application/json');
    const responseData = JSON.parse(res.getBody());
    expect(responseData).toEqual({
      user: { id: 'u1', sub: 'google-sub-123' },
      isRegistered: true,
    });

    // Validar opciones capturadas por http.request
    expect(capturedOptions?.method).toBe('POST');
    expect(capturedOptions?.path).toBe('/api/v1/auth/verify');
    expect((capturedOptions?.headers as Record<string, string>)?.authorization).toBe('Bearer firebase-mock-id-token');
    expect((capturedOptions?.headers as Record<string, string>)?.['x-forwarded-for']).toBe('127.0.0.1');
    expect((capturedOptions?.headers as Record<string, string>)?.['x-forwarded-proto']).toBe('http');

    requestSpy.mockRestore();
  });

  it('hace proxy de métodos PUT y DELETE sin rechazarlos con 405', async () => {
    let capturedMethod = '';
    let capturedPath = '';

    const { clientReq } = createMockClientRequest();
    const requestSpy = vi.spyOn(http, 'request').mockImplementation((...args: unknown[]) => {
      const options = args[0] as http.RequestOptions;
      capturedMethod = options.method || '';
      capturedPath = String(options.path || '');
      const callback = args[1] as ((res: http.IncomingMessage) => void) | undefined;
      const proxyRes = createMockProxyResponse(204, {});
      if (callback) {
        setImmediate(() => {
          callback(proxyRes);
        });
      }
      return clientReq;
    });

    const handler = createRequestHandler({
      templateHtml: mockTemplate,
      distDir: '',
      proxyTargets: {
        api: 'http://127.0.0.1:8081',
      },
    });

    const { req, res } = createMockReqRes('/api/v1/rooms/r1', 'DELETE');
    await handler(req, res);
    await res.waitFinish();

    expect(res.statusCode).toBe(204);
    expect(capturedMethod).toBe('DELETE');
    expect(capturedPath).toBe('/api/v1/rooms/r1');

    requestSpy.mockRestore();
  });

  it('responde 502 Bad Gateway si el microservicio de destino no está accesible', async () => {
    const { clientReq } = createMockClientRequest();
    const requestSpy = vi.spyOn(http, 'request').mockImplementation(() => {
      setImmediate(() => {
        clientReq.emit('error', new Error('connect ECONNREFUSED 127.0.0.1:39999'));
      });
      return clientReq;
    });

    const handler = createRequestHandler({
      templateHtml: mockTemplate,
      distDir: '',
      proxyTargets: {
        api: 'http://127.0.0.1:39999',
      },
    });

    const { req, res } = createMockReqRes('/api/v1/auth/verify', 'POST', '{}');
    await handler(req, res);
    await res.waitFinish();

    expect(res.statusCode).toBe(502);
    expect(res.getHeader('content-type')).toContain('application/json');
    const body = JSON.parse(res.getBody());
    expect(body.error).toBe('bad_gateway');
    expect(body.message).toContain('ECONNREFUSED');

    requestSpy.mockRestore();
  });

  it('maneja el evento upgrade para WebSockets hacia los canales correspondientes', async () => {
    const { clientReq } = createMockClientRequest();
    const requestSpy = vi.spyOn(http, 'request').mockImplementation(() => {
      setImmediate(() => {
        const mockTargetSocket = new Duplex({
          read() {},
          write(_chunk, _enc, cb) {
            cb();
          },
        });
        const mockProxyRes = { headers: { upgrade: 'websocket', connection: 'Upgrade' } };
        clientReq.emit('upgrade', mockProxyRes, mockTargetSocket, Buffer.alloc(0));
      });
      return clientReq;
    });

    const targets = resolveProxyTargets({
      sync: 'ws://127.0.0.1:8083',
      social: 'ws://127.0.0.1:8082',
      voice: 'ws://127.0.0.1:8085',
    });

    const upgradeHandler = createWebSocketProxyHandler(targets);

    let clientWritten = '';
    const clientSocket = new Duplex({
      read() {},
      write(chunk, _enc, cb) {
        clientWritten += chunk.toString();
        cb();
      },
    });

    const mockReq = {
      url: '/ws/sync',
      headers: {
        upgrade: 'websocket',
        connection: 'Upgrade',
      },
    } as unknown as IncomingMessage;

    upgradeHandler(mockReq, clientSocket, Buffer.alloc(0));

    await new Promise<void>((resolve) => {
      const check = setInterval(() => {
        if (clientWritten.includes('101 Switching Protocols')) {
          clearInterval(check);
          resolve();
        }
      }, 10);
    });

    expect(clientWritten).toContain('HTTP/1.1 101 Switching Protocols');
    requestSpy.mockRestore();
  });

  it('cierra sockets clientes ante rutas de upgrade no configuradas', () => {
    const targets = resolveProxyTargets();
    const upgradeHandler = createWebSocketProxyHandler(targets);

    const destroySpy = vi.fn();
    const clientSocket = {
      destroy: destroySpy,
    } as unknown as Duplex;

    const mockReq = {
      url: '/ws/desconocido',
      headers: {},
    } as unknown as IncomingMessage;

    upgradeHandler(mockReq, clientSocket, Buffer.alloc(0));
    expect(destroySpy).toHaveBeenCalled();
  });
});

describe('server - utilidades y resolución', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('resolveProxyTargets asigna puertos predeterminados y respeta variables de entorno', () => {
    delete process.env.API_PROXY_TARGET;
    delete process.env.VITE_PROXY_API_TARGET;
    delete process.env.SYNC_PROXY_TARGET;
    delete process.env.SOCIAL_PROXY_TARGET;
    delete process.env.VOICE_PROXY_TARGET;
    delete process.env.STREAM_PROXY_TARGET;
    delete process.env.ANALYTICS_PROXY_TARGET;

    const defaults = resolveProxyTargets();
    expect(defaults.api).toBe('http://localhost:8081');
    expect(defaults.sync).toBe('ws://localhost:8083');
    expect(defaults.social).toBe('ws://localhost:8082');
    expect(defaults.voice).toBe('ws://localhost:8085');
    expect(defaults.stream).toBe('http://localhost:8086');
    expect(defaults.analytics).toBe('http://localhost:8084');

    process.env.API_PROXY_TARGET = 'http://gateway:80';
    process.env.SYNC_PROXY_TARGET = 'ws://gateway:80/ws/sync';
    const envTargets = resolveProxyTargets();
    expect(envTargets.api).toBe('http://gateway:80');
    expect(envTargets.sync).toBe('ws://gateway:80/ws/sync');
  });

  it('isStaticAssetPath identifica rutas de assets y extensiones conocidas', () => {
    expect(isStaticAssetPath('/assets/index-Bk5t10yA.css')).toBe(true);
    expect(isStaticAssetPath('/assets/index-IjWPezpJ.js')).toBe(true);
    expect(isStaticAssetPath('/favicon.ico')).toBe(true);
    expect(isStaticAssetPath('/favicon.svg')).toBe(true);
    expect(isStaticAssetPath('/manifest.webmanifest')).toBe(true);
    expect(isStaticAssetPath('/robots.txt')).toBe(true);
    expect(isStaticAssetPath('/logo.svg')).toBe(true);

    expect(isStaticAssetPath('/')).toBe(false);
    expect(isStaticAssetPath('/login')).toBe(false);
    expect(isStaticAssetPath('/invite/VIP777')).toBe(false);
    expect(isStaticAssetPath('/watch/room-1')).toBe(false);
    expect(isStaticAssetPath('/invite/user.code')).toBe(false);
  });

  it('resolveDistDir maneja directorios explícitos y fallbacks', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dist-resolve-test-'));
    try {
      expect(resolveDistDir(tempDir)).toBe(path.resolve(tempDir));
      expect(resolveDistDir('/directorio-inexistente-12345')).toBeUndefined();
      expect(resolveDistDir('')).toBeUndefined();

      // Test DIST_DIR env var
      process.env.DIST_DIR = tempDir;
      expect(resolveDistDir()).toBe(path.resolve(tempDir));

      process.env.DIST_DIR = '/inexistente-env-dir';
      expect(resolveDistDir()).toBeUndefined();
    } finally {
      delete process.env.DIST_DIR;
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('cleanTemplate retira los comentarios de marcado SSR', () => {
    const html = '<div><!--ssr-head--><!--ssr-outlet-->Hola</div>';
    expect(cleanTemplate(html)).toBe('<div>Hola</div>');
  });

  it('getTemplateHtml devuelve el contenido de index.html si distDir existe o fallback', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tpl-test-'));
    try {
      fs.writeFileSync(path.join(tempDir, 'index.html'), '<html>custom template</html>');
      expect(getTemplateHtml(tempDir)).toBe('<html>custom template</html>');
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }

    const fallback = getTemplateHtml('/inexistente-xyz');
    expect(fallback).toContain('<div id="root">');
  });

  it('startServer crea y responde peticiones HTTP correctamente', async () => {
    const port = 39182;
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await new Promise<void>((resolve) => {
      const server = startServer(port, '');
      server.on('listening', () => {
        expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('39182'));
        const clientReq = http.get(`http://127.0.0.1:${port}/healthz`, (res) => {
          expect(res.statusCode).toBe(200);
          server.close(() => resolve());
        });
        clientReq.on('error', () => {
          server.close(() => resolve());
        });
      });
    });
    logSpy.mockRestore();
  });
});
