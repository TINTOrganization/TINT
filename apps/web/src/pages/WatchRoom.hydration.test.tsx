import { act, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import WatchRoom from './WatchRoom';
import { MockWebSocket } from '../test/mockWebSocket';
import { apiFetch } from '../lib/api';
import { testGuestToken } from '../test/guestToken';
import { clearPreHydrationQueue, initPreHydrationCapture } from '../lib/hydration';

vi.mock('../lib/api', () => ({ apiFetch: vi.fn() }));
const mockedApiFetch = vi.mocked(apiFetch);

function renderWatch(initialData?: Record<string, unknown>) {
  return render(
    <MemoryRouter initialEntries={['/watch/room-test-1']}>
      <Routes>
        <Route path="/watch/:roomId" element={<WatchRoom initialData={initialData} />} />
      </Routes>
    </MemoryRouter>,
  );
}

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe('WatchRoom — Client-Side Hydration & Real-Time Initialization', () => {
  beforeEach(() => {
    localStorage.clear();
    MockWebSocket.reset();
    vi.stubGlobal('WebSocket', MockWebSocket);
    mockedApiFetch.mockReset();
    mockedApiFetch.mockImplementation(async (path: string) => {
      if (path.includes('/playback')) {
        return {
          mediaId: 'test-vid',
          url: 'https://cdn.test/demo.mp4',
          status: 'ready',
          expiresAt: '2026-11-03T00:00:00Z',
        };
      }
      return { token: 'ticket-xyz', expiresAt: '2026-11-03T00:00:00Z' };
    });
    vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined);
    vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});
    clearPreHydrationQueue();
  });

  afterEach(() => {
    clearPreHydrationQueue();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  describe('Post-SSR Real-Time Feature Initialization (AC1)', () => {
    it('inicializa con datos de SSR (initialData) reflejando el título de la sala de forma consistente', async () => {
      localStorage.setItem('tint_guest_token', testGuestToken({ room_id: 'room-test-1', nick: 'Ana' }));

      renderWatch({
        roomId: 'room-test-1',
        roomTitle: 'Película Especial SSR',
      });

      await flush();

      // AC1: El título provisto por SSR se renderiza sin desfase ni parpadeo
      expect(screen.getByText('Película Especial SSR')).toBeInTheDocument();
      // Y los componentes interactivos se vuelven activos en el cliente
      expect(screen.getByRole('toolbar', { name: 'Reacciones' })).toBeInTheDocument();
      expect(screen.getByPlaceholderText('Escribe un mensaje')).toBeInTheDocument();
    });

    it('inicializa los canales WebSocket (/ws/sync y /ws/social) cleanly tras la hidratación', async () => {
      localStorage.setItem('tint_guest_token', testGuestToken({ room_id: 'room-test-1', nick: 'Carlos' }));

      renderWatch({ roomId: 'room-test-1' });
      await flush();

      // Se abren los sockets para sync y social
      expect(MockWebSocket.instances.length).toBeGreaterThanOrEqual(1);
      const syncSocket = MockWebSocket.instances.find((s) => s.url.includes('/ws/sync'));
      const socialSocket = MockWebSocket.instances.find((s) => s.url.includes('/ws/social'));

      expect(syncSocket).toBeDefined();
      expect(socialSocket).toBeDefined();

      act(() => {
        syncSocket?.open();
        socialSocket?.open();
      });

      // El chat refleja estado conectado
      expect(screen.getByText(/Chat conectado/i)).toBeInTheDocument();
    });
  });

  describe('Interaction Resilience During Hydration (AC2)', () => {
    it('captura una reacción previa a la hidratación y la despacha al montar sin perderla ni fallar', async () => {
      localStorage.setItem('tint_guest_token', testGuestToken({ room_id: 'room-test-1' }));

      // Simular evento capturado en la cola pre-hidratación antes de montar React
      initPreHydrationCapture();
      window.__TINT_PRE_HYDRATION_QUEUE__ = [
        {
          type: 'click',
          target: null,
          action: 'reaction',
          payload: { emoji: '👏' },
          timestamp: Date.now(),
        },
      ];

      renderWatch({ roomId: 'room-test-1' });
      await flush();

      const socialSocket = MockWebSocket.instances.find((s) => s.url.includes('/ws/social'));
      expect(socialSocket).toBeDefined();

      // Abrir el socket
      act(() => {
        socialSocket?.open();
      });

      // La reacción 👏 que estaba en la cola previa debe haberse enviado por el socket
      const sentReaction = socialSocket?.sent.some((msg) => String(msg).includes('"emoji":"👏"'));
      expect(sentReaction).toBe(true);
    });

    it('encola reacciones disparadas mientras el socket está conectando y las envía al abrir', async () => {
      localStorage.setItem('tint_guest_token', testGuestToken({ room_id: 'room-test-1' }));

      renderWatch({ roomId: 'room-test-1' });
      await flush();

      const socialSocket = MockWebSocket.instances.find((s) => s.url.includes('/ws/social'));
      expect(socialSocket).toBeDefined();
      // Socket sigue en connecting (readyState 0)
      expect(socialSocket?.readyState).toBe(0);

      // El usuario hace clic en el botón de reacción ❤️ mientras aún conecta
      const heartBtn = screen.getByRole('button', { name: /corazón/i });
      fireEvent.click(heartBtn);

      // Aún no debe haber fallado ni crasheado
      expect(socialSocket?.sent).toHaveLength(0);

      // Ahora el socket se abre
      act(() => {
        socialSocket?.open();
      });

      // La reacción ❤️ debe haberse despachado automáticamente
      const sentHeart = socialSocket?.sent.some((msg) => String(msg).includes('"emoji":"❤️"'));
      expect(sentHeart).toBe(true);
    });
  });

  describe('WebSocket Lifecycle & Unmount Cleanup (AC3)', () => {
    it('cierra cleanly los WebSockets y limpia los listeners al desmontar el componente', async () => {
      localStorage.setItem('tint_guest_token', testGuestToken({ room_id: 'room-test-1' }));

      const { unmount } = renderWatch({ roomId: 'room-test-1' });
      await flush();

      const syncSocket = MockWebSocket.instances.find((s) => s.url.includes('/ws/sync'));
      const socialSocket = MockWebSocket.instances.find((s) => s.url.includes('/ws/social'));

      expect(syncSocket).toBeDefined();
      expect(socialSocket).toBeDefined();

      act(() => {
        syncSocket?.open();
        socialSocket?.open();
      });

      // Desmontar el componente (navegación away)
      unmount();

      // AC3: Ambos sockets deben haber sido cerrados cleanly
      expect(syncSocket?.readyState).toBe(3); // CLOSED
      expect(socialSocket?.readyState).toBe(3); // CLOSED

      // Callbacks deben haber sido nulificados para prevenir memory leaks y zombie events
      expect(syncSocket?.onmessage).toBeNull();
      expect(syncSocket?.onopen).toBeNull();
      expect(socialSocket?.onmessage).toBeNull();
      expect(socialSocket?.onopen).toBeNull();
    });

    it('pausa la reproducción del reproductor de video al desmontar para evitar reproducción zombi', async () => {
      vi.stubEnv('VITE_DEMO_VIDEO_URL', 'https://cdn.test/demo.mp4');
      localStorage.setItem('tint_token', 'host-tok');
      const pauseSpy = vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});

      const { unmount } = renderWatch({ roomId: 'room-test-1', isHost: true });
      await flush();

      unmount();

      expect(pauseSpy).toHaveBeenCalled();
    });
  });
});
