import { eq, and, ne } from 'drizzle-orm';
import { db, type DbExecutor } from '../../db/client.js';
import { rooms } from '../../db/schema.js';

export type Room = typeof rooms.$inferSelect;
export type NewRoom = typeof rooms.$inferInsert;

export const ACTIVE_STATUSES = ['active'] as const;

export async function create(room: NewRoom, executor: DbExecutor = db) {
  const result = await executor.insert(rooms).values(room).returning();
  return result[0];
}

export async function findById(id: string) {
  const result = await db.select().from(rooms).where(eq(rooms.id, id));
  return result[0] || null;
}

export async function listByHost(hostId: string) {
  return db
    .select()
    .from(rooms)
    .where(and(eq(rooms.hostId, hostId), ne(rooms.status, 'deleted')));
}

export async function isOwner(roomId: string, userId: string) {
  const room = await findById(roomId);
  return room ? room.hostId === userId : false;
}

export async function isDeleted(room: Pick<Room, 'status'> | null | undefined) {
  return !!room && room.status === 'deleted';
}

export async function softRemoveById(id: string) {
  const result = await db
    .update(rooms)
    .set({ status: 'deleted', updatedAt: new Date() })
    .where(eq(rooms.id, id))
    .returning();
  return result[0] || null;
}

/**
 * Estado terminal de una sala `live` (ADR 0019): `UPDATE rooms SET status='disabled'`.
 * Condicional a `status='active'` para no pisar un borrado concurrente. Devuelve null
 * si no había sala activa que deshabilitar.
 */
export async function disableById(id: string) {
  const result = await db
    .update(rooms)
    .set({ status: 'disabled', updatedAt: new Date() })
    .where(and(eq(rooms.id, id), eq(rooms.status, 'active')))
    .returning();
  return result[0] || null;
}

export async function updateTitle(id: string, title: string) {
  const result = await db
    .update(rooms)
    .set({ title, updatedAt: new Date() })
    .where(eq(rooms.id, id))
    .returning();
  return result[0] || null;
}

export async function setMedia(roomId: string, media: { mediaId: string; mediaKey: string }) {
  const result = await db
    .update(rooms)
    .set({ ...media, updatedAt: new Date() })
    .where(eq(rooms.id, roomId))
    .returning();
  return result[0] || null;
}
