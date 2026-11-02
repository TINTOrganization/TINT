import { Request, Response, NextFunction } from 'express';
import { findById, type Room } from '../modules/rooms/rooms.repo.js';

declare module 'express-serve-static-core' {
  interface Request {
    room?: Room;
  }
}

/**
 * Respuesta para una sala que ya no admite operaciones: borrado lógico → `410 Deleted`;
 * sala live terminada (ADR 0019) → `410 Disabled`. null si la sala está activa.
 * Falla cerrado: cualquier otro estado se trata como deshabilitada.
 */
export function inactiveRoomError(room: Pick<Room, 'status'>): { error: 'Deleted' | 'Disabled' } | null {
  if (room.status === 'active') return null;
  return { error: room.status === 'deleted' ? 'Deleted' : 'Disabled' };
}

/**
 * Carga la sala `:id` y corta si no existe (404), tiene borrado lógico (410 Deleted)
 * o fue deshabilitada (410 Disabled). Deja la sala en `req.room`.
 * Va después de la autorización: así un tercero no puede sondear qué salas existen.
 */
export async function requireActiveRoom(req: Request, res: Response, next: NextFunction) {
  const rawId = req.params.id;
  const roomId = Array.isArray(rawId) ? rawId[0] : rawId;
  let room: Room | null;
  try {
    room = await findById(roomId);
  } catch (err) {
    console.error('[activeRoom] no se pudo leer la sala:', (err as Error).message);
    return res.status(500).json({ error: 'Internal error' });
  }
  if (!room) {
    return res.status(404).json({ error: 'Not found' });
  }
  const inactive = inactiveRoomError(room);
  if (inactive) {
    return res.status(410).json(inactive);
  }
  req.room = room;
  next();
}
