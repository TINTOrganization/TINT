import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { env } from '../config/env.js';
import { isTokenRevoked } from '../modules/tokens/revocation.js';
import { requireAuthHost } from './auth.js';

function bearer(req: Request) {
  const header = req.headers.authorization;
  return header && header.startsWith('Bearer ') ? header.substring(7) : null;
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
    return unauthorized(res);
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

  if (decoded.header.alg === 'RS256') {
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