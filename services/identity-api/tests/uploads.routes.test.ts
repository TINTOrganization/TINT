import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import request from 'supertest';

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

vi.mock('../src/modules/videos/videos.repo.js', () => ({
  create: vi.fn(async (v: any) => v),
  findById: vi.fn(),
  transitionStatus: vi.fn(),
  removePendingById: vi.fn(),
  removeStalePendingByRoom: vi.fn(async () => []),
}));

import app from '../src/app.js';
import { env } from '../src/config/env.js';
import { findById as findRoom, isOwner, setMedia } from '../src/modules/rooms/rooms.repo.js';
import {
  create as createVideo,
  findById as findVideo,
  removePendingById,
  removeStalePendingByRoom,
  transitionStatus,
} from '../src/modules/videos/videos.repo.js';
import { setMediaSigner } from '../src/modules/media/media.signer.js';
import { setMediaStore } from '../src/modules/media/media.store.js';
import { setRedisClient } from '../src/modules/tokens/revocation.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const VID = '66666666-6666-4666-8666-666666666666';
const activeRoom = { id: 'room-1', hostId: 'host-1', title: 'Sala', status: 'active', mediaId: null, mediaKey: null };
const pending = { id: VID, roomId: 'room-1', uploadedBy: 'host-1', storageKey: `incoming/${VID}/original.mp4`, contentType: 'video/mp4', sizeBytes: 10, status: 'pending' };

const presignPut = vi.fn(async (key: string, ct: string, ttl: number) => `http://minio.test/tint-media/${key}?put&ct=${ct}&ttl=${ttl}`);
const presignGet = vi.fn(async (key: string, ttl: number) => `http://minio.test/tint-media/${key}?ttl=${ttl}`);
const stat = vi.fn(async (): Promise<{ size: number } | null> => ({ size: 10 }));
const remove = vi.fn(async () => {});
const xadd = vi.fn(async () => '1-0');

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(findRoom).mockResolvedValue(activeRoom as any);
  vi.mocked(isOwner).mockResolvedValue(true);
  setMediaSigner({ presignGet, presignPut });
  setMediaStore({ stat, remove });
  setRedisClient({ xadd, exists: vi.fn(async () => 0) } as any);
  vi.mocked(transitionStatus).mockImplementation(async (_id, _from, to) => ({ ...pending, status: to }) as any);
  vi.mocked(removeStalePendingByRoom).mockResolvedValue([]);
});

afterEach(() => {
  setMediaSigner(null);
  setMediaStore(null);
  setRedisClient(null);
});

const start = (body: object) => request(app).post('/api/v1/rooms/room-1/media/uploads').send(body);

describe('POST /rooms/:id/media/uploads', () => {
  it('crea el vídeo pendiente y devuelve una URL PUT firmada', async () => {
    const res = await start({ filename: 'Mi Peli.MP4', contentType: 'video/mp4', sizeBytes: 5_000_000 });
    expect(res.status).toBe(200);
    const { videoId, storageKey, uploadUrl, expiresAt, headers } = res.body;
    expect(videoId).toMatch(UUID_RE);
    // Staging: el original nunca va a la clave publicada; el media-worker publica
    // {id}/source.<ext> solo si el vídeo es válido (y actualiza storage_key).
    expect(storageKey).toBe(`incoming/${videoId}/original.mp4`);
    expect(uploadUrl).toBe(`http://minio.test/tint-media/${storageKey}?put&ct=video/mp4&ttl=${env.UPLOAD_URL_TTL_SECONDS}`);
    expect(headers).toEqual({ 'Content-Type': 'video/mp4' });
    expect(new Date(expiresAt).getTime()).toBeGreaterThan(Date.now());
    expect(createVideo).toHaveBeenCalledWith({
      id: videoId,
      roomId: 'room-1',
      uploadedBy: 'host-1',
      storageKey,
      contentType: 'video/mp4',
      sizeBytes: 5_000_000,
      status: 'pending',
      title: 'Mi Peli',
    });
  });

  it.each([
    ['Mi Peli.MP4', 'Mi Peli'],
    ['sin-extension', 'sin-extension'],
    ['vacaciones.2025.mkv', 'vacaciones.2025'],
    ['.mp4', '.mp4'],
    ['  Clip final .webm ', 'Clip final'],
  ])('guarda el título de la biblioteca a partir de %j', async (filename, title) => {
    await start({ filename, contentType: 'video/mp4', sizeBytes: 1 });
    expect(createVideo).toHaveBeenCalledWith(expect.objectContaining({ title }));
  });

  it.each([
    ['clip.webm', 'video/webm', '.webm'],
    ['sin-extension', 'video/quicktime', '.mov'],
    ['raro.exe', 'video/x-matroska', '.mkv'],
    ['otro', 'video/x-desconocido', ''],
  ])('extensión segura para %s (%s)', async (filename, contentType, ext) => {
    const res = await start({ filename, contentType, sizeBytes: 1 });
    expect(res.body.storageKey).toBe(`incoming/${res.body.videoId}/original${ext}`);
  });

  it('400 si no es vídeo o faltan campos', async () => {
    expect((await start({ filename: 'a.png', contentType: 'image/png', sizeBytes: 1 })).status).toBe(400);
    expect((await start({ filename: 'a.mp4', contentType: 'video/mp4' })).status).toBe(400);
    expect((await start({ filename: '', contentType: 'video/mp4', sizeBytes: 1 })).status).toBe(400);
    expect(createVideo).not.toHaveBeenCalled();
  });

  it('413 si supera MAX_UPLOAD_BYTES', async () => {
    const res = await start({ filename: 'a.mp4', contentType: 'video/mp4', sizeBytes: env.MAX_UPLOAD_BYTES + 1 });
    expect(res.status).toBe(413);
    // El cuerpo lleva el límite para que la web lo muestre sin duplicar el valor.
    expect(res.body).toEqual({ error: 'File too large', maxUploadBytes: env.MAX_UPLOAD_BYTES });
    expect(createVideo).not.toHaveBeenCalled();
  });

  it('403 si no es dueño y 410 si la sala está borrada', async () => {
    vi.mocked(isOwner).mockResolvedValueOnce(false);
    expect((await start({ filename: 'a.mp4', contentType: 'video/mp4', sizeBytes: 1 })).status).toBe(403);
    vi.mocked(findRoom).mockResolvedValueOnce({ ...activeRoom, status: 'deleted' } as any);
    expect((await start({ filename: 'a.mp4', contentType: 'video/mp4', sizeBytes: 1 })).status).toBe(410);
  });
});

describe('limpieza perezosa de subidas huérfanas al reservar', () => {
  const OLD = '77777777-7777-4777-8777-777777777777';

  it('borra las filas pending de la sala más viejas que TTL + 1 h, y su objeto de incoming/', async () => {
    vi.mocked(removeStalePendingByRoom).mockResolvedValueOnce([
      { id: OLD, storageKey: `incoming/${OLD}/original.mp4` },
    ] as any);
    const before = Date.now();
    const res = await start({ filename: 'a.mp4', contentType: 'video/mp4', sizeBytes: 1 });
    expect(res.status).toBe(200);
    const [roomId, cutoff] = vi.mocked(removeStalePendingByRoom).mock.calls[0] as [string, Date];
    expect(roomId).toBe('room-1');
    const graceMs = env.UPLOAD_URL_TTL_SECONDS * 1000 + 60 * 60 * 1000;
    const after = Date.now();
    expect(cutoff.getTime()).toBeGreaterThanOrEqual(before - graceMs);
    expect(cutoff.getTime()).toBeLessThanOrEqual(after - graceMs);
    expect(remove).toHaveBeenCalledWith(`incoming/${OLD}/original.mp4`);
    // Primero se limpia y después se reserva la nueva.
    expect(vi.mocked(removeStalePendingByRoom).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(createVideo).mock.invocationCallOrder[0],
    );
  });

  it('un fallo al limpiar (BD o MinIO) se registra pero no impide reservar', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.mocked(removeStalePendingByRoom).mockRejectedValueOnce(new Error('db down'));
    expect((await start({ filename: 'a.mp4', contentType: 'video/mp4', sizeBytes: 1 })).status).toBe(200);
    vi.mocked(removeStalePendingByRoom).mockResolvedValueOnce([{ id: OLD, storageKey: 'incoming/x/original.mp4' }] as any);
    remove.mockRejectedValueOnce(new Error('minio down'));
    expect((await start({ filename: 'a.mp4', contentType: 'video/mp4', sizeBytes: 1 })).status).toBe(200);
    expect(log).toHaveBeenCalledTimes(2);
    log.mockRestore();
  });

  it('no limpia nada si la subida se rechaza por tamaño', async () => {
    await start({ filename: 'a.mp4', contentType: 'video/mp4', sizeBytes: env.MAX_UPLOAD_BYTES + 1 });
    expect(removeStalePendingByRoom).not.toHaveBeenCalled();
  });
});

describe('GET /uploads/limits', () => {
  it('devuelve el tamaño máximo de subida (fuente de verdad: MAX_UPLOAD_BYTES)', async () => {
    const res = await request(app).get('/api/v1/uploads/limits');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ maxUploadBytes: env.MAX_UPLOAD_BYTES });
  });
});

const cancel = (id = VID) => request(app).delete(`/api/v1/rooms/room-1/media/uploads/${id}`);

describe('DELETE /rooms/:id/media/uploads/:videoId (cancelar subida)', () => {
  it('borra la fila pending y el objeto parcial o completo de incoming/', async () => {
    vi.mocked(findVideo).mockResolvedValueOnce(pending as any);
    vi.mocked(removePendingById).mockResolvedValueOnce(pending as any);
    const res = await cancel();
    expect(res.status).toBe(204);
    expect(removePendingById).toHaveBeenCalledWith(VID);
    expect(remove).toHaveBeenCalledWith(pending.storageKey);
  });

  it('es idempotente: si la fila ya no existe o es de otra sala responde 204 sin borrar nada', async () => {
    vi.mocked(findVideo).mockResolvedValueOnce(null as any);
    expect((await cancel()).status).toBe(204);
    vi.mocked(findVideo).mockResolvedValueOnce({ ...pending, roomId: 'otra' } as any);
    expect((await cancel()).status).toBe(204);
    expect(removePendingById).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
  });

  it('409 si la subida ya fue confirmada (no se puede cancelar un vídeo en proceso)', async () => {
    vi.mocked(findVideo).mockResolvedValueOnce({ ...pending, status: 'processing' } as any);
    const res = await cancel();
    expect(res.status).toBe(409);
    expect(removePendingById).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
  });

  it('409 si una confirmación concurrente ganó la carrera (el borrado condicional no afecta filas)', async () => {
    vi.mocked(findVideo).mockResolvedValueOnce(pending as any);
    vi.mocked(removePendingById).mockResolvedValueOnce(null as any);
    expect((await cancel()).status).toBe(409);
    expect(remove).not.toHaveBeenCalled();
  });

  it('204 aunque falle el borrado del objeto (la limpieza perezosa lo recogerá)', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.mocked(findVideo).mockResolvedValueOnce(pending as any);
    vi.mocked(removePendingById).mockResolvedValueOnce(pending as any);
    remove.mockRejectedValueOnce(new Error('minio down'));
    expect((await cancel()).status).toBe(204);
    expect(log).toHaveBeenCalled();
    log.mockRestore();
  });

  it('404 si el id no es uuid, 403 si no es el dueño y 410 si la sala está borrada', async () => {
    expect((await cancel('no-uuid')).status).toBe(404);
    vi.mocked(isOwner).mockResolvedValueOnce(false);
    expect((await cancel()).status).toBe(403);
    vi.mocked(findRoom).mockResolvedValueOnce({ ...activeRoom, status: 'deleted' } as any);
    expect((await cancel()).status).toBe(410);
    expect(removePendingById).not.toHaveBeenCalled();
  });
});

const complete = (id = VID) => request(app).post(`/api/v1/rooms/room-1/media/uploads/${id}/complete`);

describe('POST /rooms/:id/media/uploads/:videoId/complete', () => {
  it('verifica el objeto, encola el procesamiento y asigna el vídeo a la sala', async () => {
    vi.mocked(findVideo).mockResolvedValueOnce(pending as any);
    vi.mocked(setMedia).mockResolvedValueOnce({ ...activeRoom, mediaId: VID } as any);
    const res = await complete();
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ mediaId: VID, mediaKey: pending.storageKey, status: 'processing' });
    expect(stat).toHaveBeenCalledWith(pending.storageKey);
    expect(transitionStatus).toHaveBeenCalledWith(VID, 'pending', 'processing');
    expect(xadd).toHaveBeenCalledWith('media:uploads', '*', 'video_id', VID);
    expect(setMedia).toHaveBeenCalledWith('room-1', { mediaId: VID, mediaKey: pending.storageKey });
  });

  it('409 si el archivo no llegó al bucket (no encola ni asigna)', async () => {
    vi.mocked(findVideo).mockResolvedValueOnce(pending as any);
    stat.mockResolvedValueOnce(null);
    const res = await complete();
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: 'Upload missing' });
    expect(xadd).not.toHaveBeenCalled();
    expect(setMedia).not.toHaveBeenCalled();
  });

  it('413 si el objeto subido es mayor que el sizeBytes declarado: lo borra y no encola', async () => {
    vi.mocked(findVideo).mockResolvedValueOnce(pending as any);
    stat.mockResolvedValueOnce({ size: pending.sizeBytes + 1 });
    const res = await complete();
    expect(res.status).toBe(413);
    expect(res.body).toEqual({ error: 'File too large', maxUploadBytes: env.MAX_UPLOAD_BYTES });
    expect(remove).toHaveBeenCalledWith(pending.storageKey);
    expect(transitionStatus).not.toHaveBeenCalled();
    expect(xadd).not.toHaveBeenCalled();
    expect(setMedia).not.toHaveBeenCalled();
  });

  it('413 si el objeto supera MAX_UPLOAD_BYTES aunque se declarara más grande', async () => {
    const big = env.MAX_UPLOAD_BYTES + 10;
    vi.mocked(findVideo).mockResolvedValueOnce({ ...pending, sizeBytes: big } as any);
    stat.mockResolvedValueOnce({ size: env.MAX_UPLOAD_BYTES + 1 });
    const res = await complete();
    expect(res.status).toBe(413);
    expect(xadd).not.toHaveBeenCalled();
  });

  it('413 aunque falle el borrado del objeto (se registra y se responde igual)', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.mocked(findVideo).mockResolvedValueOnce(pending as any);
    stat.mockResolvedValueOnce({ size: pending.sizeBytes + 1 });
    remove.mockRejectedValueOnce(new Error('minio down'));
    const res = await complete();
    expect(res.status).toBe(413);
    expect(log).toHaveBeenCalled();
    log.mockRestore();
  });

  it('404 si el vídeo no existe, es de otra sala o el id no es uuid', async () => {
    vi.mocked(findVideo).mockResolvedValueOnce(null as any);
    expect((await complete()).status).toBe(404);
    vi.mocked(findVideo).mockResolvedValueOnce({ ...pending, roomId: 'otra' } as any);
    expect((await complete()).status).toBe(404);
    expect((await complete('no-uuid')).status).toBe(404);
  });

  it('503 si Redis no acepta el evento (el cliente puede reintentar)', async () => {
    vi.mocked(findVideo).mockResolvedValueOnce(pending as any);
    xadd.mockRejectedValueOnce(new Error('redis down'));
    const res = await complete();
    expect(res.status).toBe(503);
    expect(setMedia).not.toHaveBeenCalled();
    // Vuelve a pending para que el reintento pueda encolar.
    expect(transitionStatus).toHaveBeenLastCalledWith(VID, 'processing', 'pending');
  });

  it.each(['processing', 'ready', 'failed'])('es idempotente: si el vídeo ya está %s responde 200 sin re-encolar ni reasignar', async (status) => {
    vi.mocked(findVideo).mockResolvedValueOnce({ ...pending, status } as any);
    const res = await complete();
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ mediaId: VID, mediaKey: pending.storageKey, status });
    expect(transitionStatus).not.toHaveBeenCalled();
    expect(xadd).not.toHaveBeenCalled();
    expect(setMedia).not.toHaveBeenCalled();
  });

  it('dos confirmaciones concurrentes: la que pierde la transición no re-encola', async () => {
    vi.mocked(findVideo)
      .mockResolvedValueOnce(pending as any)
      .mockResolvedValueOnce({ ...pending, status: 'processing' } as any);
    vi.mocked(transitionStatus).mockResolvedValueOnce(null as any);
    const res = await complete();
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('processing');
    expect(xadd).not.toHaveBeenCalled();
    expect(setMedia).not.toHaveBeenCalled();
  });

  it('404 si la sala desaparece al asignar', async () => {
    vi.mocked(findVideo).mockResolvedValueOnce(pending as any);
    vi.mocked(setMedia).mockResolvedValueOnce(null as any);
    expect((await complete()).status).toBe(404);
  });
});

describe('GET /rooms/:id/playback con estado del procesamiento', () => {
  const play = () => request(app).get('/api/v1/rooms/room-1/playback').set('Authorization', 'Bearer firebase');

  it('incluye status y, si está ready, la URL firmada de ambilight.json', async () => {
    vi.mocked(findRoom).mockResolvedValue({ ...activeRoom, mediaId: VID, mediaKey: pending.storageKey } as any);
    vi.mocked(findVideo).mockResolvedValueOnce({ ...pending, status: 'ready' } as any);
    const res = await play();
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ready');
    expect(res.body.url).toBe(`http://minio.test/tint-media/${pending.storageKey}?ttl=${env.PLAYBACK_URL_TTL_SECONDS}`);
    expect(res.body.ambilightUrl).toBe(`http://minio.test/tint-media/${VID}/ambilight.json?ttl=${env.PLAYBACK_URL_TTL_SECONDS}`);
  });

  it('status pending sin ambilight mientras el worker procesa', async () => {
    vi.mocked(findRoom).mockResolvedValue({ ...activeRoom, mediaId: VID, mediaKey: pending.storageKey } as any);
    vi.mocked(findVideo).mockResolvedValueOnce(pending as any);
    const res = await play();
    expect(res.body).toMatchObject({ status: 'pending', ambilightUrl: null });
  });

  it('firma la clave vigente del vídeo (la publicada por el worker), no la copiada en la sala', async () => {
    vi.mocked(findRoom).mockResolvedValue({ ...activeRoom, mediaId: VID, mediaKey: pending.storageKey } as any);
    vi.mocked(findVideo).mockResolvedValueOnce({ ...pending, status: 'ready', storageKey: `${VID}/source.mp4` } as any);
    const res = await play();
    expect(res.body.url).toBe(`http://minio.test/tint-media/${VID}/source.mp4?ttl=${env.PLAYBACK_URL_TTL_SECONDS}`);
  });

  it('un vídeo failed no se sirve: url null y status failed', async () => {
    vi.mocked(findRoom).mockResolvedValue({ ...activeRoom, mediaId: VID, mediaKey: pending.storageKey } as any);
    vi.mocked(findVideo).mockResolvedValueOnce({ ...pending, status: 'failed' } as any);
    const res = await play();
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ mediaId: VID, url: null, expiresAt: null, status: 'failed', ambilightUrl: null, qualities: [] });
  });

  it.each(['unsupported_format', 'unreadable', 'invalid_duration', 'missing_file', 'processing_failed'])(
    'un vídeo failed devuelve el motivo (%s) en failureReason',
    async (reason) => {
      vi.mocked(findRoom).mockResolvedValue({ ...activeRoom, mediaId: VID, mediaKey: pending.storageKey } as any);
      vi.mocked(findVideo).mockResolvedValueOnce({ ...pending, status: 'failed', failureReason: reason } as any);
      const res = await play();
      expect(res.body).toMatchObject({ status: 'failed', failureReason: reason, url: null });
    },
  );

  it('failed sin motivo (worker anterior) o con un código desconocido → failureReason null', async () => {
    vi.mocked(findRoom).mockResolvedValue({ ...activeRoom, mediaId: VID, mediaKey: pending.storageKey } as any);
    vi.mocked(findVideo).mockResolvedValueOnce({ ...pending, status: 'failed', failureReason: null } as any);
    expect((await play()).body).toMatchObject({ status: 'failed', failureReason: null });
    vi.mocked(findVideo).mockResolvedValueOnce({ ...pending, status: 'failed', failureReason: 'SELECT * FROM users' } as any);
    expect((await play()).body).toMatchObject({ status: 'failed', failureReason: null });
  });

  it('failureReason es null si el vídeo no está failed (aunque la fila conserve un motivo)', async () => {
    vi.mocked(findRoom).mockResolvedValue({ ...activeRoom, mediaId: VID, mediaKey: pending.storageKey } as any);
    vi.mocked(findVideo).mockResolvedValueOnce({ ...pending, status: 'ready', failureReason: 'unreadable' } as any);
    expect((await play()).body.failureReason).toBeNull();
    vi.mocked(findVideo).mockResolvedValueOnce(pending as any);
    expect((await play()).body.failureReason).toBeNull();
  });

  it('failureReason null también sin vídeo en la sala', async () => {
    vi.mocked(findRoom).mockResolvedValue({ ...activeRoom, mediaId: null, mediaKey: null } as any);
    expect((await play()).body).toMatchObject({ mediaId: null, status: null, failureReason: null });
  });

  it('status null si el vídeo se asignó por clave manual (sin fila en videos)', async () => {
    vi.mocked(findRoom).mockResolvedValue({ ...activeRoom, mediaId: VID, mediaKey: 'manual/a.mp4' } as any);
    vi.mocked(findVideo).mockResolvedValueOnce(null as any);
    const res = await play();
    expect(res.body).toMatchObject({ mediaId: VID, status: null, ambilightUrl: null });
  });
});

describe('GET /rooms/:id/playback con calidades', () => {
  const play = () => request(app).get('/api/v1/rooms/room-1/playback').set('Authorization', 'Bearer firebase');
  const ttl = () => env.PLAYBACK_URL_TTL_SECONDS;
  const signed = (key: string) => `http://minio.test/tint-media/${key}?ttl=${ttl()}`;

  beforeEach(() => {
    vi.mocked(findRoom).mockResolvedValue({ ...activeRoom, mediaId: VID, mediaKey: pending.storageKey } as any);
  });

  it('ready: Original primero (misma URL que url) y luego las calidades de mayor a menor', async () => {
    vi.mocked(findVideo).mockResolvedValueOnce({ ...pending, status: 'ready', storageKey: `${VID}/source.mp4`, renditions: [720, 360] } as any);
    const res = await play();
    expect(res.status).toBe(200);
    expect(res.body.url).toBe(signed(`${VID}/source.mp4`));
    expect(res.body.qualities).toEqual([
      { id: 'source', label: 'Original', url: res.body.url },
      { id: '720p', label: '720p', url: signed(`${VID}/720p.mp4`) },
      { id: '360p', label: '360p', url: signed(`${VID}/360p.mp4`) },
    ]);
  });

  it('ready con una sola calidad publicada', async () => {
    vi.mocked(findVideo).mockResolvedValueOnce({ ...pending, status: 'ready', storageKey: `${VID}/source.mp4`, renditions: [360] } as any);
    const res = await play();
    expect(res.body.qualities.map((q: any) => q.id)).toEqual(['source', '360p']);
  });

  it('ready sin renditions: solo Original', async () => {
    vi.mocked(findVideo).mockResolvedValueOnce({ ...pending, status: 'ready', storageKey: `${VID}/source.mp4`, renditions: [] } as any);
    const res = await play();
    expect(res.body.qualities).toEqual([{ id: 'source', label: 'Original', url: signed(`${VID}/source.mp4`) }]);
  });

  it('mientras se procesa solo se ofrece el Original aunque haya renditions', async () => {
    vi.mocked(findVideo).mockResolvedValueOnce({ ...pending, status: 'processing', renditions: [720, 360] } as any);
    const res = await play();
    expect(res.body.qualities).toEqual([{ id: 'source', label: 'Original', url: signed(pending.storageKey) }]);
  });

  it('vídeo asignado por clave manual (sin fila en videos): solo Original', async () => {
    vi.mocked(findRoom).mockResolvedValue({ ...activeRoom, mediaId: VID, mediaKey: 'manual/a.mp4' } as any);
    vi.mocked(findVideo).mockResolvedValueOnce(null as any);
    const res = await play();
    expect(res.body.qualities).toEqual([{ id: 'source', label: 'Original', url: signed('manual/a.mp4') }]);
  });
});
