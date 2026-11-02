import { env } from '../../config/env.js';
import { EventStartError, type EventStartDeps } from './eventStart.service.js';
import { create as createInvitation } from '../invitations/invitations.repo.js';
import { publishAnalyticsEvent } from '../analytics/analytics.events.js';
import { create as createRoom, softRemoveById } from '../rooms/rooms.repo.js';
import { getRedisClient } from '../tokens/revocation.js';

const SERVICE_TIMEOUT_MS = 5000;
/** Mismo TTL que `room:{id}:stream:enabled` (stream-core): 24 h. */
export const ROOM_KIND_TTL_SECONDS = 24 * 60 * 60;

type UpstreamName = 'sync' | 'social' | 'analytics' | 'stream';

/** `SET room:{id}:kind live EX 86400`: voice-core reconoce así las salas live (modo escenario). */
export async function markLiveRoom(roomId: string) {
  await getRedisClient().set(`room:${roomId}:kind`, 'live', 'EX', ROOM_KIND_TTL_SECONDS);
}

type ServiceResponse = Record<string, unknown>;

async function request(
  service: UpstreamName,
  baseUrl: string,
  path: string,
  options: RequestInit,
): Promise<ServiceResponse | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), SERVICE_TIMEOUT_MS);
  try {
    const response = await fetch(`${baseUrl.replace(/\/$/, '')}${path}`, {
      ...options,
      signal: controller.signal,
      headers: { 'content-type': 'application/json', ...(options.headers ?? {}) },
    });
    const body = await response.json().catch(() => null);
    if (!response.ok) {
      throw new Error(`${service} respondió ${response.status}`);
    }
    return body;
  } catch (error) {
    throw new EventStartError(service, error);
  } finally {
    clearTimeout(timeout);
  }
}

function client(service: UpstreamName, baseUrl: string) {
  return {
    start: async (roomId: string, hostId: string) =>
      request(service, baseUrl, `/internal/events/start/${encodeURIComponent(roomId)}`, {
        method: 'POST',
        body: JSON.stringify({ roomId, hostId }),
      }),
    stop: async (roomId: string) => {
      await request(service, baseUrl, `/internal/events/start/${encodeURIComponent(roomId)}`, {
        method: 'DELETE',
      });
    },
  };
}

export function defaultEventStartDeps(): EventStartDeps {
  return {
    createRoom,
    createInvitation,
    removeRoom: softRemoveById,
    services: {
      sync: client('sync', env.SYNC_CORE_URL),
      social: client('social', env.SOCIAL_CORE_URL),
      analytics: client('analytics', env.ANALYTICS_URL),
      stream: client('stream', env.STREAM_CORE_URL),
    },
    markLiveRoom,
    publishAnalyticsEvent,
    invitationTtlHours: Number.parseInt(env.INVITATION_DEFAULT_TTL_HOURS, 10),
  };
}
