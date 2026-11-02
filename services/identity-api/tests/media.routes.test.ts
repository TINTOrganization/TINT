import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import request from 'supertest';

vi.mock('../src/middlewares/auth.js', () => ({
  // Simula un ID token de Firebase ya verificado del host "host-1".
  requireAuthHost: (req: any, _res: any, next: any) => {
    req.user = { id: 'host-1', providerSub: 'sub-1', email: 'h@t.c', displayName: 'Host' };
    next();
  },
}));

vi.mock('../src/modules/rooms/rooms.repo.js', () => ({
  create: vi.fn(),
  listByHost: vi.fn(),
  findById: vi.fn(),
  isOwner: vi.fn(),
  setMedia: vi.fn(),
}));

vi.mock('../src/modules/invitations/invitations.repo.js', () => ({
  create: vi.fn(),
  findByCode: vi.fn(),
  setRevoked: vi.fn(),
}));

vi.mock('../src/modules/videos/videos.repo.js', () => ({
  create: vi.fn(),
  findById: vi.fn(async () => null),
}));

vi.mock('../src/modules/guests/guestSessions.repo.js', () => ({
  create: vi.fn(),
  findByJti: vi.fn(async () => null),
  listByRoom: vi.fn(),
  setRevoked: vi.fn(),
}));

import app from '../src/app.js';
import { env } from '../src/config/env.js';
import { findById, isOwner, setMedia } from '../src/modules/rooms/rooms.repo.js';
import { setMediaSigner } from '../src/modules/media/media.signer.js';
import { setRedisClient } from '../src/modules/tokens/revocation.js';
import { issueGuestToken } from '../src/modules/auth/auth.service.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const roomWithMedia = {
  id: 'room-1',
  hostId: 'host-1',
  title: 'Cine',
  mediaId: '11111111-1111-4111-8111-111111111111',
  mediaKey: 'videos/peli.mp4',
};

const presignGet = vi.fn(async (key: string, ttl: number) => `http://minio.test/tint-media/${key}?ttl=${ttl}`);
const revoked = new Set<string>();

beforeEach(() => {
  vi.clearAllMocks();
  // Por defecto la sala existe y está activa (requireActiveRoom).
  vi.mocked(findById).mockResolvedValue({ id: 'room-1', hostId: 'host-1', title: 'Sala', status: 'active', mediaId: null, mediaKey: null } as any);
  revoked.clear();
  setMediaSigner({ presignGet, presignPut: vi.fn() });
  setRedisClient({ exists: vi.fn(async (k: string) => (revoked.has(k) ? 1 : 0)) } as any);
});

afterEach(() => {
  setMediaSigner(null);
  setRedisClient(null);
});

describe('PUT /rooms/:id/media', () => {
  it('el dueño asigna el vídeo: genera mediaId uuid y lo persiste', async () => {
    vi.mocked(isOwner).mockResolvedValueOnce(true);
    vi.mocked(setMedia).mockImplementationOnce(async (_id: string, media: { mediaId: string; mediaKey: string }) => ({ ...roomWithMedia, ...media }) as any);
    const res = await request(app)
      .put('/api/v1/rooms/room-1/media')
      .set('Authorization', 'Bearer firebase-token')
      .send({ mediaKey: '  videos/nueva.mp4 ' });
    expect(res.status).toBe(200);
    expect(res.body.mediaKey).toBe('videos/nueva.mp4');
    expect(res.body.mediaId).toMatch(UUID_RE);
    expect(Object.keys(res.body).sort()).toEqual(['mediaId', 'mediaKey']);
    expect(setMedia).toHaveBeenCalledWith('room-1', { mediaId: res.body.mediaId, mediaKey: 'videos/nueva.mp4' });
  });

  it('cada PUT genera un mediaId nuevo', async () => {
    vi.mocked(isOwner).mockResolvedValue(true);
    vi.mocked(setMedia).mockResolvedValue(roomWithMedia as any);
    const a = await request(app).put('/api/v1/rooms/room-1/media').send({ mediaKey: 'a.mp4' });
    const b = await request(app).put('/api/v1/rooms/room-1/media').send({ mediaKey: 'a.mp4' });
    expect(a.body.mediaId).not.toBe(b.body.mediaId);
  });

  it('404 si la sala desaparece al guardar', async () => {
    vi.mocked(isOwner).mockResolvedValueOnce(true);
    vi.mocked(setMedia).mockResolvedValueOnce(null as any);
    const res = await request(app).put('/api/v1/rooms/room-1/media').send({ mediaKey: 'a.mp4' });
    expect(res.status).toBe(404);
  });

  it('403 si no es el dueño', async () => {
    vi.mocked(isOwner).mockResolvedValueOnce(false);
    const res = await request(app).put('/api/v1/rooms/room-1/media').send({ mediaKey: 'videos/a.mp4' });
    expect(res.status).toBe(403);
    expect(setMedia).not.toHaveBeenCalled();
  });

  it.each([
    ['vacía', '   '],
    ['con ..', 'videos/../secreto.mp4'],
    ['absoluta', '/etc/passwd'],
    ['demasiado larga', 'a'.repeat(513)],
    ['no string', 42],
  ])('400 si mediaKey es inválida (%s)', async (_caso, mediaKey) => {
    vi.mocked(isOwner).mockResolvedValueOnce(true);
    const res = await request(app).put('/api/v1/rooms/room-1/media').send({ mediaKey });
    expect(res.status).toBe(400);
    expect(setMedia).not.toHaveBeenCalled();
  });
});

describe('GET /rooms/:id/playback', () => {
  it('guest token de la sala obtiene URL firmada y expiresAt', async () => {
    vi.mocked(findById).mockResolvedValueOnce(roomWithMedia as any);
    const { token } = issueGuestToken('room-1', 'Ana');
    const before = Date.now();
    const res = await request(app).get('/api/v1/rooms/room-1/playback').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.mediaId).toBe(roomWithMedia.mediaId);
    expect(res.body.url).toBe(`http://minio.test/tint-media/videos/peli.mp4?ttl=${env.PLAYBACK_URL_TTL_SECONDS}`);
    expect(presignGet).toHaveBeenCalledWith('videos/peli.mp4', env.PLAYBACK_URL_TTL_SECONDS);
    const expiresAt = new Date(res.body.expiresAt).getTime();
    expect(new Date(res.body.expiresAt).toISOString()).toBe(res.body.expiresAt);
    expect(expiresAt).toBeGreaterThanOrEqual(before + env.PLAYBACK_URL_TTL_SECONDS * 1000 - 1000);
    expect(isOwner).not.toHaveBeenCalled();
  });

  it('guest token de otra sala → 403', async () => {
    const { token } = issueGuestToken('room-2', 'Ana');
    const res = await request(app).get('/api/v1/rooms/room-1/playback').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(403);
    expect(findById).not.toHaveBeenCalled();
  });

  it('guest token revocado → 401', async () => {
    const { token, payload } = issueGuestToken('room-1', 'Ana');
    revoked.add(`token:revoked:${payload.jti}`);
    const res = await request(app).get('/api/v1/rooms/room-1/playback').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(401);
    expect(findById).not.toHaveBeenCalled();
  });

  it('sala sin vídeo → los tres campos null', async () => {
    vi.mocked(findById).mockResolvedValueOnce({ ...roomWithMedia, mediaId: null, mediaKey: null } as any);
    const { token } = issueGuestToken('room-1', 'Ana');
    const res = await request(app).get('/api/v1/rooms/room-1/playback').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ mediaId: null, url: null, expiresAt: null, status: null, failureReason: null, ambilightUrl: null, qualities: [] });
    expect(presignGet).not.toHaveBeenCalled();
  });

  it('404 si la sala no existe', async () => {
    vi.mocked(findById).mockResolvedValueOnce(null as any);
    const { token } = issueGuestToken('room-1', 'Ana');
    const res = await request(app).get('/api/v1/rooms/room-1/playback').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(404);
  });

  it('host dueño con token de Firebase → OK', async () => {
    vi.mocked(isOwner).mockResolvedValueOnce(true);
    vi.mocked(findById).mockResolvedValueOnce(roomWithMedia as any);
    const res = await request(app).get('/api/v1/rooms/room-1/playback').set('Authorization', 'Bearer firebase-token');
    expect(res.status).toBe(200);
    expect(res.body.mediaId).toBe(roomWithMedia.mediaId);
    expect(isOwner).toHaveBeenCalledWith('room-1', 'host-1');
  });

  it('host no dueño con token de Firebase → 403', async () => {
    vi.mocked(isOwner).mockResolvedValueOnce(false);
    const res = await request(app).get('/api/v1/rooms/room-1/playback').set('Authorization', 'Bearer firebase-token');
    expect(res.status).toBe(403);
  });

  it('500 si falla el firmado', async () => {
    vi.mocked(findById).mockResolvedValueOnce(roomWithMedia as any);
    presignGet.mockRejectedValueOnce(new Error('sin credenciales'));
    const { token } = issueGuestToken('room-1', 'Ana');
    const res = await request(app).get('/api/v1/rooms/room-1/playback').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(500);
  });
});
