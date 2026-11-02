import { describe, it, expect, vi } from 'vitest';
import { internalTokenGuard } from '../src/middlewares/internalToken.js';

function run(secret: string | undefined, header: string | string[] | undefined) {
  const res = { status: vi.fn().mockReturnThis(), json: vi.fn().mockReturnThis() } as any;
  const req = { headers: header === undefined ? {} : { 'x-internal-token': header } } as any;
  const next = vi.fn();
  internalTokenGuard(() => secret)(req, res, next);
  return { res, next };
}

describe('internalTokenGuard (X-Internal-Token, ADR 0019)', () => {
  it('deja pasar con el secreto correcto', () => {
    const { next, res } = run('s3cret-interno', 's3cret-interno');
    expect(next).toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
  });

  it.each([
    ['sin cabecera', undefined],
    ['vacía', ''],
    ['incorrecta', 'x3cret-interno'],
    ['de otra longitud', 'corto'],
    ['repetida', ['s3cret-interno', 's3cret-interno']],
  ])('401 con la cabecera %s', (_name, header) => {
    const { next, res } = run('s3cret-interno', header);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({ error: 'Unauthorized' });
    expect(next).not.toHaveBeenCalled();
  });

  it.each([
    ['sin configurar', undefined],
    ['vacío', ''],
  ])('falla cerrado con el secreto %s: 503 aunque la cabecera coincida', (_name, secret) => {
    const { next, res } = run(secret, '');
    expect(res.status).toHaveBeenCalledWith(503);
    expect(next).not.toHaveBeenCalled();
  });
});
