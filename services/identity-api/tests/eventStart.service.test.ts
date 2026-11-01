import { describe, expect, it, vi } from 'vitest';
import { startEvent, type EventStartDeps } from '../src/modules/eventStart/eventStart.service.js';

const room = { id: 'room-1', hostId: 'host-1', title: 'Evento', status: 'active' } as any;
const invitation = {
  id: 'inv-1',
  code: 'abc123',
  roomId: 'room-1',
  createdBy: 'host-1',
  expiresAt: new Date('2026-11-01T00:00:00.000Z'),
  revoked: false,
};

function deps(overrides: Partial<EventStartDeps> = {}): EventStartDeps {
  const calls: string[] = [];
  const service = (name: string) => ({
    start: vi.fn(async () => {
      calls.push(`${name}:start`);
      return { sessionId: `${name}-session` };
    }),
    stop: vi.fn(async () => {
      calls.push(`${name}:stop`);
    }),
  });
  return {
    createRoom: vi.fn(async () => {
      calls.push('identity:create');
      return room;
    }),
    createInvitation: vi.fn(async () => {
      calls.push('identity:invitation');
      return invitation;
    }),
    removeRoom: vi.fn(async () => {
      calls.push('identity:remove');
      return room;
    }),
    services: {
      sync: service('sync'),
      social: service('social'),
      analytics: service('analytics'),
    },
    publishAnalyticsEvent: vi.fn(async () => undefined),
    invitationTtlHours: 24,
    ...overrides,
    __calls: calls,
  } as EventStartDeps & { __calls: string[] };
}

describe('startEvent', () => {
  it('starts identity, sync, social, and analytics in order and returns sessions', async () => {
    const injected = deps();
    const result = await startEvent(
      { title: 'Evento', user: { id: 'host-1', providerSub: 'sub-1' } },
      injected,
    );

    expect((injected as any).__calls).toEqual([
      'identity:create',
      'identity:invitation',
      'sync:start',
      'social:start',
      'analytics:start',
    ]);
    expect(result).toMatchObject({
      room,
      invitation: { code: 'abc123', link: '/invite/abc123' },
      sessions: {
        sync: { sessionId: 'sync-session' },
        social: { sessionId: 'social-session' },
        analytics: { sessionId: 'analytics-session' },
      },
    });
  });

  it('compensates completed services and identity in reverse order', async () => {
    const injected = deps();
    vi.mocked(injected.services.analytics.start).mockRejectedValueOnce(new Error('analytics down'));

    await expect(
      startEvent(
        { title: 'Evento', user: { id: 'host-1', providerSub: 'sub-1' } },
        injected,
      ),
    ).rejects.toMatchObject({ service: 'analytics' });

    expect((injected as any).__calls).toEqual([
      'identity:create',
      'identity:invitation',
      'sync:start',
      'social:start',
      'analytics:stop',
      'social:stop',
      'sync:stop',
      'identity:remove',
    ]);
  });

  it('does not call later services when sync initialization fails', async () => {
    const injected = deps();
    vi.mocked(injected.services.sync.start).mockRejectedValueOnce(new Error('sync down'));

    await expect(
      startEvent(
        { title: 'Evento', user: { id: 'host-1', providerSub: 'sub-1' } },
        injected,
      ),
    ).rejects.toMatchObject({ service: 'sync' });

    expect(injected.services.social.start).not.toHaveBeenCalled();
    expect(injected.services.analytics.start).not.toHaveBeenCalled();
    expect(injected.services.sync.stop).toHaveBeenCalledWith('room-1');
    expect(injected.removeRoom).toHaveBeenCalledWith('room-1');
  });

  it('removes the room when invitation creation fails', async () => {
    const injected = deps();
    vi.mocked(injected.createInvitation).mockRejectedValueOnce(new Error('db down'));

    await expect(
      startEvent(
        { title: 'Evento', user: { id: 'host-1', providerSub: 'sub-1' } },
        injected,
      ),
    ).rejects.toMatchObject({ service: 'identity' });

    expect(injected.removeRoom).toHaveBeenCalledWith('room-1');
    expect(injected.services.sync.start).not.toHaveBeenCalled();
  });
});
