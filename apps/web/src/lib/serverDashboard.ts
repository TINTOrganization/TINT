import type { IncomingMessage } from 'node:http';

export interface DashboardRoom {
  id: string;
  title: string;
  name?: string;
  kind?: string;
  status?: string;
  scheduledStartTime?: string | null;
  nextScheduledEvent?:
    | string
    | {
        id?: string;
        title?: string;
        startTime?: string;
        scheduledStartTime?: string;
      }
    | null;
  invitation?: {
    code: string;
    link: string;
    expiresAt?: string;
  } | null;
}

export interface DashboardData {
  rooms: DashboardRoom[];
  isHost?: boolean;
  role?: 'host' | 'participant';
  error?: string | null;
}

export interface FetchDashboardOptions {
  apiBaseUrl?: string;
  timeoutMs?: number;
  fetchFn?: typeof fetch;
  role?: 'host' | 'participant';
}

const DEFAULT_TIMEOUT_MS = 2500;

function resolveDefaultApiBase(): string {
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

export function formatNextScheduledEvent(
  nextEvent?: DashboardRoom['nextScheduledEvent'],
  scheduledStartTime?: string | null,
): string {
  const eventVal = nextEvent ?? scheduledStartTime;
  if (!eventVal) return '';

  if (typeof eventVal === 'string') {
    const d = new Date(eventVal);
    if (!Number.isNaN(d.getTime())) {
      return d.toLocaleString('es', { dateStyle: 'medium', timeStyle: 'short' });
    }
    return eventVal;
  }

  if (typeof eventVal === 'object' && eventVal !== null) {
    const time = eventVal.startTime || eventVal.scheduledStartTime;
    const formattedTime = time ? formatNextScheduledEvent(time) : '';
    if (eventVal.title && formattedTime) {
      return `${eventVal.title} (${formattedTime})`;
    }
    return eventVal.title || formattedTime || '';
  }

  return '';
}

/**
 * Consulta en el servidor las salas y los eventos programados para el dashboard.
 * Aplica timeout y manejo de fallos para responder de forma resiliente.
 */
export async function fetchDashboardData(
  token?: string,
  options?: FetchDashboardOptions,
): Promise<DashboardData> {
  const isParticipantRole = options?.role === 'participant';

  const baseUrl = (options?.apiBaseUrl || resolveDefaultApiBase()).replace(/\/+$/, '');
  const url = `${baseUrl}/rooms`;
  const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const doFetch =
    options && 'fetchFn' in options
      ? options.fetchFn
      : typeof fetch !== 'undefined'
        ? fetch
        : undefined;

  if (!doFetch) {
    return {
      rooms: [],
      isHost: !isParticipantRole,
      role: options?.role,
      error: 'Entorno sin soporte de fetch.',
    };
  }

  if (!token) {
    return {
      rooms: [],
      isHost: !isParticipantRole,
      role: options?.role,
      error: null,
    };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const headers: Record<string, string> = {
      Accept: 'application/json',
    };
    if (token) {
      headers.Authorization = `Bearer ${token}`;
    }

    const res = await doFetch(url, {
      method: 'GET',
      headers,
      signal: controller.signal,
    });

    if (res.status === 403) {
      return {
        rooms: [],
        isHost: false,
        role: 'participant',
        error: null,
      };
    }

    if (res.status === 401) {
      return {
        rooms: [],
        isHost: false,
        error: 'Sesión no válida o expirada.',
      };
    }

    if (!res.ok) {
      return {
        rooms: [],
        isHost: !isParticipantRole,
        role: options?.role,
        error: 'El servicio de identidad no está disponible en este momento.',
      };
    }

    const data = (await res.json()) as {
      rooms?: Array<Record<string, unknown>>;
    };

    const rawRooms = Array.isArray(data.rooms) ? data.rooms : Array.isArray(data) ? data : [];

    const rooms: DashboardRoom[] = rawRooms.map((r) => {
      const title = String(r.title || r.name || 'Sala sin título');
      const name = String(r.name || r.title || 'Sala sin título');
      const status = typeof r.status === 'string' ? r.status : 'active';
      const scheduledStartTime = typeof r.scheduledStartTime === 'string' ? r.scheduledStartTime : null;
      const nextScheduledEvent = (r.nextScheduledEvent ?? scheduledStartTime ?? null) as DashboardRoom['nextScheduledEvent'];

      return {
        id: String(r.id || ''),
        title,
        name,
        kind: typeof r.kind === 'string' ? r.kind : 'watch',
        status,
        scheduledStartTime,
        nextScheduledEvent,
        invitation: r.invitation as DashboardRoom['invitation'],
      };
    });

    const isHost = isParticipantRole ? false : true;

    return {
      rooms,
      isHost,
      role: options?.role ?? (isHost ? 'host' : 'participant'),
      error: null,
    };
  } catch {
    return {
      rooms: [],
      isHost: !isParticipantRole,
      role: options?.role,
      error: 'El servicio de identidad no está disponible en este momento.',
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Extrae tokens y rol de la cabecera HTTP de la petición entrante.
 */
export function extractAuthFromRequest(req: IncomingMessage): {
  token?: string;
  guestToken?: string;
  role?: 'host' | 'participant';
} {
  let token: string | undefined;
  let guestToken: string | undefined;
  let role: 'host' | 'participant' | undefined;

  const authHeader = req.headers['authorization'];
  if (authHeader && authHeader.startsWith('Bearer ')) {
    token = authHeader.substring(7).trim();
  }

  if (!token && typeof req.headers['x-tint-token'] === 'string') {
    token = req.headers['x-tint-token'].trim();
  }
  if (typeof req.headers['x-tint-guest-token'] === 'string') {
    guestToken = req.headers['x-tint-guest-token'].trim();
  }
  if (typeof req.headers['x-tint-role'] === 'string') {
    const r = req.headers['x-tint-role'].trim().toLowerCase();
    if (r === 'host' || r === 'participant') {
      role = r;
    }
  }

  const cookieHeader = req.headers['cookie'];
  if (cookieHeader) {
    const cookies = cookieHeader.split(';').map((c) => c.trim());
    for (const cookie of cookies) {
      const [key, ...valParts] = cookie.split('=');
      const val = valParts.join('=');
      if (key === 'tint_token' && !token) {
        token = decodeURIComponent(val);
      } else if (key === 'tint_guest_token' && !guestToken) {
        guestToken = decodeURIComponent(val);
      } else if (key === 'tint_role' && !role) {
        const r = decodeURIComponent(val).toLowerCase();
        if (r === 'host' || r === 'participant') role = r;
      }
    }
  }

  const activeToken = token || guestToken;
  if (!role && activeToken) {
    try {
      const parts = activeToken.split('.');
      if (parts.length === 3) {
        const b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
        const payloadStr =
          typeof atob === 'function'
            ? atob(b64)
            : Buffer.from(b64, 'base64').toString('utf-8');
        const payload = JSON.parse(payloadStr) as Record<string, unknown>;
        if (payload.role === 'participant' || payload.role === 'host') {
          role = payload.role;
        } else if (
          typeof payload.sub === 'string' &&
          payload.sub.startsWith('guest:')
        ) {
          role = 'participant';
        }
      }
    } catch {
      // Ignorar fallo de decodificación
    }
  }

  if (!role && guestToken && !token) {
    role = 'participant';
  }

  return { token: token || guestToken, guestToken, role };
}

/**
 * Obtiene los datos iniciales del dashboard inyectados por el servidor SSR para hidratación.
 */
export function getInitialDashboardData(): DashboardData | null {
  if (typeof document === 'undefined') return null;
  const el = document.getElementById('__TINT_DASHBOARD_DATA__');
  if (!el || !el.textContent) return null;
  try {
    return JSON.parse(el.textContent) as DashboardData;
  } catch {
    return null;
  }
}
