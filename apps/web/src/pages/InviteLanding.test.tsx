import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { vi, beforeEach, describe, it, expect } from 'vitest';
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

function renderInvite(code = 'ABC123') {
  return render(
    <MemoryRouter initialEntries={[`/invite/${code}`]}>
      <Routes>
        <Route path="/invite/:code" element={<InviteLanding />} />
        <Route path="/watch/:roomId" element={<p>Sala lista</p>} />
        <Route path="/login" element={<p>Página de login</p>} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mockedApi.mockReset();
  localStorage.clear();
  mockedApi.mockImplementation((path: string) => {
    if (path.startsWith('/invitations/claim')) {
      return Promise.resolve({ token: 'guest-tok', roomId: 'r1', nick: 'Ana' });
    }
    if (path.startsWith('/invitations/')) {
      return Promise.resolve({
        code: 'ABC123',
        roomId: 'r1',
        roomTitle: 'Noche de cine',
        hostName: 'Carlos Host',
        scheduledStartTime: '2026-11-03T20:00:00.000Z',
        roomKind: 'watch',
      });
    }
    return Promise.resolve({});
  });
});

describe('InviteLanding', () => {
  it('en móvil muestra una banda hero compacta con el titular sobre la tarjeta', async () => {
    renderInvite();
    const band = screen.getByTestId('hero-mobile');
    expect(band).toHaveClass('md:hidden');
    expect(band).toHaveTextContent('Te invitaron a ver algo juntos');
    const card = await screen.findByTestId('room-title');
    expect(band.compareDocumentPosition(card) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('AC1: muestra el título de la sala, nombre del host y horario programado sin requerir autenticación', async () => {
    mockedApi.mockImplementation((path: string) => {
      if (path === '/invitations/ABC123') {
        return Promise.resolve({
          code: 'ABC123',
          roomId: 'r1',
          roomTitle: 'Película Especial',
          hostName: 'María Host',
          scheduledStartTime: '2026-11-03T21:30:00.000Z',
          roomKind: 'watch',
        });
      }
      return Promise.resolve({});
    });
    renderInvite();
    expect(await screen.findByText('Película Especial')).toBeInTheDocument();
    expect(screen.getByText('María Host')).toBeInTheDocument();
    expect(screen.getByTestId('scheduled-start-time')).toBeInTheDocument();
    expect(screen.queryByText(/tienes una sesión de host/i)).not.toBeInTheDocument();
  });

  it('AC2: muestra una página de error clara de invitación no válida ante 404', async () => {
    mockedApi.mockImplementation((path: string) => {
      if (path === '/invitations/BAD123') {
        return Promise.reject(new ApiError(404, 'Not found'));
      }
      return Promise.resolve({});
    });
    renderInvite('BAD123');
    expect(await screen.findByText('Invitación no válida')).toBeInTheDocument();
    expect(screen.getByText(/no es válido, ha expirado o ha sido revocado/i)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /ir al inicio de sesión/i })).toBeInTheDocument();
  });

  it('AC3: al hacer clic en Unirse sin autenticación previa y sin nick, redirige al login con returnUrl y redirect', async () => {
    renderInvite();
    await waitFor(() => expect(screen.getByText('Noche de cine')).toBeInTheDocument());
    await userEvent.click(screen.getByRole('button', { name: /join|unirse/i }));
    await waitFor(() => expect(screen.getByText('Página de login')).toBeInTheDocument());
  });

  it('canjea la invitación con el nick y guarda el guest token', async () => {
    renderInvite();
    await userEvent.type(screen.getByPlaceholderText('Nick'), 'Ana');
    await userEvent.click(screen.getByRole('button', { name: /join|unirse/i }));
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
    mockedApi.mockImplementation((path: string) => {
      if (path.startsWith('/invitations/claim')) {
        return Promise.resolve({
          token: 'guest-tok',
          roomId: 'r1',
          nick: 'Ana',
          roomTitle: 'Noche de cine',
        });
      }
      return Promise.resolve({
        code: 'ABC123',
        roomId: 'r1',
        roomTitle: 'Noche de cine',
        roomKind: 'watch',
      });
    });
    renderInvite();
    await userEvent.type(screen.getByPlaceholderText('Nick'), 'Ana');
    await userEvent.click(screen.getByRole('button', { name: /join|unirse/i }));
    await waitFor(() => expect(screen.getByText('Sala lista')).toBeInTheDocument());
    expect(localStorage.getItem('tint_room_title')).toBe('Noche de cine');
    expect(localStorage.getItem('tint_invite_link')).toBe('/invite/ABC123');
  });

  it('sin título de sala borra el título guardado de otra invitación', async () => {
    localStorage.setItem('tint_room_title', 'Sala vieja');
    mockedApi.mockImplementation((path: string) => {
      if (path.startsWith('/invitations/claim')) {
        return Promise.resolve({ token: 'guest-tok', roomId: 'r1', nick: 'Ana', roomTitle: null });
      }
      return Promise.resolve({ code: 'ABC123', roomId: 'r1', roomTitle: null });
    });
    renderInvite();
    await userEvent.type(screen.getByPlaceholderText('Nick'), 'Ana');
    await userEvent.click(screen.getByRole('button', { name: /join|unirse/i }));
    await waitFor(() => expect(screen.getByText('Sala lista')).toBeInTheDocument());
    expect(localStorage.getItem('tint_room_title')).toBeNull();
  });

  it('con sesión de host avisa, ofrece entrar como host y no la borra sin confirmar', async () => {
    localStorage.setItem('tint_token', 'host-tok');
    mockedApi.mockImplementation((path: string) => {
      if (path === '/rooms') {
        return Promise.resolve({
          rooms: [
            { id: 'r0', title: 'Otra', invitation: null },
            { id: 'r1', title: 'Cine', invitation: { code: 'ABC123', link: '/invite/ABC123', expiresAt: 'x' } },
          ],
        });
      }
      return Promise.resolve({
        code: 'ABC123',
        roomId: 'r1',
        roomTitle: 'Cine',
        roomKind: 'watch',
      });
    });
    renderInvite();
    expect(await screen.findByText(/tienes una sesión de host/i)).toBeInTheDocument();
    await userEvent.type(screen.getByPlaceholderText('Nick'), 'Ana');
    expect(screen.getByRole('button', { name: 'Entrar como invitado' })).toBeInTheDocument();
    expect(localStorage.getItem('tint_token')).toBe('host-tok');
    const hostLink = await screen.findByRole('link', { name: 'Entrar como host' });
    expect(hostLink).toHaveAttribute('href', '/watch/r1');
    expect(mockedApi).toHaveBeenCalledWith('/rooms', { method: 'GET' }, 'host');
    expect(mockedApi).not.toHaveBeenCalledWith('/invitations/claim', expect.anything());
  });

  it('con sesión de host, "Entrar como invitado" canjea y entonces deja la sesión de host', async () => {
    localStorage.setItem('tint_token', 'host-tok');
    mockedApi.mockImplementation((path: string) => {
      if (path === '/invitations/claim') {
        return Promise.resolve({ token: 'guest-tok', roomId: 'r1', nick: 'Ana' });
      }
      if (path === '/rooms') {
        return Promise.resolve({ rooms: [] });
      }
      return Promise.resolve({ code: 'ABC123', roomId: 'r1', roomTitle: 'Cine' });
    });
    renderInvite();
    await userEvent.type(screen.getByPlaceholderText('Nick'), 'Ana');
    await userEvent.click(screen.getByRole('button', { name: 'Entrar como invitado' }));
    await waitFor(() => expect(screen.getByText('Sala lista')).toBeInTheDocument());
    expect(localStorage.getItem('tint_token')).toBeNull();
    expect(localStorage.getItem('tint_guest_token')).toBe('guest-tok');
  });

  it.each([
    ['la invitación no es de una sala suya', () => mockedApi.mockImplementation((p: string) => p === '/rooms' ? Promise.resolve({ rooms: [{ id: 'r0', invitation: null }] }) : Promise.resolve({ code: 'ABC123', roomId: 'r0' }))],
    ['falla la consulta', () => mockedApi.mockImplementation((p: string) => p === '/rooms' ? Promise.reject(new Error('offline')) : Promise.resolve({ code: 'ABC123', roomId: 'r0' }))],
  ])('con sesión de host, si %s ofrece ir a sus salas', async (_caso, arrange) => {
    localStorage.setItem('tint_token', 'host-tok');
    arrange();
    renderInvite();
    expect(await screen.findByRole('link', { name: 'Ir a mis salas' })).toHaveAttribute('href', '/dashboard');
  });

  it('muestra el error si el código expiró o es inválido', async () => {
    mockedApi.mockImplementation((path: string) => {
      if (path === '/invitations/claim') {
        return Promise.reject(new Error('Expired'));
      }
      return Promise.resolve({ code: 'ABC123', roomId: 'r1' });
    });
    renderInvite();
    await userEvent.type(screen.getByPlaceholderText('Nick'), 'Ana');
    await userEvent.click(screen.getByRole('button', { name: /join|unirse/i }));
    await waitFor(() => expect(screen.getByText(/Expired/)).toBeInTheDocument());
  });

  it('explica que expiró si la sala fue eliminada o el link caducó (410)', async () => {
    mockedApi.mockImplementation((path: string) => {
      if (path === '/invitations/claim') {
        return Promise.reject(new ApiError(410, 'Deleted'));
      }
      return Promise.resolve({ code: 'ABC123', roomId: 'r1' });
    });
    renderInvite();
    await userEvent.type(screen.getByPlaceholderText('Nick'), 'Ana');
    await userEvent.click(screen.getByRole('button', { name: /join|unirse/i }));
    await waitFor(() => expect(screen.getByText(/expir|eliminada/i)).toBeInTheDocument());
  });

  it('explica que fue revocado por el host (409)', async () => {
    mockedApi.mockImplementation((path: string) => {
      if (path === '/invitations/claim') {
        return Promise.reject(new ApiError(409, 'Revoked'));
      }
      return Promise.resolve({ code: 'ABC123', roomId: 'r1' });
    });
    renderInvite();
    await userEvent.type(screen.getByPlaceholderText('Nick'), 'Ana');
    await userEvent.click(screen.getByRole('button', { name: /join|unirse/i }));
    await waitFor(() => expect(screen.getByText(/revocada/i)).toBeInTheDocument());
  });

  it('reutiliza el tint_device_id guardado', async () => {
    const saved = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';
    localStorage.setItem('tint_device_id', saved);
    renderInvite();
    await userEvent.type(screen.getByPlaceholderText('Nick'), 'Ana');
    await userEvent.click(screen.getByRole('button', { name: /join|unirse/i }));
    await waitFor(() => expect(screen.getByText('Sala lista')).toBeInTheDocument());
    expect(mockedApi).toHaveBeenCalledWith('/invitations/claim', {
      method: 'POST',
      body: JSON.stringify({ code: 'ABC123', nick: 'Ana', deviceId: saved }),
    });
  });

  it('si el host lo bloqueó (403 BANNED) lo dice con claridad', async () => {
    mockedApi.mockImplementation((path: string) => {
      if (path === '/invitations/claim') {
        return Promise.reject(new ApiError(403, 'BANNED'));
      }
      return Promise.resolve({ code: 'ABC123', roomId: 'r1' });
    });
    renderInvite();
    await userEvent.type(screen.getByPlaceholderText('Nick'), 'Ana');
    await userEvent.click(screen.getByRole('button', { name: /join|unirse/i }));
    expect(await screen.findByText('El host te bloqueó en esta sala')).toBeInTheDocument();
    expect(localStorage.getItem('tint_guest_token')).toBeNull();
  });
});
