import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AnalyticsError } from '../lib/analytics';
import { fetchBusinessOverview, type BusinessOverview, type ClosedRoom } from '../lib/businessAnalytics';
import BusinessAnalytics, { PASSWORD_KEY } from './BusinessAnalytics';

vi.mock('../lib/businessAnalytics', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/businessAnalytics')>()),
  fetchBusinessOverview: vi.fn(),
}));

const mockedFetch = vi.mocked(fetchBusinessOverview);

const room: ClosedRoom = {
  room_id: '35615afb-0000-4000-8000-000000000000',
  peak_users: 2,
  avg_users: 1.5,
  avg_drift_ms: 800,
  trivia_accuracy_pct: 0,
  messages: 9,
  reactions: 9,
  playback_commands: 12,
  buffering_events: 2,
  avg_buffering_ms: 400,
  avg_rtt_ms: 33.95,
  p95_drift_ms: 2904,
  total_buffering_ms: 1500,
  close_reason: 'grace_expired',
  closed_at: '2026-10-12T05:06:00.000Z',
  computed_at: '2026-10-13T04:05:00.000Z',
  heatmap: [{ bucket_start_ms: 495_000, reactions: 5, density: 1 }],
};

const overview: BusinessOverview = {
  generated_at: '2026-10-13T04:30:00.000Z',
  daily: [
    { day: '2026-10-11', dau: 1, mau: 1 },
    { day: '2026-10-12', dau: 3, mau: 4 },
  ],
  events: {
    total: 1294,
    rooms: 5,
    by_type: [
      { type: 'drift_correction', source: 'sync-core', count: 1173 },
      { type: 'presence', source: 'social-core', count: 121 },
    ],
  },
  rooms: [
    room,
    { ...room, room_id: '4f5cb6d3-0000-4000-8000-000000000000', close_reason: null, closed_at: null, buffering_events: 0, heatmap: [] },
    { ...room, room_id: '1b3248a4-0000-4000-8000-000000000000', close_reason: 'deleted' },
    { ...room, room_id: 'aaaaaaaa-0000-4000-8000-000000000000', close_reason: 'otra_razon' },
  ],
};

function renderPage() {
  return render(
    <MemoryRouter>
      <BusinessAnalytics />
    </MemoryRouter>,
  );
}

async function enter(password = 'clave') {
  const user = userEvent.setup();
  await user.type(screen.getByLabelText('Contraseña'), password);
  await user.click(screen.getByRole('button', { name: 'Entrar' }));
  return user;
}

beforeEach(() => {
  vi.clearAllMocks();
  sessionStorage.clear();
});

describe('BusinessAnalytics', () => {
  it('pide la contraseña antes de consultar nada', () => {
    renderPage();
    expect(screen.getByRole('heading', { level: 1, name: 'Analítica de TINT' })).toBeInTheDocument();
    expect(screen.getByLabelText('Contraseña')).toHaveAttribute('type', 'password');
    expect(screen.getByRole('button', { name: 'Entrar' })).toBeDisabled();
    expect(mockedFetch).not.toHaveBeenCalled();
  });

  it('con la contraseña correcta muestra indicadores, gráficos y salas cerradas', async () => {
    mockedFetch.mockResolvedValue(overview);
    renderPage();
    await enter();
    const tiles = await screen.findByRole('list', { name: 'Indicadores de negocio' });
    expect(mockedFetch).toHaveBeenCalledWith('clave');
    const tile = (label: string) => within(tiles).getByText(label).closest('li') as HTMLElement;
    expect(tile('Usuarios activos hoy')).toHaveTextContent('3');
    expect(tile('Usuarios activos en 30 días')).toHaveTextContent('4');
    expect(tile('Eventos registrados')).toHaveTextContent('1,3 mil');
    expect(tile('Salas con actividad')).toHaveTextContent('5');
    expect(tile('Salas cerradas')).toHaveTextContent('4');
    expect(screen.getByRole('heading', { name: 'Usuarios activos por día' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Eventos por tipo' })).toBeInTheDocument();

    const table = screen.getByRole('table', { name: 'Salas cerradas con sus indicadores' });
    const rows = within(table).getAllByRole('row');
    expect(rows).toHaveLength(5);
    expect(rows[1]).toHaveTextContent('35615afb');
    expect(rows[1]).toHaveTextContent('Por inactividad');
    expect(rows[1]).toHaveTextContent('34 ms');
    expect(rows[1]).toHaveTextContent('2,9 s');
    expect(rows[1]).toHaveTextContent('2 · 1,5 s');
    expect(within(rows[1]).getByRole('img', { name: /Densidad de reacciones/ })).toBeInTheDocument();
    expect(rows[2]).toHaveTextContent('Cerrada');
    expect(rows[2]).toHaveTextContent('Sin cortes');
    expect(rows[2]).toHaveTextContent('Sin reacciones');
    expect(rows[3]).toHaveTextContent('Borrada por el host');
    expect(rows[4]).toHaveTextContent('otra_razon');
    // La contraseña válida se recuerda solo en la pestaña.
    expect(sessionStorage.getItem(PASSWORD_KEY)).toBe('clave');
  });

  it('una contraseña incorrecta vuelve al formulario con el error y no se guarda', async () => {
    mockedFetch.mockRejectedValue(new AnalyticsError(401, 'contraseña incorrecta'));
    renderPage();
    await enter('mala');
    expect(await screen.findByRole('alert')).toHaveTextContent('Contraseña incorrecta.');
    expect(screen.getByLabelText('Contraseña')).toHaveValue('');
    expect(sessionStorage.getItem(PASSWORD_KEY)).toBeNull();
  });

  it('si el servidor no tiene el panel habilitado lo explica', async () => {
    mockedFetch.mockRejectedValue(new AnalyticsError(404, 'no encontrado'));
    renderPage();
    await enter();
    expect(await screen.findByRole('alert')).toHaveTextContent('no está habilitado en este servidor');
    expect(screen.getByLabelText('Contraseña')).toBeInTheDocument();
  });

  it('si el servicio falla conserva la sesión y deja reintentar con Actualizar', async () => {
    mockedFetch.mockRejectedValueOnce(new Error('boom')).mockResolvedValueOnce(overview);
    renderPage();
    const user = await enter();
    expect(await screen.findByRole('alert')).toHaveTextContent('no está disponible');
    await user.click(screen.getByRole('button', { name: 'Actualizar' }));
    expect(await screen.findByRole('list', { name: 'Indicadores de negocio' })).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(mockedFetch).toHaveBeenCalledTimes(2);
  });

  it('recuerda la contraseña de la pestaña y Salir la olvida', async () => {
    sessionStorage.setItem(PASSWORD_KEY, 'guardada');
    mockedFetch.mockResolvedValue(overview);
    renderPage();
    expect(screen.getByText('Cargando métricas…')).toBeInTheDocument();
    await screen.findByRole('list', { name: 'Indicadores de negocio' });
    expect(mockedFetch).toHaveBeenCalledWith('guardada');
    await userEvent.setup().click(screen.getByRole('button', { name: 'Salir' }));
    expect(screen.getByLabelText('Contraseña')).toBeInTheDocument();
    expect(sessionStorage.getItem(PASSWORD_KEY)).toBeNull();
  });

  it('sin actividad muestra el estado vacío', async () => {
    mockedFetch.mockResolvedValue({ ...overview, daily: [], events: { total: 0, rooms: 0, by_type: [] }, rooms: [] });
    renderPage();
    await enter();
    expect(await screen.findByText('Aún no hay actividad registrada')).toBeInTheDocument();
  });

  it('con eventos pero sin salas cerradas ni logins muestra ceros y el aviso de la tabla', async () => {
    mockedFetch.mockResolvedValue({ ...overview, daily: [], rooms: [] });
    renderPage();
    await enter();
    const tiles = await screen.findByRole('list', { name: 'Indicadores de negocio' });
    expect(within(tiles).getByText('Usuarios activos hoy').closest('li')).toHaveTextContent('0');
    expect(screen.getByText('Todavía no se ha cerrado ninguna sala')).toBeInTheDocument();
  });

  it('funciona aunque el navegador bloquee sessionStorage', async () => {
    const getItem = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('bloqueado');
    });
    const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('bloqueado');
    });
    mockedFetch.mockResolvedValue(overview);
    renderPage();
    await enter();
    await waitFor(() => expect(screen.getByRole('list', { name: 'Indicadores de negocio' })).toBeInTheDocument());
    getItem.mockRestore();
    setItem.mockRestore();
  });
});
