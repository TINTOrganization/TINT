import { describe, it, expect, vi } from 'vitest';
import { logger } from '../src/logging.js';
import { z } from 'zod';
import { validate } from '../src/middlewares/validate.js';
import { errorHandler } from '../src/middlewares/error.js';

function mockRes() {
  const res: any = {};
  res.status = vi.fn().mockReturnValue(res);
  res.json = vi.fn().mockReturnValue(res);
  return res;
}

describe('validate', () => {
  const schema = z.object({ title: z.string().trim().min(1) });

  it('llama next y normaliza el body si es válido', () => {
    const req: any = { body: { title: '  Hola  ' } };
    const next = vi.fn();
    validate(schema)(req, mockRes(), next);
    expect(next).toHaveBeenCalled();
    expect(req.body.title).toBe('Hola');
  });

  it('responde 400 si es inválido', () => {
    const req: any = { body: { title: '' } };
    const res = mockRes();
    const next = vi.fn();
    validate(schema)(req, res, next);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(next).not.toHaveBeenCalled();
  });
});

describe('errorHandler', () => {
  it('responde 500 genérico sin filtrar el mensaje interno y lo registra en el servidor', () => {
    const res = mockRes();
    const log = vi.spyOn(logger, 'error').mockImplementation(() => {});
    const err = new Error('value too long for type character varying(150)');
    errorHandler(err, {} as any, res, (() => {}) as any);
    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({ error: 'Internal error' });
    expect(log).toHaveBeenCalled();
    expect(JSON.stringify(log.mock.calls[0])).toContain('character varying(150)');
    log.mockRestore();
  });

  it('respeta los errores 4xx expuestos de express (p. ej. JSON mal formado)', () => {
    const res = mockRes();
    const err = Object.assign(new Error('Unexpected token } in JSON'), { status: 400, expose: true });
    errorHandler(err, {} as any, res, (() => {}) as any);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({ error: 'Unexpected token } in JSON' });
  });
});
