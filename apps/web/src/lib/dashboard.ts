import { formatScheduledTime } from './invite';

export interface DashboardScheduledEvent {
  id?: string;
  title?: string;
  name?: string;
  scheduledStartTime?: string | null;
  startTime?: string | null;
  date?: string | null;
  roomId?: string | null;
  [key: string]: unknown;
}

export interface DashboardRoom {
  id: string;
  title: string;
  name?: string;
  status: 'active' | 'disabled' | string;
  invitation?: {
    code: string;
    link: string;
    expiresAt: string;
  } | null;
  nextScheduledEvent?: DashboardScheduledEvent | string | null;
  scheduledEvents?: DashboardScheduledEvent[];
  scheduledStartTime?: string | null;
  [key: string]: unknown;
}

export interface DashboardUser {
  id?: string;
  email?: string;
  displayName?: string;
  nick?: string;
  role?: string;
  isHost?: boolean;
}

export interface DashboardFetchResult {
  rooms: DashboardRoom[];
  user?: DashboardUser | null;
  role: string;
  isHost: boolean;
  error: string | null;
  valid: boolean;
}

export interface FetchDashboardOptions {
  apiUrl?: string;
  fetcher?: typeof fetch | null;
  timeoutMs?: number;
  token?: string | null;
  role?: string;
  isHost?: boolean;
}

/** Formatea el próximo evento programado de una sala para mostrarlo en la interfaz. */
export function formatNextScheduledEvent(
  event: DashboardScheduledEvent | string | null | undefined,
): string | null {
  if (!event) return null;
  if (typeof event === 'string') {
    const trimmed = event.trim();
    if (!trimmed) return null;
    if (trimmed.includes('T') || /^\d{4}-\d{2}-\d{2}/.test(trimmed)) {
      const formatted = formatScheduledTime(trimmed);
      return formatted || trimmed;
    }
    return trimmed;
  }
  const title = (event.title || event.name || '').trim();
  const timeStr = (event.scheduledStartTime || event.startTime || event.date || '') as string;
  const formattedTime = timeStr ? formatScheduledTime(timeStr) : '';

  if (title && formattedTime) {
    return `${title} — ${formattedTime}`;
  }
  if (title) return title;
  if (formattedTime) return formattedTime;
  return null;
}

/**
 * Consulta las salas y eventos programados para el dashboard SSR del host.
 * Maneja timeouts y fallas del upstream identity-api de forma defensiva para
 * renderizar un mensaje claro en la UI en vez de una pantalla en blanco o caída 500.
 */
export async function fetchDashboardData(
  options?: FetchDashboardOptions,
): Promise<DashboardFetchResult> {
  const baseUrl =
    options?.apiUrl ||
    (typeof process !== 'undefined' &&
      (process.env.VITE_IDENTITY_API_URL || process.env.IDENTITY_API_URL)) ||
    'http://localhost:8081/api/v1';

  const defaultIsHost = options?.isHost ?? (options?.role !== 'participant');
  const defaultRole = options?.role ?? (defaultIsHost ? 'host' : 'participant');

  const fetchFn =
    options?.fetcher !== undefined
      ? options.fetcher
      : typeof fetch !== 'undefined'
        ? fetch
        : null;

  if (!fetchFn) {
    return {
      rooms: [],
      role: defaultRole,
      isHost: defaultIsHost,
      error: 'No se pudo inicializar la conexión con el servicio de identidad.',
      valid: false,
    };
  }

  const timeoutMs = options?.timeoutMs ?? 3000;
  const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;

  try {
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (options?.token) {
      headers['Authorization'] = `Bearer ${options.token}`;
    }

    const roomsUrl = `${baseUrl.replace(/\/+$/, '')}/rooms`;
    const res = await fetchFn(roomsUrl, {
      method: 'GET',
      headers,
      signal: controller?.signal,
    });

    if (!res.ok) {
      const errBody = (await res.json().catch(() => null)) as { error?: string } | null;
      const errorMsg =
        errBody?.error || `El servicio de identidad no está disponible (código ${res.status}).`;
      return {
        rooms: [],
        role: defaultRole,
        isHost: defaultIsHost,
        error: errorMsg,
        valid: false,
      };
    }

    const data = (await res.json()) as {
      rooms?: DashboardRoom[];
      events?: DashboardScheduledEvent[];
      scheduledEvents?: DashboardScheduledEvent[];
      user?: DashboardUser;
      role?: string;
      isHost?: boolean;
    } | DashboardRoom[];

    let rawRooms: DashboardRoom[] = [];
    let eventsList: DashboardScheduledEvent[] = [];

    if (Array.isArray(data)) {
      rawRooms = data;
    } else if (data && typeof data === 'object') {
      rawRooms = Array.isArray(data.rooms) ? data.rooms : [];
      if (Array.isArray(data.events)) eventsList = data.events;
      if (Array.isArray(data.scheduledEvents)) eventsList = [...eventsList, ...data.scheduledEvents];
    }

    // Intento opcional y no bloqueante para consultar /events si la lista vino vacía
    if (eventsList.length === 0) {
      try {
        const eventsRes = await fetchFn(`${baseUrl.replace(/\/+$/, '')}/events`, {
          method: 'GET',
          headers,
          signal: controller?.signal,
        });
        if (eventsRes.ok) {
          const eventsData = (await eventsRes.json().catch(() => null)) as
            | { events?: DashboardScheduledEvent[] }
            | DashboardScheduledEvent[]
            | null;
          if (Array.isArray(eventsData)) {
            eventsList = eventsData;
          } else if (eventsData && Array.isArray(eventsData.events)) {
            eventsList = eventsData.events;
          }
        }
      } catch {
        // Ignorar fallo de ruta opcional /events
      }
    }

    const rooms: DashboardRoom[] = rawRooms.map((r) => {
      let nextScheduledEvent = r.nextScheduledEvent ?? null;
      if (!nextScheduledEvent && eventsList.length > 0) {
        const match = eventsList.find((e) => e.roomId === r.id);
        if (match) nextScheduledEvent = match;
      }
      if (!nextScheduledEvent && r.scheduledEvents && r.scheduledEvents.length > 0) {
        nextScheduledEvent = r.scheduledEvents[0];
      }
      if (!nextScheduledEvent && r.scheduledStartTime) {
        nextScheduledEvent = { scheduledStartTime: r.scheduledStartTime };
      }

      return {
        ...r,
        title: r.title || r.name || 'Sala sin nombre',
        status: r.status === 'disabled' ? 'disabled' : 'active',
        nextScheduledEvent,
      };
    });

    let isHost = defaultIsHost;
    let role = defaultRole;

    if (options?.isHost !== undefined) {
      isHost = options.isHost;
      role = isHost ? 'host' : 'participant';
    } else if (options?.role !== undefined) {
      role = options.role;
      isHost = role !== 'participant';
    } else if (!Array.isArray(data) && data && (data.isHost !== undefined || data.role !== undefined)) {
      isHost = data.isHost ?? (data.role !== 'participant');
      role = data.role ?? (isHost ? 'host' : 'participant');
    }

    return {
      rooms,
      role,
      isHost,
      error: null,
      valid: true,
    };
  } catch (err: unknown) {
    const isTimeout =
      (err instanceof Error && err.name === 'AbortError') ||
      (typeof err === 'object' && err !== null && 'name' in err && (err as { name?: unknown }).name === 'AbortError');

    const error = isTimeout
      ? 'El servicio de identidad tardó demasiado en responder (tiempo de espera agotado).'
      : 'No se pudo conectar con el servicio de identidad. Servicio no disponible.';

    return {
      rooms: [],
      role: defaultRole,
      isHost: defaultIsHost,
      error,
      valid: false,
    };
  } finally {
    if (timer) clearTimeout(timer);
  }
}
