/** Dashboard con salas live (ADR 0019). */
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import Dashboard from './Dashboard';
import { apiFetch } from '../lib/api';

vi.mock('../lib/api', async (orig) => ({ ...(await orig<typeof import('../lib/api')>()), apiFetch: vi.fn() }));
vi.mock('../lib/firebase', () => ({ auth: {}, app: {} }));
const mockedApi = vi.mocked(apiFetch);

beforeEach(() => mockedApi.mockReset());

describe('Dashboard — salas live', () => {
  it('marca las salas en vivo y terminadas, y "Abrir" va a su página', async () => {
    mockedApi.mockResolvedValueOnce({
      rooms: [
        { id: 'w', title: 'Cine' },
        { id: 'l', title: 'Directo', kind: 'live', status: 'active' },
        { id: 'd', title: 'Ayer', kind: 'live', status: 'disabled' },
      ],
    });
    render(
      <MemoryRouter>
        <Dashboard />
      </MemoryRouter>,
    );
    expect(await screen.findByRole('link', { name: 'Abrir Cine' })).toHaveAttribute('href', '/watch/w');
    expect(screen.getByRole('link', { name: 'Abrir Directo' })).toHaveAttribute('href', '/live/l');
    expect(screen.getByTestId('room-card-l')).toHaveTextContent('En vivo');
    expect(screen.getByTestId('room-card-d')).toHaveTextContent('Evento terminado');
    expect(screen.getByTestId('room-card-w')).not.toHaveTextContent('En vivo');
  });
});
