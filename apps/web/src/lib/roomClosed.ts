import { errorStatus } from './errorStatus';

/**
 * Cierre de sala (ADR 0019, docs/dominio-transmision.md §6.1): una sala `live` terminada queda
 * deshabilitada en todos los servicios. La web lo reconoce por:
 * - el cierre de WebSocket `4010` ROOM_DISABLED (sync, social, voz);
 * - `410 {error:"Disabled"}` de identity-api (claim, playback, sync-ticket…);
 * - `410 {error:"ROOM_DISABLED"}` de stream-core o `stream_state` `ended` por el DataChannel.
 * No se confunde con el `4001` (retirado por el host) ni con el `410 Deleted` (sala eliminada).
 */
export const CLOSE_ROOM_DISABLED = 4010;

export const ROOM_ENDED_TITLE = 'El evento terminó y la sala fue deshabilitada';

/** Texto de apoyo del aviso, según quién lo ve. */
export function roomEndedBody(isHost: boolean): string {
  return isHost
    ? 'La transmisión, el chat y la voz se cerraron para todos. El resumen sigue disponible en el análisis de la sala.'
    : 'Gracias por acompañarnos. El chat, la voz y la transmisión ya se cerraron.';
}

/** ¿Es el `410 {error:"Disabled"}` de identity-api (no el `410 Deleted` de una sala borrada)? */
export function isRoomDisabledError(err: unknown): boolean {
  if (errorStatus(err) !== 410) return false;
  const e = err as { message?: unknown; body?: { error?: unknown } | null };
  return e.message === 'Disabled' || e.body?.error === 'Disabled';
}
