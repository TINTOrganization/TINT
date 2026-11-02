/**
 * Pruebas de aceptación de las salas `live` en `POST /events/start`
 * (ADR 0019 · docs/dominio-transmision.md).
 *
 * Se prueba la orquestación real (eventStart.service + eventStart.clients):
 * solo se sustituyen los repos, Redis (setRedisClient) y `fetch` (los upstreams).
 * Las URLs de los upstreams se fijan antes de importar la app para que el
 * schema de env las lea (STREAM_CORE_URL todavía no existe en el schema).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import request from 'supertest';

vi.hoisted(() => {
  process.env.SYNC_CORE_URL = 'http://sync-core.test:8083';
  process.env.SOCIAL_CORE_URL = 'http://social-core.test:8082';
  process.env.ANALYTICS_URL = 'http://analytics.test:8084';
  process.env.STREAM_CORE_URL = 'http://stream-core.test:8086';
});

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
  softRemoveById: vi.fn(),
  updateTitle: vi.fn(),
  setMedia: vi.fn(),
}));

vi.mock('../src/modules/invitations/invitations.repo.js', () => ({
  create: vi.fn(),
  findByCode: vi.fn(),
  setRevoked: vi.fn(),
  listByRoom: vi.fn(),
  listLatestActiveByRooms: vi.fn(),
}));

import app from '../src/app.js';
import { create as createRoom, softRemoveById } from '../src/modules/rooms/rooms.repo.js';
import { create as createInvitation } from '../src/modules/invitations/invitations.repo.js';
import { setRedisClient } from '../src/modules/tokens/revocation.js';

const STREAM = 'http://stream-core.test:8086';
const SYNC = 'http://sync-core.test:8083';
const SOCIAL = 'http://social-core.test:8082';
const ANALYTICS = 'http://analytics.test:8084';

const redis = {
  set: vi.fn(async (..._args: unknown[]) => 'OK'),
  publish: vi.fn(async () => 1),
  exists: vi.fn(async () => 0),
  xadd: vi.fn(async () => '1-0'),
};

/** Respuesta del upstream según la URL; `failing` hace fallar al que empiece por esa base. */
let failing: string | null = null;
const fetchMock = vi.fn(async (url: string | URL, _init?: RequestInit) => {
  const href = String(url);
  if (failing && href.startsWith(failing)) {
    return new Response(JSON.stringify({ error: 'down' }), { status: 500, headers: { 'content-type': 'application/json' } });
  }
  return new Response(JSON.stringify({ sessionId: href }), { status: 200, headers: { 'content-type': 'application/json' } });
});

const calledUrls = () => fetchMock.mock.calls.map(([url, init]) => `${init?.method ?? 'GET'} ${String(url)}`);

beforeEach(() => {
  vi.clearAllMocks();
  failing = null;
  vi.stubGlobal('fetch', fetchMock);
  setRedisClient(redis as any);
  vi.mocked(createRoom).mockImplementation(async (input: any) => ({
    id: 'room-1',
    hostId: 'host-1',
    title: input.title,
    status: 'active',
    kind: input.kind ?? 'watch',
    mediaId: null,
    mediaKey: null,
  }) as any);
  vi.mocked(createInvitation).mockResolvedValue({
    id: 'inv-1',
    code: 'abc123def456',
    roomId: 'room-1',
    createdBy: 'host-1',
    expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
    revoked: false,
  } as any);
  vi.mocked(softRemoveById).mockResolvedValue(null as any);
});

afterEach(() => {
  vi.unstubAllGlobals();
  setRedisClient(null);
});

describe('POST /events/start con kind=live (ADR 0019)', () => {
  it('HU-LIVE-05: una sala live se crea con kind=live y registra stream-core en lugar de sync-core', async () => {
    const res = await request(app).post('/api/v1/events/start').send({ title: 'Directo', kind: 'live' });

    expect(res.status).toBe(200);
    expect(createRoom).toHaveBeenCalledWith(expect.objectContaining({ title: 'Directo', hostId: 'host-1', kind: 'live' }));
    const urls = calledUrls();
    expect(urls).toContain(`POST ${STREAM}/internal/events/start/room-1`);
    expect(urls.some((u) => u.includes(SYNC))).toBe(false);
    expect(urls).toContain(`POST ${SOCIAL}/internal/events/start/room-1`);
    expect(urls).toContain(`POST ${ANALYTICS}/internal/events/start/room-1`);
  });

  it('HU-LIVE-05: para una sala live escribe room:{id}:kind=live en Redis (voz en modo escenario)', async () => {
    const res = await request(app).post('/api/v1/events/start').send({ title: 'Directo', kind: 'live' });

    expect(res.status).toBe(200);
    const kindWrite = redis.set.mock.calls.find(([key]) => key === 'room:room-1:kind');
    // Mismo TTL que room:{id}:stream:enabled: 24 h.
    expect(kindWrite).toEqual(['room:room-1:kind', 'live', 'EX', 86400]);
    expect(res.body.room).toMatchObject({ kind: 'live' });
  });

  it('ADR 0019: si no se puede escribir room:{id}:kind responde 503 y compensa todo (falla cerrado)', async () => {
    redis.set.mockRejectedValueOnce(new Error('redis down'));

    const res = await request(app).post('/api/v1/events/start').send({ title: 'Directo', kind: 'live' });

    expect(res.status).toBe(503);
    const urls = calledUrls();
    expect(urls).toContain(`DELETE ${STREAM}/internal/events/start/room-1`);
    expect(urls).toContain(`DELETE ${SOCIAL}/internal/events/start/room-1`);
    expect(urls).toContain(`DELETE ${ANALYTICS}/internal/events/start/room-1`);
    expect(softRemoveById).toHaveBeenCalledWith('room-1');
  });

  it('ADR 0019: si social-core falla en una sala live compensa stream-core con DELETE', async () => {
    failing = SOCIAL;

    const res = await request(app).post('/api/v1/events/start').send({ title: 'Directo', kind: 'live' });

    expect(res.status).toBe(503);
    expect(calledUrls()).toContain(`DELETE ${STREAM}/internal/events/start/room-1`);
    expect(calledUrls().some((u) => u.includes(SYNC))).toBe(false);
    expect(redis.set.mock.calls.some(([key]) => key === 'room:room-1:kind')).toBe(false);
  });

  it('HU-LIVE-05: si stream-core falla responde 503 y compensa (borra la sala) sin tocar sync-core', async () => {
    failing = STREAM;

    const res = await request(app).post('/api/v1/events/start').send({ title: 'Directo', kind: 'live' });

    expect(res.status).toBe(503);
    expect(calledUrls()).toContain(`POST ${STREAM}/internal/events/start/room-1`);
    expect(calledUrls().some((u) => u.includes(SYNC))).toBe(false);
    expect(softRemoveById).toHaveBeenCalledWith('room-1');
  });

  it('ADR 0019: un kind desconocido responde 400', async () => {
    const res = await request(app).post('/api/v1/events/start').send({ title: 'Directo', kind: 'cine' });

    expect(res.status).toBe(400);
    expect(createRoom).not.toHaveBeenCalled();
  });

  // Guarda de no regresión (verde hoy a propósito): sin kind la sala es watch y nada cambia.
  it('ADR 0019: sin kind la sala es watch: registra sync-core, no stream-core ni room:{id}:kind', async () => {
    const res = await request(app).post('/api/v1/events/start').send({ title: 'Cine' });

    expect(res.status).toBe(200);
    const urls = calledUrls();
    expect(urls).toContain(`POST ${SYNC}/internal/events/start/room-1`);
    expect(urls.some((u) => u.includes(STREAM))).toBe(false);
    expect(redis.set.mock.calls.some(([key]) => key === 'room:room-1:kind')).toBe(false);
  });
});
