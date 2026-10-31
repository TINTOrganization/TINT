import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import RoomAnalytics from './RoomAnalytics';
import { apiFetch, ApiError } from '../lib/api';
import {
  AnalyticsError,
  createAnalyticsClient,
  type AnalyticsClient,
  type ReactionHeatmap,
  type RoomKpis,
  type RoomTimeline,
} from '../lib/analytics';

vi.mock('../lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/api')>();
  return { ...actual, apiFetch: vi.fn() };
});

vi.mock('../lib/analytics', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/analytics')>();
  return { ...actual, createAnalyticsClient: vi.fn() };
});

const mockedApi = vi.mocked(apiFetch);
const mockedClient = vi.mocked(createAnalyticsClient);

const kpis: RoomKpis = {
  room_id: 'r1',
  live: true,
  peak_users: 6,
  avg_users: 3.25,
  avg_drift_ms: 84.6,
  trivia_accuracy_pct: 62.5,
  messages: 42,
  reactions: 17,
  playback_commands: 9,
  buffering_events: 3,
  avg_buffering_ms: 712.4,
  avg_rtt_ms: 48.2,
  p95_drift_ms: 931.7,
  total_buffering_ms: 2137,
  close_reason: null,
  closed_at: null,
  computed_at: '2026-10-11T20:30:00.000Z',
};

const heatmap: ReactionHeatmap = {
  room_id: 'r1',
  bucket_ms: 5_000,
  buckets: [{ bucket_start_ms: 0, emoji: '👏', count: 17 }],
  density: [{ bucket_start_ms: 0, count: 17, density: 1 }],
  by_emoji: [{ emoji: '👏', count: 17 }],
};

const timeline: RoomTimeline = {
  room_id: 'r1',
  step_s: 60,
  points: [
    { t: '2026-10-11T20:00:00.000Z', connected_users: 2, messages: 10, reactions: 5 },
    { t: '2026-10-11T20:01:00.000Z', connected_users: 6, messages: 32, reactions: 12 },
  ],
};

function client(over: Partial<AnalyticsClient> = {}): AnalyticsClient {
  return {
    kpis: vi.fn().mockResolvedValue(kpis),
    heatmap: vi.fn().mockResolvedValue(heatmap),
    timeline: vi.fn().mockResolvedValue(timeline),
    ...over,
  };
}

function LoginProbe() {
  return <p>{`login${useLocation().search}`}</p>;
}

function renderPage(path = '/rooms/r1/analytics') {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/rooms/:id/analytics" element={<RoomAnalytics />} />
        <Route path="/login" element={<LoginProbe />} />
        <Route path="/dashboard" element={<p>dashboard</p>} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  mockedApi.mockResolvedValue({ room: { id: 'r1', title: 'Noche de cine' } });
});

describe('RoomAnalytics', () => {
  it('muestra esqueletos mientras carga', async () => {
    mockedClient.mockReturnValue(client({ kpis: vi.fn(() => new Promise<RoomKpis>(() => {})) }));
    renderPage();
    expect(screen.getByText('Cargando analítica…')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Actualizar' })).toBeDisabled();
    expect(await screen.findByRole('heading', { level: 1, name: 'Noche de cine' })).toBeInTheDocument();
  });

  it('muestra título, estado en vivo, KPIs y gráficos', async () => {
    mockedClient.mockReturnValue(client());
    renderPage();
    expect(await screen.findByRole('heading', { level: 1, name: 'Noche de cine' })).toBeInTheDocument();
    expect(mockedClient).toHaveBeenCalledWith('r1');
    expect(mockedApi).toHaveBeenCalledWith('/rooms/r1');
    expect(screen.getByText('En vivo')).toBeInTheDocument();

    const tiles = screen.getByRole('list', { name: 'Indicadores de la sesión' });
    const tile = (label: string) => within(tiles).getByText(label).closest('li') as HTMLElement;
    expect(tile('Pico de espectadores')).toHaveTextContent('6');
    expect(tile('Promedio de espectadores')).toHaveTextContent('3,3');
    expect(tile('Drift promedio')).toHaveTextContent('85 ms');
    expect(tile('Drift promedio')).toHaveTextContent('p95 932 ms');
    expect(tile('Latencia de red')).toHaveTextContent('48 ms');
    expect(tile('Mensajes')).toHaveTextContent('42');
    expect(tile('Reacciones')).toHaveTextContent('17');
    expect(tile('Comandos de reproducción')).toHaveTextContent('9');
    expect(tile('Buffering')).toHaveTextContent('3 eventos');
    expect(tile('Buffering')).toHaveTextContent('promedio 712 ms · total 2,1 s');
    expect(tile('Aciertos de trivia')).toHaveTextContent('62,5 %');

    expect(screen.getByRole('heading', { name: 'Espectadores en el tiempo' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Reacciones por emoji' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Reacciones a lo largo del vídeo' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Volver' })).toHaveAttribute('href', '/dashboard');
  });

  it('los KPIs numéricos cuentan hasta el valor final con números tabulares', async () => {
    mockedClient.mockReturnValue(client());
    renderPage();
    const tiles = await screen.findByRole('list', { name: 'Indicadores de la sesión' });
    const tile = (label: string) => within(tiles).getByText(label).closest('li') as HTMLElement;
    expect(await within(tile('Mensajes')).findByText('42')).toHaveClass('tabular-nums');
    expect(await within(tile('Drift promedio')).findByText('85 ms')).toHaveClass('tabular-nums');
    expect(await within(tile('Buffering')).findByText('3 eventos')).toHaveClass('tabular-nums');
    expect(await within(tile('Aciertos de trivia')).findByText('62,5 %')).toHaveClass('tabular-nums');
  });

  it('"En vivo" lleva un punto con anillo de pulso decorativo', async () => {
    mockedClient.mockReturnValue(client());
    renderPage();
    const badge = await screen.findByText('En vivo');
    const ring = within(badge).getByTestId('live-ring');
    expect(ring.closest('[aria-hidden="true"]')).not.toBeNull();
  });

  it('una sala cerrada muestra "Sesión cerrada" con la fecha', async () => {
    mockedClient.mockReturnValue(client({ kpis: vi.fn().mockResolvedValue({ ...kpis, live: false, closed_at: '2026-10-11T21:00:00.000Z' }) }));
    renderPage();
    expect(await screen.findByText('Sesión cerrada')).toBeInTheDocument();
    expect(screen.queryByText('En vivo')).not.toBeInTheDocument();
    expect(screen.queryByText('por inactividad')).not.toBeInTheDocument();
  });

  it('una sala cerrada por periodo de gracia lo indica y, sin correcciones, no muestra p95', async () => {
    const closed = { ...kpis, live: false, closed_at: '2026-10-11T21:00:00.000Z', close_reason: 'grace_expired', p95_drift_ms: 0 };
    mockedClient.mockReturnValue(client({ kpis: vi.fn().mockResolvedValue(closed) }));
    renderPage();
    expect(await screen.findByText('por inactividad')).toBeInTheDocument();
    expect(screen.getByText('Desfase medio corregido')).toBeInTheDocument();
  });

  it('si la sala ya no existe en identity-api usa un título genérico', async () => {
    mockedApi.mockRejectedValueOnce(new ApiError(410, 'Deleted'));
    mockedClient.mockReturnValue(client());
    renderPage();
    expect(await screen.findByRole('heading', { level: 1, name: 'Análisis de la sala' })).toBeInTheDocument();
    expect(screen.getByText('Pico de espectadores')).toBeInTheDocument();
  });

  it('sin actividad muestra el estado vacío general', async () => {
    mockedClient.mockReturnValue(
      client({
        kpis: vi.fn().mockResolvedValue({
          ...kpis,
          peak_users: 0,
          avg_users: 0,
          messages: 0,
          reactions: 0,
          playback_commands: 0,
          buffering_events: 0,
        }),
        heatmap: vi.fn().mockResolvedValue({ ...heatmap, buckets: [], by_emoji: [] }),
        timeline: vi.fn().mockResolvedValue({ ...timeline, points: [] }),
      }),
    );
    renderPage();
    expect(await screen.findByText('Aún no hay actividad registrada')).toBeInTheDocument();
    expect(screen.queryByText('Pico de espectadores')).not.toBeInTheDocument();
  });

  it('sin buffering no muestra el promedio', async () => {
    mockedClient.mockReturnValue(client({ kpis: vi.fn().mockResolvedValue({ ...kpis, trivia_accuracy_pct: 0, buffering_events: 0 }) }));
    renderPage();
    const tiles = await screen.findByRole('list', { name: 'Indicadores de la sesión' });
    const tile = (label: string) => within(tiles).getByText(label).closest('li') as HTMLElement;
    expect(tile('Aciertos de trivia')).toHaveTextContent('0 %');
    expect(tile('Buffering')).toHaveTextContent('0 eventos');
    expect(tile('Buffering')).not.toHaveTextContent('promedio');
  });

  it('identity-api 401: limpia la sesión y vuelve al login con ?next', async () => {
    localStorage.setItem('tint_token', 'viejo');
    mockedApi.mockRejectedValueOnce(new ApiError(401, 'Unauthorized'));
    mockedClient.mockReturnValue(client());
    renderPage();
    expect(await screen.findByText(`login?next=${encodeURIComponent('/rooms/r1/analytics')}`)).toBeInTheDocument();
    expect(localStorage.getItem('tint_token')).toBeNull();
  });

  it('ticket 401: también vuelve al login', async () => {
    localStorage.setItem('tint_token', 'viejo');
    mockedClient.mockReturnValue(client({ kpis: vi.fn().mockRejectedValue(new ApiError(401, 'Unauthorized')) }));
    renderPage();
    expect(await screen.findByText(/^login\?next=/)).toBeInTheDocument();
    expect(localStorage.getItem('tint_token')).toBeNull();
  });

  it.each([
    [new ApiError(403, 'Forbidden'), 'No tienes acceso a la analítica de esta sala.'],
    [new AnalyticsError(403, 'room mismatch'), 'No tienes acceso a la analítica de esta sala.'],
    [new ApiError(404, 'Not found'), 'La sala no existe.'],
    [new AnalyticsError(401, 'revoked'), 'Tu acceso a la analítica caducó o fue revocado. Vuelve a intentarlo.'],
    [new AnalyticsError(503, 'redis down'), 'El servicio de analítica no está disponible en este momento.'],
    [new AnalyticsError(0, 'net'), 'El servicio de analítica no está disponible en este momento.'],
    [new Error('raro'), 'raro'],
    ['texto', 'No se pudo cargar la analítica.'],
  ])('error %#: muestra un mensaje claro', async (error, message) => {
    mockedClient.mockReturnValue(client({ kpis: vi.fn().mockRejectedValue(error) }));
    renderPage();
    expect(await screen.findByRole('alert')).toHaveTextContent(message);
  });

  it('"Actualizar" vuelve a pedir los datos', async () => {
    const c = client();
    mockedClient.mockReturnValue(c);
    renderPage();
    await screen.findByText('Pico de espectadores');
    await userEvent.click(screen.getByRole('button', { name: 'Actualizar' }));
    await waitFor(() => expect(c.kpis).toHaveBeenCalledTimes(2));
    expect(c.heatmap).toHaveBeenCalledTimes(2);
    expect(c.timeline).toHaveBeenCalledTimes(2);
  });
});
