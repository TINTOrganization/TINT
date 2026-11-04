import { describe, expect, it, vi, beforeEach } from 'vitest';
import { hydrateRoot } from 'react-dom/client';
import { act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import App from './App';
import { renderApp } from './entry-server';
import type { DashboardData } from './lib/serverDashboard';
import { MockWebSocket } from './test/mockWebSocket';
import { testGuestToken } from './test/guestToken';
import { initPreHydrationCapture, clearPreHydrationQueue, getPreHydrationQueue, PRE_HYDRATION_FLAG_KEY } from './lib/preHydration';
import { apiFetch } from './lib/api';

vi.mock('firebase/auth', () => ({
  signInWithPopup: vi.fn(),
  GoogleAuthProvider: vi.fn(),
}));

vi.mock('./lib/firebase', () => ({
  auth: {},
  app: {},
}));

vi.mock('./lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./lib/api')>();
  return { ...actual, apiFetch: vi.fn() };
});

describe('Seamless Client Hydration (AC1, AC2 & AC3)', () => {
  beforeEach(() => {
    vi.stubGlobal('WebSocket', MockWebSocket);
    MockWebSocket.reset();
    clearPreHydrationQueue();
    delete (window as unknown as Record<string, unknown>)[PRE_HYDRATION_FLAG_KEY];
    localStorage.clear();
    document.body.innerHTML = '';
    window.history.pushState({}, '', '/login');
    vi.mocked(apiFetch).mockImplementation((path: string) => {
      if (typeof path === 'string' && path.includes('/playback')) {
        return Promise.resolve({
          url: 'https://example.com/video.mp4',
          status: 'ready',
          qualities: [],
        });
      }
      if (typeof path === 'string' && path.includes('/sync-ticket')) {
        return Promise.resolve({ token: 'mock-sync-ticket' });
      }
      return Promise.resolve({});
    });
  });

  it('hidrata exitosamente sobre el HTML pre-renderizado del servidor para la landing page', async () => {
    const serverHtml = renderApp('/login');
    const container = document.createElement('div');
    container.id = 'root';
    container.innerHTML = serverHtml;
    document.body.appendChild(container);

    expect(container.hasChildNodes()).toBe(true);
    expect(container.textContent).toContain('Mira junto, siente al mismo tiempo');

    await act(async () => {
      hydrateRoot(container, <App />);
    });

    const input = container.querySelector('#invite-link') as HTMLInputElement;
    expect(input).toBeInTheDocument();

    await userEvent.type(input, 'TESTCODE');
    expect(input.value).toBe('TESTCODE');

    const continueBtn = container.querySelector('button[type="submit"]') as HTMLButtonElement;
    expect(continueBtn).toBeEnabled();
  });

  it('hidrata sobre el HTML pre-renderizado de invitación y permite interacción y navegación', async () => {
    window.history.pushState({}, '', '/invite/ROOM456');

    const serverHtml = renderApp('/invite/ROOM456');
    const container = document.createElement('div');
    container.id = 'root';
    container.innerHTML = serverHtml;
    document.body.appendChild(container);

    expect(container.textContent).toContain('ROOM456');
    expect(container.textContent).toContain('Te invitaron a ver algo juntos');

    await act(async () => {
      hydrateRoot(container, <App />);
    });

    const nickInput = container.querySelector('#nick') as HTMLInputElement;
    expect(nickInput).toBeInTheDocument();

    await userEvent.type(nickInput, 'Carlos');
    expect(nickInput.value).toBe('Carlos');

    const submitBtn = container.querySelector('button[type="submit"]') as HTMLButtonElement;
    expect(submitBtn).toBeEnabled();
  });

  it('hidrata el dashboard del host con salas, próximo evento y estado sin discrepancias (AC1)', async () => {
    window.history.pushState({}, '', '/dashboard');

    const dashboardData: DashboardData = {
      rooms: [
        {
          id: 'room-cine',
          title: 'Maratón de Anime',
          status: 'active',
          nextScheduledEvent: '2026-11-04T20:00:00.000Z',
        },
        {
          id: 'room-talk',
          title: 'Directo de Charlas',
          status: 'disabled',
          nextScheduledEvent: { title: 'Charla con Creadores' },
        },
      ],
      isHost: true,
      error: null,
    };

    const serverHtml = renderApp('/dashboard', null, false, dashboardData);
    const container = document.createElement('div');
    container.id = 'root';
    container.innerHTML = serverHtml;
    document.body.appendChild(container);

    expect(container.textContent).toContain('Maratón de Anime');
    expect(container.textContent).toContain('active');
    expect(container.textContent).toContain('Directo de Charlas');
    expect(container.textContent).toContain('disabled');
    expect(container.textContent).toContain('Próximo evento:');

    await act(async () => {
      hydrateRoot(container, <App dashboardData={dashboardData} />);
    });

    // En la vista hidratada del host los controles de gestión están presentes
    expect(container.textContent).toContain('Crear sala');
    expect(container.textContent).toContain('Gestionar');
    expect(container.textContent).toContain('Análisis');
    expect(container.textContent).toContain('Eliminar');
  });

  it('hidrata el dashboard para un participante omitiendo controles de host en cliente (AC2)', async () => {
    window.history.pushState({}, '', '/dashboard');

    const dashboardData: DashboardData = {
      rooms: [
        {
          id: 'room-view',
          title: 'Sala de Espectador',
          status: 'active',
          nextScheduledEvent: '2026-11-04T20:00:00.000Z',
        },
      ],
      isHost: false,
      role: 'participant',
      error: null,
    };

    const serverHtml = renderApp('/dashboard', null, false, dashboardData);
    const container = document.createElement('div');
    container.id = 'root';
    container.innerHTML = serverHtml;
    document.body.appendChild(container);

    expect(container.textContent).toContain('Sala de Espectador');
    expect(container.textContent).toContain('active');
    expect(container.textContent).not.toContain('Crear sala');
    expect(container.textContent).not.toContain('Gestionar');
    expect(container.textContent).not.toContain('Eliminar');

    await act(async () => {
      hydrateRoot(container, <App dashboardData={dashboardData} />);
    });

    // La vista hidratada también omite las acciones de administración de host
    expect(container.textContent).not.toContain('Crear sala');
    expect(container.textContent).not.toContain('Gestionar');
    expect(container.textContent).not.toContain('Análisis');
    expect(container.textContent).not.toContain('Eliminar');
    expect(container.textContent).toContain('Abrir');
  });

  it('hidrata el dashboard con error estilizado sin romper el árbol React (AC3)', async () => {
    window.history.pushState({}, '', '/dashboard');

    const dashboardData: DashboardData = {
      rooms: [],
      isHost: true,
      error: 'El servicio de identidad no está disponible en este momento.',
    };

    const serverHtml = renderApp('/dashboard', null, false, dashboardData);
    const container = document.createElement('div');
    container.id = 'root';
    container.innerHTML = serverHtml;
    document.body.appendChild(container);

    expect(container.textContent).toContain('El servicio de identidad no está disponible en este momento.');

    await act(async () => {
      hydrateRoot(container, <App dashboardData={dashboardData} />);
    });

    expect(container.textContent).toContain('El servicio de identidad no está disponible en este momento.');
  });

  it('hidrata la sala /watch/:roomId sobre el HTML pre-renderizado del servidor sin hydration mismatch (AC1)', async () => {
    window.history.pushState({}, '', '/watch/room-ssr-1');

    const serverHtml = renderApp('/watch/room-ssr-1');
    expect(serverHtml).toContain('Sala room-ssr-1');
    expect(serverHtml).toContain('Cargando reproductor…');
    expect(serverHtml).toContain('Reproducción sincronizada');
    expect(serverHtml).toContain('chat-input');

    const container = document.createElement('div');
    container.id = 'root';
    container.innerHTML = serverHtml;
    document.body.appendChild(container);

    localStorage.setItem('tint_guest_token', testGuestToken({ room_id: 'room-ssr-1', nick: 'Luna' }));

    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await act(async () => {
      hydrateRoot(container, <App />);
    });

    const mismatchCalls = errorSpy.mock.calls.filter((call) =>
      call.some(
        (arg) =>
          typeof arg === 'string' &&
          (arg.includes('Warning: Text content did not match') ||
            arg.includes('Warning: Expected server HTML to contain a matching') ||
            arg.includes('Hydration failed')),
      ),
    );
    if (mismatchCalls.length > 0) {
      console.log('MISMATCH CALL:', mismatchCalls);
    }
    expect(mismatchCalls).toHaveLength(0);

    expect(container.textContent).toContain('Sala room-ssr-1');
    expect(container.querySelector('button[data-action="react-❤️"]')).toBeInTheDocument();

    errorSpy.mockRestore();
  });

  it('captura y repite clics pre-hidratación en controles de la sala sin perder la interacción (AC2)', async () => {
    window.history.pushState({}, '', '/watch/room-ssr-2');

    const serverHtml = renderApp('/watch/room-ssr-2');
    const container = document.createElement('div');
    container.id = 'root';
    container.innerHTML = serverHtml;
    document.body.appendChild(container);

    const cleanup = initPreHydrationCapture();

    const reactBtn = container.querySelector('button[data-action="react-❤️"]') as HTMLButtonElement;
    expect(reactBtn).toBeInTheDocument();

    const clickEvent = new MouseEvent('click', { bubbles: true, cancelable: true });
    reactBtn.dispatchEvent(clickEvent);

    expect(clickEvent.defaultPrevented).toBe(true);
    expect(getPreHydrationQueue()).toHaveLength(1);
    expect(getPreHydrationQueue()[0].action).toBe('react-❤️');

    localStorage.setItem('tint_guest_token', testGuestToken({ room_id: 'room-ssr-2', nick: 'Mateo' }));

    await act(async () => {
      hydrateRoot(container, <App />);
    });

    // Tras la hidratación la cola se vacía y el evento fue despachado
    expect(getPreHydrationQueue()).toHaveLength(0);

    cleanup();
  });

  it('desmontar la sala cierra los WebSockets activos y limpia recursos (AC3)', async () => {
    window.history.pushState({}, '', '/watch/room-ssr-3');
    localStorage.setItem('tint_guest_token', testGuestToken({ room_id: 'room-ssr-3', nick: 'Sofia' }));

    const container = document.createElement('div');
    container.id = 'root';
    document.body.appendChild(container);

    let rootInstance: ReturnType<typeof hydrateRoot> | null = null;
    await act(async () => {
      rootInstance = hydrateRoot(container, <App />);
    });

    expect(MockWebSocket.instances.length).toBeGreaterThan(0);
    const activeSockets = MockWebSocket.instances.filter(
      (ws) => ws.url.includes('/ws/sync') || ws.url.includes('/ws/social'),
    );
    expect(activeSockets.length).toBeGreaterThan(0);

    await act(async () => {
      rootInstance?.unmount();
    });

    for (const ws of activeSockets) {
      expect(ws.readyState).toBe(MockWebSocket.CLOSED);
      expect(ws.onmessage).toBeNull();
      expect(ws.onclose).toBeNull();
    }
  });
});
