/**
 * Pruebas rojas del aviso de fin del evento (HU-LIVE-08, HU-LIVE-09 AC1/AC2; ADR 0019).
 * Cierre 4010 ROOM_DISABLED o `410 {error:"Disabled"}` → "El evento terminó y la sala fue
 * deshabilitada", con un botón al dashboard (host) o al inicio (invitado). El 4001 sigue
 * siendo "retirado" (no se confunden).
 */
import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import WatchRoom from './WatchRoom';
import { MockWebSocket } from '../test/mockWebSocket';
import { apiFetch, ApiError } from '../lib/api';
import { testGuestToken } from '../test/guestToken';

vi.mock('../lib/api', async (orig) => ({
  ...(await orig<typeof import('../lib/api')>()),
  apiFetch: vi.fn(),
}));
const mockedApi = vi.mocked(apiFetch);

/** Sockets del Canal Social (los del Canal Sync son los demás MockWebSocket). */
const socialSockets = vi.hoisted(() => [] as unknown[]);

vi.mock('../hooks/useSocialSocket', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../hooks/useSocialSocket')>();
  const { MockWebSocket: Ws } = await import('../test/mockWebSocket');
  return {
    ...actual,
    useSocialSocket: (roomId: string | undefined, opts: Record<string, unknown> = {}) =>
      (actual.useSocialSocket as unknown as (r: string | undefined, o: Record<string, unknown>) => unknown)(roomId, {
        ...opts,
        reconnectBaseMs: 50,
        createSocket: (url: string) => {
          const ws = new Ws(url);
          socialSockets.push(ws);
          return ws as unknown as WebSocket;
        },
      }),
  };
});

const lastSocial = () => socialSockets[socialSockets.length - 1] as MockWebSocket;
const syncSockets = () => MockWebSocket.instances.filter((s) => !socialSockets.includes(s));

const ENDED = /el evento terminó/i;

let playbackError: unknown = null;

function routeApi(path: string) {
  if (path.endsWith('/sync-ticket')) return Promise.resolve({ token: 'ticket', expiresAt: '2099-01-01T00:00:00Z' });
  if (path.endsWith('/playback')) {
    if (playbackError) return Promise.reject(playbackError);
    return Promise.resolve({ mediaId: 'm1', url: 'https://minio/m1?sig=1', expiresAt: '2099-01-01T00:00:00Z' });
  }
  if (path === '/rooms/r1') return Promise.resolve({ room: { id: 'r1', title: 'Concierto' } });
  if (path.endsWith('/invitations')) return Promise.resolve({ invitations: [] });
  if (path.endsWith('/guests')) return Promise.resolve({ guests: [] });
  if (path.endsWith('/bans')) return Promise.resolve({ bans: [] });
  if (path === '/videos') return Promise.resolve({ videos: [] });
  return Promise.reject(new Error(`ruta no simulada ${path}`));
}

function renderWatch() {
  return render(
    <MemoryRouter initialEntries={['/watch/r1']}>
      <Routes>
        <Route path="/watch/:roomId" element={<WatchRoom />} />
        <Route path="/dashboard" element={<p>Dashboard OK</p>} />
        <Route path="/" element={<p>Inicio OK</p>} />
      </Routes>
    </MemoryRouter>,
  );
}

async function flush() {
  await act(async () => {
    for (let i = 0; i < 6; i += 1) await Promise.resolve();
  });
}

async function wait(ms: number) {
  await act(async () => {
    await new Promise((r) => setTimeout(r, ms));
  });
}

/** El único enlace o botón de la tarjeta del aviso (la acción para salir). */
function noticeAction() {
  const alert = screen.getByRole('alert');
  const card = alert.parentElement as HTMLElement;
  const actions = [...within(card).queryAllByRole('link'), ...within(card).queryAllByRole('button')];
  expect(actions).toHaveLength(1);
  return actions[0];
}

beforeEach(() => {
  localStorage.clear();
  MockWebSocket.reset();
  socialSockets.length = 0;
  playbackError = null;
  vi.stubGlobal('WebSocket', MockWebSocket);
  vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: true, addListener: vi.fn(), removeListener: vi.fn() })));
  vi.stubEnv('VITE_SYNC_ENCODING', 'json');
  mockedApi.mockReset();
  mockedApi.mockImplementation(routeApi as typeof apiFetch);
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined);
});

describe('WatchRoom — evento terminado (HU-LIVE-08)', () => {
  it('invitado: el chat cerrado con 4010 muestra "El evento terminó" y el botón lleva al inicio', async () => {
    localStorage.setItem('tint_guest_token', testGuestToken());
    renderWatch();
    await flush();
    act(() => lastSocial().open());
    act(() => lastSocial().close(4010, 'ROOM_DISABLED'));
    await flush();
    expect(screen.getByRole('alert')).toHaveTextContent(ENDED);
    expect(screen.queryByText(/retirado/i)).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Reproductor')).not.toBeInTheDocument();
    await userEvent.click(noticeAction());
    expect(await screen.findByText('Inicio OK')).toBeInTheDocument();
  });

  it('host: el chat cerrado con 4010 muestra el aviso y el botón lleva a /dashboard', async () => {
    localStorage.setItem('tint_token', 'host');
    renderWatch();
    await flush();
    act(() => lastSocial().open());
    act(() => lastSocial().close(4010, 'ROOM_DISABLED'));
    await flush();
    expect(screen.getByRole('alert')).toHaveTextContent(ENDED);
    await userEvent.click(noticeAction());
    expect(await screen.findByText('Dashboard OK')).toBeInTheDocument();
  });

  it('el 4010 es terminal: el chat no reconecta', async () => {
    localStorage.setItem('tint_guest_token', testGuestToken());
    renderWatch();
    await flush();
    act(() => lastSocial().open());
    act(() => lastSocial().close(4010));
    const opened = socialSockets.length;
    await wait(300);
    expect(socialSockets).toHaveLength(opened);
  });

  it('el Canal Sync cerrado con 4010 muestra el mismo aviso (HU-LIVE-09 AC1)', async () => {
    localStorage.setItem('tint_guest_token', testGuestToken());
    renderWatch();
    await flush();
    const sync = syncSockets()[syncSockets().length - 1];
    act(() => sync.open());
    act(() => sync.close(4010, 'ROOM_DISABLED'));
    await flush();
    expect(screen.getByRole('alert')).toHaveTextContent(ENDED);
  });

  it('al reconectarse después del fin (handshake + 4010) ve el mismo aviso, no una sala vacía (AC3)', async () => {
    localStorage.setItem('tint_guest_token', testGuestToken());
    renderWatch();
    await flush();
    act(() => lastSocial().open());
    // Corte de red: reconecta, y el servidor hace upgrade y cierra con 4010.
    act(() => lastSocial().close(1006));
    await wait(120);
    expect(socialSockets.length).toBeGreaterThanOrEqual(2);
    act(() => lastSocial().close(4010));
    await flush();
    expect(screen.getByRole('alert')).toHaveTextContent(ENDED);
  });

  it('invitado: GET /playback con 410 {error:"Disabled"} muestra el aviso de fin (AC3)', async () => {
    localStorage.setItem('tint_guest_token', testGuestToken());
    playbackError = new ApiError(410, 'Disabled', { error: 'Disabled' });
    renderWatch();
    await flush();
    expect(screen.getByRole('alert')).toHaveTextContent(ENDED);
    expect(screen.queryByText(/no se pudo cargar el vídeo/i)).not.toBeInTheDocument();
    await userEvent.click(noticeAction());
    expect(await screen.findByText('Inicio OK')).toBeInTheDocument();
  });

  it('host: GET /playback con 410 {error:"Disabled"} muestra el aviso y lleva al dashboard', async () => {
    localStorage.setItem('tint_token', 'host');
    playbackError = new ApiError(410, 'Disabled', { error: 'Disabled' });
    renderWatch();
    await flush();
    expect(screen.getByRole('alert')).toHaveTextContent(ENDED);
    await userEvent.click(noticeAction());
    expect(await screen.findByText('Dashboard OK')).toBeInTheDocument();
  });

  it('regresión: el 4001 del chat sigue siendo "retirado", no "evento terminado"', async () => {
    localStorage.setItem('tint_guest_token', testGuestToken());
    renderWatch();
    await flush();
    act(() => lastSocial().open());
    act(() => lastSocial().close(4001, 'token revocado'));
    await flush();
    expect(screen.getByRole('alert')).toHaveTextContent('Fuiste retirado de la sala por el host');
    expect(screen.queryByText(ENDED)).not.toBeInTheDocument();
  });
});
