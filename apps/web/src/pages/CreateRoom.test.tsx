import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { vi, beforeEach } from 'vitest';
import CreateRoom from './CreateRoom';
import { apiFetch, ApiError } from '../lib/api';

vi.mock('../lib/api', () => ({
  apiFetch: vi.fn(),
  ApiError: class ApiError extends Error {
    readonly status: number;
    constructor(status: number, message: string) {
      super(message);
      this.name = 'ApiError';
      this.status = status;
    }
  },
}));

const mockedApi = vi.mocked(apiFetch);

beforeEach(() => {
  vi.clearAllMocks();
  mockedApi.mockReset();
  localStorage.clear();
  vi.unstubAllGlobals();
});

function renderManage() {
  return render(
    <MemoryRouter initialEntries={['/rooms/r1']}>
      <Routes>
        <Route path="/rooms/:id" element={<CreateRoom />} />
        <Route path="/dashboard" element={<p>Volver al dashboard</p>} />
      </Routes>
    </MemoryRouter>,
  );
}

const FUTURE = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
const PAST = new Date(Date.now() - 60 * 60 * 1000).toISOString();

function mockManageLoad() {
  mockedApi.mockResolvedValueOnce({ room: { id: 'r1', title: 'Cine' } });
  mockedApi.mockResolvedValueOnce({
    invitations: [{ code: 'abc123', link: '/invite/abc123', expiresAt: FUTURE, createdAt: new Date().toISOString() }],
  });
}

describe('CreateRoom', () => {
  it('muestra el código y el link al crear la sala', async () => {
    mockedApi.mockResolvedValueOnce({
      room: { id: 'r1' },
      invitation: { code: 'abc123', link: '/invite/abc123', expiresAt: 'mañana' },
    });
    render(
      <MemoryRouter>
        <CreateRoom />
      </MemoryRouter>,
    );
    await userEvent.type(screen.getByPlaceholderText('Título'), 'Noche de cine');
    await userEvent.click(screen.getByText('Crear'));
    await waitFor(() => expect(screen.getByText(/Código:/)).toBeInTheDocument());
    expect(screen.getByText(/\/invite\/abc123/)).toBeInTheDocument();
    expect(mockedApi).toHaveBeenCalledWith('/rooms', {
      method: 'POST',
      body: JSON.stringify({ title: 'Noche de cine' }),
    });
  });

  it('tras crear la sala ofrece entrar como host como acción principal', async () => {
    mockedApi.mockResolvedValueOnce({
      room: { id: 'r9' },
      invitation: { code: 'abc123', link: '/invite/abc123', expiresAt: 'mañana' },
    });
    render(
      <MemoryRouter>
        <CreateRoom />
      </MemoryRouter>,
    );
    await userEvent.type(screen.getByPlaceholderText('Título'), 'Noche de cine');
    await userEvent.click(screen.getByText('Crear'));
    const enter = await screen.findByRole('link', { name: 'Entrar a la sala' });
    expect(enter).toHaveAttribute('href', '/watch/r9');
  });

  it('muestra el error si la creación falla', async () => {
    mockedApi.mockRejectedValueOnce(new Error('Unauthorized'));
    render(
      <MemoryRouter>
        <CreateRoom />
      </MemoryRouter>,
    );
    await userEvent.type(screen.getByPlaceholderText('Título'), 'Sala X');
    await userEvent.click(screen.getByText('Crear'));
    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument());
    expect(screen.getByText(/Unauthorized/)).toBeInTheDocument();
  });

  it('copia un link absoluto que funciona pegado en el navegador', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    mockedApi.mockResolvedValueOnce({
      room: { id: 'r1' },
      invitation: { code: 'abc123', link: '/invite/abc123', expiresAt: 'mañana' },
    });
    render(
      <MemoryRouter>
        <CreateRoom />
      </MemoryRouter>,
    );
    await userEvent.type(screen.getByPlaceholderText('Título'), 'Noche de cine');
    await userEvent.click(screen.getByText('Crear'));
    await waitFor(() => expect(screen.getByText(/Código:/)).toBeInTheDocument());
    expect(screen.getByText(`${window.location.origin}/invite/abc123`)).toBeInTheDocument();
    await userEvent.click(screen.getByText('Copiar link'));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(`${window.location.origin}/invite/abc123`));
  });

  it('modo gestionar: carga la sala y muestra el link absoluto para compartir', async () => {
    mockManageLoad();
    renderManage();
    await waitFor(() => expect(screen.getByDisplayValue('Cine')).toBeInTheDocument());
    expect(screen.getByText(`${window.location.origin}/invite/abc123`)).toBeInTheDocument();
    expect(mockedApi).toHaveBeenCalledWith('/rooms/r1');
    expect(mockedApi).toHaveBeenCalledWith('/rooms/r1/invitations');
  });

  it('modo gestionar: renombra con PATCH', async () => {
    mockManageLoad();
    mockedApi.mockResolvedValueOnce({ room: { id: 'r1', title: 'Cine 2' } });
    renderManage();
    const input = await screen.findByDisplayValue('Cine');
    await userEvent.clear(input);
    await userEvent.type(input, 'Cine 2');
    await userEvent.click(screen.getByText('Guardar nombre'));
    await waitFor(() =>
      expect(mockedApi).toHaveBeenCalledWith('/rooms/r1', {
        method: 'PATCH',
        body: JSON.stringify({ title: 'Cine 2' }),
      }),
    );
  });

  it('modo gestionar: genera un link adicional', async () => {
    mockManageLoad();
    mockedApi.mockResolvedValueOnce({ code: 'nuevo99', link: '/invite/nuevo99', expiresAt: FUTURE });
    renderManage();
    await screen.findByDisplayValue('Cine');
    await userEvent.click(screen.getByText('Generar link adicional'));
    await waitFor(() =>
      expect(mockedApi).toHaveBeenCalledWith('/rooms/r1/invitations', { method: 'POST', body: '{}' }),
    );
    await waitFor(() =>
      expect(screen.getByText(`${window.location.origin}/invite/nuevo99`)).toBeInTheDocument(),
    );
  });

  it('modo gestionar: muestra el link vigente más reciente y no el primero', async () => {
    mockedApi.mockResolvedValueOnce({ room: { id: 'r1', title: 'Cine' } });
    mockedApi.mockResolvedValueOnce({
      invitations: [
        { code: 'vieja11', link: '/invite/vieja11', expiresAt: FUTURE, createdAt: '2026-10-09T12:00:00.000Z' },
        { code: 'nueva22', link: '/invite/nueva22', expiresAt: FUTURE, createdAt: '2026-10-10T12:00:00.000Z' },
      ],
    });
    renderManage();
    await screen.findByDisplayValue('Cine');
    expect(screen.getByText(`${window.location.origin}/invite/nueva22`)).toBeInTheDocument();
    expect(screen.queryByText(`${window.location.origin}/invite/vieja11`)).not.toBeInTheDocument();
  });

  it('modo gestionar: sin link vigente muestra estado vacío con opción de generar', async () => {
    mockedApi.mockResolvedValueOnce({ room: { id: 'r1', title: 'Cine' } });
    mockedApi.mockResolvedValueOnce({
      invitations: [
        { code: 'revocada', link: '/invite/revocada', expiresAt: FUTURE, revoked: true },
        { code: 'expirada', link: '/invite/expirada', expiresAt: PAST },
      ],
    });
    renderManage();
    await screen.findByDisplayValue('Cine');
    expect(screen.getByText(/sin link vigente/i)).toBeInTheDocument();
    expect(screen.getByText('Generar link adicional')).toBeInTheDocument();
  });

  it('modo gestionar: revoca el link actual y avisa que los de adentro no salen', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm');
    mockManageLoad();
    mockedApi.mockResolvedValueOnce({ success: true });
    mockedApi.mockResolvedValueOnce({ invitations: [] });
    renderManage();
    await screen.findByDisplayValue('Cine');
    await userEvent.click(screen.getByRole('button', { name: /revocar link/i }));
    const dialog = await screen.findByRole('alertdialog', { name: '¿Revocar este link?' });
    expect(dialog).toHaveTextContent(/nadie nuevo podrá entrar/i);
    await userEvent.click(within(dialog).getByRole('button', { name: 'Revocar' }));
    expect(confirmSpy).not.toHaveBeenCalled();
    await waitFor(() =>
      expect(mockedApi).toHaveBeenCalledWith('/invitations/abc123/revoke', { method: 'POST' }),
    );
    await waitFor(() => expect(screen.getByText(/link revocado/i)).toBeInTheDocument());
    expect(screen.getByText(/sin link vigente/i)).toBeInTheDocument();
  });

  it('modo gestionar: entra a la sala en vez de ver la invitación', async () => {
    mockManageLoad();
    renderManage();
    await screen.findByDisplayValue('Cine');
    const entrar = screen.getByRole('link', { name: /entrar a la sala/i });
    expect(entrar).toHaveAttribute('href', '/watch/r1');
    expect(screen.queryByRole('link', { name: /ver invitación/i })).not.toBeInTheDocument();
  });

  it('modo gestionar: no revoca si se cancela la confirmación', async () => {
    mockManageLoad();
    renderManage();
    await screen.findByDisplayValue('Cine');
    await userEvent.click(screen.getByRole('button', { name: /revocar link/i }));
    const dialog = await screen.findByRole('alertdialog');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Cancelar' }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument());
    expect(mockedApi).toHaveBeenCalledTimes(2);
    expect(screen.getByText(`${window.location.origin}/invite/abc123`)).toBeInTheDocument();
  });

  it('modo gestionar: elimina y vuelve al dashboard', async () => {
    mockManageLoad();
    mockedApi.mockResolvedValueOnce({ success: true });
    renderManage();
    await screen.findByDisplayValue('Cine');
    await userEvent.click(screen.getByText('Eliminar sala'));
    const dialog = await screen.findByRole('alertdialog', { name: '¿Eliminar esta sala?' });
    expect(dialog).toHaveTextContent('Los links dejarán de funcionar.');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Eliminar' }));
    await waitFor(() => expect(mockedApi).toHaveBeenCalledWith('/rooms/r1', { method: 'DELETE' }));
    await waitFor(() => expect(screen.getByText('Volver al dashboard')).toBeInTheDocument());
  });

  it('modo gestionar: no elimina si se cancela la confirmación', async () => {
    mockManageLoad();
    renderManage();
    await screen.findByDisplayValue('Cine');
    await userEvent.click(screen.getByText('Eliminar sala'));
    const dialog = await screen.findByRole('alertdialog');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Cancelar' }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument());
    expect(mockedApi).not.toHaveBeenCalledWith('/rooms/r1', { method: 'DELETE' });
    expect(screen.getByDisplayValue('Cine')).toBeInTheDocument();
  });

  it('modo gestionar: el chip del código muestra el código de la invitación nueva', async () => {
    mockManageLoad();
    mockedApi.mockResolvedValueOnce({ code: 'nuevo99', link: '/invite/nuevo99', expiresAt: FUTURE });
    renderManage();
    await screen.findByDisplayValue('Cine');
    expect(screen.getByTestId('invite-code')).toHaveTextContent('abc123');
    await userEvent.click(screen.getByText('Generar link adicional'));
    await waitFor(() => expect(screen.getByTestId('invite-code')).toHaveTextContent('nuevo99'));
  });

  it('modo gestionar: avisa si la sala fue eliminada (410)', async () => {
    mockedApi.mockRejectedValueOnce(new ApiError(410, 'Deleted'));
    renderManage();
    await waitFor(() => expect(screen.getByText(/eliminada/i)).toBeInTheDocument());
  });

  it('modo gestionar: redirige a /403?reason=not_host si la API responde 403 Forbidden', async () => {
    mockedApi.mockRejectedValueOnce(new ApiError(403, 'Forbidden'));
    render(
      <MemoryRouter initialEntries={['/rooms/r1']}>
        <Routes>
          <Route path="/rooms/:id" element={<CreateRoom />} />
          <Route path="/403" element={<p>forbidden-page</p>} />
        </Routes>
      </MemoryRouter>,
    );
    expect(await screen.findByText('forbidden-page')).toBeInTheDocument();
  });
  
  it('modo crear: tiene enlace Volver al dashboard', async () => {
    render(
      <MemoryRouter>
        <CreateRoom />
      </MemoryRouter>,
    );
    expect(screen.getByRole('link', { name: 'Volver' })).toHaveAttribute('href', '/dashboard');
  });

  it('modo gestionar: tiene enlace Volver al dashboard', async () => {
    mockManageLoad();
    renderManage();
    await screen.findByDisplayValue('Cine');
    const backLinks = screen.getAllByRole('link', { name: 'Volver' });
    expect(backLinks).toHaveLength(1);
    expect(backLinks[0]).toHaveAttribute('href', '/dashboard');
  });

  it('sala eliminada: usa el mismo enlace Volver sin duplicados', async () => {
    mockedApi.mockRejectedValueOnce(new ApiError(410, 'Deleted'));
    renderManage();
    await waitFor(() => expect(screen.getByText(/eliminada/i)).toBeInTheDocument());
    const backLinks = screen.getAllByRole('link', { name: 'Volver' });
    expect(backLinks).toHaveLength(1);
    expect(backLinks[0]).toHaveAttribute('href', '/dashboard');
  });
});
