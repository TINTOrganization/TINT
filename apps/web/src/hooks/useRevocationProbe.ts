import { useEffect, useState } from 'react';
import { apiFetch } from '../lib/api';
import { errorStatus } from '../lib/errorStatus';

/** Espera entre comprobaciones mientras el invitado sigue sin poder reconectar. */
export const REVOCATION_PROBE_INTERVAL_MS = 3_000;

export interface UseRevocationProbeOptions {
  roomId: string | undefined;
  role: 'host' | 'guest';
  /** true mientras algún canal está reconectando: solo entonces vale la pena preguntar. */
  active: boolean;
  intervalMs?: number;
}

/**
 * Red de seguridad de la expulsión. Los servidores avisan con un cierre `4001`, pero un
 * navegador puede entregarlo como `1006` (o perderse un `REVOKED` por Pub/Sub) y el invitado
 * se quedaría reconectando para siempre con la sala a la vista. Mientras `active`, el invitado
 * pregunta a identity-api si su token sigue vigente: un 401/403 es una expulsión (se borra
 * `tint_guest_token`). Un fallo de red o un 5xx no expulsa: se vuelve a preguntar.
 */
export function useRevocationProbe({
  roomId,
  role,
  active,
  intervalMs = REVOCATION_PROBE_INTERVAL_MS,
}: UseRevocationProbeOptions): { revoked: boolean } {
  const [revoked, setRevoked] = useState(false);

  useEffect(() => {
    if (!active || !roomId || role !== 'guest' || revoked) return;
    let cancelled = false;
    let timer: number | undefined;

    const check = () => {
      apiFetch(`/rooms/${encodeURIComponent(roomId)}/playback`)
        .then(() => undefined)
        .catch((err: unknown) => {
          const status = errorStatus(err);
          if (status === 401 || status === 403) {
            localStorage.removeItem('tint_guest_token');
            if (!cancelled) setRevoked(true);
            cancelled = true;
          }
        })
        .finally(() => {
          if (!cancelled) timer = window.setTimeout(check, intervalMs);
        });
    };

    check();
    return () => {
      cancelled = true;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [active, roomId, role, revoked, intervalMs]);

  return { revoked };
}
