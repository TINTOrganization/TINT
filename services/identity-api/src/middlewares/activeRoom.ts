import { Request, Response, NextFunction } from 'express';
import { findById, type Room } from '../modules/rooms/rooms.repo.js';
import { logger } from '../logging.js';

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

function roomGuard(allowed: ReadonlySet<string>) {
  return async (req: Request, res: Response, next: NextFunction) => {
    const rawId = req.params.id;
    const roomId = Array.isArray(rawId) ? rawId[0] : rawId;
    let room: Room | null;
    try {
      room = await findById(roomId);
    } catch (err) {
      logger.error('activeRoom: no se pudo leer la sala', { error: (err as Error).message });
      return res.status(500).json({ error: 'Internal error' });
    }
    if (!room) {
      return res.status(404).json({ error: 'Not found' });
    }
    if (!allowed.has(room.status)) {
      // `allowed` siempre incluye `active`, así que aquí inactiveRoomError nunca es null.
      return res.status(410).json(inactiveRoomError(room));
    }
    req.room = room;
    next();
  };
}

/**
 * Carga la sala `:id` y corta si no existe (404), tiene borrado lógico (410 Deleted)
 * o fue deshabilitada (410 Disabled). Deja la sala en `req.room`.
 * Va después de la autorización: así un tercero no puede sondear qué salas existen.
 */
export const requireActiveRoom = roomGuard(new Set(['active']));

/**
 * Como requireActiveRoom, pero también deja pasar una sala live terminada (`disabled`):
 * el host sigue leyendo lo que quedó de ella (historial de chat, HU-LIVE-09 AC3). Una sala
 * borrada sigue siendo 410 Deleted y cualquier otro status, 410 Disabled (falla cerrado).
 */
export const requireReadableRoom = roomGuard(new Set(['active', 'disabled']));
