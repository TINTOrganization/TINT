/**
 * Gestor de eventos pre-hidratación (AC2).
 * Captura, encola y reproduce eventos generados por el usuario antes de que
 * React complete la hidratación en cliente.
 */

export const PRE_HYDRATION_QUEUE_KEY = '__TINT_PRE_HYDRATION_QUEUE__';
export const PRE_HYDRATION_FLAG_KEY = '__TINT_HYDRATED__';

export interface QueuedPreHydrationEvent {
  type: string;
  action: string;
  target: HTMLElement | null;
  timeStamp: number;
}

declare global {
  interface Window {
    [PRE_HYDRATION_QUEUE_KEY]?: QueuedPreHydrationEvent[];
    [PRE_HYDRATION_FLAG_KEY]?: boolean;
    __TINT_PRE_HYDRATION_LISTENER__?: (e: MouseEvent) => void;
  }
}

/** Comprueba si la aplicación en cliente ya completó la hidratación. */
export function isHydrated(): boolean {
  if (typeof window === 'undefined') return false;
  return Boolean(window[PRE_HYDRATION_FLAG_KEY]);
}

/** Devuelve la lista actual de eventos encolados en espera de hidratación. */
export function getPreHydrationQueue(): QueuedPreHydrationEvent[] {
  if (typeof window === 'undefined') return [];
  const queue = window[PRE_HYDRATION_QUEUE_KEY];
  return Array.isArray(queue) ? queue : [];
}

/** Limpia la cola de eventos pre-hidratación. */
export function clearPreHydrationQueue(): void {
  if (typeof window === 'undefined') return;
  window[PRE_HYDRATION_QUEUE_KEY] = [];
}

/**
 * Inicializa la captura en fase temprana (capture phase) para botones y controles.
 * Devuelve una función para retirar el listener.
 */
export function initPreHydrationCapture(): () => void {
  if (typeof window === 'undefined' || typeof document === 'undefined') {
    return () => {};
  }

  window[PRE_HYDRATION_QUEUE_KEY] = window[PRE_HYDRATION_QUEUE_KEY] || [];

  if (window.__TINT_PRE_HYDRATION_LISTENER__) {
    document.removeEventListener('click', window.__TINT_PRE_HYDRATION_LISTENER__, true);
  }

  const listener = (event: MouseEvent) => {
    if (window[PRE_HYDRATION_FLAG_KEY]) return;

    const target = event.target as HTMLElement | null;
    if (!target) return;

    const interactive = target.closest('button, [data-action], input[type="submit"], [role="button"]') as HTMLElement | null;
    if (!interactive) return;

    event.preventDefault();
    event.stopPropagation();

    const action =
      interactive.getAttribute('data-action') ||
      interactive.getAttribute('aria-label') ||
      interactive.id ||
      '';

    window[PRE_HYDRATION_QUEUE_KEY] = window[PRE_HYDRATION_QUEUE_KEY] || [];
    window[PRE_HYDRATION_QUEUE_KEY].push({
      type: event.type,
      action,
      target: interactive,
      timeStamp: Date.now(),
    });
  };

  window.__TINT_PRE_HYDRATION_LISTENER__ = listener;
  document.addEventListener('click', listener, true);

  return () => {
    document.removeEventListener('click', listener, true);
    if (window.__TINT_PRE_HYDRATION_LISTENER__ === listener) {
      delete window.__TINT_PRE_HYDRATION_LISTENER__;
    }
  };
}

/**
 * Marca la hidratación como completa y procesa todos los eventos encolados.
 * Si se proporcionan manejadores específicos en `handlers`, se invocan; de lo contrario,
 * se re-despacha el evento sobre el elemento destino (o su equivalente en el nuevo DOM).
 */
export function markHydratedAndReplay(
  handlers: Record<string, (event: QueuedPreHydrationEvent) => void> = {},
): void {
  if (typeof window === 'undefined') return;

  window[PRE_HYDRATION_FLAG_KEY] = true;
  const queue = [...getPreHydrationQueue()];
  clearPreHydrationQueue();

  for (const item of queue) {
    if (item.action && handlers[item.action]) {
      try {
        handlers[item.action](item);
      } catch {
        // Evitar que el fallo de un handler interrumpa el resto
      }
      continue;
    }

    // Si no hay un handler registrado específico, re-disparar el clic
    let target = item.target;
    if (target && !target.isConnected && item.action) {
      target = document.querySelector(`[data-action="${CSS.escape(item.action)}"]`) as HTMLElement | null;
    }

    if (target && target.isConnected) {
      try {
        target.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
      } catch {
        // Silencioso ante errores sintéticos
      }
    }
  }
}
