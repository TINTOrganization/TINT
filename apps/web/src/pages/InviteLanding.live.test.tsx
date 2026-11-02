/** Invitación a una sala `live` (ADR 0019): el invitado va a /live/:id, no a /watch/:id. */
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import InviteLanding from './InviteLanding';
import { apiFetch } from '../lib/api';

vi.mock('../lib/api', async (orig) => ({
  ...(await orig<typeof import('../lib/api')>()),
  apiFetch: vi.fn(),
}));
const mockedApi = vi.mocked(apiFetch);

function renderInvite() {
  return render(
    <MemoryRouter initialEntries={['/invite/ABC123']}>
      <Routes>
        <Route path="/invite/:code" element={<InviteLanding />} />
        <Route path="/watch/:roomId" element={<p>Sala watch</p>} />
        <Route path="/live/:roomId" element={<p>Sala live</p>} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  mockedApi.mockReset();
  localStorage.clear();
  global.fetch = vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({
      code: 'ABC123',
      roomTitle: 'Sala de prueba',
      hostName: 'Host de prueba',
      scheduledStartTime: '2026-11-01T20:00:00.000Z',
      roomId: 'r1',
    }),
  });
});

describe('InviteLanding — salas live', () => {
  it('con roomKind live lleva a /live/:id', async () => {
    mockedApi.mockResolvedValueOnce({ token: 'g', roomId: 'r1', nick: 'Ana', roomTitle: 'Directo', roomKind: 'live' });
    renderInvite();
    await userEvent.type(screen.getByPlaceholderText('Nick'), 'Ana');
    await userEvent.click(screen.getByText('Unirse'));
    expect(await screen.findByText('Sala live')).toBeInTheDocument();
  });

  it('sin roomKind sigue yendo a /watch/:id', async () => {
    mockedApi.mockResolvedValueOnce({ token: 'g', roomId: 'r1', nick: 'Ana', roomTitle: 'Cine' });
    renderInvite();
    await userEvent.type(screen.getByPlaceholderText('Nick'), 'Ana');
    await userEvent.click(screen.getByText('Unirse'));
    expect(await screen.findByText('Sala watch')).toBeInTheDocument();
  });

  it('el host con una sala live entra como host a /live/:id', async () => {
    localStorage.setItem('tint_token', 'host');
    mockedApi.mockResolvedValueOnce({ rooms: [{ id: 'r9', kind: 'live', invitation: { code: 'ABC123' } }] });
    renderInvite();
    expect(await screen.findByRole('link', { name: 'Entrar como host' })).toHaveAttribute('href', '/live/r9');
  });
});
