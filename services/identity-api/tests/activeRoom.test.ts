import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';

vi.mock('../src/middlewares/auth.js', () => ({
  requireAuthHost: (req: any, _res: any, next: any) => {
    req.user = { id: 'host-1', providerSub: 'sub-1', email: 'h@t.c', displayName: 'Host' };
    next();
  },
}));

vi.mock('../src/modules/rooms/rooms.repo.js', () => ({
  create: vi.fn(),
  listByHost: vi.fn(),
  findById: vi.fn(),
  isOwner: vi.fn(async () => true),
  setMedia: vi.fn(),
  softRemoveById: vi.fn(),
  updateTitle: vi.fn(),
}));

vi.mock('../src/modules/guests/guestSessions.repo.js', () => ({
  create: vi.fn(),
  findByJti: vi.fn(async () => null),
  listByRoom: vi.fn(async () => []),
  setRevoked: vi.fn(),
}));

vi.mock('../src/modules/tokens/revocation.js', () => ({
  isTokenRevoked: vi.fn(async () => false),
  markTokenRevoked: vi.fn(),
  publishRevoked: vi.fn(),
}));

import app from '../src/app.js';
import { env } from '../src/config/env.js';
import { findById, setMedia } from '../src/modules/rooms/rooms.repo.js';
import { requireActiveRoom } from '../src/middlewares/activeRoom.js';

const deleted = { id: 'room-1', hostId: 'host-1', title: 'Sala', status: 'deleted', mediaId: null, mediaKey: null };
const JTI = '33333333-3333-4333-8333-333333333333';

function guestToken() {
  return jwt.sign(
    { sub: 'guest:1', room_id: 'room-1', role: 'participant', nick: 'Ana', jti: JTI, iss: env.JWT_ISSUER, aud: env.JWT_AUDIENCE },
    env.JWT_SECRET,
    { algorithm: 'HS256', expiresIn: 600 },
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(findById).mockResolvedValue(deleted as any);
});

// Una sala borrada (borrado lógico) no se puede sincronizar ni administrar.
describe('rutas del Canal Sync sobre salas borradas → 410', () => {
  it.each([
    ['POST', '/api/v1/rooms/room-1/sync-ticket', undefined],
    ['PUT', '/api/v1/rooms/room-1/media', { mediaKey: 'videos/a.mp4' }],
    ['GET', '/api/v1/rooms/room-1/guests', undefined],
    ['POST', `/api/v1/rooms/room-1/guests/${JTI}/revoke`, undefined],
  ])('%s %s (host)', async (method, path, body) => {
    const agent = request(app)[method.toLowerCase() as 'get' | 'post' | 'put'](path);
    const res = body ? await agent.send(body) : await agent;
    expect(res.status).toBe(410);
    expect(res.body).toEqual({ error: 'Deleted' });
  });

  it('PUT /media no modifica una sala borrada', async () => {
    await request(app).put('/api/v1/rooms/room-1/media').send({ mediaKey: 'videos/a.mp4' });
    expect(setMedia).not.toHaveBeenCalled();
  });

  it('GET /playback con guest token → 410', async () => {
    const res = await request(app).get('/api/v1/rooms/room-1/playback').set('Authorization', `Bearer ${guestToken()}`);
    expect(res.status).toBe(410);
  });
});

describe('requireActiveRoom', () => {
  function run(room: unknown) {
    vi.mocked(findById).mockResolvedValueOnce(room as any);
    const res = { status: vi.fn().mockReturnThis(), json: vi.fn().mockReturnThis() } as any;
    const req = { params: { id: 'room-1' } } as any;
    const next = vi.fn();
    return requireActiveRoom(req, res, next).then(() => ({ req, res, next }));
  }

  it('404 si no existe', async () => {
    const { res, next } = await run(null);
    expect(res.status).toHaveBeenCalledWith(404);
    expect(next).not.toHaveBeenCalled();
  });

  it('410 Disabled si la sala live terminó (ADR 0019)', async () => {
    const { res, next } = await run({ ...deleted, status: 'disabled' });
    expect(res.status).toHaveBeenCalledWith(410);
    expect(res.json).toHaveBeenCalledWith({ error: 'Disabled' });
    expect(next).not.toHaveBeenCalled();
  });

  it('falla cerrado ante un status desconocido (no deja pasar)', async () => {
    const { res, next } = await run({ ...deleted, status: 'otro' });
    expect(res.status).toHaveBeenCalledWith(410);
    expect(next).not.toHaveBeenCalled();
  });

  it('deja pasar una sala activa y la expone en req.room', async () => {
    const active = { ...deleted, status: 'active' };
    const { req, next } = await run(active);
    expect(next).toHaveBeenCalled();
    expect(req.room).toEqual(active);
  });

  it('500 si falla la BD', async () => {
    vi.mocked(findById).mockRejectedValueOnce(new Error('db down'));
    const res = { status: vi.fn().mockReturnThis(), json: vi.fn().mockReturnThis() } as any;
    const next = vi.fn();
    await requireActiveRoom({ params: { id: ['room-1'] } } as any, res, next);
    expect(res.status).toHaveBeenCalledWith(500);
    expect(next).not.toHaveBeenCalled();
  });
});
