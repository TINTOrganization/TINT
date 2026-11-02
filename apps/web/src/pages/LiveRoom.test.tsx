/**
 * Sala live (ADR 0019, dominio-transmision): sin Canal Sync, viewer por WHEP, estudio del host,
 * aviso de fin (HU-LIVE-08) y escenario de voz. `useLiveStream` se sustituye por un doble.
 */
import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import LiveRoom from './LiveRoom';
import { MockWebSocket } from '../test/mockWebSocket';
import { testGuestToken } from '../test/guestToken';
import { ApiError, apiFetch } from '../lib/api';
import { inviteToStage, removeFromStage } from '../lib/voiceStage';
import type { LiveStream } from '../hooks/useLiveStream';

vi.mock('../lib/api', async (orig) => ({ ...(await orig<typeof import('../lib/api')>()), apiFetch: vi.fn() }));
vi.mock('../lib/voiceStage', () => ({ inviteToStage: vi.fn(async () => {}), removeFromStage: vi.fn(async () => {}) }));

const liveState = vi.hoisted(() => ({ current: {} as Record<string, unknown> }));
vi.mock('../hooks/useLiveStream', () => ({ useLiveStream: () => liveState.current }));

const mockedApi = vi.mocked(apiFetch);
let room: Record<string, unknown>;

function fakeLive(extra: Partial<LiveStream> = {}): LiveStream {
  const live = {
    status: 'idle',
    publishing: false,
    error: null,
    notice: null,
    systemAudioUnavailable: false,
    echoHint: false,
    viewerCount: null,
    scene: null,
    hostStats: null,
    endedReason: null,
    remoteStream: null,
    previewStream: null,
    cameraOn: false,
    screenSharing: false,
    mixer: {
      pc: { available: true, gain: 1, muted: false },
      mic: { available: false, gain: 1, muted: false },
      stage: { available: false, gain: 1, muted: false },
    },
    publish: vi.fn(async () => {}),
    watch: vi.fn(async () => {}),
    stop: vi.fn(async () => {}),
    replaceScreen: vi.fn(async () => {}),
    setCameraEnabled: vi.fn(async () => {}),
    enableMic: vi.fn(async () => {}),
    setScene: vi.fn(),
    setGain: vi.fn(),
    setMuted: vi.fn(),
    levels: () => ({ pc: 0, mic: 0, stage: 0 }),
    setStageStreams: vi.fn(),
    dismissNotice: vi.fn(),
    ...extra,
  } as LiveStream;
  liveState.current = live as unknown as Record<string, unknown>;
  return live;
}

function routeApi(path: string, init?: RequestInit) {
  if (path.endsWith('/sync-ticket')) return Promise.resolve({ token: 'ticket' });
  if (path === '/rooms/r1') return Promise.resolve({ room: { id: 'r1', title: 'Final', kind: 'live', status: 'active', ...room } });
  if (path === '/rooms/r1/invitations') return Promise.resolve({ invitations: [] });
  if (path === '/rooms/r1/end' && init?.method === 'POST') return Promise.resolve({ room_id: 'r1', status: 'disabled' });
  return Promise.reject(new Error(`no simulada ${path}`));
}

function renderLive() {
  return render(
    <MemoryRouter initialEntries={['/live/r1']}>
      <Routes>
        <Route path="/live/:roomId" element={<LiveRoom />} />
        <Route path="/watch/:roomId" element={<p>Página watch</p>} />
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

const social = () => MockWebSocket.instances.filter((s) => s.url.includes('/ws/social')).at(-1) as MockWebSocket;

beforeEach(() => {
  localStorage.clear();
  MockWebSocket.reset();
  room = {};
  vi.stubGlobal('WebSocket', MockWebSocket);
  vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: true, addListener: vi.fn(), removeListener: vi.fn() })));
  mockedApi.mockReset();
  mockedApi.mockImplementation(routeApi as typeof apiFetch);
  vi.mocked(inviteToStage).mockClear();
  vi.mocked(removeFromStage).mockClear();
  fakeLive();
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined);
  Object.defineProperty(HTMLMediaElement.prototype, 'srcObject', { configurable: true, writable: true, value: null });
});

describe('LiveRoom — audiencia', () => {
  beforeEach(() => {
    localStorage.setItem('tint_guest_token', testGuestToken());
    localStorage.setItem('tint_room_title', 'Final del torneo');
  });

  it('se conecta por WHEP y no abre /ws/sync', async () => {
    const live = fakeLive({ status: 'connecting' });
    renderLive();
    await flush();
    expect(live.watch).toHaveBeenCalled();
    expect(MockWebSocket.instances.some((s) => s.url.includes('/ws/sync'))).toBe(false);
    expect(MockWebSocket.instances.some((s) => s.url.includes('/ws/social'))).toBe(true);
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Final del torneo');
    expect(screen.getByText(/conectando con la transmisión/i)).toBeInTheDocument();
  });

  it('muestra "esperando", luego en vivo con contador de espectadores', async () => {
    fakeLive({ status: 'waiting' });
    const view = renderLive();
    await flush();
    expect(screen.getByText('El host aún no empieza')).toBeInTheDocument();
    fakeLive({ status: 'live', viewerCount: 12, scene: 'brb' });
    view.rerender(
      <MemoryRouter initialEntries={['/live/r1']}>
        <Routes>
          <Route path="/live/:roomId" element={<LiveRoom />} />
        </Routes>
      </MemoryRouter>,
    );
    expect(screen.queryByText('El host aún no empieza')).not.toBeInTheDocument();
    expect(screen.getByLabelText('12 espectadores')).toBeInTheDocument();
    expect(screen.getByText('Escena: Ya volvemos')).toBeInTheDocument();
    expect(screen.getByLabelText('Estado de la transmisión')).toHaveTextContent('En vivo');
  });

  it('error con reintento', async () => {
    const live = fakeLive({ status: 'error', error: { code: 'ROOM_FULL', message: 'La transmisión está llena.' } });
    renderLive();
    await flush();
    expect(screen.getByRole('alert')).toHaveTextContent('La transmisión está llena.');
    await userEvent.click(screen.getByRole('button', { name: 'Reintentar' }));
    expect(live.watch).toHaveBeenCalledTimes(2);
  });

  it('stream_state ended → aviso de fin con botón al inicio (HU-LIVE-08)', async () => {
    fakeLive({ status: 'ended' });
    renderLive();
    await flush();
    expect(screen.getByRole('alert')).toHaveTextContent(/el evento terminó y la sala fue deshabilitada/i);
    expect(screen.queryByRole('button', { name: 'Ver chat del evento' })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('link', { name: 'Volver al inicio' }));
    expect(await screen.findByText('Inicio OK')).toBeInTheDocument();
  });

  it('el chat cerrado con 4010 muestra el aviso; con 4001, "retirado"', async () => {
    renderLive();
    await flush();
    act(() => social().open());
    act(() => social().close(4010));
    await flush();
    expect(screen.getByRole('alert')).toHaveTextContent(/el evento terminó/i);
  });

  it('4001 del chat: retirado (no se confunde con el fin)', async () => {
    renderLive();
    await flush();
    act(() => social().open());
    act(() => social().close(4001));
    await flush();
    expect(screen.getByRole('alert')).toHaveTextContent('Fuiste retirado de la sala por el host');
  });

  it('4003 del chat: la invitación expiró', async () => {
    renderLive();
    await flush();
    act(() => social().open());
    act(() => social().close(4003));
    await flush();
    expect(screen.getByRole('alert')).toHaveTextContent(/expiró/);
  });

  it('WHEP 404 STREAM_NOT_FOUND: la sala no es live → /watch', async () => {
    fakeLive({ status: 'error', error: { code: 'STREAM_NOT_FOUND', message: 'x' } });
    renderLive();
    await flush();
    expect(screen.getByText('Página watch')).toBeInTheDocument();
  });

  it('la audiencia no ve el estudio ni el escenario del host', async () => {
    renderLive();
    await flush();
    expect(screen.queryByRole('button', { name: /empezar a transmitir/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Escenario' })).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /voz · escenario/i })).toBeInTheDocument();
  });
});

describe('LiveRoom — sin acceso', () => {
  it('sin token pide una invitación', async () => {
    renderLive();
    await flush();
    expect(screen.getByRole('alert')).toHaveTextContent(/invitación/);
  });
});

describe('LiveRoom — host', () => {
  beforeEach(() => localStorage.setItem('tint_token', 'host'));

  it('una sala watch redirige a /watch', async () => {
    room = { kind: 'watch' };
    renderLive();
    await flush();
    expect(screen.getByText('Página watch')).toBeInTheDocument();
  });

  it('una sala ya deshabilitada muestra el aviso con botón al dashboard', async () => {
    room = { status: 'disabled' };
    renderLive();
    await flush();
    expect(screen.getByRole('alert')).toHaveTextContent(/el evento terminó/i);
    expect(screen.getByRole('link', { name: 'Ir al dashboard' })).toHaveAttribute('href', '/dashboard');
    // El host puede leer el chat del evento terminado (HU-LIVE-09 AC3).
    expect(screen.getByRole('button', { name: 'Ver chat del evento' })).toBeInTheDocument();
  });

  it('empieza a transmitir y, publicando, ve mezclador, estadísticas y escenas', async () => {
    const live = fakeLive();
    const view = renderLive();
    await flush();
    expect(live.watch).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole('button', { name: 'Empezar a transmitir' }));
    expect(live.publish).toHaveBeenCalled();
    const publishing = fakeLive({
      status: 'live',
      publishing: true,
      screenSharing: true,
      scene: 'live',
      viewerCount: 3,
      previewStream: {} as MediaStream,
      hostStats: { layers: [{ rid: 'h', bitrate_bps: 2_400_000, active: true, viewers: 3 }], nacks: 1, plis: 2 },
      notice: 'Aviso de prueba',
    });
    view.rerender(
      <MemoryRouter initialEntries={['/live/r1']}>
        <Routes>
          <Route path="/live/:roomId" element={<LiveRoom />} />
        </Routes>
      </MemoryRouter>,
    );
    expect(screen.getByRole('heading', { name: 'Mezclador de audio' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Estadísticas' })).toBeInTheDocument();
    expect(screen.getByText('2,4 Mbps')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('radio', { name: 'Ya volvemos' }));
    expect(publishing.setScene).toHaveBeenCalledWith('brb');
    await userEvent.click(screen.getByRole('button', { name: 'Activar cámara' }));
    expect(publishing.setCameraEnabled).toHaveBeenCalledWith(true);
    await userEvent.click(screen.getByRole('button', { name: 'Cambiar pantalla' }));
    expect(publishing.replaceScreen).toHaveBeenCalled();
    await userEvent.click(screen.getByRole('button', { name: 'Cerrar aviso' }));
    expect(publishing.dismissNotice).toHaveBeenCalled();
    await userEvent.click(screen.getByRole('button', { name: 'Silenciar Audio del PC' }));
    expect(publishing.setMuted).toHaveBeenCalledWith('pc', true);
    await userEvent.click(screen.getByRole('button', { name: 'Activar micrófono' }));
    expect(publishing.enableMic).toHaveBeenCalled();
  });

  it('"Terminar evento" pide confirmación, llama a /end, para la transmisión y muestra el aviso', async () => {
    const live = fakeLive({ status: 'live', publishing: true });
    renderLive();
    await flush();
    await userEvent.click(screen.getByRole('button', { name: 'Terminar evento' }));
    const confirmDialog = screen.getByRole('alertdialog');
    await userEvent.click(within(confirmDialog).getByRole('button', { name: 'Terminar evento' }));
    await flush();
    expect(mockedApi).toHaveBeenCalledWith('/rooms/r1/end', { method: 'POST' }, 'host');
    expect(live.stop).toHaveBeenCalled();
    expect(screen.getByRole('alert')).toHaveTextContent(/el evento terminó/i);
    await userEvent.click(screen.getByRole('link', { name: 'Ir al dashboard' }));
    expect(await screen.findByText('Dashboard OK')).toBeInTheDocument();
  });

  it('cancelar la confirmación no termina nada; un 503 muestra el error', async () => {
    renderLive();
    await flush();
    await userEvent.click(screen.getByRole('button', { name: 'Terminar evento' }));
    await userEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: /cancelar/i }));
    expect(mockedApi).not.toHaveBeenCalledWith('/rooms/r1/end', expect.anything(), 'host');
    mockedApi.mockImplementation(((path: string, init?: RequestInit) =>
      path.endsWith('/end') ? Promise.reject(new ApiError(503, 'x')) : routeApi(path, init)) as typeof apiFetch);
    await userEvent.click(screen.getByRole('button', { name: 'Terminar evento' }));
    await userEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Terminar evento' }));
    await flush();
    expect(screen.getByRole('alert')).toHaveTextContent(/no se pudo terminar el evento/i);
  });

  it('invita y baja del escenario a alguien del chat', async () => {
    renderLive();
    await flush();
    act(() => social().open());
    act(() =>
      social().receive({
        type: 'chat_message',
        event_id: 'e1',
        room_id: 'r1',
        user_id: 'guest:ana',
        nick: 'Ana',
        text: 'hola',
        occurred_at: '2026-11-01T00:00:00.000Z',
        received_at: '2026-11-01T00:00:00.000Z',
      }),
    );
    await userEvent.click(screen.getByRole('button', { name: 'Invitar al escenario a Ana' }));
    expect(inviteToStage).toHaveBeenCalledWith('r1', 'guest:ana');
    await userEvent.click(await screen.findByRole('button', { name: 'Bajar del escenario a Ana' }));
    expect(removeFromStage).toHaveBeenCalledWith('r1', 'guest:ana');
    vi.mocked(inviteToStage).mockRejectedValueOnce(new Error('Solo el host puede invitar.'));
    await userEvent.click(await screen.findByRole('button', { name: 'Invitar al escenario a Ana' }));
    expect(await screen.findByText('Solo el host puede invitar.')).toBeInTheDocument();
  });
});
