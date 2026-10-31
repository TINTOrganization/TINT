import { act, render } from '@testing-library/react';
import { memo } from 'react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import WatchRoom from './WatchRoom';
import { MockWebSocket } from '../test/mockWebSocket';
import { apiFetch } from '../lib/api';
import { testGuestToken } from '../test/guestToken';

vi.mock('../lib/api', async (orig) => ({
  ...(await orig<typeof import('../lib/api')>()),
  apiFetch: vi.fn(),
}));
const mockedApiFetch = vi.mocked(apiFetch);

// Reproductor espía: memo como el real, cuenta cuántas veces se renderiza.
const playerRenders = vi.hoisted(() => ({ count: 0 }));
vi.mock('../components/SyncedPlayer', () => ({
  SyncedPlayer: memo(function SyncedPlayerSpy() {
    playerRenders.count += 1;
    return null;
  }),
}));

// Canal social: funciones estables (como useCallback en el hook real) y un chat que cambia
// en cada render, como cuando llegan mensajes y reacciones.
const social = vi.hoisted(() => {
  const fn = () => () => true;
  return {
    calls: 0,
    stable: {
      status: 'open' as const,
      laser: [] as unknown[],
      poll: null,
      lastError: null,
      recap: null,
      chatSettings: { slow_mode_s: 0, muted_user_ids: [] as string[] },
      chatCooldownUntil: null,
      trivia: { question: null, receivedAt: null, ack: null, result: null, myOption: null },
      triviaSchedule: [] as unknown[],
      send: fn(),
      sendReaction: fn(),
      sendLaser: fn(),
      createPoll: fn(),
      votePoll: fn(),
      closePoll: fn(),
      requestRecap: fn(),
      setSlowMode: fn(),
      muteUser: fn(),
      scheduleTrivia: fn(),
      deleteTrivia: fn(),
      listTrivia: fn(),
      answerTrivia: fn(),
      dismissTrivia: () => {},
    },
  };
});
vi.mock('../hooks/useSocialSocket', () => ({
  useSocialSocket: () => {
    social.calls += 1;
    return {
      ...social.stable,
      messages: [
        {
          event_id: `m${social.calls}`,
          type: 'chat_message',
          room_id: 'r1',
          user_id: 'u1',
          nick: 'Ana',
          text: `Hola ${social.calls}`,
          occurred_at: '2026-10-10T10:05:00Z',
          received_at: '2026-10-10T10:05:01Z',
        },
      ],
      reactions: [],
    };
  },
}));

function tree() {
  return (
    <MemoryRouter initialEntries={['/watch/r1']}>
      <Routes>
        <Route path="/watch/:roomId" element={<WatchRoom />} />
      </Routes>
    </MemoryRouter>
  );
}

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem('tint_guest_token', testGuestToken());
  MockWebSocket.reset();
  vi.stubGlobal('WebSocket', MockWebSocket);
  vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: true, addListener: vi.fn(), removeListener: vi.fn() })));
  mockedApiFetch.mockReset();
  mockedApiFetch.mockImplementation(((path: string) =>
    path.endsWith('/playback')
      ? Promise.resolve({ mediaId: 'm1', url: 'https://minio/m1?sig=1', expiresAt: '2099-01-01T00:00:00Z' })
      : Promise.reject(new Error(`ruta no simulada ${path}`))) as typeof apiFetch);
  playerRenders.count = 0;
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('WatchRoom — el reproductor no se re-renderiza por el chat', () => {
  it('un mensaje de chat re-renderiza la sala pero no el reproductor (props estables)', async () => {
    const { rerender } = render(tree());
    await flush();
    const ws = MockWebSocket.last();
    act(() => ws.open());
    act(() =>
      ws.receive({
        type: 'STATE',
        status: 'paused',
        position_ms: 0,
        updated_at_ms: 1,
        rate: 1,
        version: 1,
        server_time_ms: 1,
        media_id: 'm1',
      }),
    );
    await flush();
    const before = playerRenders.count;
    const socialBefore = social.calls;
    rerender(tree());
    rerender(tree());
    expect(social.calls).toBeGreaterThan(socialBefore);
    expect(playerRenders.count).toBe(before);
  });
});
