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

export type EventStartResult = {
  room: Room;
  invitation: EventStartInvitation;
  sessions: {
    sync: unknown;
    social: unknown;
    analytics: unknown;
  };
};

type ServiceName = 'sync' | 'social' | 'analytics';

type ServiceClient = {
  start(roomId: string, hostId: string): Promise<unknown>;
  stop(roomId: string): Promise<void>;
};

export type EventStartDeps = {
  createRoom: typeof createRoom;
  createInvitation: typeof createInvitation;
  removeRoom: typeof softRemoveById;
  services: Record<ServiceName, ServiceClient>;
  publishAnalyticsEvent: typeof publishAnalyticsEvent;
  invitationTtlHours: number;
};

export class EventStartError extends Error {
  readonly service: ServiceName | 'identity';
  readonly cause: unknown;

  constructor(service: ServiceName | 'identity', cause: unknown) {
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
  input: { title: string; user: EventStartUser },
  deps: EventStartDeps,
): Promise<EventStartResult> {
  let room: Room | undefined;
  let invitation: Awaited<ReturnType<typeof createInvitation>>;
  try {
    room = await deps.createRoom({ title: input.title, hostId: input.user.id });
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
    for (const service of ['sync', 'social', 'analytics'] as const) {
      started.push(service);
      try {
        sessions[service] = await deps.services[service].start(room.id, input.user.id);
      } catch (error) {
        throw new EventStartError(service, error);
      }
    }
  } catch (error) {
    for (const service of started.reverse()) {
      try {
        await deps.services[service].stop(room.id);
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
    sessions: {
      sync: sessions.sync,
      social: sessions.social,
      analytics: sessions.analytics,
    },
  };
}
