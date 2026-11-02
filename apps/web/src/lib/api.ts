const API_URL = import.meta.env.VITE_IDENTITY_API_URL || 'http://localhost:8081/api/v1';

export class ApiError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

/**
 * Qué credencial enviar: `auto` (host si existe, si no guest), `host` (solo el token de
 * Firebase `tint_token`) o `guest` (solo `tint_guest_token`, p. ej. el invitado en
 * `GET /rooms/:id/playback` aunque el navegador conserve una sesión de host).
 */
export type ApiAuth = 'auto' | 'host' | 'guest';

/**
 * Devuelve un ID token de Firebase vigente (`forceRefresh` lo renueva aunque no haya
 * caducado) o null si no hay usuario. Lo registra `startHostSession` al arrancar.
 */
export type HostTokenProvider = (forceRefresh: boolean) => Promise<string | null>;

let hostTokenProvider: HostTokenProvider | null = null;

export function setHostTokenProvider(provider: HostTokenProvider | null) {
  hostTokenProvider = provider;
}

/** Ruta de login que vuelve a `pathname + search` tras iniciar sesión. */
export function loginRedirectPath(pathname: string, search = ''): string {
  return `/login?next=${encodeURIComponent(`${pathname}${search}`)}`;
}

/**
 * Por defecto, la sesión de host caducada lleva a /login?next=<ruta actual>. Usa la
 * History API + popstate para que React Router navegue sin recargar la página.
 */
function redirectToLogin() {
  const { pathname, search } = window.location;
  if (pathname.startsWith('/login')) return;
  window.history.pushState(null, '', loginRedirectPath(pathname, search));
  window.dispatchEvent(new PopStateEvent('popstate'));
}

let onHostSessionExpired: () => void = redirectToLogin;

/** Cambia qué pasa cuando la sesión de host ya no es válida (null → redirigir a /login). */
export function setHostSessionExpiredHandler(handler: (() => void) | null) {
  onHostSessionExpired = handler ?? redirectToLogin;
}

/** Pide un token al proveedor; si no hay o falla, null (se sigue con el guardado). */
async function freshHostToken(forceRefresh: boolean): Promise<string | null> {
  if (!hostTokenProvider) return null;
  try {
    const token = await hostTokenProvider(forceRefresh);
    if (token) localStorage.setItem('tint_token', token);
    return token || null;
  } catch {
    return null;
  }
}

interface Bearer {
  token: string | null;
  /** true si es la sesión de host (Firebase), que se puede refrescar. */
  host: boolean;
}

async function bearerFor(auth: ApiAuth): Promise<Bearer> {
  const stored = localStorage.getItem('tint_token');
  const guestToken = localStorage.getItem('tint_guest_token');
  if (auth === 'guest' || (auth === 'auto' && !stored)) {
    return { token: guestToken, host: false };
  }
  // Solo con sesión de host activa: tras cerrar sesión no se revive con Firebase.
  if (!stored) return { token: null, host: false };
  return { token: (await freshHostToken(false)) ?? stored, host: true };
}

export async function apiFetch(path: string, options: RequestInit = {}, auth: ApiAuth = 'auto') {
  const send = (bearer: string | null) => {
    const headers = new Headers(options.headers);
    if (!headers.has('Content-Type') && options.body) {
      headers.set('Content-Type', 'application/json');
    }
    if (bearer) {
      headers.set('Authorization', `Bearer ${bearer}`);
    }
    return fetch(`${API_URL}${path}`, {
      ...options,
      headers,
    });
  };
  const bearer = await bearerFor(auth);
  let res = await send(bearer.token);
  if (res.status === 401 && bearer.host) {
    // El ID token de Firebase dura ~1 h: se fuerza un refresco y se reintenta una vez.
    const renewed = await freshHostToken(true);
    if (renewed) res = await send(renewed);
    if (res.status === 401) {
      // Falla cerrado: la sesión de host ya no sirve.
      localStorage.removeItem('tint_token');
      onHostSessionExpired();
    }
  }
  if (!res.ok) {
    const data = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new ApiError(res.status, data?.error || `API error ${res.status}`);
  }
  return res.json();
}
