import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';

const authUser = vi.hoisted(() => ({
  override: null as Record<string, unknown> | null,
}));

vi.mock('../src/middlewares/auth.js', () => ({
  requireAuthHost: (req: any, _res: any, next: any) => {
    req.user = { id: 'host-1', providerSub: 'sub-1', email: 'h@t.c', displayName: 'Host', ...authUser.override };
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
}));

vi.mock('../src/modules/invitations/invitations.repo.js', () => ({
  create: vi.fn(),
  findByCode: vi.fn(),
  setRevoked: vi.fn(),
  listByRoom: vi.fn(),
  listLatestActiveByRooms: vi.fn(),
}));

vi.mock('../src/modules/eventStart/eventStart.clients.js', () => ({
  defaultEventStartDeps: vi.fn(),
}));

vi.mock('../src/modules/eventStart/eventStart.service.js', () => ({
  EventStartError: class EventStartError extends Error {},
  startEvent: vi.fn(),
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
import { create as createGuestSession, listActiveByRoom, setRevokedMany } from '../src/modules/guests/guestSessions.repo.js';
import { setRedisClient } from '../src/modules/tokens/revocation.js';
import { create as createRoom, listByHost, findById, isOwner, softRemoveById, updateTitle } from '../src/modules/rooms/rooms.repo.js';
import { create as createInvitation, findByCode, setRevoked, listByRoom, listLatestActiveByRooms } from '../src/modules/invitations/invitations.repo.js';
import { defaultEventStartDeps } from '../src/modules/eventStart/eventStart.clients.js';
import { EventStartError, startEvent } from '../src/modules/eventStart/eventStart.service.js';

const room = { id: 'room-1', hostId: 'host-1', title: 'Noche de cine', status: 'active' };
const deletedRoom = { ...room, status: 'deleted' };
const invitation = {
  id: 'inv-1',
  code: 'abc123def456',
  roomId: 'room-1',
  createdBy: 'host-1',
  expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
  revoked: false,
};

beforeEach(() => {
  vi.clearAllMocks();
  // Por defecto la sala existe y está activa (requireActiveRoom).
  vi.mocked(findById).mockResolvedValue({ id: 'room-1', hostId: 'host-1', title: 'Sala', status: 'active', mediaId: null, mediaKey: null } as any);
  authUser.override = null;
  setRedisClient(redis as any);
});

const redis = {
  set: vi.fn(async () => 'OK'),
  publish: vi.fn(async () => 1),
  exists: vi.fn(async () => 0),
  xadd: vi.fn(async () => '1-0'),
};

describe('rutas v1', () => {
  it('POST /events/start coordina el inicio y devuelve sala, invitación y sesiones', async () => {
    vi.mocked(defaultEventStartDeps).mockReturnValue({} as any);
    vi.mocked(startEvent).mockResolvedValueOnce({
      room,
      invitation: { code: invitation.code, expiresAt: invitation.expiresAt, link: '/invite/abc123def456' },
      sessions: {
        sync: { sessionId: 'sync-1' },
        social: { sessionId: 'social-1' },
        analytics: { sessionId: 'analytics-1' },
      },
    } as any);

    const res = await request(app).post('/api/v1/events/start').send({ title: 'Noche de cine' });

    expect(res.status).toBe(200);
    expect(res.body.sessions.sync.sessionId).toBe('sync-1');
    expect(startEvent).toHaveBeenCalledWith(
      { title: 'Noche de cine', user: expect.objectContaining({ id: 'host-1' }) },
      {},
    );
  });

  it('POST /events/start devuelve 503 claro si un servicio falla', async () => {
    vi.mocked(defaultEventStartDeps).mockReturnValue({} as any);
    const error = new EventStartError('social', new Error('caído'));
    vi.mocked(startEvent).mockRejectedValueOnce(error);

    const res = await request(app).post('/api/v1/events/start').send({ title: 'Noche de cine' });

    expect(res.status).toBe(503);
    expect(res.body).toEqual({ error: 'No se pudo iniciar el evento' });
  });

  it('GET /healthz responde ok', async () => {
    const res = await request(app).get('/api/v1/healthz');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ok', service: 'identity-api' });
  });

  it('POST /auth/verify retorna el usuario y isRegistered', async () => {
    const res = await request(app).post('/api/v1/auth/verify').send({});
    expect(res.status).toBe(200);
    expect(res.body.isRegistered).toBe(true);
    expect(res.body.user.id).toBe('host-1');
  });

  it('POST /rooms 400 si el título está vacío', async () => {
    const res = await request(app).post('/api/v1/rooms').send({ title: '  ' });
    expect(res.status).toBe(400);
  });

  it('POST /rooms 400 si el título supera 150 caracteres (varchar(150) en la BD)', async () => {
    const res = await request(app).post('/api/v1/rooms').send({ title: 'a'.repeat(151) });
    expect(res.status).toBe(400);
    expect(createRoom).not.toHaveBeenCalled();
  });

  it('POST /rooms 500 genérico si la BD falla (no filtra el error de Postgres)', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.mocked(createRoom).mockRejectedValueOnce(new Error('value too long for type character varying(150)'));
    const res = await request(app).post('/api/v1/rooms').send({ title: 'Sala' });
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'Internal error' });
    log.mockRestore();
  });

  it('POST /rooms crea sala + invitación inicial con link relativo', async () => {
    vi.mocked(createRoom).mockResolvedValueOnce(room as any);
    vi.mocked(createInvitation).mockResolvedValueOnce(invitation as any);
    const res = await request(app).post('/api/v1/rooms').send({ title: 'Noche de cine' });
    expect(res.status).toBe(200);
    expect(res.body.room).toMatchObject({ id: 'room-1', title: 'Noche de cine' });
    expect(res.body.invitation.code).toBe('abc123def456');
    expect(res.body.invitation.link).toBe('/invite/abc123def456');
  });

  it('GET /rooms lista las salas del host', async () => {
    vi.mocked(listByHost).mockResolvedValueOnce([room] as any);
    vi.mocked(listLatestActiveByRooms).mockResolvedValueOnce(new Map());
    const res = await request(app).get('/api/v1/rooms');
    expect(res.status).toBe(200);
    expect(res.body.rooms).toHaveLength(1);
    expect(listByHost).toHaveBeenCalledWith('host-1');
  });

  it('GET /rooms incluye la invitacion vigente de cada sala (null si no hay)', async () => {
    vi.mocked(listByHost).mockResolvedValueOnce([room, { ...room, id: 'room-2' }] as any);
    vi.mocked(listLatestActiveByRooms).mockResolvedValueOnce(
      new Map([['room-1', invitation as any]]),
    );
    const res = await request(app).get('/api/v1/rooms');
    expect(res.status).toBe(200);
    expect(listLatestActiveByRooms).toHaveBeenCalledWith(['room-1', 'room-2']);
    expect(res.body.rooms[0].invitation).toMatchObject({
      code: 'abc123def456',
      link: '/invite/abc123def456',
    });
    expect(res.body.rooms[1].invitation).toBeNull();
  });

  it('POST /rooms/:id/invitations 403 si no es dueño', async () => {
    vi.mocked(isOwner).mockResolvedValueOnce(false);
    const res = await request(app).post('/api/v1/rooms/room-1/invitations').send({});
    expect(res.status).toBe(403);
  });

  it('POST /rooms/:id/invitations genera invitación si es dueño', async () => {
    vi.mocked(isOwner).mockResolvedValueOnce(true);
    vi.mocked(findById).mockResolvedValueOnce(room as any);
    vi.mocked(createInvitation).mockResolvedValueOnce(invitation as any);
    const res = await request(app).post('/api/v1/rooms/room-1/invitations').send({ ttlHours: 6 });
    expect(res.status).toBe(200);
    expect(res.body.link).toBe('/invite/abc123def456');
  });

  it.each([[721], [1e308], [1.5], [0]])('POST /rooms/:id/invitations 400 si ttlHours=%s (entero de 1 a 720)', async (ttlHours) => {
    vi.mocked(isOwner).mockResolvedValueOnce(true);
    const res = await request(app).post('/api/v1/rooms/room-1/invitations').send({ ttlHours });
    expect(res.status).toBe(400);
    expect(createInvitation).not.toHaveBeenCalled();
  });

  it('POST /rooms/:id/invitations acepta ttlHours=720 (30 días)', async () => {
    vi.mocked(isOwner).mockResolvedValueOnce(true);
    vi.mocked(createInvitation).mockResolvedValueOnce(invitation as any);
    const res = await request(app).post('/api/v1/rooms/room-1/invitations').send({ ttlHours: 720 });
    expect(res.status).toBe(200);
  });

  it('POST /rooms/:id/sync-ticket 403 si no es dueño', async () => {
    vi.mocked(isOwner).mockResolvedValueOnce(false);
    const res = await request(app).post('/api/v1/rooms/room-1/sync-ticket').send({});
    expect(res.status).toBe(403);
  });

  it('POST /rooms/:id/sync-ticket emite ticket HS256 de host si es dueño', async () => {
    vi.mocked(isOwner).mockResolvedValueOnce(true);
    const res = await request(app).post('/api/v1/rooms/room-1/sync-ticket').send({});
    expect(res.status).toBe(200);
    expect(isOwner).toHaveBeenCalledWith('room-1', 'host-1');
    expect(typeof res.body.token).toBe('string');
    expect(new Date(res.body.expiresAt).toISOString()).toBe(res.body.expiresAt);
    const decoded = jwt.verify(res.body.token, env.JWT_SECRET, {
      algorithms: ['HS256'],
      issuer: env.JWT_ISSUER,
      audience: env.JWT_AUDIENCE,
    }) as any;
    expect(decoded.sub).toBe('host-1');
    expect(decoded.room_id).toBe('room-1');
    expect(decoded.role).toBe('host');
    expect(decoded.nick).toBe('Host');
    expect(decoded.exp * 1000).toBe(new Date(res.body.expiresAt).getTime());
  });

  it('POST /rooms/:id/sync-ticket sin displayName usa solo la parte local del email (nunca el email completo)', async () => {
    authUser.override = { displayName: null, email: 'ana.perez@correo.com' };
    vi.mocked(isOwner).mockResolvedValueOnce(true);
    const res = await request(app).post('/api/v1/rooms/room-1/sync-ticket').send({});
    expect(res.status).toBe(200);
    const nick = (jwt.decode(res.body.token) as any).nick;
    expect(nick).toBe('ana.perez');
    expect(res.body.token).not.toContain('correo.com');
  });

  it('POST /rooms/:id/sync-ticket usa "Host" si no hay displayName ni email', async () => {
    authUser.override = { displayName: '', email: null };
    vi.mocked(isOwner).mockResolvedValueOnce(true);
    const res = await request(app).post('/api/v1/rooms/room-1/sync-ticket').send({});
    expect((jwt.decode(res.body.token) as any).nick).toBe('Host');
  });

  it('POST /invitations/:code/revoke 404 si no existe', async () => {
    vi.mocked(findByCode).mockResolvedValueOnce(null as any);
    const res = await request(app).post('/api/v1/invitations/xxx/revoke');
    expect(res.status).toBe(404);
  });

  it('POST /invitations/:code/revoke 404 (no 403) si la sala de la invitación no existe', async () => {
    vi.mocked(findByCode).mockResolvedValueOnce(invitation as any);
    vi.mocked(findById).mockResolvedValueOnce(null as any);
    const res = await request(app).post('/api/v1/invitations/abc123def456/revoke');
    expect(res.status).toBe(404);
    expect(setRevoked).not.toHaveBeenCalled();
  });

  it('POST /invitations/:code/revoke 403 si no es dueño de la sala', async () => {
    vi.mocked(findByCode).mockResolvedValueOnce(invitation as any);
    vi.mocked(findById).mockResolvedValueOnce({ ...room, hostId: 'otro-host' } as any);
    const res = await request(app).post('/api/v1/invitations/abc123def456/revoke');
    expect(res.status).toBe(403);
  });

  it('POST /invitations/:code/revoke revoca si es dueño', async () => {
    vi.mocked(findByCode).mockResolvedValueOnce(invitation as any);
    vi.mocked(findById).mockResolvedValueOnce(room as any);
    vi.mocked(setRevoked).mockResolvedValueOnce({ ...invitation, revoked: true } as any);
    const res = await request(app).post('/api/v1/invitations/abc123def456/revoke');
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(setRevoked).toHaveBeenCalledWith('inv-1', true);
  });

  it('POST /invitations/claim 404 si el código no existe', async () => {
    vi.mocked(findByCode).mockResolvedValueOnce(null as any);
    const res = await request(app).post('/api/v1/invitations/claim').send({ code: 'xxx', nick: 'Ana' });
    expect(res.status).toBe(404);
  });

  it('POST /invitations/claim 409 si está revocado', async () => {
    vi.mocked(findByCode).mockResolvedValueOnce({ ...invitation, revoked: true } as any);
    const res = await request(app).post('/api/v1/invitations/claim').send({ code: 'abc', nick: 'Ana' });
    expect(res.status).toBe(409);
  });

  it('POST /invitations/claim 410 si expiró', async () => {
    vi.mocked(findByCode).mockResolvedValueOnce({
      ...invitation,
      expiresAt: new Date(Date.now() - 1000),
    } as any);
    const res = await request(app).post('/api/v1/invitations/claim').send({ code: 'abc', nick: 'Ana' });
    expect(res.status).toBe(410);
  });

  it('POST /invitations/claim 400 si el nick está vacío', async () => {
    const res = await request(app).post('/api/v1/invitations/claim').send({ code: 'abc', nick: '  ' });
    expect(res.status).toBe(400);
  });

  it('POST /invitations/claim emite guest token acotado (mismo nick permitido)', async () => {
    vi.mocked(findByCode).mockResolvedValue({ ...invitation } as any);
    const first = await request(app).post('/api/v1/invitations/claim').send({ code: 'abc', nick: 'Ana' });
    const second = await request(app).post('/api/v1/invitations/claim').send({ code: 'abc', nick: 'Ana' });
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(first.body.roomId).toBe('room-1');
    expect(first.body.nick).toBe('Ana');
    expect(typeof first.body.token).toBe('string');
  });

  it('GET /rooms/:id 403 si no es dueño', async () => {
    vi.mocked(isOwner).mockResolvedValueOnce(false);
    const res = await request(app).get('/api/v1/rooms/room-1');
    expect(res.status).toBe(403);
  });

  it('GET /rooms/:id 404 si no existe', async () => {
    vi.mocked(isOwner).mockResolvedValueOnce(true);
    vi.mocked(findById).mockResolvedValueOnce(null as any);
    const res = await request(app).get('/api/v1/rooms/room-1');
    expect(res.status).toBe(404);
  });

  it('GET /rooms/:id 410 si está eliminada', async () => {
    vi.mocked(isOwner).mockResolvedValueOnce(true);
    vi.mocked(findById).mockResolvedValueOnce(deletedRoom as any);
    const res = await request(app).get('/api/v1/rooms/room-1');
    expect(res.status).toBe(410);
  });

  it('GET /rooms/:id retorna la sala si está activa', async () => {
    vi.mocked(isOwner).mockResolvedValueOnce(true);
    vi.mocked(findById).mockResolvedValueOnce(room as any);
    const res = await request(app).get('/api/v1/rooms/room-1');
    expect(res.status).toBe(200);
    expect(res.body.room).toMatchObject({ id: 'room-1', title: 'Noche de cine' });
  });

  it('GET /rooms/:id/invitations 403 si no es dueño', async () => {
    vi.mocked(isOwner).mockResolvedValueOnce(false);
    const res = await request(app).get('/api/v1/rooms/room-1/invitations');
    expect(res.status).toBe(403);
  });

  it('GET /rooms/:id/invitations 410 si la sala está eliminada', async () => {
    vi.mocked(isOwner).mockResolvedValueOnce(true);
    vi.mocked(findById).mockResolvedValueOnce(deletedRoom as any);
    const res = await request(app).get('/api/v1/rooms/room-1/invitations');
    expect(res.status).toBe(410);
  });

  it('GET /rooms/:id/invitations lista los links vigentes con link usable', async () => {
    vi.mocked(isOwner).mockResolvedValueOnce(true);
    vi.mocked(findById).mockResolvedValueOnce(room as any);
    vi.mocked(listByRoom).mockResolvedValueOnce([invitation] as any);
    const res = await request(app).get('/api/v1/rooms/room-1/invitations');
    expect(res.status).toBe(200);
    expect(res.body.invitations).toHaveLength(1);
    expect(res.body.invitations[0].code).toBe('abc123def456');
    expect(res.body.invitations[0].link).toBe('/invite/abc123def456');
  });

  it('PATCH /rooms/:id 400 si el título está vacío', async () => {
    vi.mocked(isOwner).mockResolvedValueOnce(true);
    const res = await request(app).patch('/api/v1/rooms/room-1').send({ title: '  ' });
    expect(res.status).toBe(400);
  });

  it('PATCH /rooms/:id 403 si no es dueño', async () => {
    vi.mocked(isOwner).mockResolvedValueOnce(false);
    const res = await request(app).patch('/api/v1/rooms/room-1').send({ title: 'Nuevo' });
    expect(res.status).toBe(403);
  });

  it('PATCH /rooms/:id 404 si no existe', async () => {
    vi.mocked(isOwner).mockResolvedValueOnce(true);
    vi.mocked(findById).mockResolvedValueOnce(null as any);
    const res = await request(app).patch('/api/v1/rooms/room-1').send({ title: 'Nuevo' });
    expect(res.status).toBe(404);
  });

  it('PATCH /rooms/:id 410 si está eliminada', async () => {
    vi.mocked(isOwner).mockResolvedValueOnce(true);
    vi.mocked(findById).mockResolvedValueOnce(deletedRoom as any);
    const res = await request(app).patch('/api/v1/rooms/room-1').send({ title: 'Nuevo' });
    expect(res.status).toBe(410);
  });

  it('PATCH /rooms/:id renombra si es dueño', async () => {
    vi.mocked(isOwner).mockResolvedValueOnce(true);
    vi.mocked(findById).mockResolvedValueOnce(room as any);
    vi.mocked(updateTitle).mockResolvedValueOnce({ ...room, title: 'Nuevo' } as any);
    const res = await request(app).patch('/api/v1/rooms/room-1').send({ title: 'Nuevo' });
    expect(res.status).toBe(200);
    expect(res.body.room.title).toBe('Nuevo');
    expect(updateTitle).toHaveBeenCalledWith('room-1', 'Nuevo');
  });

  it('DELETE /rooms/:id 403 si no es dueño', async () => {
    vi.mocked(isOwner).mockResolvedValueOnce(false);
    const res = await request(app).delete('/api/v1/rooms/room-1');
    expect(res.status).toBe(403);
  });

  it('DELETE /rooms/:id 404 si no existe', async () => {
    vi.mocked(isOwner).mockResolvedValueOnce(true);
    vi.mocked(findById).mockResolvedValueOnce(null as any);
    const res = await request(app).delete('/api/v1/rooms/room-1');
    expect(res.status).toBe(404);
  });

  it('DELETE /rooms/:id 410 si ya está eliminada', async () => {
    vi.mocked(isOwner).mockResolvedValueOnce(true);
    vi.mocked(findById).mockResolvedValueOnce(deletedRoom as any);
    const res = await request(app).delete('/api/v1/rooms/room-1');
    expect(res.status).toBe(410);
    expect(softRemoveById).not.toHaveBeenCalled();
  });

  it('DELETE /rooms/:id hace borrado lógico si es dueño', async () => {
    vi.mocked(isOwner).mockResolvedValueOnce(true);
    vi.mocked(findById).mockResolvedValueOnce(room as any);
    vi.mocked(softRemoveById).mockResolvedValueOnce(deletedRoom as any);
    const res = await request(app).delete('/api/v1/rooms/room-1');
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(softRemoveById).toHaveBeenCalledWith('room-1');
  });

  describe('DELETE /rooms/:id corta las sesiones de invitado en vivo', () => {
    const exp = new Date(Date.now() + 60 * 60 * 1000);
    const sessions = [
      { jti: '77777777-7777-4777-8777-777777777777', roomId: 'room-1', expiresAt: exp, revoked: false },
      { jti: '88888888-8888-4888-8888-888888888888', roomId: 'room-1', expiresAt: exp, revoked: false },
    ];

    it('marca cada jti en Redis, publica REVOKED y lo registra en la BD', async () => {
      vi.mocked(isOwner).mockResolvedValueOnce(true);
      vi.mocked(findById).mockResolvedValueOnce(room as any);
      vi.mocked(softRemoveById).mockResolvedValueOnce(deletedRoom as any);
      vi.mocked(listActiveByRoom).mockResolvedValueOnce(sessions as any);
      const res = await request(app).delete('/api/v1/rooms/room-1');
      expect(res.status).toBe(200);
      expect(listActiveByRoom).toHaveBeenCalledWith('room-1');
      const expSec = Math.floor(exp.getTime() / 1000);
      for (const { jti } of sessions) {
        expect(redis.set).toHaveBeenCalledWith(`token:revoked:${jti}`, '1', 'EXAT', expSec);
        expect(redis.publish).toHaveBeenCalledWith('room:room-1:sync', expect.stringContaining(`"jti":"${jti}"`));
      }
      expect(setRevokedMany).toHaveBeenCalledWith(sessions.map((s) => s.jti));
    });

    it('503 si Redis falla: la sala queda borrada y las sesiones siguen pendientes de revocar', async () => {
      vi.mocked(isOwner).mockResolvedValueOnce(true);
      vi.mocked(findById).mockResolvedValueOnce(room as any);
      vi.mocked(softRemoveById).mockResolvedValueOnce(deletedRoom as any);
      vi.mocked(listActiveByRoom).mockResolvedValueOnce(sessions as any);
      redis.publish.mockRejectedValueOnce(new Error('redis down'));
      const res = await request(app).delete('/api/v1/rooms/room-1');
      expect(res.status).toBe(503);
      expect(res.body.error).toMatch(/retry/i);
      expect(softRemoveById).toHaveBeenCalledWith('room-1');
      // Sin marcar en la BD: el reintento las vuelve a encontrar y re-publica.
      expect(setRevokedMany).not.toHaveBeenCalled();
    });

    it('un reintento sobre la sala ya borrada vuelve a revocar las sesiones pendientes y responde 410', async () => {
      vi.mocked(isOwner).mockResolvedValueOnce(true);
      vi.mocked(findById).mockResolvedValueOnce(deletedRoom as any);
      vi.mocked(listActiveByRoom).mockResolvedValueOnce(sessions as any);
      const res = await request(app).delete('/api/v1/rooms/room-1');
      expect(res.status).toBe(410);
      expect(softRemoveById).not.toHaveBeenCalled();
      expect(redis.publish).toHaveBeenCalledTimes(2);
      expect(setRevokedMany).toHaveBeenCalledWith(sessions.map((s) => s.jti));
    });

    it('el reintento sigue respondiendo 503 mientras Redis no responda', async () => {
      vi.mocked(isOwner).mockResolvedValueOnce(true);
      vi.mocked(findById).mockResolvedValueOnce(deletedRoom as any);
      vi.mocked(listActiveByRoom).mockResolvedValueOnce(sessions as any);
      redis.set.mockRejectedValueOnce(new Error('redis down'));
      const res = await request(app).delete('/api/v1/rooms/room-1');
      expect(res.status).toBe(503);
      expect(setRevokedMany).not.toHaveBeenCalled();
    });
  });

  it('POST /rooms/:id/invitations 410 si la sala está eliminada', async () => {
    vi.mocked(isOwner).mockResolvedValueOnce(true);
    vi.mocked(findById).mockResolvedValueOnce(deletedRoom as any);
    const res = await request(app).post('/api/v1/rooms/room-1/invitations').send({});
    expect(res.status).toBe(410);
    expect(createInvitation).not.toHaveBeenCalled();
  });

  it('POST /invitations/claim 410 si la sala está eliminada', async () => {
    vi.mocked(findByCode).mockResolvedValueOnce({ ...invitation } as any);
    vi.mocked(findById).mockResolvedValueOnce(deletedRoom as any);
    const res = await request(app).post('/api/v1/invitations/claim').send({ code: 'abc', nick: 'Ana' });
    expect(res.status).toBe(410);
  });

  it('POST /invitations/claim devuelve el titulo de la sala para el invitado', async () => {
    vi.mocked(findByCode).mockResolvedValueOnce({ ...invitation } as any);
    vi.mocked(findById).mockResolvedValueOnce(room as any);
    const res = await request(app).post('/api/v1/invitations/claim').send({ code: 'abc', nick: 'Ana' });
    expect(res.status).toBe(200);
    expect(res.body.roomTitle).toBe('Noche de cine');
  });

  it('POST /invitations/claim 400 si el nick supera 64 caracteres', async () => {
    const res = await request(app).post('/api/v1/invitations/claim').send({ code: 'abc', nick: 'a'.repeat(65) });
    expect(res.status).toBe(400);
    expect(findByCode).not.toHaveBeenCalled();
  });

  it('POST /invitations/claim registra la sesión del invitado con los datos del token', async () => {
    vi.mocked(findByCode).mockResolvedValueOnce({ ...invitation } as any);
    const res = await request(app).post('/api/v1/invitations/claim').send({ code: 'abc', nick: ' Ana ' });
    expect(res.status).toBe(200);
    const decoded = jwt.decode(res.body.token) as any;
    expect(createGuestSession).toHaveBeenCalledTimes(1);
    expect(createGuestSession).toHaveBeenCalledWith({
      jti: decoded.jti,
      roomId: 'room-1',
      sub: decoded.sub,
      nick: 'Ana',
      joinedAt: new Date(decoded.iat * 1000),
      expiresAt: new Date(decoded.exp * 1000),
      deviceId: null,
    });
  });

  it('POST /invitations/claim 500 (sin token) si no se puede registrar la sesión', async () => {
    vi.mocked(findByCode).mockResolvedValueOnce({ ...invitation } as any);
    vi.mocked(createGuestSession).mockRejectedValueOnce(new Error('db down'));
    const res = await request(app).post('/api/v1/invitations/claim').send({ code: 'abc', nick: 'Ana' });
    expect(res.status).toBe(500);
    expect(res.body.token).toBeUndefined();
  });
});
