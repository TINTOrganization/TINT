import { apiFetch } from './api';
import { errorStatus } from './errorStatus';

/**
 * Tipos de sala (ADR 0019): `watch` (vídeo sincronizado, Canal Sync) o `live` (transmisión del
 * host por stream-core, sin `/ws/sync`). Una sala `live` terminada queda `disabled`.
 */
export type RoomKind = 'watch' | 'live';
export type RoomStatus = 'active' | 'disabled';

/** `kind` del servidor; cualquier otro valor (o ausente: salas viejas) es `watch`. */
export function roomKindOf(value: unknown): RoomKind {
  return value === 'live' ? 'live' : 'watch';
}

export const watchPath = (roomId: string) => `/watch/${encodeURIComponent(roomId)}`;
export const livePath = (roomId: string) => `/live/${encodeURIComponent(roomId)}`;

/** Ruta de la sala según su tipo. */
export function roomPath(room: { id: string; kind?: unknown }): string {
  return roomKindOf(room.kind) === 'live' ? livePath(room.id) : watchPath(room.id);
}

export interface StartedEvent {
  room: { id: string; title?: string; kind?: string };
  invitation: { code: string; link: string; expiresAt: string };
}

/**
 * Crea una sala `live` y la registra en stream-core, social y analytics:
 * `POST /events/start {title, kind:'live'}` → `{room, invitation, sessions}`.
 */
export async function startLiveEvent(title: string): Promise<StartedEvent> {
  return (await apiFetch('/events/start', {
    method: 'POST',
    body: JSON.stringify({ title, kind: 'live' }),
  })) as StartedEvent;
}

export interface EndedRoom {
  room_id: string;
  status: 'disabled';
  reason: string;
  closed_at: string;
}

/**
 * Termina el evento y deshabilita la sala en todos los servicios (HU-LIVE-05):
 * `POST /rooms/{id}/end` → `200 {room_id, status:"disabled", reason:"host_ended", closed_at}`.
 * Un `409 AlreadyDisabled` también cuenta como terminado (el aviso ya salió).
 */
export async function endLiveEvent(roomId: string): Promise<'ended'> {
  try {
    await apiFetch(`/rooms/${encodeURIComponent(roomId)}/end`, { method: 'POST' }, 'host');
  } catch (err) {
    if (errorStatus(err) === 409 && (err as Error).message === 'AlreadyDisabled') return 'ended';
    throw err;
  }
  return 'ended';
}

/** Mensaje para un fallo de `POST /rooms/{id}/end`, sin jerga. */
export function endEventErrorMessage(err: unknown): string {
  const status = errorStatus(err);
  const code = (err as Error | null)?.message;
  if (status === 403) return 'Solo el host dueño de la sala puede terminar el evento.';
  if (status === 404 || status === 410) return 'Esta sala ya no existe.';
  if (status === 409 && code === 'NotLive') return 'Esta sala no es una transmisión; elimínala desde Gestionar.';
  return 'No se pudo terminar el evento. Intenta de nuevo en un momento.';
}
