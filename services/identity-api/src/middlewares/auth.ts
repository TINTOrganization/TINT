import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { verifyFirebaseIdToken } from '../modules/auth/firebaseToken.js';
import { upsertByProvider } from '../modules/users/users.repo.js';
import { logger } from '../logging.js';

export interface AuthUser {
  id: string;
  providerSub: string;
  email?: string | null;
  displayName?: string | null;
}

declare module 'express-serve-static-core' {
  interface Request {
    user?: AuthUser;
  }
}

export async function requireAuthHost(req: Request, res: Response, next: NextFunction) {
  try {
    const header = req.headers.authorization;
    if (!header || !header.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    const token = header.substring(7);
    let verified: jwt.JwtPayload;
    try {
      verified = await verifyFirebaseIdToken(token);
    } catch (err) {
      logger.error('auth: fallo al verificar JWT de Firebase', { error: (err as Error).message });
      return res.status(401).json({ error: 'Invalid token' });
    }
    const providerSub = verified.sub as string;
    let user;
    try {
      user = await upsertByProvider({
        providerSub,
        email: verified.email,
        displayName: verified.name || verified.displayName,
        avatarUrl: verified.picture,
      });
    } catch (err) {
      logger.error('auth: fallo de infraestructura (DB) en upsert de usuario', {
        error: (err as Error).message,
      });
      return res.status(500).json({ error: 'Internal error' });
    }
    req.user = {
      id: user.id,
      providerSub: user.providerSub,
      email: user.email,
      displayName: user.displayName,
    };
    next();
  } catch (err) {
    logger.error('auth: error inesperado en requireAuthHost', { error: (err as Error).message });
    return res.status(401).json({ error: 'Unauthorized' });
  }
}
