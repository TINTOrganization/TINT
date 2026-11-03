import { describe, it, expect, vi, beforeEach } from 'vitest';

const tx = vi.hoisted(() => ({ marker: 'tx' }));
const transaction = vi.hoisted(() => vi.fn(async (work: (t: unknown) => Promise<unknown>) => work(tx)));

vi.mock('../src/db/client.js', () => ({ db: { transaction } }));
vi.mock('../src/modules/rooms/rooms.repo.js', () => ({ create: vi.fn() }));
vi.mock('../src/modules/invitations/invitations.repo.js', () => ({ create: vi.fn() }));

import { createRoomWithInvitation } from '../src/modules/rooms/rooms.create.js';
import { create as createRoom } from '../src/modules/rooms/rooms.repo.js';
import { create as createInvitation } from '../src/modules/invitations/invitations.repo.js';

const room = { id: 'room-1', hostId: 'host-1', title: 'Sala' };
const draft = { createdBy: 'host-1', expiresAt: new Date('2030-01-01'), revoked: false };

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(createRoom).mockResolvedValue(room as any);
  vi.mocked(createInvitation).mockResolvedValue({ id: 'inv-1', code: 'abc' } as any);
});

describe('createRoomWithInvitation', () => {
  it('guarda sala e invitación en la misma transacción', async () => {
    const result = await createRoomWithInvitation({ title: 'Sala', hostId: 'host-1' }, draft);
    expect(transaction).toHaveBeenCalledTimes(1);
    expect(createRoom).toHaveBeenCalledWith({ title: 'Sala', hostId: 'host-1' }, tx);
    expect(createInvitation).toHaveBeenCalledWith({ ...draft, roomId: 'room-1' }, tx);
    expect(result).toEqual({ room, invitation: { id: 'inv-1', code: 'abc' } });
  });

  it('si la invitación falla propaga el error para que la transacción revierta', async () => {
    vi.mocked(createInvitation).mockRejectedValueOnce(new Error('fk violation'));
    await expect(createRoomWithInvitation({ title: 'Sala', hostId: 'host-1' }, draft)).rejects.toThrow('fk violation');
  });
});
