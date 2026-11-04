/** Identidad local para display (nick propio, mensajes propios). Solo UI. */

export interface LocalIdentity {
  sub: string;
  nick: string;
  isGuest: boolean;
}

function decodePayload(token: string): Record<string, unknown> | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  try {
    const b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const data: unknown = JSON.parse(atob(b64));
    if (typeof data !== 'object' || data === null) return null;
    return data as Record<string, unknown>;
  } catch {
    return null;
  }
}

function str(v: unknown): string {
  return typeof v === 'string' ? v.trim() : '';
}

/**
 * ¿El guest token sirve para entrar a `roomId`? Debe ser de esa sala (`room_id`) y no
 * haber caducado (`exp`). Sin verificar firma: solo evita abrir la sala con un token que
 * sync-core rechazaría (bucle de reconexión) o con el título de otra sala; quien autoriza
 * sigue siendo el backend.
 */
export function guestTokenGrantsRoom(
  token: string | null,
  roomId: string | undefined,
  now: number = Date.now(),
): boolean {
  if (!token || !roomId) return false;
  const p = decodePayload(token);
  if (!p || str(p.room_id) !== roomId) return false;
  return typeof p.exp === 'number' && p.exp * 1000 > now;
}

/**
 * Lee nick y sub del token con sesión (host manda sobre invitado).
 * Decodifica el payload sin verificar firma: solo para mostrar,
 * nunca para decidir autorización (eso lo hace el backend).
 */
export function getLocalIdentity(): LocalIdentity | null {
  if (typeof window === 'undefined' || typeof localStorage === 'undefined') {
    return null;
  }
  const hostToken = localStorage.getItem('tint_token');
  if (hostToken) {
    const p = decodePayload(hostToken);
    const sub = p ? str(p.sub) : '';
    if (!sub) return null;
    const nick = (p && (str(p.name) || str(p.email))) || 'Host';
    return { sub, nick, isGuest: false };
  }
  const guestToken = localStorage.getItem('tint_guest_token');
  if (guestToken) {
    const p = decodePayload(guestToken);
    const sub = p ? str(p.sub) : '';
    const nick = p ? str(p.nick) : '';
    if (!sub || !nick) return null;
    return { sub, nick, isGuest: true };
  }
  return null;
}
