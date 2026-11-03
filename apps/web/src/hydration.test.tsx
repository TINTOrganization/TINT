import { describe, expect, it, vi, beforeEach } from 'vitest';
import { hydrateRoot } from 'react-dom/client';
import { act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import App from './App';
import { renderApp } from './entry-server';

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

describe('Seamless Client Hydration (AC3)', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    window.history.pushState({}, '', '/login');
  });

  it('hidrata exitosamente sobre el HTML pre-renderizado del servidor para la landing page', async () => {
    // 1. Simular respuesta del servidor con HTML pre-renderizado
    const serverHtml = renderApp('/login');
    const container = document.createElement('div');
    container.id = 'root';
    container.innerHTML = serverHtml;
    document.body.appendChild(container);

    expect(container.hasChildNodes()).toBe(true);
    expect(container.textContent).toContain('Mira junto, siente al mismo tiempo');

    // 2. Ejecutar hidratación en cliente (igual que main.tsx)
    await act(async () => {
      hydrateRoot(container, <App />);
    });

    // 3. Verificar que los elementos interactivos responden sin recargar página
    const input = container.querySelector('#invite-link') as HTMLInputElement;
    expect(input).toBeInTheDocument();

    await userEvent.type(input, 'TESTCODE');
    expect(input.value).toBe('TESTCODE');

    // El botón se habilita al escribir
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
});
