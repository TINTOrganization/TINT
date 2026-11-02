import { eq, inArray } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { invitations } from '../../db/schema.js';
import { nanoid } from 'nanoid';

export type Invitation = typeof invitations.$inferSelect;
export type NewInvitation = typeof invitations.$inferInsert;

export async function create(invitation: Omit<NewInvitation, 'code' | 'id'>) {
  const code = nanoid(12);
  const result = await db.insert(invitations).values({ ...invitation, code }).returning();
  return result[0];
}

export async function findByCode(code: string): Promise<Invitation | null> {
  const result = await db.select().from(invitations).where(eq(invitations.code, code));
  return result[0] || null;
}

export async function setRevoked(id: string, revoked = true): Promise<Invitation | null> {
  const result = await db.update(invitations).set({ revoked }).where(eq(invitations.id, id)).returning();
  return result[0] || null;
}

export async function listByRoom(roomId: string) {
  const result = await db.select().from(invitations).where(eq(invitations.roomId, roomId));
  return result;
}

// Última invitación vigente por sala (una sola query, sin N+1).
// Vigente = no revocada y sin expirar; desempatan por createdAt descendente.
export async function listLatestActiveByRooms(roomIds: string[], now = new Date()) {
  const latest = new Map<string, Invitation>();
  if (roomIds.length === 0) return latest;
  const rows = await db
    .select()
    .from(invitations)
    .where(inArray(invitations.roomId, roomIds));
  for (const row of rows) {
    if (row.revoked || row.expiresAt <= now) continue;
    const prev = latest.get(row.roomId);
    if (!prev || row.createdAt > prev.createdAt) {
      latest.set(row.roomId, row);
    }
  }
  return latest;
}
