import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { env } from '../config/env.js';
import { isTokenRevoked } from '../modules/tokens/revocation.js';
import { requireAuthHost } from './auth.js';

function bearer(req: Request) {
  const header = req.headers.authorization;
  return header && header.startsWith('Bearer ') ? header.substring(7) : null;
}

/**
 * Token de un handshake WebSocket que llega por el gateway. El navegador no puede mandar
 * `Authorization` al abrir un WebSocket, así que la web lo pone en `?token=` y Caddy
 * (`forward_auth`) reenvía la URI original en `X-Forwarded-Uri`. Solo vale para `/ws/*`:
 * la API REST siempre usa `Authorization`.
 */
function websocketToken(req: Request) {
  const uri = req.headers['x-forwarded-uri'];
  if (typeof uri !== 'string' || !uri.startsWith('/ws/')) return null;
  const query = uri.indexOf('?');
  if (query < 0) return null;
  return new URLSearchParams(uri.slice(query + 1)).get('token') || null;
}

/**
 * En `/ws/*` se exige la firma, el emisor y la audiencia, pero no se rechazan la caducidad ni la
 * revocación: cada servicio vuelve a verificar el token y, tras el upgrade, cierra con `4003` o
 * `4001`. Si el gateway respondiera 401 antes del upgrade el navegador solo vería `1006`,
 * reintentaría sin fin y no podría mostrar el aviso (lección de ADR 0014).
 */
function checkWebsocketToken(token: string, res: Response) {
  const decoded = jwt.decode(token, { complete: true }) as jwt.Jwt | null;
  if (decoded?.header?.alg !== 'HS256') {
    return unauthorized(res);
  }
  try {
    const payload = jwt.verify(token, env.JWT_SECRET, {
      algorithms: ['HS256'],
      issuer: env.JWT_ISSUER,
      audience: env.JWT_AUDIENCE,
      ignoreExpiration: true,
    }) as jwt.JwtPayload;
    if (!payload.sub) {
      return unauthorized(res);
    }
    return forwardIdentity(res, {
      'X-User-Id': payload.sub,
      'X-User-Sub': payload.sub,
      'X-User-Role': payload.role,
      'X-User-Room-Id': payload.room_id,
      'X-User-Nick': payload.nick,
    });
  } catch {
    return unauthorized(res);
  }
}

function unauthorized(res: Response) {
  return res.status(401).json({ error: 'Invalid token' });
}

function forwardIdentity(res: Response, identity: Record<string, unknown>) {
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(identity)) {
    if (typeof value === 'string' && value.length > 0) {
      headers[name] = value;
    }
  }
  return res.set(headers).status(204).end();
}

export async function centralTokenCheck(req: Request, res: Response, next: NextFunction) {
  const token = bearer(req);
  if (!token) {
    const wsToken = websocketToken(req);
    return wsToken ? checkWebsocketToken(wsToken, res) : unauthorized(res);
  }

  const decoded = jwt.decode(token, { complete: true }) as jwt.Jwt | null;
  if (!decoded?.header?.alg) {
    return unauthorized(res);
  }

  if (decoded.header.alg === 'HS256') {
    try {
      const payload = jwt.verify(token, env.JWT_SECRET, {
        algorithms: ['HS256'],
        issuer: env.JWT_ISSUER,
        audience: env.JWT_AUDIENCE,
      }) as jwt.JwtPayload;
      if (!payload.sub || (payload.jti && await isTokenRevoked(payload.jti))) {
        return unauthorized(res);
      }
      return forwardIdentity(res, {
        'X-User-Id': payload.sub,
        'X-User-Sub': payload.sub,
        'X-User-Role': payload.role,
        'X-User-Room-Id': payload.room_id,
        'X-User-Nick': payload.nick,
      });
    } catch {
      return unauthorized(res);
    }
  }

  // ID token de Firebase del host: RS256 o, solo en modo emulador, `none` (requireAuthHost decide).
  if (decoded.header.alg === 'RS256' || decoded.header.alg === 'none') {
    return requireAuthHost(req, res, () => {
      const user = req.user;
      if (!user) {
        return unauthorized(res);
      }
      return forwardIdentity(res, {
        'X-User-Id': user.id,
        'X-User-Sub': user.providerSub,
        'X-User-Role': 'host',
      });
    });
  }

  return unauthorized(res);
}