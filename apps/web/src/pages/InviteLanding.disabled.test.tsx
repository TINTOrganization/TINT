/**
 * Pruebas rojas: canjear una invitación de una sala deshabilitada (HU-LIVE-08 AC3,
 * HU-LIVE-09 AC2; ADR 0019). `POST /invitations/claim` → `410 {error:"Disabled"}` muestra
 * "El evento terminó"; el `410` de una sala eliminada conserva su mensaje.
 */
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import InviteLanding from './InviteLanding';
import { apiFetch, ApiError } from '../lib/api';

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
        <Route path="/watch/:roomId" element={<p>Sala lista</p>} />
      </Routes>
    </MemoryRouter>,
  );
}

async function claimAs(nick: string) {
  await userEvent.type(screen.getByPlaceholderText('Nick'), nick);
  await userEvent.click(screen.getByText('Unirse'));
}

beforeEach(() => {
  mockedApi.mockReset();
  localStorage.clear();
});

describe('InviteLanding — sala deshabilitada', () => {
  it('410 {error:"Disabled"} avisa que el evento terminó y no entra a la sala', async () => {
    mockedApi.mockImplementation((path: string) => {
      if (path === '/invitations/claim') {
        return Promise.reject(new ApiError(410, 'Disabled', { error: 'Disabled' }));
      }
      return Promise.resolve({ code: 'ABC123', roomId: 'r1', roomTitle: 'Directo' });
    });
    renderInvite();
    await claimAs('Ana');
    expect(await screen.findByText(/el evento terminó/i)).toBeInTheDocument();
    expect(screen.queryByText('Sala lista')).not.toBeInTheDocument();
    expect(localStorage.getItem('tint_guest_token')).toBeNull();
  });

  it('regresión: 410 de una sala eliminada sigue mostrando su propio mensaje', async () => {
    mockedApi.mockImplementation((path: string) => {
      if (path === '/invitations/claim') {
        return Promise.reject(new ApiError(410, 'Deleted', { error: 'Deleted' }));
      }
      return Promise.resolve({ code: 'ABC123', roomId: 'r1', roomTitle: 'Directo' });
    });
    renderInvite();
    await claimAs('Ana');
    expect(await screen.findByText(/expiró o la sala fue eliminada/i)).toBeInTheDocument();
    expect(screen.queryByText(/el evento terminó/i)).not.toBeInTheDocument();
  });
});
