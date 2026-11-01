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

const social = vi.hoisted(() => ({ current: {} as Record<string, unknown> }));
vi.mock('../hooks/useSocialSocket', () => ({
  useSocialSocket: () => social.current,
}));

const requestRecap = vi.fn(() => true);

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
    requestRecap,
    chatSettings: { slow_mode_s: 0, muted_user_ids: [] },
    chatCooldownUntil: null,
    setSlowMode: vi.fn(() => true),
    muteUser: vi.fn(() => true),
    trivia: { question: null, receivedAt: null, ack: null, result: null, myOption: null },
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

const makeRecap = (n: number) => ({
  type: 'recap',
  room_id: 'r1',
  top_emoji_user: { user_id: 'u1', nick: 'Ana', count: n },
  most_paused: null,
  peak_reactions: null,
  totals: { reactions: n, pauses: 0, rewinds: 0, polls: 0 },
});

const playingState = {
  type: 'STATE',
  status: 'playing',
  position_ms: 59_000,
  updated_at_ms: 1_000,
  rate: 1,
  version: 1,
  server_time_ms: 1_000,
  online: true,
  media_id: 'm1',
  can_control: true,
};

function routeApi(path: string, init?: RequestInit) {
  if (path.endsWith('/sync-ticket')) return Promise.resolve({ token: 'ticket', expiresAt: 'x' });
  if (path.endsWith('/playback')) return Promise.resolve({ mediaId: 'm1', url: 'https://cdn/m1.mp4', expiresAt: null });
  if (path === '/rooms/r1' && init?.method === 'DELETE') return Promise.resolve({ success: true });
  return Promise.reject(new Error(`ruta no simulada ${path}`));
}

const tree = () => (
  <MemoryRouter initialEntries={['/watch/r1']}>
    <Routes>
      <Route path="/watch/:roomId" element={<WatchRoom />} />
      <Route path="/dashboard" element={<p>Mis salas</p>} />
    </Routes>
  </MemoryRouter>
);

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

const video = () => screen.getByLabelText('Vídeo de la sala') as HTMLVideoElement;

beforeEach(() => {
  localStorage.clear();
  MockWebSocket.reset();
  vi.stubGlobal('WebSocket', MockWebSocket);
  vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: true })));
  vi.stubEnv('VITE_SYNC_ENCODING', 'json');
  mockedApiFetch.mockReset();
  mockedApiFetch.mockImplementation(routeApi as typeof apiFetch);
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined);
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});
  requestRecap.mockClear();
  social.current = baseSocial();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('WatchRoom — el recap aparece una sola vez por vídeo', () => {
  it('dos `ended` seguidos piden el recap una vez y, cerrado, no reaparece', async () => {
    localStorage.setItem('tint_guest_token', testGuestToken());
    const { rerender } = render(tree());
    await flush();
    act(() => MockWebSocket.instances[0].open());
    act(() => MockWebSocket.instances[0].receive({ ...playingState, can_control: false }));
    fireEvent.ended(video());
    fireEvent.ended(video());
    expect(requestRecap).toHaveBeenCalledTimes(1);
    social.current = baseSocial({ recap: makeRecap(1) });
    rerender(tree());
    fireEvent.click(screen.getByRole('button', { name: 'Cerrar recap' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();

    // El drift re-posiciona el vídeo cerca del final: otro `ended` y otro recap.
    fireEvent.ended(video());
    social.current = baseSocial({ recap: makeRecap(2) });
    rerender(tree());
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(requestRecap).toHaveBeenCalledTimes(1);
  });

  it('el invitado espera la decisión del host y puede cerrar el modal', async () => {
    localStorage.setItem('tint_guest_token', testGuestToken());
    social.current = baseSocial({ recap: makeRecap(1) });
    render(tree());
    await flush();
    expect(screen.getByText('Esperando a que el host decida qué sigue…')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Volver a verla' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Cerrar recap' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('si el invitado es expulsado tras el final, ve que el host terminó la sala', async () => {
    localStorage.setItem('tint_guest_token', testGuestToken());
    render(tree());
    await flush();
    const ws = MockWebSocket.instances[0];
    act(() => ws.open());
    fireEvent.ended(video());
    act(() => ws.close(4001));
    expect(screen.getByText('El host terminó la sala')).toBeInTheDocument();
  });
});

describe('WatchRoom — el host decide qué sigue', () => {
  async function hostAtEnd() {
    localStorage.setItem('tint_token', 'host-token');
    render(tree());
    await flush();
    const ws = MockWebSocket.last();
    act(() => ws.open());
    act(() => ws.receive(playingState));
    Object.defineProperty(video(), 'duration', { configurable: true, value: 60 });
    fireEvent.ended(video());
    return ws;
  }

  it('al terminar pausa la sala en la posición final para que el drift no la reanude', async () => {
    const ws = await hostAtEnd();
    expect(ws.sentJson().find((m) => m.type === 'PAUSE')).toMatchObject({ position_ms: 60_000 });
  });

  it('"Volver a verla" envía SEEK 0 y PLAY, y cierra el modal', async () => {
    const ws = await hostAtEnd();
    fireEvent.click(screen.getByRole('button', { name: 'Volver a verla' }));
    const sent = ws.sentJson();
    expect(sent.find((m) => m.type === 'SEEK')).toMatchObject({ position_ms: 0 });
    expect(sent.some((m) => m.type === 'PLAY')).toBe(true);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('"Elegir otra película" cierra el modal y abre la biblioteca', async () => {
    await hostAtEnd();
    fireEvent.click(screen.getByRole('button', { name: 'Elegir otra película' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Cambiar vídeo' })).toHaveAttribute('aria-expanded', 'true');
  });

  it('"Terminar la sala" pide confirmación, borra la sala y vuelve a mis salas', async () => {
    await hostAtEnd();
    fireEvent.click(screen.getByRole('button', { name: 'Terminar la sala' }));
    expect(mockedApiFetch).not.toHaveBeenCalledWith('/rooms/r1', expect.objectContaining({ method: 'DELETE' }), 'host');
    fireEvent.click(screen.getByRole('button', { name: 'Sí, terminar' }));
    await waitFor(() => expect(screen.getByText('Mis salas')).toBeInTheDocument());
    expect(mockedApiFetch).toHaveBeenCalledWith('/rooms/r1', { method: 'DELETE' }, 'host');
  });

  it('si no se puede terminar la sala muestra un error simple', async () => {
    await hostAtEnd();
    mockedApiFetch.mockImplementation(((path: string, init?: RequestInit) =>
      init?.method === 'DELETE' ? Promise.reject(new Error('x')) : routeApi(path, init)) as typeof apiFetch);
    fireEvent.click(screen.getByRole('button', { name: 'Terminar la sala' }));
    fireEvent.click(screen.getByRole('button', { name: 'Sí, terminar' }));
    expect(await screen.findByText('No se pudo terminar la sala. Inténtalo de nuevo.')).toBeInTheDocument();
  });
});
