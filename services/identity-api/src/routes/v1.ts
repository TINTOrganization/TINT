import { Router } from 'express';
import { z } from 'zod';
import { env } from '../config/env.js';
import { validate } from '../middlewares/validate.js';
import { requireAuthHost } from '../middlewares/auth.js';
import { centralTokenCheck } from '../middlewares/centralAuth.js';
import { requireRoomOwner } from '../middlewares/requireRoomOwner.js';
import { upsertByProvider } from '../modules/users/users.repo.js';
import { requireRoomHostOrGuest } from '../middlewares/guestAuth.js';
import { requireActiveRoom } from '../middlewares/activeRoom.js';
import { create as createRoom, listByHost, findById, softRemoveById, updateTitle, setMedia } from '../modules/rooms/rooms.repo.js';
import { create as createInvitation, findByCode, setRevoked, listByRoom, listLatestActiveByRooms } from '../modules/invitations/invitations.repo.js';
import { issueGuestToken, generateHostTicket } from '../modules/auth/auth.service.js';
import { publishAnalyticsEvent } from '../modules/analytics/analytics.events.js';
import { getMediaSigner } from '../modules/media/media.signer.js';
import { getMediaStore } from '../modules/media/media.store.js';
import { enqueueMediaUpload } from '../modules/media/media.queue.js';
import {
  create as createVideo,
  findById as findVideo,
  transitionStatus as transitionVideoStatus,
  listByUploader as listVideosByUploader,
  updateTitle as updateVideoTitle,
  type Video,
} from '../modules/videos/videos.repo.js';
import {
  create as createGuestSession,
  findByJti as findGuestSession,
  listByRoom as listGuestSessions,
  setRevoked as setGuestSessionRevoked,
  listActiveByRoom as listActiveGuestSessions,
  setRevokedMany as setGuestSessionsRevoked,
  listByRoomAndSub as listGuestSessionsBySub,
  type GuestSession,
} from '../modules/guests/guestSessions.repo.js';
import {
  create as createBan,
  findByRoomAndDevice as findBanByDevice,
  findByRoomAndSub as findBanBySub,
  listByRoom as listBans,
  removeById as removeBan,
  type RoomBan,
} from '../modules/bans/roomBans.repo.js';
import { markTokenRevoked, publishRevoked } from '../modules/tokens/revocation.js';
import { v4 as uuidv4 } from 'uuid';
import { defaultEventStartDeps } from '../modules/eventStart/eventStart.clients.js';
import { EventStartError, startEvent } from '../modules/eventStart/eventStart.service.js';

const router = Router();

function getRoomId(req: { params: unknown }) {
  const rawId = (req.params as Record<string, unknown>).id;
  return Array.isArray(rawId) ? rawId[0] : (rawId as string);
}

function paramId(raw: string | string[]) {
  return Array.isArray(raw) ? raw[0] : raw;
}

router.get('/healthz', (req, res) => {
  res.json({ status: 'ok', service: 'identity-api' });
});

router.get('/internal/auth/check', centralTokenCheck);

const verifySchema = z.object({});
router.post('/auth/verify', requireAuthHost, validate(verifySchema), async (req, res) => {
  res.json({ user: req.user, isRegistered: true });
  // Analítica: user_id es el sub de Firebase (users.provider_sub), nunca users.id ni el email.
  void publishAnalyticsEvent('user_login', { method: 'google', user_id: req.user!.providerSub });
});

const startEventSchema = z.object({
  title: z.string().trim().min(1).max(150),
});
router.post('/events/start', requireAuthHost, validate(startEventSchema), async (req, res) => {
  try {
    const result = await startEvent(
      { title: req.body.title, user: req.user! },
      defaultEventStartDeps(),
    );
    res.json(result);
  } catch (error) {
    if (error instanceof EventStartError) {
      console.error(`[event-start] ${error.service}:`, (error.cause as Error)?.message ?? String(error.cause));
      return res.status(503).json({ error: 'No se pudo iniciar el evento' });
    }
    throw error;
  }
});

const createRoomSchema = z.object({
  title: z.string().trim().min(1).max(150),
});
router.post('/rooms', requireAuthHost, validate(createRoomSchema), async (req, res) => {
  const { title } = req.body;
  const room = await createRoom({ title, hostId: req.user!.id });
  const ttlHours = parseInt(env.INVITATION_DEFAULT_TTL_HOURS, 10);
  const expiresAt = new Date(Date.now() + ttlHours * 60 * 60 * 1000);
  const invitation = await createInvitation({
    roomId: room.id,
    createdBy: req.user!.id,
    expiresAt,
    revoked: false,
  });
  res.json({
    room,
    invitation: {
      code: invitation.code,
      expiresAt: invitation.expiresAt,
      link: `/invite/${invitation.code}`,
    },
  });
  void publishAnalyticsEvent('room_created', { room_id: room.id, user_id: req.user!.providerSub });
});

router.get('/rooms', requireAuthHost, async (req, res) => {
  const rooms = await listByHost(req.user!.id);
  const latest = await listLatestActiveByRooms(rooms.map((room) => room.id));
  res.json({
    rooms: rooms.map((room) => {
      const invitation = latest.get(room.id);
      return {
        ...room,
        invitation: invitation
          ? { code: invitation.code, link: `/invite/${invitation.code}`, expiresAt: invitation.expiresAt }
          : null,
      };
    }),
  });
});

router.get('/rooms/:id', requireAuthHost, requireRoomOwner, async (req, res) => {
  const room = await findById(getRoomId(req));
  if (!room) {
    return res.status(404).json({ error: 'Not found' });
  }
  if (room.status === 'deleted') {
    return res.status(410).json({ error: 'Deleted' });
  }
  res.json({ room });
});

router.get('/rooms/:id/invitations', requireAuthHost, requireRoomOwner, async (req, res) => {
  const room = await findById(getRoomId(req));
  if (!room) {
    return res.status(404).json({ error: 'Not found' });
  }
  if (room.status === 'deleted') {
    return res.status(410).json({ error: 'Deleted' });
  }
  const invitations = await listByRoom(room.id);
  res.json({ invitations: invitations.map((invitation) => ({ ...invitation, link: `/invite/${invitation.code}` })) });
});

const updateRoomSchema = z.object({
  title: z.string().trim().min(1).max(150),
});
router.patch('/rooms/:id', requireAuthHost, requireRoomOwner, validate(updateRoomSchema), async (req, res) => {
  const roomId = getRoomId(req);
  const room = await findById(roomId);
  if (!room) {
    return res.status(404).json({ error: 'Not found' });
  }
  if (room.status === 'deleted') {
    return res.status(410).json({ error: 'Deleted' });
  }
  const updated = await updateTitle(roomId, req.body.title);
  res.json({ room: updated });
});

/**
 * Corta a los invitados que siguen conectados: `token:revoked:{jti}` + `REVOKED`
 * (sync-core cierra con 4001). La BD se marca solo después de Redis: si Redis
 * falla, las sesiones siguen activas en la BD y un reintento las vuelve a encontrar.
 * Devuelve false si Redis falló (falla cerrado → 503).
 */
async function revokeActiveGuestSessions(roomId: string) {
  const sessions = await listActiveGuestSessions(roomId);
  try {
    await Promise.all(
      sessions.map(async ({ jti, expiresAt }) => {
        await markTokenRevoked(jti, Math.floor(expiresAt.getTime() / 1000));
        await publishRevoked(roomId, jti);
      }),
    );
  } catch (err) {
    console.error('[rooms] no se pudieron revocar las sesiones de la sala borrada:', (err as Error).message);
    return false;
  }
  await setGuestSessionsRevoked(sessions.map((s) => s.jti));
  return true;
}

const REVOKE_RETRY_ERROR = { error: 'Room deleted but guest sessions could not be revoked; retry DELETE' };

router.delete('/rooms/:id', requireAuthHost, requireRoomOwner, async (req, res) => {
  const roomId = getRoomId(req);
  const room = await findById(roomId);
  if (!room) {
    return res.status(404).json({ error: 'Not found' });
  }
  if (room.status === 'deleted') {
    // Reintento tras un 503: vuelve a cortar las sesiones que quedaron pendientes.
    if (!(await revokeActiveGuestSessions(roomId))) {
      return res.status(503).json(REVOKE_RETRY_ERROR);
    }
    return res.status(410).json({ error: 'Deleted' });
  }
  const removed = await softRemoveById(roomId);
  if (!(await revokeActiveGuestSessions(roomId))) {
    return res.status(503).json(REVOKE_RETRY_ERROR);
  }
  res.json({ success: true, room: removed });
  // Solo el primer borrado: el reintento (status === 'deleted') no vuelve a cerrar la sala.
  void publishAnalyticsEvent('room_closed', { room_id: roomId, user_id: req.user!.providerSub, reason: 'deleted' });
});

const createInvitationSchema = z.object({
  // Máximo 30 días: sin cota, un número enorme producía una fecha inválida y un 500.
  ttlHours: z.number().int().positive().max(720).optional(),
});
router.post('/rooms/:id/invitations', requireAuthHost, requireRoomOwner, validate(createInvitationSchema), async (req, res) => {
  const rawId = req.params.id;
  const roomId = Array.isArray(rawId) ? rawId[0] : rawId;
  const room = await findById(roomId);
  if (!room) {
    return res.status(404).json({ error: 'Not found' });
  }
  if (room.status === 'deleted') {
    return res.status(410).json({ error: 'Deleted' });
  }
  const ttlHours = req.body.ttlHours || parseInt(env.INVITATION_DEFAULT_TTL_HOURS, 10);
  const expiresAt = new Date(Date.now() + ttlHours * 60 * 60 * 1000);
  const invitation = await createInvitation({
    roomId,
    createdBy: req.user!.id,
    expiresAt,
    revoked: false,
  });
  res.json({
    code: invitation.code,
    expiresAt: invitation.expiresAt,
    link: `/invite/${invitation.code}`,
  });
});

/**
 * Nick visible del host en el Canal Sync (lo ven todos los invitados): nunca el
 * email completo. displayName → parte local del email → 'Host'.
 */
function hostNick(user: { displayName?: string | null; email?: string | null }) {
  const displayName = user.displayName?.trim();
  if (displayName) return displayName;
  const localPart = user.email?.split('@')[0]?.trim();
  return localPart || 'Host';
}

router.post('/rooms/:id/sync-ticket', requireAuthHost, requireRoomOwner, requireActiveRoom, async (req, res) => {
  const rawId = req.params.id;
  const roomId = Array.isArray(rawId) ? rawId[0] : rawId;
  const user = req.user!;
  const { token, expiresAt } = generateHostTicket({
    userId: user.id,
    roomId,
    nick: hostNick(user),
  });
  res.json({ token, expiresAt: expiresAt.toISOString() });
});

// Ticket de host para la API de lectura de analytics. Sin requireActiveRoom: los
// KPIs de una sala cerrada (borrado lógico) se siguen consultando. requireRoomOwner
// no filtra por estado, así que solo el dueño lo obtiene, esté la sala activa o no.
router.post('/rooms/:id/analytics-ticket', requireAuthHost, requireRoomOwner, async (req, res) => {
  const user = req.user!;
  const { token, expiresAt } = generateHostTicket({
    userId: user.id,
    roomId: paramId(req.params.id),
    nick: hostNick(user),
  });
  res.json({ token, expiresAt: expiresAt.toISOString() });
});

const mediaKeySchema = z
  .string()
  .trim()
  .min(1)
  .max(512)
  .refine((key) => !key.includes('..'), { message: 'mediaKey no puede contener ".."' })
  .refine((key) => !key.startsWith('/'), { message: 'mediaKey no puede empezar con "/"' });
// { mediaKey } (clave manual del bucket) o { videoId } (vídeo de la biblioteca del host), no ambos.
const setMediaSchema = z.union([
  z.object({ mediaKey: mediaKeySchema }).strict(),
  z.object({ videoId: z.string().uuid() }).strict(),
]);
router.put('/rooms/:id/media', requireAuthHost, requireRoomOwner, validate(setMediaSchema), requireActiveRoom, async (req, res) => {
  const roomId = paramId(req.params.id);
  const body = req.body as { mediaKey: string } | { videoId: string };
  let mediaId: string;
  let mediaKey: string;
  if ('videoId' in body) {
    // Reuso desde la biblioteca: media_id = videos.id para que playback siga
    // resolviendo estado, calidades y Ambilight. Solo vídeos propios y confirmados (processing/ready).
    const video = await findVideo(body.videoId);
    if (!video || video.uploadedBy !== req.user!.id || (video.status !== 'processing' && video.status !== 'ready')) {
      return res.status(404).json({ error: 'Not found' });
    }
    mediaId = video.id;
    mediaKey = video.storageKey;
  } else {
    mediaId = uuidv4();
    mediaKey = body.mediaKey;
  }
  const room = await setMedia(roomId, { mediaId, mediaKey });
  if (!room) {
    return res.status(404).json({ error: 'Not found' });
  }
  res.json({ mediaId, mediaKey });
});

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Extensiones permitidas en la clave del bucket: el nombre del usuario nunca forma parte de ella.
const VIDEO_EXTENSIONS = new Set(['.mp4', '.webm', '.mov', '.mkv', '.m4v', '.ogv']);
const EXTENSION_BY_TYPE: Record<string, string> = {
  'video/mp4': '.mp4',
  'video/webm': '.webm',
  'video/quicktime': '.mov',
  'video/x-matroska': '.mkv',
  'video/x-m4v': '.m4v',
  'video/ogg': '.ogv',
};

/** Título de la biblioteca: el nombre del archivo sin su extensión (o tal cual si no queda nada). */
function videoTitle(filename: string) {
  const base = filename.replace(/\.[^./\\]{1,10}$/, '').trim();
  return base || filename;
}

function videoExtension(filename: string, contentType: string) {
  const match = /\.[a-z0-9]{1,5}$/i.exec(filename);
  const fromName = match?.[0].toLowerCase();
  if (fromName && VIDEO_EXTENSIONS.has(fromName)) return fromName;
  return EXTENSION_BY_TYPE[contentType.toLowerCase()] ?? '';
}

const startUploadSchema = z.object({
  filename: z.string().trim().min(1).max(255),
  contentType: z.string().trim().toLowerCase().regex(/^video\/[a-z0-9.+-]+$/, 'Debe ser un vídeo'),
  sizeBytes: z.number().int().positive(),
});

// 1) Reserva el vídeo y entrega una URL PUT firmada: el archivo va directo del
//    navegador a MinIO, sin pasar por identity-api.
router.post('/rooms/:id/media/uploads', requireAuthHost, requireRoomOwner, validate(startUploadSchema), requireActiveRoom, async (req, res) => {
  const { filename, contentType, sizeBytes } = req.body;
  if (sizeBytes > env.MAX_UPLOAD_BYTES) {
    return res.status(413).json({ error: 'File too large' });
  }
  const videoId = uuidv4();
  // Staging: el original va a incoming/ y el media-worker publica {id}/source.<ext>
  // solo si el vídeo es válido (actualiza videos.storage_key al marcarlo ready).
  const storageKey = `incoming/${videoId}/original${videoExtension(filename, contentType)}`;
  await createVideo({
    id: videoId,
    roomId: req.room!.id,
    uploadedBy: req.user!.id,
    storageKey,
    contentType,
    sizeBytes,
    status: 'pending',
    title: videoTitle(filename),
  });
  const ttl = env.UPLOAD_URL_TTL_SECONDS;
  const uploadUrl = await getMediaSigner().presignPut(storageKey, contentType, ttl);
  res.json({
    videoId,
    uploadUrl,
    storageKey,
    expiresAt: new Date(Date.now() + ttl * 1000).toISOString(),
    headers: { 'Content-Type': contentType },
  });
});

// 2) Confirma la subida: comprueba el objeto, encola el procesamiento
//    (XADD media:uploads) y asigna el vídeo a la sala. Idempotente: solo el
//    paso pending → processing encola y asigna; las repeticiones devuelven el
//    estado actual sin volver a encolar.
router.post('/rooms/:id/media/uploads/:videoId/complete', requireAuthHost, requireRoomOwner, requireActiveRoom, async (req, res) => {
  const roomId = req.room!.id;
  const videoId = paramId(req.params.videoId);
  const video = UUID_RE.test(videoId) ? await findVideo(videoId) : null;
  if (!video || video.roomId !== roomId) {
    return res.status(404).json({ error: 'Not found' });
  }
  const current = (v: { id: string; storageKey: string; status: string }) =>
    res.json({ mediaId: v.id, mediaKey: v.storageKey, status: v.status });
  if (video.status !== 'pending') {
    return current(video);
  }
  const store = getMediaStore();
  const object = await store.stat(video.storageKey);
  if (!object) {
    return res.status(409).json({ error: 'Upload missing' });
  }
  // La URL PUT firmada no acota el tamaño: se comprueba el objeto real contra lo
  // declarado y contra MAX_UPLOAD_BYTES. Si se pasa, se borra (no se procesa ni se
  // guarda) y el vídeo sigue en pending: el host puede volver a subir el archivo correcto.
  if (object.size > video.sizeBytes || object.size > env.MAX_UPLOAD_BYTES) {
    try {
      await store.remove(video.storageKey);
    } catch (err) {
      console.error('[uploads] no se pudo borrar un objeto que supera el tamaño:', (err as Error).message);
    }
    return res.status(413).json({ error: 'File too large' });
  }
  // Transición condicional: de dos confirmaciones concurrentes solo una encola.
  const queued = await transitionVideoStatus(video.id, 'pending', 'processing');
  if (!queued) {
    const latest = await findVideo(video.id);
    return current(latest ?? video);
  }
  try {
    await enqueueMediaUpload(video.id);
  } catch (err) {
    console.error('[uploads] no se pudo encolar media:uploads:', (err as Error).message);
    // Vuelve a pending para que el reintento pueda encolar.
    await transitionVideoStatus(video.id, 'processing', 'pending');
    return res.status(503).json({ error: 'Service unavailable' });
  }
  const room = await setMedia(roomId, { mediaId: video.id, mediaKey: video.storageKey });
  if (!room) {
    return res.status(404).json({ error: 'Not found' });
  }
  current(queued);
});

/** Alturas que se ofrecen como calidad, de mayor a menor (contrato con media-worker). */
const PLAYBACK_RENDITION_HEIGHTS = [720, 360] as const;
type PlaybackQuality = { id: 'source' | `${(typeof PLAYBACK_RENDITION_HEIGHTS)[number]}p`; label: string; url: string };

router.get('/rooms/:id/playback', requireRoomHostOrGuest, requireActiveRoom, async (req, res) => {
  const room = req.room!;
  if (!room.mediaId || !room.mediaKey) {
    return res.json({ mediaId: null, url: null, expiresAt: null, status: null, ambilightUrl: null, qualities: [] });
  }
  // Vídeos subidos por la API tienen fila en `videos` (estado del media-worker);
  // los asignados por clave manual no (status null). Mientras se procesa se
  // reproduce el original de incoming/; al quedar ready, la versión publicada
  // (storage_key la actualiza el worker). Un vídeo failed no se sirve.
  const video = await findVideo(room.mediaId);
  if (video?.status === 'failed') {
    return res.json({ mediaId: room.mediaId, url: null, expiresAt: null, status: 'failed', ambilightUrl: null, qualities: [] });
  }
  const ttl = env.PLAYBACK_URL_TTL_SECONDS;
  const expiresAt = new Date(Date.now() + ttl * 1000);
  const signer = getMediaSigner();
  const url = await signer.presignGet(video?.storageKey ?? room.mediaKey, ttl);
  const ambilightUrl = video?.status === 'ready' ? await signer.presignGet(`${video.id}/ambilight.json`, ttl) : null;
  // Calidades: el Original siempre (= url); las versiones `{id}/{h}p.mp4` que
  // media-worker publicó (renditions) solo cuando el vídeo está ready.
  const qualities: PlaybackQuality[] = [{ id: 'source', label: 'Original', url }];
  if (video?.status === 'ready') {
    const published = Array.isArray(video.renditions) ? video.renditions : [];
    for (const h of PLAYBACK_RENDITION_HEIGHTS.filter((height) => published.includes(height))) {
      qualities.push({ id: `${h}p`, label: `${h}p`, url: await signer.presignGet(`${video.id}/${h}p.mp4`, ttl) });
    }
  }
  res.json({
    mediaId: room.mediaId,
    url,
    expiresAt: expiresAt.toISOString(),
    status: video?.status ?? null,
    ambilightUrl,
    qualities,
  });
});

/**
 * Tarjeta de la biblioteca. previewUrl es una GET firmada para mostrar un
 * fotograma: la versión 360p si el vídeo está ready y la tiene; si no, storage_key.
 */
async function libraryItem(video: Video) {
  const { id, title, durationMs, status, createdAt, storageKey } = video;
  const renditions = Array.isArray(video.renditions) ? video.renditions : [];
  const previewKey = status === 'ready' && renditions.includes(360) ? `${id}/360p.mp4` : storageKey;
  const previewUrl = await getMediaSigner().presignGet(previewKey, env.PLAYBACK_URL_TTL_SECONDS);
  return { id, title, durationMs, status, createdAt, previewUrl };
}

router.get('/videos', requireAuthHost, async (req, res) => {
  const videos = await listVideosByUploader(req.user!.id);
  res.json({ videos: await Promise.all(videos.map(libraryItem)) });
});

const updateVideoSchema = z.object({
  title: z.string().trim().min(1).max(255),
});
router.patch('/videos/:id', requireAuthHost, validate(updateVideoSchema), async (req, res) => {
  const videoId = paramId(req.params.id);
  const video = UUID_RE.test(videoId) ? await findVideo(videoId) : null;
  if (!video || video.uploadedBy !== req.user!.id) {
    return res.status(404).json({ error: 'Not found' });
  }
  const updated = await updateVideoTitle(video.id, req.body.title);
  if (!updated) {
    return res.status(404).json({ error: 'Not found' });
  }
  res.json({ video: await libraryItem(updated) });
});

router.get('/rooms/:id/guests', requireAuthHost, requireRoomOwner, requireActiveRoom, async (req, res) => {
  const sessions = await listGuestSessions(paramId(req.params.id));
  res.json({
    // `sub` no se expone: es el identificador interno del invitado en sync-core.
    guests: sessions.map(({ jti, nick, joinedAt, expiresAt, revoked }) => ({ jti, nick, joinedAt, expiresAt, revoked })),
  });
});

router.post('/rooms/:id/guests/:jti/revoke', requireAuthHost, requireRoomOwner, requireActiveRoom, async (req, res) => {
  const roomId = paramId(req.params.id);
  const jti = paramId(req.params.jti);
  const session = UUID_RE.test(jti) ? await findGuestSession(jti) : null;
  if (!session || session.roomId !== roomId) {
    return res.status(404).json({ error: 'Not found' });
  }
  // Idempotente: revocar de nuevo reescribe la marca y vuelve a publicar REVOKED.
  await setGuestSessionRevoked(jti);
  await markTokenRevoked(jti, Math.floor(session.expiresAt.getTime() / 1000));
  await publishRevoked(roomId, jti);
  res.json({ success: true });
});

// Bloqueo por dispositivo. Los invitados son anónimos: el bloqueo se ata al
// deviceId que la web guarda en el navegador, así que borrar los datos del
// navegador lo evade (ver docs/usuarios-e-identidad.md §6.6).
const createBanSchema = z
  .object({
    jti: z.string().uuid().optional(),
    sub: z.string().trim().min(1).max(128).optional(),
  })
  .refine((body) => (body.jti === undefined) !== (body.sub === undefined), { message: 'Envía jti o sub (solo uno)' });

const banView = ({ id, nick, createdAt }: RoomBan) => ({ id, nick, createdAt });

/** Inserta (o recupera, si ya existía) el bloqueo de cada dispositivo del invitado. */
async function upsertBans(roomId: string, sessions: GuestSession[], createdBy: string) {
  const { sub, nick } = sessions[0];
  const devices = [...new Set(sessions.map((s) => s.deviceId).filter((d): d is string => !!d))];
  if (devices.length === 0) {
    // Cliente viejo sin deviceId: queda registrado por sub (no impide volver a entrar).
    return (await findBanBySub(roomId, sub)) ?? (await createBan({ roomId, deviceId: null, sub, nick, createdBy }));
  }
  const bans: (RoomBan | null)[] = [];
  for (const deviceId of devices) {
    bans.push((await createBan({ roomId, deviceId, sub, nick, createdBy })) ?? (await findBanByDevice(roomId, deviceId)));
  }
  return bans.find((b): b is RoomBan => !!b) ?? null;
}

router.post('/rooms/:id/bans', requireAuthHost, requireRoomOwner, validate(createBanSchema), requireActiveRoom, async (req, res) => {
  const roomId = req.room!.id;
  const { jti, sub } = req.body as { jti?: string; sub?: string };
  let guestSub = sub;
  if (jti) {
    const session = await findGuestSession(jti);
    guestSub = session?.roomId === roomId ? session.sub : undefined;
  }
  const sessions = guestSub ? await listGuestSessionsBySub(roomId, guestSub) : [];
  if (sessions.length === 0) {
    return res.status(404).json({ error: 'Not found' });
  }
  // El bloqueo se guarda antes de revocar: si Redis falla, el dispositivo ya no
  // puede volver a entrar y el reintento (idempotente) termina de revocar.
  const ban = await upsertBans(roomId, sessions, req.user!.id);
  if (!ban) {
    return res.status(503).json({ error: 'Service unavailable' });
  }
  const now = Date.now();
  const live = sessions.filter((s) => s.expiresAt.getTime() > now);
  try {
    for (const s of live) {
      await markTokenRevoked(s.jti, Math.floor(s.expiresAt.getTime() / 1000));
      await publishRevoked(roomId, s.jti);
    }
  } catch (err) {
    console.error('[bans] no se pudieron revocar las sesiones del invitado bloqueado:', (err as Error).message);
    return res.status(503).json({ error: 'Service unavailable' });
  }
  for (const s of live) {
    await setGuestSessionRevoked(s.jti);
  }
  res.json({ ban: banView(ban) });
});

router.get('/rooms/:id/bans', requireAuthHost, requireRoomOwner, requireActiveRoom, async (req, res) => {
  const bans = await listBans(req.room!.id);
  // Ni device_id ni sub salen de identity-api.
  res.json({ bans: bans.map(banView) });
});

router.delete('/rooms/:id/bans/:banId', requireAuthHost, requireRoomOwner, requireActiveRoom, async (req, res) => {
  const banId = paramId(req.params.banId);
  const removed = UUID_RE.test(banId) ? await removeBan(req.room!.id, banId) : null;
  if (!removed) {
    return res.status(404).json({ error: 'Not found' });
  }
  res.json({ success: true });
});

router.post('/invitations/:code/revoke', requireAuthHost, async (req, res) => {
  const rawCode = req.params.code;
  const code = Array.isArray(rawCode) ? rawCode[0] : rawCode;
  const invitation = await findByCode(code);
  if (!invitation) {
    return res.status(404).json({ error: 'Not found' });
  }
  const room = await findById(invitation.roomId);
  if (!room) {
    return res.status(404).json({ error: 'Not found' });
  }
  if (room.hostId !== req.user!.id) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  await setRevoked(invitation.id, true);
  res.json({ success: true });
});

const claimSchema = z.object({
  code: z.string().trim(),
  nick: z.string().trim().min(1).max(64),
  // Identificador anónimo del navegador (bloqueo por dispositivo). Opcional: los clientes viejos no lo envían.
  deviceId: z.string().uuid().optional(),
});
router.post('/invitations/claim', validate(claimSchema), async (req, res) => {
  const { code, nick, deviceId } = req.body as { code: string; nick: string; deviceId?: string };
  const invitation = await findByCode(code);
  if (!invitation) {
    return res.status(404).json({ error: 'Not found' });
  }
  if (invitation.revoked) {
    return res.status(409).json({ error: 'Revoked' });
  }
  if (invitation.expiresAt < new Date()) {
    return res.status(410).json({ error: 'Expired' });
  }
  const room = await findById(invitation.roomId);
  if (room && room.status === 'deleted') {
    return res.status(410).json({ error: 'Deleted' });
  }
  if (deviceId && (await findBanByDevice(invitation.roomId, deviceId))) {
    return res.status(403).json({ error: 'BANNED' });
  }
  const { token, payload } = issueGuestToken(invitation.roomId, nick);
  // Registrar la sesión antes de entregar el token: un token sin fila no se podría listar ni revocar.
  await createGuestSession({
    jti: payload.jti,
    roomId: payload.room_id,
    sub: payload.sub,
    nick: payload.nick,
    joinedAt: new Date(payload.iat * 1000),
    expiresAt: new Date(payload.exp * 1000),
    deviceId: deviceId ?? null,
  });
  res.json({ token, roomId: invitation.roomId, nick, roomTitle: room?.title ?? null });
  void publishAnalyticsEvent('invitation_claimed', { room_id: payload.room_id, user_id: payload.sub });
});

export default router;
