import { and, desc, eq, inArray, lt } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { videos } from '../../db/schema.js';

export type Video = typeof videos.$inferSelect;
export type NewVideo = typeof videos.$inferInsert;

/** Estados de `videos.status` (los avanza media-worker después de `pending`). */
export type VideoStatus = 'pending' | 'processing' | 'ready' | 'failed';

export async function create(video: NewVideo) {
  const result = await db.insert(videos).values(video).returning();
  return result[0];
}

/** Alturas de calidad que puede publicar media-worker (`{id}/{h}p.mp4`), de mayor a menor. */
export const RENDITION_HEIGHTS = [720, 360] as const;
export type RenditionHeight = (typeof RENDITION_HEIGHTS)[number];

/**
 * `renditions` lo escribe media-worker: se lee a la defensiva y solo se aceptan
 * alturas conocidas (enteros de RENDITION_HEIGHTS), sin duplicados y de mayor a menor.
 */
export function normalizeRenditions(value: unknown): RenditionHeight[] {
  if (!Array.isArray(value)) return [];
  return RENDITION_HEIGHTS.filter((h) => value.some((v) => v === h));
}

export async function findById(id: string) {
  const result = await db.select().from(videos).where(eq(videos.id, id));
  const row = result[0];
  if (!row) return null;
  return { ...row, renditions: normalizeRenditions(row.renditions) };
}

/**
 * `UPDATE videos SET status = to WHERE id = ? AND status = from RETURNING *`:
 * transición condicional y atómica. Devuelve null si el vídeo ya no estaba en `from`
 * (otra petición ganó la carrera o el worker ya lo avanzó).
 */
export async function transitionStatus(id: string, from: VideoStatus, to: VideoStatus) {
  const result = await db
    .update(videos)
    .set({ status: to, updatedAt: new Date() })
    .where(and(eq(videos.id, id), eq(videos.status, from)))
    .returning();
  return result[0] || null;
}

/** Estados reutilizables desde la biblioteca: subida confirmada y no fallida. */
export const LIBRARY_STATUSES: VideoStatus[] = ['processing', 'ready'];

/** Biblioteca del host: sus vídeos confirmados (processing/ready), de más reciente a más antiguo. */
export async function listByUploader(userId: string) {
  const rows = await db
    .select()
    .from(videos)
    .where(and(eq(videos.uploadedBy, userId), inArray(videos.status, LIBRARY_STATUSES)))
    .orderBy(desc(videos.createdAt));
  return rows.map((row) => ({ ...row, renditions: normalizeRenditions(row.renditions) }));
}

/** Renombra el vídeo en la biblioteca. Devuelve null si ya no existe. */
export async function updateTitle(id: string, title: string) {
  const result = await db.update(videos).set({ title, updatedAt: new Date() }).where(eq(videos.id, id)).returning();
  const row = result[0];
  if (!row) return null;
  return { ...row, renditions: normalizeRenditions(row.renditions) };
}

/**
 * Cancela una subida: borra la fila solo si sigue `pending` (atómico frente a una
 * confirmación concurrente). Devuelve la fila borrada, o null si ya no estaba pending.
 */
export async function removePendingById(id: string) {
  const result = await db
    .delete(videos)
    .where(and(eq(videos.id, id), eq(videos.status, 'pending')))
    .returning();
  return result[0] || null;
}

/**
 * Subidas abandonadas de una sala: borra las filas `pending` creadas antes de `olderThan`
 * (la URL PUT ya caducó y nadie confirmó) y devuelve `{ id, storageKey }` de cada una para
 * borrar también su objeto de `incoming/`.
 */
export async function removeStalePendingByRoom(roomId: string, olderThan: Date) {
  const rows = await db
    .delete(videos)
    .where(and(eq(videos.roomId, roomId), eq(videos.status, 'pending'), lt(videos.createdAt, olderThan)))
    .returning();
  return rows.map((row) => ({ id: row.id, storageKey: row.storageKey }));
}
