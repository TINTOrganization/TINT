import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import {
  initPreHydrationCapture,
  getPreHydrationQueue,
  clearPreHydrationQueue,
  markHydratedAndReplay,
  isHydrated,
  PRE_HYDRATION_QUEUE_KEY,
  PRE_HYDRATION_FLAG_KEY,
} from './preHydration';

describe('preHydration (AC2)', () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    clearPreHydrationQueue();
    delete (window as unknown as Record<string, unknown>)[PRE_HYDRATION_FLAG_KEY];
    delete (window as unknown as Record<string, unknown>)[PRE_HYDRATION_QUEUE_KEY];
    container = document.createElement('div');
    document.body.appendChild(container);
  });

  afterEach(() => {
    clearPreHydrationQueue();
    container.remove();
    vi.restoreAllMocks();
  });

  it('captura clics en elementos con data-action o botones antes de la hidratación', () => {
    const cleanup = initPreHydrationCapture();

    const btn = document.createElement('button');
    btn.setAttribute('data-action', 'react-❤️');
    btn.setAttribute('aria-label', 'Reaccionar con corazón');
    container.appendChild(btn);

    const event = new MouseEvent('click', { bubbles: true, cancelable: true });
    btn.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);

    const queue = getPreHydrationQueue();
    expect(queue).toHaveLength(1);
    expect(queue[0].action).toBe('react-❤️');
    expect(queue[0].target).toBe(btn);

    cleanup();
  });

  it('no captura clics cuando la hidratación ya ha ocurrido', () => {
    const cleanup = initPreHydrationCapture();
    (window as unknown as Record<string, unknown>)[PRE_HYDRATION_FLAG_KEY] = true;

    const btn = document.createElement('button');
    btn.setAttribute('data-action', 'toggle-play');
    container.appendChild(btn);

    const event = new MouseEvent('click', { bubbles: true, cancelable: true });
    btn.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(false);
    expect(getPreHydrationQueue()).toHaveLength(0);

    cleanup();
  });

  it('ignora clics en elementos no interactivos', () => {
    const cleanup = initPreHydrationCapture();

    const div = document.createElement('div');
    div.textContent = 'Texto plano sin acción';
    container.appendChild(div);

    const event = new MouseEvent('click', { bubbles: true, cancelable: true });
    div.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(false);
    expect(getPreHydrationQueue()).toHaveLength(0);

    cleanup();
  });

  it('ejecuta los manejadores registrados al llamar a markHydratedAndReplay', () => {
    initPreHydrationCapture();

    const btn = document.createElement('button');
    btn.setAttribute('data-action', 'react-🔥');
    container.appendChild(btn);

    btn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    expect(getPreHydrationQueue()).toHaveLength(1);

    const handler = vi.fn();
    markHydratedAndReplay({
      'react-🔥': handler,
    });

    expect(isHydrated()).toBe(true);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'react-🔥',
        target: btn,
      }),
    );
    expect(getPreHydrationQueue()).toHaveLength(0);
  });

  it('re-despacha el clic en el botón si no hay un manejador específico pero el elemento sigue en el DOM', () => {
    initPreHydrationCapture();

    const btn = document.createElement('button');
    btn.setAttribute('data-action', 'toggle-play');
    const clickSpy = vi.fn();
    btn.addEventListener('click', clickSpy);
    container.appendChild(btn);

    btn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    expect(getPreHydrationQueue()).toHaveLength(1);

    // Al hidratar sin handler específico, el replayer re-despacha click sobre el elemento
    markHydratedAndReplay({});

    expect(clickSpy).toHaveBeenCalledTimes(1);
    expect(getPreHydrationQueue()).toHaveLength(0);
  });

  it('si el elemento fue reemplazado por la hidratación, busca el nuevo por data-action', () => {
    initPreHydrationCapture();

    const oldBtn = document.createElement('button');
    oldBtn.setAttribute('data-action', 'react-👏');
    container.appendChild(oldBtn);

    oldBtn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    expect(getPreHydrationQueue()).toHaveLength(1);

    // Simular que React hidrató y reemplazó oldBtn por newBtn
    oldBtn.remove();
    const newBtn = document.createElement('button');
    newBtn.setAttribute('data-action', 'react-👏');
    const newClickSpy = vi.fn();
    newBtn.addEventListener('click', newClickSpy);
    container.appendChild(newBtn);

    markHydratedAndReplay({});

    expect(newClickSpy).toHaveBeenCalledTimes(1);
  });
});
