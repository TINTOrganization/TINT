import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
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

// Canal social controlable: cada prueba fija lo que "llega" de social-core.
const social = vi.hoisted(() => ({ current: {} as Record<string, unknown>, args: [] as unknown[] }));
vi.mock('../hooks/useSocialSocket', () => ({
  useSocialSocket: (...args: unknown[]) => {
    social.args = args;
    return social.current;
  },
}));

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
    trivia: { question: null, receivedAt: null, ack: null, result: null, myOption: null },
    triviaSchedule: [],
    triviaLeaderboard: { entries: [], myRank: null, myTotal: null },
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
  if (path.endsWith('/playback')) return Promise.resolve({ mediaId: 'm1', url: 'https://minio/m1?sig=1', expiresAt: null });
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
    await Promise.resolve();
  });
}

beforeEach(() => {
  localStorage.clear();
  MockWebSocket.reset();
  vi.stubGlobal('WebSocket', MockWebSocket);
  vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: true, addListener: vi.fn(), removeListener: vi.fn() })));
  vi.stubEnv('VITE_SYNC_ENCODING', 'json');
  mockedApiFetch.mockReset();
  mockedApiFetch.mockImplementation(routeApi as typeof apiFetch);
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined);
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});
  social.current = baseSocial();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('WatchRoom — puntero láser', () => {
  it('el host activa el láser y dibuja sobre el vídeo', async () => {
    localStorage.setItem('tint_token', 'host-token');
    renderWatch();
    await flush();
    const toggle = screen.getByRole('button', { name: 'Puntero láser' });
    expect(toggle).toHaveAttribute('aria-pressed', 'false');
    const surface = screen.getByTestId('laser-overlay');
    expect(surface.className).toContain('pointer-events-none');
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-pressed', 'true');
    expect(surface.style.cursor).toContain('url(');
    vi.spyOn(surface, 'getBoundingClientRect').mockReturnValue({
      left: 0,
      top: 0,
      width: 100,
      height: 100,
      right: 100,
      bottom: 100,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    });
    fireEvent.pointerDown(surface, { clientX: 25, clientY: 50 });
    fireEvent.pointerMove(surface, { clientX: 50, clientY: 50 });
    expect(social.current.sendLaser).toHaveBeenCalledWith(0.25, 0.5, false);
    expect(social.current.sendLaser).toHaveBeenLastCalledWith(0.5, 0.5, false);
  });

  it('el invitado ve el trazo pero no tiene el botón del láser', async () => {
    localStorage.setItem('tint_guest_token', testGuestToken());
    renderWatch();
    await flush();
    expect(screen.queryByRole('button', { name: 'Puntero láser' })).not.toBeInTheDocument();
    expect(screen.getByTestId('laser-overlay').className).toContain('pointer-events-none');
  });
});

describe('WatchRoom — encuestas', () => {
  it('el botón de la barra abre el creador con el foco en la pregunta', async () => {
    localStorage.setItem('tint_token', 'host-token');
    renderWatch();
    await flush();
    fireEvent.click(screen.getByRole('button', { name: 'Crear encuesta' }));
    expect(screen.getByLabelText('Pregunta')).toHaveFocus();
    fireEvent.change(screen.getByLabelText('Pregunta'), { target: { value: '¿Final?' } });
    fireEvent.change(screen.getByLabelText('Opción 1'), { target: { value: 'Sí' } });
    fireEvent.change(screen.getByLabelText('Opción 2'), { target: { value: 'No' } });
    fireEvent.click(screen.getByRole('button', { name: 'Lanzar encuesta' }));
    expect(social.current.createPoll).toHaveBeenCalledWith('¿Final?', ['Sí', 'No'], 60);
    // El creador colapsa animado (AnimatePresence) antes de desmontarse.
    await waitFor(() => expect(screen.queryByLabelText('Pregunta')).not.toBeInTheDocument());
  });

  it('el invitado vota en la encuesta activa y ve los errores del canal', async () => {
    localStorage.setItem('tint_guest_token', testGuestToken());
    social.current = baseSocial({
      poll: {
        type: 'poll_state',
        poll_id: 'p1',
        question: '¿Quién fue?',
        options: ['A', 'B'],
        counts: [0, 0],
        closes_at_ms: Date.now() + 30_000,
        closed: false,
        my_vote: null,
      },
      lastError: { code: 'POLL_CLOSED' },
    });
    renderWatch();
    await flush();
    expect(screen.queryByRole('button', { name: 'Crear encuesta' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /^B/ }));
    expect(social.current.votePoll).toHaveBeenCalledWith('p1', 1);
    expect(screen.getByText('La encuesta ya está cerrada.')).toBeInTheDocument();
  });
});

describe('WatchRoom — Watch Party Recap', () => {
  const recap = {
    type: 'recap',
    room_id: 'r1',
    top_emoji_user: { user_id: 'u1', nick: 'Ana', count: 12 },
    most_paused: null,
    peak_reactions: null,
    totals: { reactions: 12, pauses: 0, rewinds: 0, polls: 0 },
  };

  it('al terminar el vídeo pide el recap y muestra la pantalla', async () => {
    localStorage.setItem('tint_guest_token', testGuestToken());
    const { rerender } = renderWatch();
    await flush();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    fireEvent.ended(screen.getByLabelText('Vídeo de la sala'));
    expect(social.current.requestRecap).toHaveBeenCalled();
    expect(screen.getByText('Preparando el recap de la sesión…')).toBeInTheDocument();
    social.current = { ...social.current, recap };
    rerender(
      <MemoryRouter initialEntries={['/watch/r1']}>
        <Routes>
          <Route path="/watch/:roomId" element={<WatchRoom />} />
        </Routes>
      </MemoryRouter>,
    );
    expect(screen.getByText('Ana')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Cerrar recap' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('un recap que llega sin pedirlo también se muestra', async () => {
    localStorage.setItem('tint_guest_token', testGuestToken());
    social.current = baseSocial({ recap });
    renderWatch();
    await flush();
    expect(screen.getByRole('dialog', { name: 'Watch Party Recap' })).toBeInTheDocument();
  });
});

describe('WatchRoom — halo del reproductor', () => {
  it('respira mientras el vídeo se reproduce y se atenúa en pausa o al terminar', async () => {
    localStorage.setItem('tint_guest_token', testGuestToken());
    const { container } = renderWatch();
    await flush();
    const halo = screen.getByTestId('player-halo');
    expect(halo).toHaveAttribute('aria-hidden', 'true');
    expect(halo).toHaveAttribute('data-playing', 'false');
    const video = screen.getByLabelText('Vídeo de la sala');
    fireEvent.play(video);
    expect(halo).toHaveAttribute('data-playing', 'true');
    fireEvent.pause(video);
    expect(halo).toHaveAttribute('data-playing', 'false');
    fireEvent.play(video);
    fireEvent.ended(video);
    expect(halo).toHaveAttribute('data-playing', 'false');
    // La franja degradada difuminada bajo el vídeo ya no existe.
    expect(container.querySelector('.blur-\\[6px\\]')).toBeNull();
  });
});

describe('WatchRoom — chat', () => {
  const msg = (id: string, text: string) => ({
    event_id: id,
    type: 'chat_message',
    room_id: 'r1',
    user_id: 'u1',
    nick: 'Ana',
    text,
    occurred_at: '2026-10-10T10:05:00Z',
  });

  it('los mensajes del primer render no animan su entrada; los nuevos sí', async () => {
    localStorage.setItem('tint_guest_token', testGuestToken());
    social.current = baseSocial({ messages: [msg('m1', 'Hola')] });
    const { rerender } = renderWatch();
    await flush();
    expect(screen.getByText('Hola').closest('li')).toHaveAttribute('data-enter', 'false');
    social.current = { ...social.current, messages: [msg('m1', 'Hola'), msg('m2', 'Qué tal')] };
    rerender(
      <MemoryRouter initialEntries={['/watch/r1']}>
        <Routes>
          <Route path="/watch/:roomId" element={<WatchRoom />} />
        </Routes>
      </MemoryRouter>,
    );
    expect(screen.getByText('Qué tal').closest('li')).toHaveAttribute('data-enter', 'true');
    expect(screen.getByText('Hola').closest('li')).toHaveAttribute('data-enter', 'false');
  });
});

describe('WatchRoom — credencial del canal social', () => {
  it('el host abre /ws/social con rol host (sync-ticket) y el invitado con rol guest', async () => {
    localStorage.setItem('tint_token', 'host-token');
    const { unmount } = renderWatch();
    await flush();
    expect(social.args).toEqual(['r1', { role: 'host' }]);
    unmount();
    localStorage.clear();
    localStorage.setItem('tint_guest_token', testGuestToken());
    renderWatch();
    await flush();
    expect(social.args).toEqual(['r1', { role: 'guest' }]);
  });
});
