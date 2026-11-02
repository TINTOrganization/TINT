import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';

export const CORRELATION_HEADER = 'X-Correlation-ID';

const SAFE_CORRELATION_ID = /^[A-Za-z0-9._:-]{1,128}$/;

export function correlationId(value: string | undefined): string {
  return value && SAFE_CORRELATION_ID.test(value) ? value : randomUUID();
}

export function correlationMiddleware(req: Request, res: Response, next: NextFunction) {
  const incoming = req.get(CORRELATION_HEADER);
  const id = correlationId(incoming);
  res.locals.correlationId = id;
  res.locals.includeCorrelationId = Boolean(incoming && SAFE_CORRELATION_ID.test(incoming));
  res.setHeader(CORRELATION_HEADER, id);
  const json = res.json.bind(res);
  res.json = (body: unknown) => {
    if (
      res.locals.includeCorrelationId &&
      body &&
      typeof body === 'object' &&
      'error' in body &&
      !('correlation_id' in body)
    ) {
      return json({ ...(body as Record<string, unknown>), correlation_id: id });
    }
    return json(body);
  };
  res.on('finish', () => {
    console.log(
      JSON.stringify({
        level: 'info',
        message: 'http_request',
        correlation_id: id,
        method: req.method,
        path: req.path,
        status: res.statusCode,
      }),
    );
  });
  next();
}
