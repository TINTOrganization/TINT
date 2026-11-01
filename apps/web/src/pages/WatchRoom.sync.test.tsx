import { act, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import WatchRoom from './WatchRoom';
import { MockWebSocket } from '../test/mockWebSocket';
import { apiFetch } from '../lib/api';
import { testGuestToken } from '../test/guestToken';

vi.mock('../lib/api', () => ({ apiFetch: vi.fn() }));
const mockedApiFetch = vi.mocked(apiFetch);

const sendReactionMock = vi.hoisted(() => vi.fn(() => true));

// El chat (/ws/social) se prueba en WatchRoomChat.test.tsx.
vi.mock('../hooks/useSocialSocket', () => ({
  useSocialSocket: () => ({
    status: 'open' as const,
    messages: [],
    reactions: [],
    send: vi.fn(() => true),
    sendReaction: sendReactionMock,
    laser: [],
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
    scheduleTrivia: vi.fn(() => true),
    updateTrivia: vi.fn(() => true),
    deleteTrivia: vi.fn(() => true),
    listTrivia: vi.fn(() => true),
    answerTrivia: vi.fn(() => true),
    dismissTrivia: vi.fn(),
  }),
}));

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
  mockedApiFetch.mockReset();
  mockedApiFetch.mockResolvedValue({ token: 'ticket', expiresAt: 'x' });
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined);
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('WatchRoom', () => {
  // El chip de nick/rol se prueba en WatchRoom.test.tsx; aquí solo el Canal Sync.
  it('con sesión de host muestra la sala y pide un sync-ticket', async () => {
    localStorage.setItem('tint_token', 'firebase');
    renderWatch();
    await flush();
    expect(screen.getByText(/Sala r1/)).toBeInTheDocument();
    expect(mockedApiFetch).toHaveBeenCalledWith('/rooms/r1/sync-ticket', { method: 'POST' });
  });

  it('el token de host tiene prioridad sobre un guest token previo', async () => {
    localStorage.setItem('tint_token', 'firebase');
    localStorage.setItem('tint_guest_token', testGuestToken());
    renderWatch();
    await flush();
    expect(mockedApiFetch).toHaveBeenCalledWith('/rooms/r1/sync-ticket', { method: 'POST' });
    expect(MockWebSocket.last().url).toContain('token=ticket');
  });

  it('guest se conecta a /ws/sync con su token y no puede controlar', () => {
    const token = testGuestToken();
    localStorage.setItem('tint_guest_token', token);
    renderWatch();
    expect(MockWebSocket.last().url).toContain(`room_id=r1&token=${encodeURIComponent(token)}`);
    act(() => MockWebSocket.last().open());
    expect(screen.getByRole('button', { name: 'Reproducir' })).toBeDisabled();
    expect(mockedApiFetch).not.toHaveBeenCalledWith('/rooms/r1/sync-ticket', expect.anything());
  });

  it('host obtiene un ticket, conecta y habilita los controles', async () => {
    localStorage.setItem('tint_token', 'firebase');
    renderWatch();
    await flush();
    expect(MockWebSocket.last().url).toContain('token=ticket');
    expect(screen.getByText('Conectando…')).toBeInTheDocument();
    act(() => MockWebSocket.last().open());
    expect(screen.getByText('Sincronizado')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Reproducir' })).toBeEnabled();
  });

  it('sin VITE_DEMO_VIDEO_URL muestra el aviso', async () => {
    vi.stubEnv('VITE_DEMO_VIDEO_URL', '');
    localStorage.setItem('tint_guest_token', testGuestToken());
    renderWatch();
    await flush();
    expect(screen.getByText('Sin video configurado')).toBeInTheDocument();
  });

  it('con VITE_DEMO_VIDEO_URL (sala sin vídeo) reproduce el respaldo y responde heartbeats', async () => {
    vi.stubEnv('VITE_DEMO_VIDEO_URL', 'https://cdn.test/demo.mp4');
    localStorage.setItem('tint_guest_token', testGuestToken());
    renderWatch();
    await flush();
    const video = screen.getByLabelText('Vídeo de la sala') as HTMLVideoElement;
    expect(video).toHaveAttribute('src', 'https://cdn.test/demo.mp4');
    const ws = MockWebSocket.last();
    act(() => ws.open());
    video.currentTime = 7;
    fireEvent.timeUpdate(video);
    act(() => ws.receive({ type: 'HEARTBEAT', server_time_ms: 123 }));
    expect(ws.sentJson()[0]).toMatchObject({ type: 'SYNC_CHECK', position_ms: 7_000, echo_server_ts: 123 });
  });

  it('la reacción viaja anclada a la posición actual del vídeo (REQ-21)', async () => {
    vi.stubEnv('VITE_DEMO_VIDEO_URL', 'https://cdn.test/demo.mp4');
    localStorage.setItem('tint_guest_token', testGuestToken());
    renderWatch();
    await flush();
    const video = screen.getByLabelText('Vídeo de la sala') as HTMLVideoElement;
    video.currentTime = 12.34;
    fireEvent.click(screen.getByRole('button', { name: /corazón/i }));
    expect(sendReactionMock).toHaveBeenCalledWith('❤️', 12_340);
  });
});
