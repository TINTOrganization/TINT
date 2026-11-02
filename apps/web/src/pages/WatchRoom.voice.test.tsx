import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import WatchRoom from './WatchRoom';
import { MockWebSocket } from '../test/mockWebSocket';
import { apiFetch } from '../lib/api';
import { testGuestToken } from '../test/guestToken';

vi.mock('../lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/api')>()),
  apiFetch: vi.fn(),
}));

function renderWatch() {
  return render(
    <MemoryRouter initialEntries={['/watch/r1']}>
      <Routes>
        <Route path="/watch/:roomId" element={<WatchRoom />} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.stubGlobal('WebSocket', MockWebSocket);
  MockWebSocket.reset();
  vi.mocked(apiFetch).mockRejectedValue(new Error('offline'));
  localStorage.clear();
  localStorage.setItem('tint_guest_token', testGuestToken({ sub: 'guest:u9', nick: 'Pedro' }));
});

// HU-VOZ-06: la voz es su propio componente; la sala no depende de ella.
describe('WatchRoom — canal de voz', () => {
  it('muestra la tarjeta de voz sin conectar a voice-core hasta que se pulse', () => {
    renderWatch();
    expect(screen.getByRole('heading', { name: 'Voz' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /unirse a la voz/i })).toBeInTheDocument();
    expect(MockWebSocket.instances.some((ws) => ws.url.includes('/ws/voice'))).toBe(false);
  });
});
