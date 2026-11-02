/**
 * MED-02 / MED-03 contra la infraestructura real (docker compose: PostgreSQL, Redis, MinIO y
 * media-worker): un vídeo inválido queda `failed` con su motivo y `playback` lo devuelve; un vídeo
 * válido queda `ready` sin motivo.
 *
 * Solo corre con INTEGRATION=1 y necesita media-worker en marcha y `ffmpeg` local. Solo se simula
 * la verificación del ID token de Firebase. Borra la sala, los vídeos y el usuario que crea.
 */
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const state = vi.hoisted(() => ({ userId: '' }));

vi.mock('../../src/middlewares/auth.js', () => ({
  requireAuthHost: (req: any, _res: any, next: any) => {
    req.user = { id: state.userId, providerSub: 'it-failure', email: 'failure@tint.test', displayName: 'Host IT' };
    next();
  },
}));

const RUN = !!process.env.INTEGRATION;

describe.skipIf(!RUN)('motivo del fallo de procesamiento con servicios reales', () => {
  let app: any;
  let roomId = '';
  let guestToken = '';
  let db: any;
  const keys: string[] = [];

  async function upload(filename: string, contentType: string, body: Buffer) {
    const start = await request(app)
      .post(`/api/v1/rooms/${roomId}/media/uploads`)
      .send({ filename, contentType, sizeBytes: body.length });
    expect(start.status).toBe(200);
    keys.push(start.body.storageKey);
    const put = await fetch(start.body.uploadUrl, { method: 'PUT', headers: start.body.headers, body });
    expect(put.status).toBe(200);
    const done = await request(app).post(`/api/v1/rooms/${roomId}/media/uploads/${start.body.videoId}/complete`);
    expect(done.status).toBe(200);
    return start.body.videoId as string;
  }

  /** Espera a que media-worker termine (ready o failed) y devuelve el playback que ve un invitado. */
  async function finished() {
    let body: any = {};
    for (let i = 0; i < 80 && body.status !== 'ready' && body.status !== 'failed'; i++) {
      await new Promise((r) => setTimeout(r, 500));
      body = (await request(app).get(`/api/v1/rooms/${roomId}/playback`).set('Authorization', `Bearer ${guestToken}`)).body;
    }
    return body;
  }

  beforeAll(async () => {
    ({ default: app } = await import('../../src/app.js'));
    ({ db } = await import('../../src/db/client.js'));
    const users = await import('../../src/modules/users/users.repo.js');
    const user = await users.upsertByProvider({ providerSub: `it-failure-${Date.now()}`, email: 'failure@tint.test', displayName: 'Host IT' });
    state.userId = user.id;
    const room = await request(app).post('/api/v1/rooms').send({ title: 'Prueba de motivos de fallo' });
    expect(room.status).toBe(200);
    roomId = room.body.room.id;
    const claim = await request(app).post('/api/v1/invitations/claim').send({ code: room.body.invitation.code, nick: 'Invitada' });
    expect(claim.status).toBe(200);
    guestToken = claim.body.token;
  });

  afterAll(async () => {
    const { eq } = await import('drizzle-orm');
    const { rooms, users: usersTable, videos } = await import('../../src/db/schema.js');
    const store = (await import('../../src/modules/media/media.store.js')).getMediaStore();
    for (const key of keys) await store.remove(key).catch(() => {});
    if (roomId) {
      await db.delete(videos).where(eq(videos.roomId, roomId));
      await db.delete(rooms).where(eq(rooms.id, roomId));
    }
    if (state.userId) await db.delete(usersTable).where(eq(usersTable.id, state.userId)).catch(() => {});
    const { pool } = await import('../../src/db/client.js');
    await pool.end();
    const { getRedisClient } = await import('../../src/modules/tokens/revocation.js');
    await (getRedisClient() as any).quit?.();
  });

  it('un archivo que no es vídeo queda failed con motivo `unreadable`', async () => {
    const id = await upload('roto.mp4', 'video/mp4', Buffer.from('esto no es un vídeo'));
    const body = await finished();
    expect(body).toMatchObject({ mediaId: id, status: 'failed', failureReason: 'unreadable', url: null, qualities: [] });
  }, 60_000);

  it('una extensión no admitida queda failed con motivo `unsupported_format`', async () => {
    const id = await upload('peli.avi', 'video/x-msvideo', Buffer.from('da igual el contenido'));
    const body = await finished();
    expect(body).toMatchObject({ mediaId: id, status: 'failed', failureReason: 'unsupported_format' });
  }, 60_000);

  it('un vídeo válido queda ready, sin motivo de fallo', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tint-it-'));
    const file = join(dir, 'clip.mp4');
    execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc=duration=3:size=320x180:rate=10', '-pix_fmt', 'yuv420p', file]);
    const id = await upload('clip.mp4', 'video/mp4', readFileSync(file));
    const body = await finished();
    expect(body).toMatchObject({ mediaId: id, status: 'ready', failureReason: null });
    expect(body.url).toContain(`${id}/source.mp4`);
  }, 90_000);
});
