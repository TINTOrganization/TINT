import { create as createInvitation } from '../invitations/invitations.repo.js';
import { publishAnalyticsEvent } from '../analytics/analytics.events.js';
import { create as createRoom, softRemoveById, type Room } from '../rooms/rooms.repo.js';

export type EventStartUser = {
  id: string;
  providerSub: string;
};

export type EventStartInvitation = {
  code: string;
  expiresAt: Date;
  link: string;
};

export type RoomKind = 'watch' | 'live';

export type EventStartResult = {
  room: Room;
  invitation: EventStartInvitation;
  /** watch: sync, social, analytics · live: stream, social, analytics (ADR 0019). */
  sessions: Partial<Record<ServiceName, unknown>>;
};

type ServiceName = 'sync' | 'social' | 'analytics' | 'stream';

/** Servicios que se inician, en orden, según el tipo de sala: live usa stream-core en lugar de sync-core. */
const SERVICES_BY_KIND: Record<RoomKind, readonly ServiceName[]> = {
  watch: ['sync', 'social', 'analytics'],
  live: ['stream', 'social', 'analytics'],
};

type ServiceClient = {
  start(roomId: string, hostId: string): Promise<unknown>;
  stop(roomId: string): Promise<void>;
};

export type EventStartDeps = {
  createRoom: typeof createRoom;
  createInvitation: typeof createInvitation;
  removeRoom: typeof softRemoveById;
  services: Record<Exclude<ServiceName, 'stream'>, ServiceClient> & { stream?: ServiceClient };
  /** `SET room:{id}:kind live EX 86400` (voice-core: modo escenario). Solo salas live. */
  markLiveRoom?: (roomId: string) => Promise<void>;
  publishAnalyticsEvent: typeof publishAnalyticsEvent;
  invitationTtlHours: number;
};

export class EventStartError extends Error {
  readonly service: ServiceName | 'identity' | 'redis';
  readonly cause: unknown;

  constructor(service: ServiceName | 'identity' | 'redis', cause: unknown) {
    super(`No se pudo iniciar el evento en ${service}`);
    this.name = 'EventStartError';
    this.service = service;
    this.cause = cause;
  }
}

function rollbackFailure(service: ServiceName | 'identity', error: unknown) {
  console.error(`[event-start] no se pudo compensar ${service}:`, (error as Error)?.message ?? String(error));
}

export async function startEvent(
  input: { title: string; kind?: RoomKind; user: EventStartUser },
  deps: EventStartDeps,
): Promise<EventStartResult> {
  const kind = input.kind ?? 'watch';
  let room: Room | undefined;
  let invitation: Awaited<ReturnType<typeof createInvitation>>;
  try {
    room = await deps.createRoom({ title: input.title, hostId: input.user.id, kind });
    const expiresAt = new Date(Date.now() + deps.invitationTtlHours * 60 * 60 * 1000);
    invitation = await deps.createInvitation({
      roomId: room.id,
      createdBy: input.user.id,
      expiresAt,
      revoked: false,
    });
  } catch (error) {
    if (room) {
      try {
        await deps.removeRoom(room.id);
      } catch (rollbackError) {
        rollbackFailure('identity', rollbackError);
      }
    }
    throw new EventStartError('identity', error);
  }

  const started: ServiceName[] = [];
  const sessions: Partial<Record<ServiceName, unknown>> = {};
  try {
    for (const service of SERVICES_BY_KIND[kind]) {
      started.push(service);
      try {
        const client = deps.services[service];
        if (!client) throw new Error(`${service} no está configurado`);
        sessions[service] = await client.start(room.id, input.user.id);
      } catch (error) {
        throw new EventStartError(service, error);
      }
    }
    // Al final: si falla, se compensa todo y la clave no queda escrita (falla cerrado: sin ella
    // voice-core trataría la sala live como una sala watch, sin modo escenario).
    if (kind === 'live') {
      try {
        if (!deps.markLiveRoom) throw new Error('markLiveRoom no está configurado');
        await deps.markLiveRoom(room.id);
      } catch (error) {
        throw new EventStartError('redis', error);
      }
    }
  } catch (error) {
    for (const service of started.reverse()) {
      try {
        const client = deps.services[service];
        if (!client) continue;
        await client.stop(room.id);
      } catch (rollbackError) {
        rollbackFailure(service, rollbackError);
      }
    }
    try {
      await deps.removeRoom(room.id);
    } catch (rollbackError) {
      rollbackFailure('identity', rollbackError);
    }
    throw error;
  }

  void deps.publishAnalyticsEvent('room_created', {
    room_id: room.id,
    user_id: input.user.providerSub,
  });

  return {
    room,
    invitation: {
      code: invitation.code,
      expiresAt: invitation.expiresAt,
      link: `/invite/${invitation.code}`,
    },
    sessions,
  };
}
