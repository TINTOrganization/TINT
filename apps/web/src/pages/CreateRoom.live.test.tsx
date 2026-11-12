/** Crear y gestionar salas live (ADR 0019). */
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import CreateRoom from './CreateRoom';
import { apiFetch } from '../lib/api';

vi.mock('../lib/api', async (orig) => ({ ...(await orig<typeof import('../lib/api')>()), apiFetch: vi.fn() }));
const mockedApi = vi.mocked(apiFetch);

beforeEach(() => mockedApi.mockReset());

const FUTURE = new Date(Date.now() + 86_400_000).toISOString();

describe('CreateRoom — salas live', () => {
  it('por defecto crea una sala watch; eligiendo transmisión usa POST /events/start kind live', async () => {
    mockedApi.mockResolvedValueOnce({
      room: { id: 'r7', kind: 'live' },
      invitation: { code: 'abc123', link: '/invite/abc123', expiresAt: FUTURE },
    });
    render(
      <MemoryRouter>
        <CreateRoom />
      </MemoryRouter>,
    );
    expect(screen.getByRole('radio', { name: /ver un vídeo juntos/i })).toBeChecked();
    await userEvent.click(screen.getByRole('radio', { name: /transmisión en vivo/i }));
    await userEvent.type(screen.getByPlaceholderText('Título'), 'Final del torneo');
    await userEvent.click(screen.getByText('Crear'));
    expect(mockedApi).toHaveBeenCalledWith('/events/start', {
      method: 'POST',
      body: JSON.stringify({ title: 'Final del torneo', kind: 'live' }),
    });
    expect(await screen.findByRole('link', { name: 'Ir a transmitir' })).toHaveAttribute('href', '/live/r7');
  });

  it('gestionar una sala live lleva a /live; una terminada no admite cambios', async () => {
    mockedApi.mockResolvedValueOnce({ room: { id: 'r1', title: 'Directo', kind: 'live', status: 'active' } });
    mockedApi.mockResolvedValueOnce({ invitations: [{ code: 'c', link: '/invite/c', expiresAt: FUTURE }] });
    const view = render(
      <MemoryRouter initialEntries={['/rooms/r1']}>
        <Routes>
          <Route path="/rooms/:id" element={<CreateRoom />} />
        </Routes>
      </MemoryRouter>,
    );
    expect(await screen.findByRole('link', { name: 'Entrar a la sala' })).toHaveAttribute('href', '/live/r1');
    expect(screen.queryByRole('radio')).not.toBeInTheDocument();
    view.unmount();

    mockedApi.mockResolvedValueOnce({ room: { id: 'r1', title: 'Directo', kind: 'live', status: 'disabled' } });
    mockedApi.mockResolvedValueOnce({ invitations: [{ code: 'c', link: '/invite/c', expiresAt: FUTURE }] });
    render(
      <MemoryRouter initialEntries={['/rooms/r1']}>
        <Routes>
          <Route path="/rooms/:id" element={<CreateRoom />} />
        </Routes>
      </MemoryRouter>,
    );
    expect(await screen.findByText('El evento terminó')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Ver análisis' })).toHaveAttribute('href', '/rooms/r1/analytics');
    expect(screen.getByRole('button', { name: 'Ver chat del evento' })).toBeInTheDocument();
    expect(screen.queryByPlaceholderText('Título')).not.toBeInTheDocument();
    expect(screen.queryByText('Sala lista para compartir')).not.toBeInTheDocument();
  });
});
