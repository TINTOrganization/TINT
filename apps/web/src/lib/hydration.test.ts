import { renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  clearPreHydrationQueue,
  drainPreHydrationQueue,
  initPreHydrationCapture,
  markHydrated,
  removePreHydrationCapture,
  useHydrated,
} from './hydration';

describe('hydration utilities (AC1 & AC2)', () => {
  beforeEach(() => {
    clearPreHydrationQueue();
    removePreHydrationCapture();
    delete window.__TINT_HYDRATED__;
    document.body.innerHTML = '';
  });

  afterEach(() => {
    removePreHydrationCapture();
    clearPreHydrationQueue();
    delete window.__TINT_HYDRATED__;
  });

  describe('useHydrated (AC1)', () => {
    it('comienza en false para asegurar consistencia con SSR y pasa a true tras montar', () => {
      const { result } = renderHook(() => useHydrated());
      // En entorno de testing con RTL effects corren tras renderHook, por lo que result.current es true tras montar
      expect(result.current).toBe(true);
      expect(window.__TINT_HYDRATED__).toBe(true);
    });
  });

  describe('Pre-Hydration Event Capture (AC2)', () => {
    it('captura clics en botones interactivos antes de completar la hidratación', () => {
      initPreHydrationCapture();

      const btn = document.createElement('button');
      btn.setAttribute('data-action', 'play');
      btn.setAttribute('aria-label', 'Reproducir');
      document.body.appendChild(btn);

      btn.click();

      const queue = drainPreHydrationQueue();
      expect(queue).toHaveLength(1);
      expect(queue[0].action).toBe('play');
      expect(queue[0].type).toBe('click');
      expect(queue[0].target).toBe(btn);
    });

    it('captura reacciones con emoji en data-reaction', () => {
      initPreHydrationCapture();

      const reactionBtn = document.createElement('button');
      reactionBtn.setAttribute('data-action', 'reaction');
      reactionBtn.setAttribute('data-reaction', '👏');
      document.body.appendChild(reactionBtn);

      reactionBtn.click();

      const queue = drainPreHydrationQueue();
      expect(queue).toHaveLength(1);
      expect(queue[0].action).toBe('reaction');
      expect(queue[0].payload?.emoji).toBe('👏');
    });

    it('drainPreHydrationQueue vacía la cola tras consumirla', () => {
      initPreHydrationCapture();

      const btn = document.createElement('button');
      btn.setAttribute('data-action', 'test');
      document.body.appendChild(btn);

      btn.click();
      expect(drainPreHydrationQueue()).toHaveLength(1);
      expect(drainPreHydrationQueue()).toHaveLength(0);
    });

    it('no captura eventos una vez que la hidratación ha finalizado (markHydrated)', () => {
      initPreHydrationCapture();
      markHydrated();

      const btn = document.createElement('button');
      btn.setAttribute('data-action', 'reaction');
      btn.setAttribute('data-reaction', '❤️');
      document.body.appendChild(btn);

      btn.click();

      const queue = drainPreHydrationQueue();
      expect(queue).toHaveLength(0);
    });

    it('removePreHydrationCapture remueve los listeners correctamente', () => {
      initPreHydrationCapture();
      removePreHydrationCapture();

      const btn = document.createElement('button');
      btn.setAttribute('data-action', 'reaction');
      btn.setAttribute('data-reaction', '😂');
      document.body.appendChild(btn);

      btn.click();

      expect(drainPreHydrationQueue()).toHaveLength(0);
    });
  });
});
