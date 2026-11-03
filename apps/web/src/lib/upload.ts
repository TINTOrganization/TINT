import { apiFetch, ApiError } from './api';

/** Tamaño legible (`2.0 GB`, `3.0 MB`, `1 KB`), el mismo formato en el selector y en los errores. */
export function formatSize(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

/** Mensaje de pre-chequeo: el archivo elegido supera el máximo que informó identity-api. */
export function fileTooLargeMessage(fileBytes: number, maxBytes: number): string {
  return `El archivo pesa ${formatSize(fileBytes)} y el máximo es ${formatSize(maxBytes)}.`;
}

/** Respuesta de `POST /rooms/:id/media/uploads` (identity-api). */
export interface UploadTicket {
  videoId: string;
  /** URL PUT pre-firmada de MinIO. */
  uploadUrl: string;
  storageKey: string;
  expiresAt: string;
  /** Cabeceras que el PUT debe enviar tal cual (firmadas con la URL). */
  headers: Record<string, string>;
}

/** Respuesta de `POST /rooms/:id/media/uploads/:videoId/complete`. */
export interface UploadComplete {
  mediaId: string;
  mediaKey: string;
  status: string;
}

export type UploadErrorKind = 'http' | 'network' | 'abort';

/** Fallo del PUT directo al Blob Storage (no de identity-api). */
export class UploadError extends Error {
  readonly kind: UploadErrorKind;
  /** Estado HTTP de MinIO; 0 si no hubo respuesta. */
  readonly status: number;

  constructor(kind: UploadErrorKind, status: number) {
    super(kind === 'http' ? `Upload failed with status ${status}` : `Upload ${kind}`);
    this.name = 'UploadError';
    this.kind = kind;
    this.status = status;
  }
}

/**
 * Sube `file` con un PUT directo a la URL pre-firmada. Usa XMLHttpRequest para tener
 * progreso de subida (fetch no lo expone). Envía exactamente `headers` (sin
 * `Authorization` ni cookies: la firma va en la URL). `onProgress` recibe un
 * porcentaje entero 0–100.
 */
export function uploadToBlob(
  url: string,
  file: Blob,
  headers: Record<string, string>,
  onProgress?: (percent: number) => void,
  signal?: AbortSignal,
): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new UploadError('abort', 0));
      return;
    }
    const xhr = new XMLHttpRequest();
    const onAbortSignal = () => xhr.abort();
    const settle = (fn: () => void) => {
      signal?.removeEventListener('abort', onAbortSignal);
      fn();
    };

    xhr.open('PUT', url);
    xhr.withCredentials = false;
    for (const [name, value] of Object.entries(headers)) xhr.setRequestHeader(name, value);

    xhr.upload.onprogress = (ev) => {
      if (ev.lengthComputable && ev.total > 0) onProgress?.(Math.round((ev.loaded / ev.total) * 100));
    };
    xhr.onload = () =>
      settle(() =>
        xhr.status >= 200 && xhr.status < 300 ? resolve() : reject(new UploadError('http', xhr.status)),
      );
    xhr.onerror = () => settle(() => reject(new UploadError('network', 0)));
    xhr.onabort = () => settle(() => reject(new UploadError('abort', 0)));

    signal?.addEventListener('abort', onAbortSignal);
    xhr.send(file);
  });
}

/** Paso 1: pide a identity-api la URL pre-firmada para subir `file`. */
export async function requestUpload(roomId: string, file: File): Promise<UploadTicket> {
  const res = (await apiFetch(
    `/rooms/${encodeURIComponent(roomId)}/media/uploads`,
    {
      method: 'POST',
      body: JSON.stringify({ filename: file.name, contentType: file.type, sizeBytes: file.size }),
    },
    'host',
  )) as Partial<UploadTicket> & Pick<UploadTicket, 'videoId' | 'uploadUrl' | 'storageKey' | 'expiresAt'>;
  return { ...res, headers: res.headers ?? { 'Content-Type': file.type } };
}

/**
 * Tamaño máximo de subida (`GET /uploads/limits`, fuente de verdad de identity-api), o null si no
 * se pudo obtener: sin pre-chequeo en la web, el servidor sigue decidiendo (413).
 */
export async function fetchUploadLimit(): Promise<number | null> {
  try {
    const res = (await apiFetch('/uploads/limits', {}, 'host')) as { maxUploadBytes?: unknown } | null;
    const max = res?.maxUploadBytes;
    return typeof max === 'number' && Number.isFinite(max) && max > 0 ? max : null;
  } catch {
    return null;
  }
}

/**
 * Cancela una subida reservada (`DELETE /rooms/:id/media/uploads/:videoId`): borra la fila
 * `pending` y el objeto parcial, para que el reintento empiece limpio. Es un aviso de limpieza:
 * nunca lanza (si no llega, identity-api la limpia al reservar la siguiente subida).
 */
export async function cancelUpload(roomId: string, videoId: string): Promise<void> {
  try {
    await apiFetch(
      `/rooms/${encodeURIComponent(roomId)}/media/uploads/${encodeURIComponent(videoId)}`,
      { method: 'DELETE' },
      'host',
    );
  } catch {
    // La limpieza perezosa de identity-api recoge lo que quede.
  }
}

/** Paso 3: confirma la subida; identity-api asigna el vídeo a la sala y encola el procesamiento. */
export async function completeUpload(roomId: string, videoId: string): Promise<UploadComplete> {
  return (await apiFetch(
    `/rooms/${encodeURIComponent(roomId)}/media/uploads/${encodeURIComponent(videoId)}/complete`,
    { method: 'POST' },
    'host',
  )) as UploadComplete;
}

/** Mensaje simple (sin jerga técnica) para cualquier fallo del flujo de subida. */
export function uploadErrorMessage(err: unknown): string {
  if (err instanceof UploadError) {
    if (err.kind === 'abort') return 'Subida cancelada.';
    if (err.kind === 'network') return 'Se perdió la conexión durante la subida. Inténtalo de nuevo.';
    return 'No se pudo subir el vídeo: el permiso de subida pudo caducar. Inténtalo de nuevo.';
  }
  if (err instanceof ApiError) {
    if (err.status === 413 || /too large/i.test(err.message)) {
      const max = err.body?.maxUploadBytes;
      return typeof max === 'number' && max > 0
        ? `El archivo supera el tamaño máximo permitido (${formatSize(max)}).`
        : 'El archivo supera el tamaño máximo permitido.';
    }
    if (err.status === 409) return 'El vídeo no terminó de llegar; inténtalo de nuevo.';
    if (err.status === 403) return 'No tienes permiso para cambiar el vídeo de esta sala.';
    if (err.status === 404) return 'La sala o la subida no existe.';
    if (err.status === 410) return 'La sala está cerrada; ya no admite vídeos.';
  }
  return 'No se pudo subir el vídeo. Inténtalo de nuevo.';
}
