import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import WatchRoom from './WatchRoom';
import { MockWebSocket } from '../test/mockWebSocket';
import { MockXhr } from '../test/mockXhr';
import { apiFetch } from '../lib/api';
import { testGuestToken } from '../test/guestToken';

vi.mock('../lib/api', async (orig) => ({
  ...(await orig<typeof import('../lib/api')>()),
  apiFetch: vi.fn(),
}));
const mockedApiFetch = vi.mocked(apiFetch);

// El chat (/ws/social) se prueba en WatchRoomChat.test.tsx.
vi.mock('../hooks/useSocialSocket', () => ({
  useSocialSocket: () => ({
    status: 'open' as const,
    messages: [],
    reactions: [],
    send: vi.fn(() => true),
    sendReaction: vi.fn(() => true),
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
    deleteTrivia: vi.fn(() => true),
    listTrivia: vi.fn(() => true),
    answerTrivia: vi.fn(() => true),
    dismissTrivia: vi.fn(),
  }),
}));

const state = {
  type: 'STATE',
  status: 'paused',
  position_ms: 10_000,
  updated_at_ms: 1_000,
  rate: 1,
  version: 1,
  server_time_ms: 1_000,
  online: true,
  media_id: 'm1',
};

let playbackByCall: Array<{
  mediaId: string | null;
  url: string | null;
  expiresAt: string | null;
  status?: string | null;
  ambilightUrl?: string | null;
}>;

function routeApi(path: string, init?: RequestInit) {
  if (path.endsWith('/sync-ticket')) return Promise.resolve({ token: 'ticket', expiresAt: 'x' });
  if (path.endsWith('/playback')) {
    const next = playbackByCall.length > 1 ? playbackByCall.shift()! : playbackByCall[0];
    return Promise.resolve(next);
  }
  if (path.endsWith('/media') && init?.method === 'PUT') return Promise.resolve({ mediaId: 'm2', mediaKey: 'k' });
  if (path === '/videos') {
    return Promise.resolve({
      videos: [{ id: 'm2', title: 'Otra peli', durationMs: 60_000, status: 'ready', createdAt: 'x', previewUrl: null }],
    });
  }
  if (path.endsWith('/bans')) return Promise.resolve({ bans: [] });
  if (path.endsWith('/media/uploads')) {
    return Promise.resolve({
      videoId: 'v9',
      uploadUrl: 'https://minio/tint/v9/source.mp4?sig=1',
      storageKey: 'v9/source.mp4',
      expiresAt: '2099-01-01T00:00:00Z',
      headers: { 'Content-Type': 'video/mp4' },
    });
  }
  if (path.endsWith('/media/uploads/v9/complete')) {
    return Promise.resolve({ mediaId: 'v9', mediaKey: 'v9/source.mp4', status: 'pending' });
  }
  if (path.endsWith('/guests')) {
    return Promise.resolve({
      guests: [{ jti: 'j1', nick: 'Ana', joinedAt: '2026-01-01T10:00:00Z', expiresAt: '2026-01-02T10:00:00Z', revoked: false }],
    });
  }
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
  playbackByCall = [{ mediaId: 'm1', url: 'https://minio/m1?sig=1', expiresAt: '2099-01-01T00:00:00Z' }];
  mockedApiFetch.mockReset();
  mockedApiFetch.mockImplementation(routeApi as typeof apiFetch);
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined);
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('WatchRoom v2 — vídeo de la sala (F3)', () => {
  it('el invitado pide el playback con su guest token y reproduce la URL firmada', async () => {
    localStorage.setItem('tint_guest_token', testGuestToken());
    renderWatch();
    expect(screen.getByText('Cargando vídeo…')).toBeInTheDocument();
    await flush();
    expect(mockedApiFetch).toHaveBeenCalledWith('/rooms/r1/playback', { method: 'GET' }, 'guest');
    expect(screen.getByLabelText('Vídeo de la sala')).toHaveAttribute('src', 'https://minio/m1?sig=1');
  });

  it('un LOAD con otro media_id vuelve a pedir el playback y cambia el src', async () => {
    localStorage.setItem('tint_guest_token', testGuestToken());
    playbackByCall = [
      { mediaId: 'm1', url: 'https://minio/m1', expiresAt: null },
      { mediaId: 'm2', url: 'https://minio/m2', expiresAt: null },
    ];
    renderWatch();
    await flush();
    const ws = MockWebSocket.last();
    act(() => ws.open());
    act(() => ws.receive(state));
    await flush();
    expect(mockedApiFetch).toHaveBeenCalledTimes(1);
    act(() => ws.receive({ ...state, type: 'LOAD', event_id: 'e', position_ms: 0, version: 2, media_id: 'm2' }));
    await flush();
    expect(mockedApiFetch).toHaveBeenCalledTimes(2);
    expect(screen.getByLabelText('Vídeo de la sala')).toHaveAttribute('src', 'https://minio/m2');
    expect(screen.getByText('El host cargó un nuevo vídeo')).toBeInTheDocument();
  });

  it('si el vídeo falla (URL caducada) pide una URL nueva y la aplica', async () => {
    localStorage.setItem('tint_guest_token', testGuestToken());
    playbackByCall = [
      { mediaId: 'm1', url: 'https://minio/m1?sig=1', expiresAt: '2099-01-01T00:00:00Z' },
      { mediaId: 'm1', url: 'https://minio/m1?sig=2', expiresAt: '2099-01-01T00:00:00Z' },
    ];
    renderWatch();
    await flush();
    const video = screen.getByLabelText('Vídeo de la sala');
    expect(video).toHaveAttribute('src', 'https://minio/m1?sig=1');
    Object.defineProperty(video, 'error', { configurable: true, value: { code: 2 } });
    fireEvent.error(video);
    await flush();
    expect(screen.getByLabelText('Vídeo de la sala')).toHaveAttribute('src', 'https://minio/m1?sig=2');
  });

  it('el refresco de la URL no cambia el src; un cambio de calidad adopta la URL nueva', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    localStorage.setItem('tint_guest_token', testGuestToken());
    const soon = new Date(Date.now() + 70_000).toISOString();
    const qualities = (sig: number) => [
      { id: 'source', label: 'Original', url: `https://minio/m1?sig=${sig}` },
      { id: '360p', label: '360p', url: `https://minio/m1/360p?sig=${sig}` },
    ];
    playbackByCall = [
      { mediaId: 'm1', url: 'https://minio/m1?sig=1', expiresAt: soon, qualities: qualities(1) } as never,
      { mediaId: 'm1', url: 'https://minio/m1?sig=2', expiresAt: '2099-01-01T00:00:00Z', qualities: qualities(2) } as never,
    ];
    renderWatch();
    await flush();
    const ws = MockWebSocket.last();
    act(() => ws.open());
    act(() => ws.receive({ ...state, quality: 'source' }));
    await flush();
    expect(screen.getByLabelText('Vídeo de la sala')).toHaveAttribute('src', 'https://minio/m1?sig=1');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(mockedApiFetch.mock.calls.filter(([p]) => String(p).endsWith('/playback'))).toHaveLength(2);
    expect(screen.getByLabelText('Vídeo de la sala')).toHaveAttribute('src', 'https://minio/m1?sig=1');
    act(() => ws.receive({ ...state, type: 'QUALITY', event_id: 'q', version: 2, quality: '360p' }));
    await flush();
    expect(screen.getByLabelText('Vídeo de la sala')).toHaveAttribute('src', 'https://minio/m1/360p?sig=2');
  });

  it('tras un LOAD, mientras llega la URL nueva, el heartbeat no reporta la posición del vídeo viejo', async () => {
    localStorage.setItem('tint_guest_token', testGuestToken());
    let playbackCalls = 0;
    mockedApiFetch.mockImplementation(((path: string, init?: RequestInit) => {
      if (path.endsWith('/playback')) {
        playbackCalls += 1;
        // La URL de m2 aún no llega.
        return playbackCalls === 1 ? Promise.resolve(playbackByCall[0]) : new Promise(() => {});
      }
      return routeApi(path, init);
    }) as typeof apiFetch);
    renderWatch();
    await flush();
    const ws = MockWebSocket.last();
    act(() => ws.open());
    act(() => ws.receive(state));
    await flush();
    const video = screen.getByLabelText('Vídeo de la sala') as HTMLVideoElement;
    video.currentTime = 42;
    act(() => ws.receive({ type: 'HEARTBEAT', server_time_ms: 1_000 }));
    expect(ws.sentJson().at(-1)).toMatchObject({ type: 'SYNC_CHECK', position_ms: 42_000 });
    act(() => ws.receive({ ...state, type: 'LOAD', event_id: 'e', position_ms: 0, version: 2, media_id: 'm2' }));
    await flush();
    expect(screen.getByLabelText('Vídeo de la sala')).toHaveAttribute('src', 'https://minio/m1?sig=1');
    // El <video> sigue con m1 (p. ej. siguió avanzando o no pudo buscar).
    video.currentTime = 42;
    act(() => ws.receive({ type: 'HEARTBEAT', server_time_ms: 2_000 }));
    // Posición esperada del estado maestro (m2 en pausa en 0), no los 42 s de m1.
    expect(ws.sentJson().at(-1)).toMatchObject({ type: 'SYNC_CHECK', position_ms: 0, version: 2 });
  });

  it('si falla el playback muestra el error en el reproductor', async () => {
    localStorage.setItem('tint_guest_token', testGuestToken());
    mockedApiFetch.mockImplementation(((path: string) =>
      path.endsWith('/playback') ? Promise.reject(new Error('401')) : routeApi(path)) as typeof apiFetch);
    renderWatch();
    await flush();
    expect(screen.getByText('No se pudo cargar el vídeo de la sala.')).toBeInTheDocument();
  });
});

describe('WatchRoom v2 — estado del procesamiento (Ambilight)', () => {
  const base = { mediaId: 'm1', url: 'https://minio/m1', expiresAt: null };

  beforeEach(() => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve({ ok: true, json: () => Promise.resolve([]) })),
    );
  });

  it('listo: brillo con interruptor "Ambilight" y sin texto técnico ni tarjeta de relleno', async () => {
    localStorage.setItem('tint_guest_token', testGuestToken());
    playbackByCall = [{ ...base, status: 'ready', ambilightUrl: 'https://minio/m1/ambilight.json?sig=1' }];
    const { container } = renderWatch();
    await flush();
    expect(screen.getByRole('switch', { name: 'Ambilight' })).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByTestId('ambilight-glow')).toBeInTheDocument();
    // Con paleta, el brillo es el Ambilight: el halo cálido de respaldo no se apila.
    expect(screen.queryByTestId('player-halo')).not.toBeInTheDocument();
    expect(fetch).toHaveBeenCalledWith('https://minio/m1/ambilight.json?sig=1', expect.anything());
    expect(screen.queryByRole('heading', { name: 'Ambilight' })).not.toBeInTheDocument();
    expect(container.textContent).not.toMatch(/ambilight\.json|media-worker/);
  });

  it('procesando: sin brillo ni interruptor', async () => {
    localStorage.setItem('tint_guest_token', testGuestToken());
    playbackByCall = [{ ...base, status: 'processing', ambilightUrl: null }];
    renderWatch();
    await flush();
    expect(screen.queryByRole('switch', { name: 'Ambilight' })).not.toBeInTheDocument();
    expect(screen.getByTestId('ambilight-glow')).toHaveAttribute('data-visible', 'false');
    expect(screen.getByTestId('player-halo')).toBeInTheDocument();
  });

  it.each([
    ['pending', 'Preparando el vídeo…'],
    ['processing', 'Preparando el vídeo…'],
    ['ready', 'Vídeo listo'],
  ])('status %s → "%s"', async (status, text) => {
    localStorage.setItem('tint_guest_token', testGuestToken());
    playbackByCall = [{ ...base, status, ambilightUrl: status === 'ready' ? 'https://a' : null }];
    renderWatch();
    await flush();
    expect(screen.getByRole('status', { name: 'Estado del vídeo' })).toHaveTextContent(text);
    expect(screen.getByLabelText('Vídeo de la sala')).toHaveAttribute('src', 'https://minio/m1');
  });

  it('failed: avisa que el vídeo no se pudo procesar y el reproductor no lo carga', async () => {
    localStorage.setItem('tint_guest_token', testGuestToken());
    playbackByCall = [{ mediaId: 'm1', url: null, expiresAt: null, status: 'failed', ambilightUrl: null }];
    renderWatch();
    await flush();
    expect(screen.getByRole('status', { name: 'Estado del vídeo' })).toHaveTextContent(
      'No se pudo procesar el vídeo (archivo dañado o formato no soportado)',
    );
    expect(screen.getByText('Este vídeo no se pudo procesar. El host puede subir otro.')).toBeInTheDocument();
    expect(screen.queryByText('Sin video configurado')).not.toBeInTheDocument();
  });

  it('sin fila de vídeo (status null) no muestra estado de procesamiento', async () => {
    localStorage.setItem('tint_guest_token', testGuestToken());
    playbackByCall = [{ ...base, status: null }];
    renderWatch();
    await flush();
    expect(screen.getByRole('status', { name: 'Estado del vídeo' })).toHaveTextContent('');
  });
});

describe('WatchRoom v2 — host', () => {
  beforeEach(() => localStorage.setItem('tint_token', 'firebase'));

  it('sube un vídeo a MinIO, lo confirma y envía LOAD por el canal', async () => {
    MockXhr.reset();
    vi.stubGlobal('XMLHttpRequest', MockXhr);
    renderWatch();
    await flush();
    const ws = MockWebSocket.last();
    act(() => ws.open());
    await userEvent.click(screen.getByRole('button', { name: 'Cambiar vídeo' }));
    await userEvent.click(screen.getByRole('tab', { name: 'Subir nuevo' }));
    await userEvent.upload(
      screen.getByLabelText('Archivo de vídeo'),
      new File(['abc'], 'peli.mp4', { type: 'video/mp4' }),
    );
    await userEvent.click(screen.getByRole('button', { name: 'Subir' }));
    await waitFor(() => expect(MockXhr.instances).toHaveLength(1));
    act(() => MockXhr.last().respond(200));
    await waitFor(() => expect(ws.sentJson().some((m) => m.type === 'LOAD')).toBe(true));
    expect(ws.sentJson().find((m) => m.type === 'LOAD')).toMatchObject({ media_id: 'v9', position_ms: 0 });
    expect(screen.getByText('Vídeo cargado para todos.')).toBeInTheDocument();
  });

  it('elige un vídeo de "Mis vídeos": PUT /media {videoId} y LOAD por el canal', async () => {
    renderWatch();
    await flush();
    const ws = MockWebSocket.last();
    act(() => ws.open());
    await userEvent.click(screen.getByRole('button', { name: 'Cambiar vídeo' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Ver «Otra peli» en la sala' }));
    await waitFor(() => expect(ws.sentJson().some((m) => m.type === 'LOAD')).toBe(true));
    expect(ws.sentJson().find((m) => m.type === 'LOAD')).toMatchObject({ media_id: 'm2', position_ms: 0, room_id: 'r1' });
    expect(mockedApiFetch).toHaveBeenCalledWith(
      '/rooms/r1/media',
      { method: 'PUT', body: JSON.stringify({ videoId: 'm2' }) },
      'host',
    );
  });

  it('lista los participantes', async () => {
    renderWatch();
    expect(await screen.findByRole('button', { name: 'Retirar a Ana' })).toBeInTheDocument();
  });

  it('el servidor puede quitarle el control al host', async () => {
    renderWatch();
    await flush();
    const ws = MockWebSocket.last();
    act(() => ws.open());
    expect(screen.getByRole('button', { name: 'Reproducir' })).toBeEnabled();
    act(() => ws.receive({ ...state, can_control: false }));
    expect(screen.getByRole('button', { name: 'Reproducir' })).toBeDisabled();
  });
});

describe('WatchRoom v2 — invitado', () => {
  it('con control delegado ve el aviso y puede controlar', async () => {
    localStorage.setItem('tint_guest_token', testGuestToken());
    renderWatch();
    await flush();
    const ws = MockWebSocket.last();
    act(() => ws.open());
    expect(screen.queryByRole('button', { name: 'Cambiar vídeo' })).not.toBeInTheDocument();
    act(() => ws.receive({ type: 'CONTROL', can_control: true }));
    expect(screen.getByText('El host no está: tienes el control temporal')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Reproducir' })).toBeEnabled();
    expect(screen.getByText('Controlas la reproducción de la sala')).toBeInTheDocument();
  });

  it('cierre 4001: muestra la expulsión y no reconecta', async () => {
    localStorage.setItem('tint_guest_token', testGuestToken());
    renderWatch();
    await flush();
    const ws = MockWebSocket.last();
    act(() => ws.open());
    act(() => ws.close(4001, 'token revocado'));
    expect(screen.getByRole('alert')).toHaveTextContent('Fuiste retirado de la sala por el host');
    expect(screen.queryByLabelText('Vídeo de la sala')).not.toBeInTheDocument();
    expect(localStorage.getItem('tint_guest_token')).toBeNull();
    expect(screen.getByRole('link', { name: 'Volver al inicio' })).toHaveAttribute('href', '/');
  });

  it('cierre 4003 del invitado: pantalla de invitación caducada, sin reconectar', async () => {
    localStorage.setItem('tint_guest_token', testGuestToken());
    renderWatch();
    await flush();
    act(() => MockWebSocket.last().open());
    act(() => MockWebSocket.last().close(4003, 'token expirado'));
    expect(screen.getByRole('alert')).toHaveTextContent(/tu invitación expiró/i);
    expect(localStorage.getItem('tint_guest_token')).toBeNull();
  });

  it('cierre 4003 repetido del host: avisa que la sesión de sincronía caducó', async () => {
    localStorage.setItem('tint_token', 'host');
    renderWatch();
    await flush();
    act(() => MockWebSocket.last().open());
    act(() => MockWebSocket.last().close(4003));
    await flush();
    act(() => MockWebSocket.last().open());
    act(() => MockWebSocket.last().close(4003));
    await flush();
    expect(screen.getByRole('alert')).toHaveTextContent(/sesión de sincronía caducó/i);
    expect(screen.getByRole('link', { name: 'Ir al dashboard' })).toHaveAttribute('href', '/dashboard');
  });

  it('invitado con el playback en 401 (retirado con la pestaña cerrada): pantalla de invitación no válida', async () => {
    localStorage.setItem('tint_guest_token', testGuestToken());
    mockedApiFetch.mockImplementation(((path: string, init?: RequestInit) =>
      path.endsWith('/playback')
        ? Promise.reject(Object.assign(new Error('Unauthorized'), { status: 401 }))
        : routeApi(path, init)) as typeof apiFetch);
    renderWatch();
    await flush();
    expect(screen.getByRole('alert')).toHaveTextContent(/tu invitación ya no es válida/i);
    expect(screen.queryByText(/reconectando/i)).not.toBeInTheDocument();
    expect(localStorage.getItem('tint_guest_token')).toBeNull();
    // El socket que alcanzó a abrirse se cierra y no se reintenta.
    const opened = MockWebSocket.instances.length;
    await act(async () => {
      await new Promise((r) => setTimeout(r, 700));
    });
    expect(MockWebSocket.instances).toHaveLength(opened);
  });

  it.each([
    [403, /no eres el host de esta sala/i],
    [404, /la sala ya no existe/i],
    [410, /la sala ya no existe/i],
  ])('host con sync-ticket en %i: mensaje claro en vez de "Reconectando…"', async (status, text) => {
    localStorage.setItem('tint_token', 'host');
    mockedApiFetch.mockImplementation(((path: string, init?: RequestInit) =>
      path.endsWith('/sync-ticket')
        ? Promise.reject(Object.assign(new Error('x'), { status }))
        : routeApi(path, init)) as typeof apiFetch);
    renderWatch();
    await flush();
    expect(screen.getByRole('alert')).toHaveTextContent(text);
    expect(screen.queryByText(/reconectando/i)).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Ir al dashboard' })).toHaveAttribute('href', '/dashboard');
  });

  it('avisa de los comandos del host en una región aria-live', async () => {
    localStorage.setItem('tint_guest_token', testGuestToken());
    renderWatch();
    await flush();
    const ws = MockWebSocket.last();
    act(() => ws.open());
    act(() => ws.receive(state));
    act(() => ws.receive({ ...state, type: 'SEEK', event_id: 'h1', position_ms: 754_000, version: 2 }));
    const toast = screen.getByText('El host saltó a 12:34');
    expect(toast.closest('[aria-live="polite"]')).not.toBeNull();
  });
});

describe('WatchRoom v2 — estado de conexión', () => {
  it('muestra la calidad de sincronía con RTT', async () => {
    localStorage.setItem('tint_guest_token', testGuestToken());
    renderWatch();
    await flush();
    const ws = MockWebSocket.last();
    act(() => ws.open());
    act(() => ws.receive({ type: 'HEARTBEAT', server_time_ms: 1, rtt_ms: 40 }));
    expect(screen.getByTestId('sync-quality')).toHaveTextContent('Sincronía buena');
  });

  it('muestra el intento de reconexión con cuenta regresiva', async () => {
    localStorage.setItem('tint_guest_token', testGuestToken());
    renderWatch();
    await flush();
    act(() => MockWebSocket.last().close(1006));
    expect(screen.getByTestId('reconnect-countdown')).toHaveTextContent('Reconectando… intento 1');
    expect(screen.queryByTestId('sync-quality')).not.toBeInTheDocument();
  });

  it('los atajos no se disparan al escribir en el chat', async () => {
    localStorage.setItem('tint_token', 'firebase');
    renderWatch();
    await flush();
    const ws = MockWebSocket.last();
    act(() => ws.open());
    const input = screen.getByPlaceholderText('Escribe un mensaje');
    fireEvent.keyDown(input, { key: 'k' });
    expect(ws.sentJson().filter((m) => m.type === 'PLAY')).toHaveLength(0);
    fireEvent.keyDown(document.body, { key: 'k' });
    expect(ws.sentJson().filter((m) => m.type === 'PLAY')).toHaveLength(1);
  });
});
