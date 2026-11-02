/** WatchRoom con salas `live` o deshabilitadas (ADR 0019). */
import { act, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import WatchRoom from './WatchRoom';
import { MockWebSocket } from '../test/mockWebSocket';
import { apiFetch } from '../lib/api';

vi.mock('../lib/api', async (orig) => ({
  ...(await orig<typeof import('../lib/api')>()),
  apiFetch: vi.fn(),
}));
const mockedApi = vi.mocked(apiFetch);

let room: Record<string, unknown> = {};

function routeApi(path: string) {
  if (path.endsWith('/sync-ticket')) return Promise.resolve({ token: 'ticket', expiresAt: '2099-01-01T00:00:00Z' });
  if (path.endsWith('/playback')) return Promise.resolve({ mediaId: null, url: null, expiresAt: null });
  if (path === '/rooms/r1') return Promise.resolve({ room: { id: 'r1', title: 'Sala', ...room } });
  if (path.endsWith('/invitations')) return Promise.resolve({ invitations: [] });
  return Promise.resolve({});
}

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem('tint_token', 'host');
  MockWebSocket.reset();
  room = {};
  vi.stubGlobal('WebSocket', MockWebSocket);
  vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: true, addListener: vi.fn(), removeListener: vi.fn() })));
  mockedApi.mockReset();
  mockedApi.mockImplementation(routeApi as typeof apiFetch);
});

function renderWatch() {
  return render(
    <MemoryRouter initialEntries={['/watch/r1']}>
      <Routes>
        <Route path="/watch/:roomId" element={<WatchRoom />} />
        <Route path="/live/:roomId" element={<p>Página live</p>} />
      </Routes>
    </MemoryRouter>,
  );
}

async function flush() {
  await act(async () => {
    for (let i = 0; i < 6; i += 1) await Promise.resolve();
  });
}

describe('WatchRoom — tipo de sala', () => {
  it('el host de una sala live va a /live/:id', async () => {
    room = { kind: 'live' };
    renderWatch();
    await flush();
    expect(screen.getByText('Página live')).toBeInTheDocument();
  });

  it('una sala deshabilitada muestra el aviso de fin', async () => {
    room = { kind: 'watch', status: 'disabled' };
    renderWatch();
    await flush();
    expect(screen.getByRole('alert')).toHaveTextContent(/el evento terminó/i);
    expect(screen.getByRole('link', { name: 'Ir al dashboard' })).toHaveAttribute('href', '/dashboard');
  });
});
