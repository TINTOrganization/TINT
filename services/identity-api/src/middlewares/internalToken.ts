import { createHash, timingSafeEqual } from 'node:crypto';
import type { Request, Response, NextFunction } from 'express';
import { env } from '../config/env.js';
import { logger } from '../logging.js';

const digest = (value: string) => createHash('sha256').update(value, 'utf8').digest();

/**
 * Autoriza las llamadas servicio a servicio (`/api/v1/internal/*`, ADR 0019) con la cabecera
 * `X-Internal-Token` = `INTERNAL_API_SECRET`. Compara los SHA-256 en tiempo constante: los dos
 * buffers miden siempre 32 bytes, así que una cabecera de otra longitud no lanza (no hay 500)
 * ni revela la longitud del secreto. Falla cerrado: sin secreto configurado responde 503.
 */
export function internalTokenGuard(getSecret: () => string | undefined) {
  return (req: Request, res: Response, next: NextFunction) => {
    const secret = getSecret();
    if (!secret) {
      logger.error('internal: INTERNAL_API_SECRET no está configurado; se rechaza la llamada');
      return res.status(503).json({ error: 'Service unavailable' });
    }
    const header = req.headers['x-internal-token'];
    if (typeof header !== 'string' || header === '' || !timingSafeEqual(digest(header), digest(secret))) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    next();
  };
}

export const requireInternalToken = internalTokenGuard(() => env.INTERNAL_API_SECRET);
