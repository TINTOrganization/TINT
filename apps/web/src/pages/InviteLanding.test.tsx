import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { vi, beforeEach } from 'vitest';
import InviteLanding from './InviteLanding';
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

function renderInvite() {
  return render(
    <MemoryRouter initialEntries={['/invite/ABC123']}>
      <Routes>
        <Route path="/invite/:code" element={<InviteLanding />} />
        <Route path="/watch/:roomId" element={<p>Sala lista</p>} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mockedApi.mockReset();
  localStorage.clear();
});

describe('InviteLanding', () => {
  it('en móvil muestra una banda hero compacta con el titular sobre la tarjeta', () => {
    renderInvite();
    const band = screen.getByTestId('hero-mobile');
    expect(band).toHaveClass('md:hidden');
    expect(band).toHaveTextContent('Te invitaron a ver algo juntos');
    const card = screen.getByRole('heading', { name: 'Unirse a la sala' });
    expect(band.compareDocumentPosition(card) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('canjea la invitación con el nick y guarda el guest token', async () => {
    mockedApi.mockResolvedValueOnce({ token: 'guest-tok', roomId: 'r1', nick: 'Ana' });
    renderInvite();
    await userEvent.type(screen.getByPlaceholderText('Nick'), 'Ana');
    await userEvent.click(screen.getByText('Unirse'));
    await waitFor(() => expect(screen.getByText('Sala lista')).toBeInTheDocument());
    const deviceId = localStorage.getItem('tint_device_id');
    expect(deviceId).toMatch(/^[0-9a-f-]{36}$/);
    expect(mockedApi).toHaveBeenCalledWith('/invitations/claim', {
      method: 'POST',
      body: JSON.stringify({ code: 'ABC123', nick: 'Ana', deviceId }),
    });
    expect(localStorage.getItem('tint_guest_token')).toBe('guest-tok');
  });

  it('guarda el titulo de la sala y el link para mostrarlos al invitado', async () => {
    mockedApi.mockResolvedValueOnce({
      token: 'guest-tok',
      roomId: 'r1',
      nick: 'Ana',
      roomTitle: 'Noche de cine',
    });
    renderInvite();
    await userEvent.type(screen.getByPlaceholderText('Nick'), 'Ana');
    await userEvent.click(screen.getByText('Unirse'));
    await waitFor(() => expect(screen.getByText('Sala lista')).toBeInTheDocument());
    expect(localStorage.getItem('tint_room_title')).toBe('Noche de cine');
    expect(localStorage.getItem('tint_invite_link')).toBe('/invite/ABC123');
  });

  it('sin título de sala borra el título guardado de otra invitación', async () => {
    localStorage.setItem('tint_room_title', 'Sala vieja');
    mockedApi.mockResolvedValueOnce({ token: 'guest-tok', roomId: 'r1', nick: 'Ana', roomTitle: null });
    renderInvite();
    await userEvent.type(screen.getByPlaceholderText('Nick'), 'Ana');
    await userEvent.click(screen.getByText('Unirse'));
    await waitFor(() => expect(screen.getByText('Sala lista')).toBeInTheDocument());
    expect(localStorage.getItem('tint_room_title')).toBeNull();
  });

  it('con sesión de host avisa, ofrece entrar como host y no la borra sin confirmar', async () => {
    localStorage.setItem('tint_token', 'host-tok');
    // La sala del host se resuelve con sus salas (GET /rooms) por el código del link.
    mockedApi.mockResolvedValueOnce({
      rooms: [
        { id: 'r0', title: 'Otra', invitation: null },
        { id: 'r1', title: 'Cine', invitation: { code: 'ABC123', link: '/invite/ABC123', expiresAt: 'x' } },
      ],
    });
    renderInvite();
    expect(screen.getByText(/tienes una sesión de host/i)).toBeInTheDocument();
    // El botón de unirse pide confirmación explícita; no canjea todavía.
    await userEvent.type(screen.getByPlaceholderText('Nick'), 'Ana');
    expect(screen.queryByRole('button', { name: 'Unirse' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Entrar como invitado' })).toBeInTheDocument();
    expect(localStorage.getItem('tint_token')).toBe('host-tok');
    const hostLink = await screen.findByRole('link', { name: 'Entrar como host' });
    expect(hostLink).toHaveAttribute('href', '/watch/r1');
    expect(mockedApi).toHaveBeenCalledWith('/rooms', { method: 'GET' }, 'host');
    expect(mockedApi).not.toHaveBeenCalledWith('/invitations/claim', expect.anything());
  });

  it('con sesión de host, "Entrar como invitado" canjea y entonces deja la sesión de host', async () => {
    localStorage.setItem('tint_token', 'host-tok');
    mockedApi.mockImplementation((path: string) =>
      path === '/invitations/claim'
        ? Promise.resolve({ token: 'guest-tok', roomId: 'r1', nick: 'Ana' })
        : Promise.resolve({ rooms: [] }),
    );
    renderInvite();
    await userEvent.type(screen.getByPlaceholderText('Nick'), 'Ana');
    await userEvent.click(screen.getByRole('button', { name: 'Entrar como invitado' }));
    await waitFor(() => expect(screen.getByText('Sala lista')).toBeInTheDocument());
    expect(localStorage.getItem('tint_token')).toBeNull();
    expect(localStorage.getItem('tint_guest_token')).toBe('guest-tok');
  });

  it.each([
    ['la invitación no es de una sala suya', () => mockedApi.mockResolvedValueOnce({ rooms: [{ id: 'r0', invitation: null }] })],
    ['falla la consulta', () => mockedApi.mockRejectedValueOnce(new Error('offline'))],
  ])('con sesión de host, si %s ofrece ir a sus salas', async (_caso, arrange) => {
    localStorage.setItem('tint_token', 'host-tok');
    arrange();
    renderInvite();
    expect(await screen.findByRole('link', { name: 'Ir a mis salas' })).toHaveAttribute('href', '/dashboard');
  });

  it('sin sesión de host no consulta salas y muestra el botón Unirse', () => {
    renderInvite();
    expect(screen.getByRole('button', { name: 'Unirse' })).toBeInTheDocument();
    expect(screen.queryByText(/tienes una sesión de host/i)).not.toBeInTheDocument();
    expect(mockedApi).not.toHaveBeenCalled();
  });

  it('muestra el error si el código expiró o es inválido', async () => {
    mockedApi.mockRejectedValueOnce(new Error('Expired'));
    renderInvite();
    await userEvent.type(screen.getByPlaceholderText('Nick'), 'Ana');
    await userEvent.click(screen.getByText('Unirse'));
    await waitFor(() => expect(screen.getByText(/Expired/)).toBeInTheDocument());
  });

  it('explica que expiró si la sala fue eliminada o el link caducó (410)', async () => {
    mockedApi.mockRejectedValueOnce(new ApiError(410, 'Deleted'));
    renderInvite();
    await userEvent.type(screen.getByPlaceholderText('Nick'), 'Ana');
    await userEvent.click(screen.getByText('Unirse'));
    await waitFor(() => expect(screen.getByText(/expir|eliminada/i)).toBeInTheDocument());
  });

  it('explica que no existe si el código es inválido (404)', async () => {
    mockedApi.mockRejectedValueOnce(new ApiError(404, 'Not found'));
    renderInvite();
    await userEvent.type(screen.getByPlaceholderText('Nick'), 'Ana');
    await userEvent.click(screen.getByText('Unirse'));
    await waitFor(() => expect(screen.getByText(/no existe|eliminada/i)).toBeInTheDocument());
  });

  it('explica que fue revocado por el host (409)', async () => {
    mockedApi.mockRejectedValueOnce(new ApiError(409, 'Revoked'));
    renderInvite();
    await userEvent.type(screen.getByPlaceholderText('Nick'), 'Ana');
    await userEvent.click(screen.getByText('Unirse'));
    await waitFor(() => expect(screen.getByText(/revocada/i)).toBeInTheDocument());
  });

  it('reutiliza el tint_device_id guardado', async () => {
    const saved = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';
    localStorage.setItem('tint_device_id', saved);
    mockedApi.mockResolvedValueOnce({ token: 'guest-tok', roomId: 'r1', nick: 'Ana' });
    renderInvite();
    await userEvent.type(screen.getByPlaceholderText('Nick'), 'Ana');
    await userEvent.click(screen.getByText('Unirse'));
    await waitFor(() => expect(screen.getByText('Sala lista')).toBeInTheDocument());
    expect(mockedApi).toHaveBeenCalledWith('/invitations/claim', {
      method: 'POST',
      body: JSON.stringify({ code: 'ABC123', nick: 'Ana', deviceId: saved }),
    });
  });

  it('si el host lo bloqueó (403 BANNED) lo dice con claridad', async () => {
    mockedApi.mockRejectedValueOnce(new ApiError(403, 'BANNED'));
    renderInvite();
    await userEvent.type(screen.getByPlaceholderText('Nick'), 'Ana');
    await userEvent.click(screen.getByText('Unirse'));
    expect(await screen.findByText('El host te bloqueó en esta sala')).toBeInTheDocument();
    expect(localStorage.getItem('tint_guest_token')).toBeNull();
  });
});
