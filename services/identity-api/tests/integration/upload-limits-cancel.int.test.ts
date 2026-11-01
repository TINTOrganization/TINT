/**
 * Límite de subida, subida interrumpida y limpieza, contra la infraestructura real
 * (docker compose: PostgreSQL, Redis y MinIO). Solo se simula la verificación del ID
 * token de Firebase; la BD, el bucket y las URLs firmadas son reales.
 *
 * Solo corre con INTEGRATION=1 (`npm run test:integration`). Deja la BD y el bucket
 * como los encontró: borra la sala y los vídeos que crea.
 */
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import request from 'supertest';

const state = vi.hoisted(() => ({ userId: '' }));

vi.mock('../../src/middlewares/auth.js', () => ({
  requireAuthHost: (req: any, _res: any, next: any) => {
    req.user = { id: state.userId, providerSub: 'it-upload', email: 'upload@tint.test', displayName: 'Host IT' };
    next();
  },
}));

const RUN = !!process.env.INTEGRATION;

describe.skipIf(!RUN)('límite, subida interrumpida y limpieza con servicios reales', () => {
  let app: any;
  let roomId = '';
  const created: string[] = [];
  let db: any;
  let videosTable: any;
  let store: any;
  let findVideo: (id: string) => Promise<any>;
  let env: any;

  const reserve = (body: object = { filename: 'clip.mp4', contentType: 'video/mp4', sizeBytes: 64 * 1024 * 1024 }) =>
    request(app).post(`/api/v1/rooms/${roomId}/media/uploads`).send(body);

  beforeAll(async () => {
    ({ default: app } = await import('../../src/app.js'));
    ({ env } = await import('../../src/config/env.js'));
    ({ db } = await import('../../src/db/client.js'));
    ({ videos: videosTable } = await import('../../src/db/schema.js'));
    ({ findById: findVideo } = await import('../../src/modules/videos/videos.repo.js'));
    store = (await import('../../src/modules/media/media.store.js')).getMediaStore();
    const users = await import('../../src/modules/users/users.repo.js');
    const user = await users.upsertByProvider({ providerSub: `it-upload-${Date.now()}`, email: 'upload@tint.test', displayName: 'Host IT' });
    state.userId = user.id;
    const room = await request(app).post('/api/v1/rooms').send({ title: 'Prueba de subidas' });
    expect(room.status).toBe(200);
    roomId = room.body.room.id;
  });

  afterAll(async () => {
    const { eq } = await import('drizzle-orm');
    const { rooms, users: usersTable } = await import('../../src/db/schema.js');
    for (const key of created) await store.remove(key).catch(() => {});
    if (roomId) {
      await db.delete(videosTable).where(eq(videosTable.roomId, roomId)); // por si quedó alguna fila
      await db.delete(rooms).where(eq(rooms.id, roomId));
    }
    if (state.userId) await db.delete(usersTable).where(eq(usersTable.id, state.userId)).catch(() => {});
    const { pool } = await import('../../src/db/client.js');
    await pool.end();
    const { getRedisClient } = await import('../../src/modules/tokens/revocation.js');
    await (getRedisClient() as any).quit?.();
  });

  it('GET /uploads/limits informa el límite real y el 413 lo trae en el cuerpo', async () => {
    const limits = await request(app).get('/api/v1/uploads/limits');
    expect(limits.status).toBe(200);
    expect(limits.body).toEqual({ maxUploadBytes: env.MAX_UPLOAD_BYTES });

    const tooBig = await reserve({ filename: 'enorme.mp4', contentType: 'video/mp4', sizeBytes: env.MAX_UPLOAD_BYTES + 1 });
    expect(tooBig.status).toBe(413);
    expect(tooBig.body).toEqual({ error: 'File too large', maxUploadBytes: env.MAX_UPLOAD_BYTES });
  });

  it('una subida cortada a mitad no deja objeto parcial; cancelarla borra la fila y el reintento funciona', async () => {
    const first = await reserve();
    expect(first.status).toBe(200);
    const { videoId, uploadUrl, storageKey, headers } = first.body;
    created.push(storageKey);

    // PUT que se corta a la mitad: se envían unos MiB y se aborta la conexión.
    const ctrl = new AbortController();
    const chunk = Buffer.alloc(1024 * 1024, 7);
    let sent = 0;
    const body = new ReadableStream({
      async pull(controller) {
        if (sent >= 4) {
          ctrl.abort();
          return;
        }
        controller.enqueue(chunk);
        sent += 1;
        await new Promise((r) => setTimeout(r, 20));
      },
    });
    await fetch(uploadUrl, { method: 'PUT', headers, body, duplex: 'half', signal: ctrl.signal } as any).catch(() => {});
    expect(await store.stat(storageKey)).toBeNull(); // sin archivo parcial en MinIO
    expect((await findVideo(videoId))?.status).toBe('pending'); // la fila sí quedó

    const cancel = await request(app).delete(`/api/v1/rooms/${roomId}/media/uploads/${videoId}`);
    expect(cancel.status).toBe(204);
    expect(await findVideo(videoId)).toBeNull();
    // Idempotente: repetir no falla.
    expect((await request(app).delete(`/api/v1/rooms/${roomId}/media/uploads/${videoId}`)).status).toBe(204);

    // Reintento completo con un archivo pequeño: reserva, PUT y confirmación.
    const small = Buffer.from('contenido de prueba');
    const retry = await reserve({ filename: 'clip.mp4', contentType: 'video/mp4', sizeBytes: small.length });
    created.push(retry.body.storageKey);
    expect((await fetch(retry.body.uploadUrl, { method: 'PUT', headers: retry.body.headers, body: small })).status).toBe(200);
    expect((await store.stat(retry.body.storageKey))?.size).toBe(small.length);
    const done = await request(app).post(`/api/v1/rooms/${roomId}/media/uploads/${retry.body.videoId}/complete`);
    expect(done.status).toBe(200);

    // Ya confirmada (processing): no se puede cancelar y la fila sigue.
    const late = await request(app).delete(`/api/v1/rooms/${roomId}/media/uploads/${retry.body.videoId}`);
    expect(late.status).toBe(409);
    expect(await findVideo(retry.body.videoId)).not.toBeNull();
  }, 60_000);

  it('reservar limpia las subidas pending abandonadas (fila y objeto) y respeta las recientes', async () => {
    const { eq } = await import('drizzle-orm');
    const abandoned = await reserve();
    const recent = await reserve();
    created.push(abandoned.body.storageKey, recent.body.storageKey);
    // El objeto de la abandonada sí llegó al bucket (subida completa pero nunca confirmada).
    const file = Buffer.from('huérfano');
    await fetch(abandoned.body.uploadUrl, { method: 'PUT', headers: abandoned.body.headers, body: file });
    expect(await store.stat(abandoned.body.storageKey)).not.toBeNull();

    // La fila se hace más vieja que TTL + 1 h.
    const old = new Date(Date.now() - (env.UPLOAD_URL_TTL_SECONDS * 1000 + 61 * 60 * 1000));
    await db.update(videosTable).set({ createdAt: old }).where(eq(videosTable.id, abandoned.body.videoId));

    const next = await reserve();
    expect(next.status).toBe(200);
    created.push(next.body.storageKey);
    expect(await findVideo(abandoned.body.videoId)).toBeNull();
    expect(await store.stat(abandoned.body.storageKey)).toBeNull();
    expect(await findVideo(recent.body.videoId)).not.toBeNull(); // la reciente se respeta
  }, 60_000);
});
