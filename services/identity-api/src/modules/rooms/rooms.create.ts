import { db } from '../../db/client.js';
import { create as createInvitation, type NewInvitation } from '../invitations/invitations.repo.js';
import { create as createRoom, type NewRoom } from './rooms.repo.js';

/**
 * Crea la sala y su invitación inicial en una sola transacción: si la invitación falla, la sala
 * no queda guardada sin invitación (DAT-01).
 */
export async function createRoomWithInvitation(
  room: NewRoom,
  invitation: Omit<NewInvitation, 'code' | 'id' | 'roomId'>,
) {
  return db.transaction(async (tx) => {
    const createdRoom = await createRoom(room, tx);
    const createdInvitation = await createInvitation({ ...invitation, roomId: createdRoom.id }, tx);
    return { room: createdRoom, invitation: createdInvitation };
  });
}
