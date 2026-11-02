import { apiFetch, ApiError } from './api';

/** Vídeo de la biblioteca del host (`GET /videos` en identity-api). */
export interface LibraryVideo {
  id: string;
  /** null en vídeos subidos antes de guardar el nombre. */
  title: string | null;
  durationMs: number | null;
  /** Solo llegan `processing` y `ready` (los fallidos no se listan). */
  status: string;
  createdAt: string;
  /** GET firmado (360p si existe) para mostrar un fotograma en la tarjeta. */
  previewUrl: string | null;
}

export async function listVideos(): Promise<LibraryVideo[]> {
  const res = (await apiFetch('/videos', { method: 'GET' }, 'host')) as { videos?: LibraryVideo[] } | null;
  return res?.videos ?? [];
}

/** Pone un vídeo de la biblioteca en la sala; devuelve el `mediaId` para el LOAD. */
export async function assignVideo(roomId: string, videoId: string): Promise<{ mediaId: string; mediaKey?: string }> {
  return (await apiFetch(
    `/rooms/${encodeURIComponent(roomId)}/media`,
    { method: 'PUT', body: JSON.stringify({ videoId }) },
    'host',
  )) as { mediaId: string; mediaKey?: string };
}

export function assignVideoErrorMessage(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.status === 404) return 'Ese vídeo ya no está disponible.';
    if (err.status === 403) return 'No tienes permiso para cambiar el vídeo de esta sala.';
    if (err.status === 410) return 'La sala está cerrada; ya no admite vídeos.';
  }
  return 'No se pudo poner el vídeo. Inténtalo de nuevo.';
}

/** Duración legible: "45 s", "1 min 05 s", "1 h 30 min"; '' si se desconoce. */
export function formatDuration(ms: number | null | undefined): string {
  if (!ms || ms <= 0) return '';
  const total = Math.round(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return m > 0 ? `${h} h ${m} min` : `${h} h`;
  if (m > 0) return `${m} min ${String(s).padStart(2, '0')} s`;
  return `${s} s`;
}

/**
 * Mezcla la lista recién descargada con la que ya se muestra, para refrescar sin recargar las
 * miniaturas: cada `GET /videos` firma URLs nuevas, y si cambiara el `src` de cada `<video>` el
 * navegador volvería a cargarlos (parpadeo y salto de layout cada 5 s). Un vídeo conserva su
 * `previewUrl` mientras su estado no cambie; al pasar a `ready` se adopta la nueva (la 360p). Si
 * no cambió nada más, devuelve la lista anterior (misma referencia) y no se vuelve a pintar.
 */
export function mergeLibrary(prev: LibraryVideo[] | null, next: LibraryVideo[]): LibraryVideo[] {
  if (!prev) return next;
  const before = new Map(prev.map((v) => [v.id, v]));
  const merged = next.map((v) => {
    const old = before.get(v.id);
    return old && old.status === v.status && old.previewUrl && v.previewUrl ? { ...v, previewUrl: old.previewUrl } : v;
  });
  const same =
    merged.length === prev.length &&
    merged.every((v, i) => {
      const old = prev[i];
      return (
        v.id === old.id &&
        v.title === old.title &&
        v.durationMs === old.durationMs &&
        v.status === old.status &&
        v.createdAt === old.createdAt &&
        v.previewUrl === old.previewUrl
      );
    });
  return same ? prev : merged;
}

export function videoStatusLabel(status: string): string {
  return status === 'ready' ? 'Listo' : 'Preparando…';
}

export function videoTitle(video: Pick<LibraryVideo, 'title'>): string {
  return video.title?.trim() || 'Vídeo sin nombre';
}
