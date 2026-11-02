import { useEffect, useState } from 'react';

/**
 * Evento de interacción capturado antes de completar la hidratación del cliente.
 */
export interface PreHydrationEvent {
  type: string;
  target: HTMLElement | null;
  action?: string;
  payload?: Record<string, unknown>;
  timestamp: number;
}

declare global {
  interface Window {
    __TINT_PRE_HYDRATION_QUEUE__?: PreHydrationEvent[];
    __TINT_HYDRATED__?: boolean;
    __TINT_PRE_HYDRATION_LISTENER__?: (e: Event) => void;
  }
}

/**
 * Inicializa la captura de eventos previos a la hidratación para no perder
 * clics ni interacciones del usuario mientras React monta (AC2).
 */
export function initPreHydrationCapture(): void {
  if (typeof window === 'undefined') return;
  if (!window.__TINT_PRE_HYDRATION_QUEUE__) {
    window.__TINT_PRE_HYDRATION_QUEUE__ = [];
  }
  if (window.__TINT_PRE_HYDRATION_LISTENER__) return;

  const handler = (e: Event) => {
    if (window.__TINT_HYDRATED__) return;
    const target = e.target as HTMLElement | null;
    const button = target?.closest ? (target.closest('button, [data-action]') as HTMLElement | null) : null;
    if (!button) return;

    const action = button.getAttribute('data-action') || (button.getAttribute('data-reaction') ? 'reaction' : undefined);
    const emoji = button.getAttribute('data-reaction') || undefined;

    window.__TINT_PRE_HYDRATION_QUEUE__?.push({
      type: e.type,
      target: button,
      action,
      payload: emoji ? { emoji } : undefined,
      timestamp: Date.now(),
    });
  };

  window.__TINT_PRE_HYDRATION_LISTENER__ = handler;
  document.addEventListener('click', handler, { capture: true, passive: true });
}

/**
 * Remueve el listener de captura temprana de eventos.
 */
export function removePreHydrationCapture(): void {
  if (typeof window === 'undefined' || !window.__TINT_PRE_HYDRATION_LISTENER__) return;
  document.removeEventListener('click', window.__TINT_PRE_HYDRATION_LISTENER__, { capture: true });
  delete window.__TINT_PRE_HYDRATION_LISTENER__;
}

/**
 * Marca que la hidratación en cliente ha finalizado.
 */
export function markHydrated(): void {
  if (typeof window !== 'undefined') {
    window.__TINT_HYDRATED__ = true;
  }
}

/**
 * Obtiene y vacía la cola de eventos previos a la hidratación (AC2).
 */
export function drainPreHydrationQueue(): PreHydrationEvent[] {
  if (typeof window === 'undefined' || !window.__TINT_PRE_HYDRATION_QUEUE__) return [];
  const events = [...window.__TINT_PRE_HYDRATION_QUEUE__];
  window.__TINT_PRE_HYDRATION_QUEUE__ = [];
  return events;
}

/**
 * Limpia la cola de eventos previos a la hidratación sin retornarla.
 */
export function clearPreHydrationQueue(): void {
  if (typeof window !== 'undefined') {
    window.__TINT_PRE_HYDRATION_QUEUE__ = [];
  }
}

/**
 * Hook para sincronizar el ciclo de vida de hidratación en componentes cliente (AC1).
 * Retorna false en el render inicial (isomórfico con SSR) y true una vez montado.
 */
export function useHydrated(): boolean {
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    setHydrated(true);
    markHydrated();
  }, []);

  return hydrated;
}
