import { v4 as uuidv4 } from 'uuid';
import { getRedisClient } from '../tokens/revocation.js';
import { publishAnalyticsEvent } from '../analytics/analytics.events.js';
import { disableById, findById } from './rooms.repo.js';

/** `reason` de cierre (dominio-transmision §6.1): el mismo en ROOM_CLOSED y en analítica. */
export type CloseReason = 'host_ended' | 'grace_expired';

export type CloseResult =
  | { ok: true; body: { room_id: string; status: 'disabled'; reason: CloseReason; closed_at: string } }
  | { ok: false; status: 404 | 409 | 410 | 503; body: { error: string } };

/** Marca sin TTL que leen sync/social/voice/stream en cada handshake (ADR 0019). */
export function closedKey(roomId: string) {
  return `room:${roomId}:closed`;
}

const NOT_FOUND: CloseResult = { ok: false, status: 404, body: { error: 'Not found' } };
const UNAVAILABLE: CloseResult = { ok: false, status: 503, body: { error: 'Service unavailable' } };

/** Por qué no se puede cerrar la sala (null si está activa y es live). */
function precondition(room: Awaited<ReturnType<typeof findById>>): CloseResult | null {
  if (!room) return NOT_FOUND;
  if (room.status === 'deleted') return { ok: false, status: 410, body: { error: 'Deleted' } };
  // Solo una sala ya disabled llega aquí (o un status desconocido: falla cerrado, no se toca).
  if (room.status !== 'active') return { ok: false, status: 409, body: { error: 'AlreadyDisabled' } };
  if (room.kind !== 'live') return { ok: false, status: 409, body: { error: 'NotLive' } };
  return null;
}

/**
 * Deshabilita una sala live (ADR 0019 · dominio-transmision §6.1). Orden, para no perder el aviso:
 * `SET room:{id}:closed 1` → `PUBLISH room:{id}:sync ROOM_CLOSED` → `UPDATE status='disabled'`
 * → `XADD room_closed` (mejor esfuerzo). Si falla alguno de los tres primeros responde 503 y la
 * sala sigue `active` en la BD: el reintento repite todo (los pasos son idempotentes). Por eso
 * `409 AlreadyDisabled` (BD ya en disabled) implica que el aviso ya se publicó.
 */
export async function closeLiveRoom(roomId: string, reason: CloseReason, userId?: string): Promise<CloseResult> {
  let room;
  try {
    room = await findById(roomId);
  } catch (err) {
    // 22P02: el id no es un uuid válido → no existe esa sala. Cualquier otro error: BD caída.
    if ((err as { code?: string }).code === '22P02') return NOT_FOUND;
    console.error('[rooms] no se pudo leer la sala a deshabilitar:', (err as Error).message);
    return UNAVAILABLE;
  }
  const blocked = precondition(room);
  if (blocked) return blocked;

  const occurredAt = new Date().toISOString();
  let disabled;
  try {
    const redis = getRedisClient();
    await redis.set(closedKey(roomId), '1');
    await redis.publish(
      `room:${roomId}:sync`,
      JSON.stringify({ type: 'ROOM_CLOSED', event_id: uuidv4(), room_id: roomId, reason, occurred_at: occurredAt }),
    );
    disabled = await disableById(roomId);
  } catch (err) {
    console.error('[rooms] no se pudo deshabilitar la sala:', (err as Error).message);
    return UNAVAILABLE;
  }
  if (!disabled) {
    // Otra petición cambió la sala entre la lectura y el UPDATE (borrado o cierre concurrente).
    return precondition(await findById(roomId)) ?? UNAVAILABLE;
  }

  void publishAnalyticsEvent('room_closed', { room_id: roomId, user_id: userId, reason });
  return { ok: true, body: { room_id: roomId, status: 'disabled', reason, closed_at: occurredAt } };
}
