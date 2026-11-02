import { Request, Response, NextFunction } from 'express';

type HttpError = Error & { status?: number; statusCode?: number; expose?: boolean };

/**
 * Último manejador: el detalle de los errores internos (Postgres, Redis, S3…) se
 * registra en el servidor y nunca llega al cliente. Solo se respetan los 4xx que
 * express marca como expuestos (p. ej. JSON mal formado o cuerpo demasiado grande).
 */
export function errorHandler(err: HttpError, req: Request, res: Response, next: NextFunction) {
  const status = err.status ?? err.statusCode;
  const correlationId = res.locals?.correlationId;
  if (err.expose && status && status >= 400 && status < 500) {
    return res.status(status).json({ error: err.message });
  }
  console.error(
    JSON.stringify({
      level: 'error',
      message: 'unhandled_error',
      correlation_id: correlationId,
      error: err.stack ?? err.message,
    }),
  );
  res.status(500).json({ error: 'Internal error' });
}
