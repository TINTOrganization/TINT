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
      stream: service('stream'),
    },
    markLiveRoom: vi.fn(async () => {
      calls.push('redis:kind');
    }),
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

  describe('kind=live (ADR 0019)', () => {
    const live = { title: 'Directo', kind: 'live' as const, user: { id: 'host-1', providerSub: 'sub-1' } };

    it('registra stream-core en lugar de sync-core y marca room:{id}:kind al final', async () => {
      const injected = deps();
      const result = await startEvent(live, injected);

      expect((injected as any).__calls).toEqual([
        'identity:create',
        'identity:invitation',
        'stream:start',
        'social:start',
        'analytics:start',
        'redis:kind',
      ]);
      expect(injected.createRoom).toHaveBeenCalledWith({ title: 'Directo', hostId: 'host-1', kind: 'live' });
      expect(injected.markLiveRoom).toHaveBeenCalledWith('room-1');
      expect(injected.services.sync.start).not.toHaveBeenCalled();
      expect(result.sessions).toEqual({
        stream: { sessionId: 'stream-session' },
        social: { sessionId: 'social-session' },
        analytics: { sessionId: 'analytics-session' },
      });
    });

    it('si no se puede marcar la sala como live compensa todos los servicios y la sala', async () => {
      const injected = deps();
      vi.mocked(injected.markLiveRoom!).mockRejectedValueOnce(new Error('redis down'));

      await expect(startEvent(live, injected)).rejects.toMatchObject({ service: 'redis' });

      expect((injected as any).__calls).toEqual([
        'identity:create',
        'identity:invitation',
        'stream:start',
        'social:start',
        'analytics:start',
        'analytics:stop',
        'social:stop',
        'stream:stop',
        'identity:remove',
      ]);
    });

    it('falla cerrado si stream-core no está configurado', async () => {
      const injected = deps();
      delete (injected.services as any).stream;

      await expect(startEvent(live, injected)).rejects.toMatchObject({ service: 'stream' });
      expect(injected.services.social.start).not.toHaveBeenCalled();
      expect(injected.removeRoom).toHaveBeenCalledWith('room-1');
    });

    it('una sala watch no escribe room:{id}:kind', async () => {
      const injected = deps();
      await startEvent({ title: 'Cine', user: { id: 'host-1', providerSub: 'sub-1' } }, injected);

      expect(injected.markLiveRoom).not.toHaveBeenCalled();
      expect(injected.createRoom).toHaveBeenCalledWith({ title: 'Cine', hostId: 'host-1', kind: 'watch' });
    });
  });
});
