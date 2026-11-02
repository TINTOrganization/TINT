/**
 * Pruebas de aceptación del cierre de sala `ROOM_CLOSED` (ADR 0019 ·
 * docs/dominio-transmision.md §6.1, HU-LIVE-05 y HU-LIVE-09).
 *
 * Contrato que fijan para la implementación:
 * - `rooms.repo.disableById(id)`: `UPDATE rooms SET status='disabled'` (devuelve la sala).
 *   Se declara en el mock con `vi.hoisted` para no importar un export que aún no existe.
 * - `POST /rooms/:id/end` (Firebase + dueño) y `POST /internal/rooms/:id/disable`
 *   (`X-Internal-Token` = `INTERNAL_API_SECRET`) hacen, en orden: `SET room:{id}:closed 1`
 *   (sin TTL) → `PUBLISH room:{id}:sync ROOM_CLOSED` → `status='disabled'` → `XADD room_closed`.
 *   Si falla alguno de los tres primeros: 503 y la sala sigue `active` (el reintento repite todo).
 * - `reason` es `host_ended` (end) o `grace_expired` (interno), igual en ROOM_CLOSED y en analítica.
 * - Una sala `disabled` responde `410 {error:'Disabled'}` al unirse, al reproducir y en
 *   `requireActiveRoom`; el analytics-ticket sigue disponible y reactivar responde 409.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import request from 'supertest';

const INTERNAL_SECRET = 'internal-secret-de-prueba-0123456789';

const state = vi.hoisted(() => {
  process.env.INTERNAL_API_SECRET = 'internal-secret-de-prueba-0123456789';
  return {
    /** host: Firebase válido · none: sin ID token de Firebase (401). */
    auth: 'host' as 'host' | 'none',
    calls: [] as string[],
    disableById: vi.fn(),
  };
});

vi.mock('../src/middlewares/auth.js', () => ({
  requireAuthHost: (req: any, res: any, next: any) => {
    if (state.auth === 'none') return res.status(401).json({ error: 'Unauthorized' });
    req.user = { id: 'host-1', providerSub: 'sub-1', email: 'h@t.c', displayName: 'Host' };
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
  disableById: state.disableById,
}));

vi.mock('../src/modules/invitations/invitations.repo.js', () => ({
  create: vi.fn(),
  findByCode: vi.fn(),
  setRevoked: vi.fn(),
  listByRoom: vi.fn(),
  listLatestActiveByRooms: vi.fn(),
}));

vi.mock('../src/modules/guests/guestSessions.repo.js', () => ({
  create: vi.fn(async (s: unknown) => s),
  findByJti: vi.fn(async () => null),
  listByRoom: vi.fn(async () => []),
  setRevoked: vi.fn(),
  listActiveByRoom: vi.fn(async () => []),
  setRevokedMany: vi.fn(async () => []),
  listByRoomAndSub: vi.fn(async () => []),
}));

vi.mock('../src/modules/bans/roomBans.repo.js', () => ({
  create: vi.fn(),
  findByRoomAndDevice: vi.fn(async () => null),
  findByRoomAndSub: vi.fn(async () => null),
  listByRoom: vi.fn(async () => []),
  removeById: vi.fn(),
}));

vi.mock('../src/modules/videos/videos.repo.js', () => ({
  create: vi.fn(),
  findById: vi.fn(async () => null),
  transitionStatus: vi.fn(),
  listByUploader: vi.fn(async () => []),
  updateTitle: vi.fn(),
  removePendingById: vi.fn(),
  removeStalePendingByRoom: vi.fn(async () => []),
}));

import app from '../src/app.js';
import { findById, isOwner } from '../src/modules/rooms/rooms.repo.js';
import { findByCode } from '../src/modules/invitations/invitations.repo.js';
import { create as createGuestSession } from '../src/modules/guests/guestSessions.repo.js';
import { setRedisClient } from '../src/modules/tokens/revocation.js';
import { issueGuestToken } from '../src/modules/auth/auth.service.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

const liveRoom = {
  id: 'room-1',
  hostId: 'host-1',
  title: 'Directo',
  status: 'active',
  kind: 'live',
  mediaId: null,
  mediaKey: null,
};
const disabledRoom = { ...liveRoom, status: 'disabled' };

const redis = {
  set: vi.fn(async (key: string, ..._rest: unknown[]) => {
    state.calls.push(`redis:set ${key}`);
    return 'OK';
  }),
  publish: vi.fn(async (channel: string, _message: string) => {
    state.calls.push(`redis:publish ${channel}`);
    return 1;
  }),
  exists: vi.fn(async (..._keys: unknown[]) => 0),
  xadd: vi.fn(async (..._args: unknown[]) => {
    state.calls.push('redis:xadd');
    return '1-0';
  }),
};

/** Campos (pares clave/valor) del primer XADD de analytics:events con type=room_closed. */
function roomClosedFields() {
  const call = redis.xadd.mock.calls.find((args) => args[0] === 'analytics:events' && args.includes('room_closed'));
  if (!call) return null;
  const star = call.indexOf('*');
  const pairs = call.slice(star + 1) as string[];
  const fields: Record<string, string> = {};
  for (let i = 0; i < pairs.length; i += 2) fields[pairs[i]] = pairs[i + 1];
  return fields;
}

function roomClosedMessage() {
  const call = redis.publish.mock.calls.find(([channel]) => channel === 'room:room-1:sync');
  return call ? JSON.parse(call[1]) : null;
}

beforeEach(() => {
  vi.clearAllMocks();
  state.auth = 'host';
  state.calls = [];
  setRedisClient(redis as any);
  vi.mocked(isOwner).mockResolvedValue(true);
  vi.mocked(findById).mockResolvedValue(liveRoom as any);
  state.disableById.mockImplementation(async () => {
    state.calls.push('db:disable');
    return disabledRoom;
  });
});

afterEach(() => {
  setRedisClient(null);
});

describe('POST /rooms/:id/end (HU-LIVE-05)', () => {
  it('HU-LIVE-05 AC1: sobre una sala activa responde 200 y la deja en disabled', async () => {
    const res = await request(app).post('/api/v1/rooms/room-1/end').send({});

    expect(res.status).toBe(200);
    expect(state.disableById).toHaveBeenCalledWith('room-1');
  });

  it('HU-LIVE-05 AC1: escribe room:{id}:closed=1 sin TTL', async () => {
    await request(app).post('/api/v1/rooms/room-1/end').send({});

    // Exactamente (clave, valor): sin EX/PX/EXAT, la marca no caduca.
    expect(redis.set).toHaveBeenCalledWith('room:room-1:closed', '1');
  });

  it('HU-LIVE-05 AC1: publica ROOM_CLOSED reason=host_ended en room:{id}:sync', async () => {
    await request(app).post('/api/v1/rooms/room-1/end').send({});

    const message = roomClosedMessage();
    expect(message).toMatchObject({ type: 'ROOM_CLOSED', room_id: 'room-1', reason: 'host_ended' });
    expect(message.event_id).toMatch(UUID_RE);
    expect(message.occurred_at).toMatch(ISO_RE);
  });

  it('HU-LIVE-05 AC1: responde el cuerpo de §6.1 (room_id, status, reason, closed_at)', async () => {
    const res = await request(app).post('/api/v1/rooms/room-1/end').send({});

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      room_id: 'room-1',
      status: 'disabled',
      reason: 'host_ended',
      closed_at: expect.stringMatching(ISO_RE),
    });
    // closed_at es el mismo instante que occurred_at del ROOM_CLOSED.
    expect(res.body.closed_at).toBe(roomClosedMessage().occurred_at);
  });

  it('HU-LIVE-05 AC1: ROOM_CLOSED tiene exactamente los campos de §6.1', async () => {
    await request(app).post('/api/v1/rooms/room-1/end').send({});

    expect(Object.keys(roomClosedMessage()).sort()).toEqual(['event_id', 'occurred_at', 'reason', 'room_id', 'type']);
  });

  it('HU-LIVE-05 AC1: publica room_closed reason=host_ended en analytics:events', async () => {
    const res = await request(app).post('/api/v1/rooms/room-1/end').send({});

    expect(res.status).toBe(200);
    await vi.waitFor(() =>
      expect(roomClosedFields()).toMatchObject({ room_id: 'room-1', user_id: 'sub-1', reason: 'host_ended' }),
    );
  });

  it('ADR 0019: el orden es SET closed → PUBLISH ROOM_CLOSED → status disabled → XADD room_closed', async () => {
    const res = await request(app).post('/api/v1/rooms/room-1/end').send({});

    expect(res.status).toBe(200);
    await vi.waitFor(() => expect(state.calls).toContain('redis:xadd'));
    expect(state.calls).toEqual([
      'redis:set room:room-1:closed',
      'redis:publish room:room-1:sync',
      'db:disable',
      'redis:xadd',
    ]);
  });

  it('HU-LIVE-09 AC4: una segunda llamada sobre la sala ya deshabilitada responde 409 sin repetir efectos', async () => {
    vi.mocked(findById).mockResolvedValue(disabledRoom as any);

    const res = await request(app).post('/api/v1/rooms/room-1/end').send({});

    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: 'AlreadyDisabled' });
    expect(state.disableById).not.toHaveBeenCalled();
    expect(redis.set).not.toHaveBeenCalled();
    expect(redis.publish).not.toHaveBeenCalled();
    expect(redis.xadd).not.toHaveBeenCalled();
  });

  it('ADR 0019: si falla el SET responde 503 y la sala sigue active (se puede reintentar)', async () => {
    redis.set.mockRejectedValueOnce(new Error('redis down'));

    const res = await request(app).post('/api/v1/rooms/room-1/end').send({});

    expect(res.status).toBe(503);
    expect(state.disableById).not.toHaveBeenCalled();
    expect(redis.publish).not.toHaveBeenCalled();
    expect(redis.xadd).not.toHaveBeenCalled();
  });

  it('ADR 0019: si falla el PUBLISH responde 503 y la sala sigue active', async () => {
    redis.publish.mockRejectedValueOnce(new Error('redis down'));

    const res = await request(app).post('/api/v1/rooms/room-1/end').send({});

    expect(res.status).toBe(503);
    expect(state.disableById).not.toHaveBeenCalled();
    expect(redis.xadd).not.toHaveBeenCalled();
  });

  it('ADR 0019: si falla el UPDATE responde 503 y el reintento repite SET y PUBLISH (el aviso no se pierde)', async () => {
    state.disableById.mockRejectedValueOnce(new Error('db down'));

    const first = await request(app).post('/api/v1/rooms/room-1/end').send({});

    expect(first.status).toBe(503);
    expect(redis.xadd).not.toHaveBeenCalled();

    const retry = await request(app).post('/api/v1/rooms/room-1/end').send({});

    expect(retry.status).toBe(200);
    expect(redis.set).toHaveBeenCalledTimes(2);
    expect(redis.publish).toHaveBeenCalledTimes(2);
    expect(state.disableById).toHaveBeenCalledTimes(2);
  });

  it('ADR 0019: si la BD no responde al leer la sala responde 503 sin cerrar nada', async () => {
    vi.mocked(findById).mockRejectedValueOnce(new Error('db down'));

    const res = await request(app).post('/api/v1/rooms/room-1/end').send({});

    expect(res.status).toBe(503);
    expect(redis.set).not.toHaveBeenCalled();
  });

  it('ADR 0019: si otra petición borró la sala antes del UPDATE responde 410 Deleted', async () => {
    state.disableById.mockResolvedValueOnce(null);
    vi.mocked(findById)
      .mockResolvedValueOnce(liveRoom as any) // lectura inicial: activa
      .mockResolvedValueOnce({ ...liveRoom, status: 'deleted' } as any);

    const res = await request(app).post('/api/v1/rooms/room-1/end').send({});

    expect(res.status).toBe(410);
    expect(res.body).toEqual({ error: 'Deleted' });
    expect(redis.xadd).not.toHaveBeenCalled();
  });

  it('ADR 0019: si el UPDATE no cambia nada y la sala sigue activa responde 503 (reintentable)', async () => {
    state.disableById.mockResolvedValueOnce(null);

    const res = await request(app).post('/api/v1/rooms/room-1/end').send({});

    expect(res.status).toBe(503);
    expect(redis.xadd).not.toHaveBeenCalled();
  });

  it('ADR 0019: una sala watch responde 409 NotLive (se borra con DELETE) sin cerrar nada', async () => {
    vi.mocked(findById).mockResolvedValue({ ...liveRoom, kind: 'watch' } as any);

    const res = await request(app).post('/api/v1/rooms/room-1/end').send({});

    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: 'NotLive' });
    expect(redis.set).not.toHaveBeenCalled();
    expect(state.disableById).not.toHaveBeenCalled();
  });

  it('ADR 0019: una sala borrada responde 410 Deleted', async () => {
    vi.mocked(findById).mockResolvedValue({ ...liveRoom, status: 'deleted' } as any);

    const res = await request(app).post('/api/v1/rooms/room-1/end').send({});

    expect(res.status).toBe(410);
    expect(res.body).toEqual({ error: 'Deleted' });
    expect(redis.set).not.toHaveBeenCalled();
  });

  it('ADR 0019: si la sala desaparece tras la autorización responde 404', async () => {
    vi.mocked(findById).mockResolvedValue(null as any);

    const res = await request(app).post('/api/v1/rooms/room-1/end').send({});

    expect(res.status).toBe(404);
    expect(redis.set).not.toHaveBeenCalled();
  });

  it('ADR 0019: sin ID token de Firebase responde 401', async () => {
    state.auth = 'none';

    const res = await request(app).post('/api/v1/rooms/room-1/end').send({});

    expect(res.status).toBe(401);
    expect(redis.set).not.toHaveBeenCalled();
  });

  it('ADR 0019: quien no es dueño de la sala recibe 403 y no se cierra nada', async () => {
    vi.mocked(isOwner).mockResolvedValue(false);

    const res = await request(app).post('/api/v1/rooms/room-1/end').send({});

    expect(res.status).toBe(403);
    expect(state.disableById).not.toHaveBeenCalled();
    expect(redis.set).not.toHaveBeenCalled();
    expect(redis.publish).not.toHaveBeenCalled();
  });
});

describe('POST /internal/rooms/:id/disable (HU-LIVE-05 AC2, gracia vencida)', () => {
  const disable = () => request(app).post('/api/v1/internal/rooms/room-1/disable');

  it('HU-LIVE-05 AC2: sin X-Internal-Token responde 401 y no cierra la sala', async () => {
    const res = await disable().send({ reason: 'grace_expired' });

    expect(res.status).toBe(401);
    expect(state.disableById).not.toHaveBeenCalled();
    expect(redis.set).not.toHaveBeenCalled();
  });

  it('HU-LIVE-05 AC2: con un X-Internal-Token incorrecto (misma longitud) responde 401', async () => {
    const wrong = 'x'.repeat(INTERNAL_SECRET.length);

    const res = await disable().set('X-Internal-Token', wrong).send({ reason: 'grace_expired' });

    expect(res.status).toBe(401);
    expect(state.disableById).not.toHaveBeenCalled();
  });

  it('HU-LIVE-05 AC2: con un X-Internal-Token de otra longitud responde 401 (no 500 de timingSafeEqual)', async () => {
    const res = await disable().set('X-Internal-Token', 'corto').send({ reason: 'grace_expired' });

    expect(res.status).toBe(401);
    expect(state.disableById).not.toHaveBeenCalled();
  });

  it('HU-LIVE-05 AC2: con el token correcto (sin ID token de Firebase) deshabilita la sala con reason=grace_expired', async () => {
    state.auth = 'none';

    const res = await disable().set('X-Internal-Token', INTERNAL_SECRET).send({ reason: 'grace_expired' });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      room_id: 'room-1',
      status: 'disabled',
      reason: 'grace_expired',
      closed_at: expect.stringMatching(ISO_RE),
    });
    expect(redis.set).toHaveBeenCalledWith('room:room-1:closed', '1');
    expect(state.disableById).toHaveBeenCalledWith('room-1');
    const message = roomClosedMessage();
    expect(message).toMatchObject({ type: 'ROOM_CLOSED', room_id: 'room-1', reason: 'grace_expired' });
    expect(message.event_id).toMatch(UUID_RE);
    expect(message.occurred_at).toMatch(ISO_RE);
    await vi.waitFor(() => expect(roomClosedFields()).toMatchObject({ room_id: 'room-1', reason: 'grace_expired' }));
    expect(state.calls).toEqual([
      'redis:set room:room-1:closed',
      'redis:publish room:room-1:sync',
      'db:disable',
      'redis:xadd',
    ]);
  });

  it('HU-LIVE-05 AC2: sobre una sala ya deshabilitada responde 409', async () => {
    vi.mocked(findById).mockResolvedValue(disabledRoom as any);

    const res = await disable().set('X-Internal-Token', INTERNAL_SECRET).send({ reason: 'grace_expired' });

    expect(res.status).toBe(409);
    expect(state.disableById).not.toHaveBeenCalled();
    expect(redis.publish).not.toHaveBeenCalled();
  });

  it.each([
    ['inexistente', null, 404, { error: 'Not found' }],
    ['watch', { ...liveRoom, kind: 'watch' }, 409, { error: 'NotLive' }],
    ['borrada', { ...liveRoom, status: 'deleted' }, 410, { error: 'Deleted' }],
  ])('ADR 0019: sala %s responde el error de §6.1', async (_name, room, status, body) => {
    vi.mocked(findById).mockResolvedValue(room as any);

    const res = await disable().set('X-Internal-Token', INTERNAL_SECRET).send({ reason: 'grace_expired' });

    expect(res.status).toBe(status);
    expect(res.body).toEqual(body);
    expect(redis.set).not.toHaveBeenCalled();
  });

  it('ADR 0019: un id que no es uuid responde 404 (no 500)', async () => {
    vi.mocked(findById).mockRejectedValueOnce(Object.assign(new Error('invalid input syntax for type uuid'), { code: '22P02' }));

    const res = await request(app).post('/api/v1/internal/rooms/no-es-uuid/disable').set('X-Internal-Token', INTERNAL_SECRET);

    expect(res.status).toBe(404);
    expect(redis.set).not.toHaveBeenCalled();
  });

  it('ADR 0019: un reason distinto de grace_expired responde 400', async () => {
    const res = await disable().set('X-Internal-Token', INTERNAL_SECRET).send({ reason: 'porque_si' });

    expect(res.status).toBe(400);
    expect(state.disableById).not.toHaveBeenCalled();
  });

  it('ADR 0019: reason=host_ended no se acepta por la ruta interna (solo la usa la gracia) → 400', async () => {
    const res = await disable().set('X-Internal-Token', INTERNAL_SECRET).send({ reason: 'host_ended' });

    expect(res.status).toBe(400);
    expect(redis.set).not.toHaveBeenCalled();
  });

  it('ADR 0019: si Redis falla responde 503 y la sala sigue active (stream-core reintenta)', async () => {
    redis.set.mockRejectedValueOnce(new Error('redis down'));

    const res = await disable().set('X-Internal-Token', INTERNAL_SECRET).send({ reason: 'grace_expired' });

    expect(res.status).toBe(503);
    expect(state.disableById).not.toHaveBeenCalled();
    expect(redis.publish).not.toHaveBeenCalled();
  });
});

describe('sala deshabilitada (HU-LIVE-09)', () => {
  beforeEach(() => {
    vi.mocked(findById).mockResolvedValue(disabledRoom as any);
  });

  it('HU-LIVE-09 AC2: POST /invitations/claim con el código de una sala deshabilitada responde 410 Disabled', async () => {
    vi.mocked(findByCode).mockResolvedValue({
      id: 'inv-1',
      code: 'abc123def456',
      roomId: 'room-1',
      createdBy: 'host-1',
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
      revoked: false,
    } as any);

    const res = await request(app).post('/api/v1/invitations/claim').send({ code: 'abc123def456', nick: 'Ana' });

    expect(res.status).toBe(410);
    expect(res.body).toEqual({ error: 'Disabled' });
    expect(createGuestSession).not.toHaveBeenCalled();
  });

  it('HU-LIVE-09 AC2: GET /rooms/:id/playback de una sala deshabilitada responde 410 Disabled', async () => {
    const { token } = issueGuestToken('room-1', 'Ana');

    const res = await request(app).get('/api/v1/rooms/room-1/playback').set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(410);
    expect(res.body).toEqual({ error: 'Disabled' });
  });

  it('HU-LIVE-09: requireActiveRoom responde 410 Disabled (POST /rooms/:id/sync-ticket)', async () => {
    const res = await request(app).post('/api/v1/rooms/room-1/sync-ticket').send({});

    expect(res.status).toBe(410);
    expect(res.body).toEqual({ error: 'Disabled' });
  });

  it('HU-LIVE-09: requireActiveRoom responde 410 Disabled (GET /rooms/:id/guests)', async () => {
    const res = await request(app).get('/api/v1/rooms/room-1/guests');

    expect(res.status).toBe(410);
    expect(res.body).toEqual({ error: 'Disabled' });
  });

  // Guarda de no regresión (verde hoy a propósito): el resumen sigue legible tras deshabilitar.
  it('HU-LIVE-09 AC3: POST /rooms/:id/analytics-ticket sigue respondiendo 200 para una sala deshabilitada', async () => {
    const res = await request(app).post('/api/v1/rooms/room-1/analytics-ticket').send({});

    expect(res.status).toBe(200);
    expect(typeof res.body.token).toBe('string');
  });

  it('HU-LIVE-05 AC4 / HU-LIVE-09 AC4: POST /rooms/:id/reactivate sobre una sala deshabilitada responde 409 NotReactivable', async () => {
    const res = await request(app).post('/api/v1/rooms/room-1/reactivate').send({});

    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: 'NotReactivable' });
    expect(redis.set).not.toHaveBeenCalled();
  });

  it('ADR 0019: reactivar responde 409 NotReactivable siempre (también con la sala activa)', async () => {
    vi.mocked(findById).mockResolvedValue(liveRoom as any);

    const res = await request(app).post('/api/v1/rooms/room-1/reactivate').send({});

    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: 'NotReactivable' });
  });

  it('ADR 0019: reactivar exige ser el dueño (403)', async () => {
    vi.mocked(isOwner).mockResolvedValue(false);

    const res = await request(app).post('/api/v1/rooms/room-1/reactivate').send({});

    expect(res.status).toBe(403);
  });

  it('HU-LIVE-09: PATCH /rooms/:id sobre una sala deshabilitada responde 410 Disabled', async () => {
    const res = await request(app).patch('/api/v1/rooms/room-1').send({ title: 'Otro' });

    expect(res.status).toBe(410);
    expect(res.body).toEqual({ error: 'Disabled' });
  });

  it('HU-LIVE-09: POST /rooms/:id/invitations sobre una sala deshabilitada responde 410 Disabled', async () => {
    const res = await request(app).post('/api/v1/rooms/room-1/invitations').send({});

    expect(res.status).toBe(410);
    expect(res.body).toEqual({ error: 'Disabled' });
  });

  it('HU-LIVE-09: GET /rooms/:id/invitations sigue respondiendo 200 con la sala deshabilitada', async () => {
    const { listByRoom } = await import('../src/modules/invitations/invitations.repo.js');
    vi.mocked(listByRoom).mockResolvedValueOnce([]);

    const res = await request(app).get('/api/v1/rooms/room-1/invitations');

    expect(res.status).toBe(200);
  });

  it('HU-LIVE-09: GET /rooms sigue listando la sala deshabilitada', async () => {
    const { listByHost } = await import('../src/modules/rooms/rooms.repo.js');
    const { listLatestActiveByRooms } = await import('../src/modules/invitations/invitations.repo.js');
    vi.mocked(listByHost).mockResolvedValueOnce([disabledRoom] as any);
    vi.mocked(listLatestActiveByRooms).mockResolvedValueOnce(new Map());

    const res = await request(app).get('/api/v1/rooms');

    expect(res.status).toBe(200);
    expect(res.body.rooms[0]).toMatchObject({ status: 'disabled', kind: 'live' });
  });

  it('HU-LIVE-09: GET /rooms/:id sigue devolviendo la sala deshabilitada (con status y kind) para el dueño', async () => {
    const res = await request(app).get('/api/v1/rooms/room-1');

    expect(res.status).toBe(200);
    expect(res.body.room).toMatchObject({ status: 'disabled', kind: 'live' });
  });
});
