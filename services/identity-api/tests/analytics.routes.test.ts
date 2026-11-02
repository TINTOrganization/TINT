import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { logger } from '../src/logging.js';
import request from 'supertest';
import jwt from 'jsonwebtoken';

vi.mock('../src/middlewares/auth.js', () => ({
  requireAuthHost: (req: any, _res: any, next: any) => {
    req.user = { id: 'host-1', providerSub: 'firebase-uid-1', email: 'ana@correo.com', displayName: 'Ana Pérez' };
    next();
  },
}));

vi.mock('../src/modules/rooms/rooms.repo.js', () => ({
  create: vi.fn(),
  listByHost: vi.fn(),
  findById: vi.fn(),
  isOwner: vi.fn(),
  softRemoveById: vi.fn(),
  updateTitle: vi.fn(),
  setMedia: vi.fn(),
}));

vi.mock('../src/modules/rooms/rooms.create.js', () => ({ createRoomWithInvitation: vi.fn() }));
vi.mock('../src/modules/invitations/invitations.repo.js', () => ({
  create: vi.fn(),
  findByCode: vi.fn(),
  setRevoked: vi.fn(),
  listByRoom: vi.fn(),
  listLatestActiveByRooms: vi.fn(),
}));

vi.mock('../src/modules/guests/guestSessions.repo.js', () => ({
  create: vi.fn(async (s: unknown) => s),
  findByJti: vi.fn(),
  listByRoom: vi.fn(),
  setRevoked: vi.fn(),
  listActiveByRoom: vi.fn(async () => []),
  setRevokedMany: vi.fn(async () => []),
}));

import app from '../src/app.js';
import { env } from '../src/config/env.js';
import { setRedisClient } from '../src/modules/tokens/revocation.js';
import { listActiveByRoom } from '../src/modules/guests/guestSessions.repo.js';
import { createRoomWithInvitation } from '../src/modules/rooms/rooms.create.js';
import { findById, isOwner, softRemoveById } from '../src/modules/rooms/rooms.repo.js';
import { findByCode } from '../src/modules/invitations/invitations.repo.js';

const ROOM_ID = '3d97d007-29c0-4cec-bb61-cb37683c3256';
const room = { id: ROOM_ID, hostId: 'host-1', title: 'Noche de cine', status: 'active', mediaId: null, mediaKey: null };
const deletedRoom = { ...room, status: 'deleted' };
const invitation = {
  id: 'inv-1',
  code: 'abc123def456',
  roomId: ROOM_ID,
  createdBy: 'host-1',
  expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
  revoked: false,
};

const xadd = vi.fn(async (..._args: unknown[]) => '1-0');
const redis = {
  xadd,
  set: vi.fn(async () => 'OK'),
  publish: vi.fn(async () => 1),
  exists: vi.fn(async () => 0),
};

/** Eventos publicados en analytics:events, como objetos campo → valor. */
function events() {
  return xadd.mock.calls
    .filter((call) => call[0] === 'analytics:events')
    .map((call) => {
      const pairs = call.slice(call.indexOf('*') + 1) as string[];
      const out: Record<string, string> = {};
      for (let i = 0; i < pairs.length; i += 2) out[pairs[i]] = pairs[i + 1];
      return out;
    });
}

function expectNoPersonalData() {
  const raw = JSON.stringify(xadd.mock.calls);
  expect(raw).not.toContain('ana@correo.com');
  expect(raw).not.toContain('Ana');
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(findById).mockResolvedValue(room as any);
  vi.mocked(isOwner).mockResolvedValue(true);
  setRedisClient(redis as any);
});

afterEach(() => {
  setRedisClient(null);
  vi.restoreAllMocks();
});

describe('eventos de analítica emitidos por las rutas', () => {
  it('POST /auth/verify publica user_login con el provider_sub y sin room_id', async () => {
    const res = await request(app).post('/api/v1/auth/verify').send({});
    expect(res.status).toBe(200);
    expect(events()).toHaveLength(1);
    const [event] = events();
    expect(event).toMatchObject({ type: 'user_login', source: 'identity-api', method: 'google', user_id: 'firebase-uid-1' });
    expect(event).not.toHaveProperty('room_id');
    expectNoPersonalData();
  });

  it('POST /rooms publica room_created con room_id y el provider_sub del host', async () => {
    vi.mocked(createRoomWithInvitation).mockResolvedValueOnce({ room, invitation } as any);
    const res = await request(app).post('/api/v1/rooms').send({ title: 'Noche de cine' });
    expect(res.status).toBe(200);
    expect(events()).toEqual([expect.objectContaining({ type: 'room_created', room_id: ROOM_ID, user_id: 'firebase-uid-1' })]);
    expectNoPersonalData();
  });

  it('POST /rooms no publica nada si la creación falla', async () => {
    vi.spyOn(logger, 'error').mockImplementation(() => {});
    vi.mocked(createRoomWithInvitation).mockRejectedValueOnce(new Error('db down'));
    const res = await request(app).post('/api/v1/rooms').send({ title: 'Sala' });
    expect(res.status).toBe(500);
    expect(events()).toHaveLength(0);
  });

  it('DELETE /rooms/:id publica room_closed reason=deleted en el primer borrado', async () => {
    vi.mocked(softRemoveById).mockResolvedValueOnce(deletedRoom as any);
    const res = await request(app).delete(`/api/v1/rooms/${ROOM_ID}`);
    expect(res.status).toBe(200);
    expect(events()).toEqual([
      expect.objectContaining({ type: 'room_closed', room_id: ROOM_ID, user_id: 'firebase-uid-1', reason: 'deleted' }),
    ]);
  });

  it('DELETE /rooms/:id no publica room_closed en el reintento sobre la sala ya borrada', async () => {
    vi.mocked(findById).mockResolvedValueOnce(deletedRoom as any);
    const res = await request(app).delete(`/api/v1/rooms/${ROOM_ID}`);
    expect(res.status).toBe(410);
    expect(events()).toHaveLength(0);
  });

  it('DELETE /rooms/:id no publica room_closed si la revocación falla (503)', async () => {
    vi.spyOn(logger, 'error').mockImplementation(() => {});
    vi.mocked(softRemoveById).mockResolvedValueOnce(deletedRoom as any);
    vi.mocked(listActiveByRoom).mockResolvedValueOnce([
      { jti: '77777777-7777-4777-8777-777777777777', roomId: ROOM_ID, expiresAt: new Date(Date.now() + 60_000), revoked: false },
    ] as any);
    redis.publish.mockRejectedValueOnce(new Error('redis down'));
    const res = await request(app).delete(`/api/v1/rooms/${ROOM_ID}`);
    expect(res.status).toBe(503);
    expect(events()).toHaveLength(0);
  });

  it('POST /invitations/claim publica invitation_claimed con el sub del invitado', async () => {
    vi.mocked(findByCode).mockResolvedValueOnce({ ...invitation } as any);
    const res = await request(app).post('/api/v1/invitations/claim').send({ code: 'abc123def456', nick: 'Ana' });
    expect(res.status).toBe(200);
    const decoded = jwt.decode(res.body.token) as any;
    expect(decoded.sub).toMatch(/^guest:/);
    expect(events()).toEqual([expect.objectContaining({ type: 'invitation_claimed', room_id: ROOM_ID, user_id: decoded.sub })]);
    expectNoPersonalData();
  });

  it('POST /invitations/claim no publica nada si el código no existe', async () => {
    vi.mocked(findByCode).mockResolvedValueOnce(undefined as any);
    const res = await request(app).post('/api/v1/invitations/claim').send({ code: 'nope', nick: 'Ana' });
    expect(res.status).toBe(404);
    expect(events()).toHaveLength(0);
  });

  describe('un fallo de Redis no cambia la respuesta', () => {
    const failures = {
      'XADD rechaza': () => xadd.mockRejectedValue(new Error('redis down')),
      'XADD lanza': () =>
        xadd.mockImplementation(() => {
          throw new Error('boom');
        }),
    };

    for (const [name, arrange] of Object.entries(failures)) {
      it(`${name}: verify, crear, borrar y canjear responden igual`, async () => {
        const log = vi.spyOn(logger, 'error').mockImplementation(() => {});
        arrange();

        const verify = await request(app).post('/api/v1/auth/verify').send({});
        expect(verify.status).toBe(200);
        expect(verify.body.isRegistered).toBe(true);

        vi.mocked(createRoomWithInvitation).mockResolvedValueOnce({ room, invitation } as any);
        const created = await request(app).post('/api/v1/rooms').send({ title: 'Noche de cine' });
        expect(created.status).toBe(200);
        expect(created.body.invitation.code).toBe('abc123def456');

        vi.mocked(softRemoveById).mockResolvedValueOnce(deletedRoom as any);
        const removed = await request(app).delete(`/api/v1/rooms/${ROOM_ID}`);
        expect(removed.status).toBe(200);
        expect(removed.body.success).toBe(true);

        vi.mocked(findById).mockResolvedValueOnce(room as any);
        vi.mocked(findByCode).mockResolvedValueOnce({ ...invitation } as any);
        const claimed = await request(app).post('/api/v1/invitations/claim').send({ code: 'abc123def456', nick: 'Ana' });
        expect(claimed.status).toBe(200);
        expect(typeof claimed.body.token).toBe('string');

        expect(xadd).toHaveBeenCalledTimes(4);
        await new Promise((resolve) => setImmediate(resolve));
        expect(log).toHaveBeenCalledTimes(4);
      });
    }
  });
});

describe('POST /rooms/:id/analytics-ticket', () => {
  it('403 si no es dueño', async () => {
    vi.mocked(isOwner).mockResolvedValueOnce(false);
    const res = await request(app).post(`/api/v1/rooms/${ROOM_ID}/analytics-ticket`).send({});
    expect(res.status).toBe(403);
    expect(res.body.token).toBeUndefined();
  });

  it('emite un ticket HS256 de host con los mismos claims que el sync-ticket', async () => {
    const res = await request(app).post(`/api/v1/rooms/${ROOM_ID}/analytics-ticket`).send({});
    expect(res.status).toBe(200);
    expect(isOwner).toHaveBeenCalledWith(ROOM_ID, 'host-1');
    expect(new Date(res.body.expiresAt).toISOString()).toBe(res.body.expiresAt);
    const decoded = jwt.verify(res.body.token, env.JWT_SECRET, {
      algorithms: ['HS256'],
      issuer: env.JWT_ISSUER,
      audience: env.JWT_AUDIENCE,
    }) as any;
    expect(decoded).toMatchObject({ sub: 'host-1', room_id: ROOM_ID, role: 'host', nick: 'Ana Pérez' });
    expect(typeof decoded.jti).toBe('string');
    expect(decoded.exp - decoded.iat).toBe(env.SYNC_TICKET_TTL_SECONDS);
    expect(decoded.exp * 1000).toBe(new Date(res.body.expiresAt).getTime());
  });

  it('también emite el ticket si la sala está borrada (sus KPIs se siguen consultando)', async () => {
    vi.mocked(findById).mockResolvedValue(deletedRoom as any);
    const res = await request(app).post(`/api/v1/rooms/${ROOM_ID}/analytics-ticket`).send({});
    expect(res.status).toBe(200);
    expect(typeof res.body.token).toBe('string');
  });

  it('el sync-ticket sigue respondiendo 410 para una sala borrada', async () => {
    vi.mocked(findById).mockResolvedValue(deletedRoom as any);
    const res = await request(app).post(`/api/v1/rooms/${ROOM_ID}/sync-ticket`).send({});
    expect(res.status).toBe(410);
  });

  it('no publica eventos de analítica', async () => {
    await request(app).post(`/api/v1/rooms/${ROOM_ID}/analytics-ticket`).send({});
    expect(events()).toHaveLength(0);
  });
});
