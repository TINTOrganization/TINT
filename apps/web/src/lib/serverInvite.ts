export interface RoomDetails {
  code: string;
  roomId: string;
  roomTitle: string | null;
  roomKind?: string;
  hostName?: string | null;
  scheduledStartTime?: string | null;
}

export interface FetchRoomDetailsOptions {
  apiBaseUrl?: string;
  timeoutMs?: number;
  fetchFn?: typeof fetch;
}

const DEFAULT_TIMEOUT_MS = 2500;

function resolveDefaultApiBase(): string {
  // En Node.js bajo SSR preferimos IDENTITY_API_URL o fallback a localhost:8081/api/v1
  if (typeof process !== 'undefined' && process.env) {
    const raw = process.env.IDENTITY_API_URL || (process.env.VITE_IDENTITY_API_URL && /^https?:\/\//i.test(process.env.VITE_IDENTITY_API_URL) ? process.env.VITE_IDENTITY_API_URL : '');
    if (raw) {
      let base = raw.trim().replace(/\/+$/, '');
      if (!base.endsWith('/api/v1')) base += '/api/v1';
      return base;
    }
  }
  return 'http://localhost:8081/api/v1';
}

/**
 * Consulta en el servidor los detalles de una sala a partir de su código de invitación.
 * Falla silenciosamente devolviendo `null` ante cualquier error (404, 410, timeout, fallo de red)
 * para asegurar que el renderizado SSR continúe con metadatos por defecto sin romper la respuesta.
 */
export async function fetchRoomDetails(
  code: string,
  options?: FetchRoomDetailsOptions,
): Promise<RoomDetails | null> {
  const cleanCode = code.trim();
  if (!cleanCode) return null;

  const baseUrl = (options?.apiBaseUrl || resolveDefaultApiBase()).replace(/\/+$/, '');
  const url = `${baseUrl}/invitations/${encodeURIComponent(cleanCode)}`;
  const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const doFetch = options?.fetchFn ?? (typeof fetch !== 'undefined' ? fetch : undefined);

  if (!doFetch) return null;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await doFetch(url, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      signal: controller.signal,
    });

    if (!res.ok) {
      return null;
    }

    const data = (await res.json()) as {
      code?: string;
      roomId?: string;
      roomTitle?: string | null;
      roomKind?: string;
      hostName?: string | null;
      scheduledStartTime?: string | null;
    };

    return {
      code: data.code || cleanCode,
      roomId: data.roomId || '',
      roomTitle: data.roomTitle ?? null,
      roomKind: data.roomKind,
      hostName: data.hostName ?? null,
      scheduledStartTime: data.scheduledStartTime ?? null,
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
