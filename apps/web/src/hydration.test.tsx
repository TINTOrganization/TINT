import { describe, expect, it, vi, beforeEach } from 'vitest';
import { hydrateRoot } from 'react-dom/client';
import { act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import App from './App';
import { renderApp } from './entry-server';
import type { DashboardData } from './lib/serverDashboard';

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
    document.body.innerHTML = '';
    window.history.pushState({}, '', '/login');
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
});
