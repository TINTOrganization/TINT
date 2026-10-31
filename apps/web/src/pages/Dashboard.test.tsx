import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Routes, Route, useLocation } from 'react-router-dom';
import { vi, beforeEach } from 'vitest';
import Dashboard from './Dashboard';
import Login from './Login';
import { apiFetch, ApiError } from '../lib/api';

vi.mock('../lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/api')>();
  return { ...actual, apiFetch: vi.fn() };
});

// Evita inicializar Firebase real en tests (la ruta /login renderiza Login).
vi.mock('../lib/firebase', () => ({
  auth: {},
  app: {},
}));

const mockedApi = vi.mocked(apiFetch);

function renderDashboard() {
  return render(
    <MemoryRouter initialEntries={['/dashboard']}>
      <Routes>
        <Route path="/dashboard" element={<Dashboard />} />
        <Route path="/login" element={<Login />} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
});

describe('Dashboard', () => {
  it('lista las salas del host', async () => {
    mockedApi.mockResolvedValueOnce({ rooms: [{ id: '1', title: 'Sala 1' }] });
    renderDashboard();
    await waitFor(() => expect(screen.getByText('Sala 1')).toBeInTheDocument());
    expect(screen.getByText('Mis salas')).toBeInTheDocument();
    expect(screen.getByText('Crear sala')).toBeInTheDocument();
  });

  it('limpia el token y vuelve al login si la sesión es inválida (401)', async () => {
    localStorage.setItem('tint_token', 'viejo');
    mockedApi.mockRejectedValueOnce(new ApiError(401, 'Unauthorized'));
    renderDashboard();
    await waitFor(() =>
      expect(screen.getByText('Iniciar sesión con Google')).toBeInTheDocument(),
    );
    expect(localStorage.getItem('tint_token')).toBeNull();
  });

  it('redirige a /403?reason=not_host si la API responde 403 Forbidden', async () => {
    mockedApi.mockRejectedValueOnce(new ApiError(403, 'Forbidden'));
    function ForbiddenProbe() {
      return <p>{`forbidden${useLocation().search}`}</p>;
    }
    render(
      <MemoryRouter initialEntries={['/dashboard']}>
        <Routes>
          <Route path="/dashboard" element={<Dashboard />} />
          <Route path="/403" element={<ForbiddenProbe />} />
          <Route path="/login" element={<Login />} />
        </Routes>
      </MemoryRouter>,
    );
    expect(await screen.findByText('forbidden?reason=not_host')).toBeInTheDocument();
  });

  it('al expirar la sesión vuelve al login con ?next=/dashboard', async () => {
    localStorage.setItem('tint_token', 'viejo');
    mockedApi.mockRejectedValueOnce(new ApiError(401, 'Unauthorized'));
    function LoginProbe() {
      return <p>{`login${useLocation().search}`}</p>;
    }
    render(
      <MemoryRouter initialEntries={['/dashboard']}>
        <Routes>
          <Route path="/dashboard" element={<Dashboard />} />
          <Route path="/login" element={<LoginProbe />} />
        </Routes>
      </MemoryRouter>,
    );
    expect(await screen.findByText('login?next=%2Fdashboard')).toBeInTheDocument();
  });

  it('muestra el error sin redirigir si falla por otra causa', async () => {
    mockedApi.mockRejectedValueOnce(new Error('DB caída'));
    renderDashboard();
    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument());
    expect(screen.getByText(/DB caída/)).toBeInTheDocument();
    expect(screen.getByText('Mis salas')).toBeInTheDocument();
  });

  it('cada sala enlaza a Gestionar para obtener el link, renombrar o eliminar', async () => {
    mockedApi.mockResolvedValueOnce({ rooms: [{ id: '1', title: 'Sala 1' }] });
    renderDashboard();
    await waitFor(() => expect(screen.getByText('Sala 1')).toBeInTheDocument());
    const manage = screen.getByRole('link', { name: /gestionar sala 1/i });
    expect(manage).toHaveAttribute('href', '/rooms/1');
  });

  it('cada sala enlaza a su análisis', async () => {
    mockedApi.mockResolvedValueOnce({ rooms: [{ id: '1', title: 'Sala 1' }] });
    renderDashboard();
    const link = await screen.findByRole('link', { name: 'Análisis de Sala 1' });
    expect(link).toHaveAttribute('href', '/rooms/1/analytics');
    expect(link).toHaveTextContent('Análisis');
  });

  it('elimina la sala con confirmación y la quita de la lista', async () => {
    const user = (await import('@testing-library/user-event')).default;
    const confirmSpy = vi.spyOn(window, 'confirm');
    mockedApi.mockResolvedValueOnce({ rooms: [{ id: '1', title: 'Sala 1' }] });
    mockedApi.mockResolvedValueOnce({ success: true });
    renderDashboard();
    await waitFor(() => expect(screen.getByText('Sala 1')).toBeInTheDocument());
    await user.click(screen.getByRole('button', { name: /eliminar sala 1/i }));
    const dialog = await screen.findByRole('alertdialog', { name: '¿Eliminar la sala "Sala 1"?' });
    expect(dialog).toHaveTextContent('Sus links dejarán de funcionar.');
    expect(mockedApi).toHaveBeenCalledTimes(1);
    await user.click(within(dialog).getByRole('button', { name: 'Eliminar' }));
    expect(confirmSpy).not.toHaveBeenCalled();
    await waitFor(() => expect(mockedApi).toHaveBeenCalledWith('/rooms/1', { method: 'DELETE' }));
    await waitFor(() => expect(screen.queryByText('Sala 1')).not.toBeInTheDocument());
  });

  it('muestra error si eliminar falla', async () => {
    const user = (await import('@testing-library/user-event')).default;
    mockedApi.mockResolvedValueOnce({ rooms: [{ id: '1', title: 'Sala 1' }] });
    mockedApi.mockRejectedValueOnce(new ApiError(403, 'Forbidden'));
    renderDashboard();
    await waitFor(() => expect(screen.getByText('Sala 1')).toBeInTheDocument());
    await user.click(screen.getByRole('button', { name: /eliminar sala 1/i }));
    const dialog = await screen.findByRole('alertdialog');
    await user.click(within(dialog).getByRole('button', { name: 'Eliminar' }));
    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument());
    expect(screen.getByText('Sala 1')).toBeInTheDocument();
  });

  it('no elimina si se cancela la confirmación', async () => {
    const user = (await import('@testing-library/user-event')).default;
    mockedApi.mockResolvedValueOnce({ rooms: [{ id: '1', title: 'Sala 1' }] });
    renderDashboard();
    await waitFor(() => expect(screen.getByText('Sala 1')).toBeInTheDocument());
    await user.click(screen.getByRole('button', { name: /eliminar sala 1/i }));
    const dialog = await screen.findByRole('alertdialog');
    await user.click(within(dialog).getByRole('button', { name: 'Cancelar' }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument());
    expect(mockedApi).toHaveBeenCalledTimes(1);
    expect(screen.getByText('Sala 1')).toBeInTheDocument();
  });

  it('muestra el link de invitación con copiar cuando la sala lo trae', async () => {
    const user = (await import('@testing-library/user-event')).default;
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    mockedApi.mockResolvedValueOnce({
      rooms: [{ id: '1', title: 'Sala 1', invitation: { code: 'abc123', link: '/invite/abc123' } }],
    });
    renderDashboard();
    await waitFor(() => expect(screen.getByText('Sala 1')).toBeInTheDocument());
    expect(
      screen.getByText(`${window.location.origin}/invite/abc123`),
    ).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /copiar/i }));
    expect(writeText).toHaveBeenCalledWith(`${window.location.origin}/invite/abc123`);
  });

  it('no muestra link si la sala no trae invitación vigente', async () => {
    mockedApi.mockResolvedValueOnce({ rooms: [{ id: '1', title: 'Sala 1', invitation: null }] });
    renderDashboard();
    await waitFor(() => expect(screen.getByText('Sala 1')).toBeInTheDocument());
    expect(screen.queryByRole('button', { name: /copiar/i })).not.toBeInTheDocument();
  });

  it('todas las cards tienen la misma estructura aunque falte la invitación', async () => {
    mockedApi.mockResolvedValueOnce({
      rooms: [
        { id: '1', title: 'Sala 1', invitation: { code: 'abc123', link: '/invite/abc123' } },
        { id: '2', title: 'Sala 2', invitation: null },
      ],
    });
    renderDashboard();
    await waitFor(() => expect(screen.getByText('Sala 2')).toBeInTheDocument());
    // La card sin invitación mantiene la fila con estado coherente.
    expect(screen.getByText(/sin link vigente/i)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /generar en gestionar/i })).toHaveAttribute(
      'href',
      '/rooms/2',
    );
  });

  it('Abrir es la acción primaria con estilo de acento', async () => {
    mockedApi.mockResolvedValueOnce({ rooms: [{ id: '1', title: 'Sala 1' }] });
    renderDashboard();
    await waitFor(() => expect(screen.getByText('Sala 1')).toBeInTheDocument());
    // Primario de la base visual: degradado de acento (bg-accent-sheen).
    expect(screen.getByRole('link', { name: /abrir sala 1/i }).className).toContain(
      'bg-accent-sheen',
    );
  });

  it('Crear sala usa el botón primario en la barra y en el estado vacío', async () => {
    mockedApi.mockResolvedValueOnce({ rooms: [] });
    renderDashboard();
    await screen.findByText('Sin salas por ahora');
    const links = screen.getAllByRole('link', { name: 'Crear sala' });
    expect(links).toHaveLength(2);
    for (const link of links) {
      expect(link).toHaveAttribute('href', '/rooms/new');
      expect(link.className).toContain('bg-accent-sheen');
    }
  });

  it('cada card sigue el puntero con un brillo radial (variables --mx/--my)', async () => {
    mockedApi.mockResolvedValueOnce({ rooms: [{ id: '1', title: 'Sala 1' }] });
    renderDashboard();
    await screen.findByText('Sala 1');
    const card = screen.getByTestId('room-card-1');
    card.getBoundingClientRect = () => ({ left: 10, top: 20, width: 200, height: 100 }) as DOMRect;
    fireEvent.pointerMove(card, { clientX: 60, clientY: 50 });
    expect(card.style.getPropertyValue('--mx')).toBe('50px');
    expect(card.style.getPropertyValue('--my')).toBe('30px');
  });

  it('las salas se listan como lista con un elemento por sala', async () => {
    mockedApi.mockResolvedValueOnce({
      rooms: [
        { id: '1', title: 'Sala 1' },
        { id: '2', title: 'Sala 2' },
      ],
    });
    renderDashboard();
    await screen.findByText('Sala 2');
    expect(screen.getAllByRole('listitem')).toHaveLength(2);
  });
});
