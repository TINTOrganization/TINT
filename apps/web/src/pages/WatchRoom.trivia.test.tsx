import { act, fireEvent, render, screen } from '@testing-library/react';
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

const social = vi.hoisted(() => ({ current: {} as Record<string, unknown> }));
vi.mock('../hooks/useSocialSocket', () => ({ useSocialSocket: () => social.current }));

const emptyTrivia = { question: null, receivedAt: null, ack: null, result: null, myOption: null };

function baseSocial(over: Record<string, unknown> = {}) {
  return {
    status: 'open' as const,
    messages: [],
    reactions: [],
    laser: [],
    send: vi.fn(() => true),
    sendReaction: vi.fn(() => true),
    sendLaser: vi.fn(() => true),
    poll: null,
    lastError: null,
    createPoll: vi.fn(() => true),
    votePoll: vi.fn(() => true),
    closePoll: vi.fn(() => true),
    recap: null,
    requestRecap: vi.fn(() => true),
    chatSettings: { slow_mode_s: 0, muted_user_ids: [] },
    chatCooldownUntil: null,
    setSlowMode: vi.fn(() => true),
    muteUser: vi.fn(() => true),
    trivia: emptyTrivia,
    triviaSchedule: [],
    scheduleTrivia: vi.fn(() => true),
    updateTrivia: vi.fn(() => true),
    deleteTrivia: vi.fn(() => true),
    listTrivia: vi.fn(() => true),
    answerTrivia: vi.fn(() => true),
    dismissTrivia: vi.fn(),
    ...over,
  };
}

function routeApi(path: string) {
  if (path.endsWith('/sync-ticket')) return Promise.resolve({ token: 'ticket', expiresAt: 'x' });
  if (path.endsWith('/playback')) return Promise.resolve({ mediaId: 'm1', url: 'https://cdn/m1.mp4', expiresAt: null });
  if (path.endsWith('/guests')) return Promise.resolve({ guests: [] });
  if (path.endsWith('/bans')) return Promise.resolve({ bans: [] });
  return Promise.reject(new Error(`ruta no simulada ${path}`));
}

function renderWatch() {
  return render(
    <MemoryRouter initialEntries={['/watch/r1']}>
      <Routes>
        <Route path="/watch/:roomId" element={<WatchRoom />} />
      </Routes>
    </MemoryRouter>,
  );
}

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

beforeEach(() => {
  localStorage.clear();
  MockWebSocket.reset();
  vi.stubGlobal('WebSocket', MockWebSocket);
  vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: true })));
  mockedApiFetch.mockReset();
  mockedApiFetch.mockImplementation(routeApi as typeof apiFetch);
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined);
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});
  social.current = baseSocial();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('WatchRoom — trivia', () => {
  it('el host programa una pregunta en el momento actual del vídeo', async () => {
    localStorage.setItem('tint_token', 'host-token');
    renderWatch();
    await flush();
    expect(screen.queryByText(/social-core/)).not.toBeInTheDocument();
    (screen.getByLabelText('Vídeo de la sala') as HTMLVideoElement).currentTime = 42;
    fireEvent.click(screen.getByRole('button', { name: 'Agregar pregunta en este momento' }));
    expect(screen.getByLabelText('Momento del vídeo (mm:ss)')).toHaveValue('00:42');
  });

  it('el invitado responde la pregunta emergente sobre el reproductor', async () => {
    localStorage.setItem('tint_guest_token', testGuestToken());
    social.current = baseSocial({
      trivia: {
        ...emptyTrivia,
        question: { type: 'trivia_question', trivia_id: 't1', question: '¿Quién?', options: ['A', 'B'], opens_at_ms: 0, closes_at_ms: 20_000 },
        receivedAt: Date.now(),
      },
    });
    renderWatch();
    await flush();
    const player = screen.getByRole('region', { name: 'Reproductor' });
    expect(player).toContainElement(screen.getByRole('region', { name: 'Trivia' }));
    fireEvent.click(screen.getByRole('button', { name: 'B' }));
    expect(social.current.answerTrivia).toHaveBeenCalledWith('t1', 1);
  });
});
