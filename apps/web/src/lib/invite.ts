import { ApiError } from './api';
import { isRoomDisabledError } from './roomClosed';

/**
 * Convierte el link relativo que devuelve identity-api (`/invite/:code`)
 * en una URL absoluta que funciona al pegarla en cualquier navegador.
 * Los links ya absolutos se devuelven intactos.
 */
export function toAbsoluteInviteLink(link: string): string {
  if (!link) return link;
  if (/^https?:\/\//i.test(link)) return link;
  const origin = typeof window !== 'undefined' && window.location?.origin ? window.location.origin : '';
  return `${origin}${link.startsWith('/') ? link : `/${link}`}`;
}

/**
 * Traduce los errores de `POST /invitations/claim` a mensajes
 * comprensibles: la sala pudo ser eliminada (borrado lógico),
 * el link pudo expirar o ser revocado por el host.
 */
export function inviteClaimErrorMessage(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.status === 403 && err.message === 'BANNED') return 'El host te bloqueó en esta sala';
    // 410 Disabled (ADR 0019): la sala live terminó; no es lo mismo que una sala borrada.
    if (isRoomDisabledError(err)) return 'El evento terminó y la sala fue deshabilitada.';
    if (err.status === 410) return 'Esta invitación expiró o la sala fue eliminada.';
    if (err.status === 404) return 'Esta invitación no existe o la sala fue eliminada.';
    if (err.status === 409) return 'Esta invitación fue revocada por el host.';
  }
  return err instanceof Error ? err.message : 'No se pudo unir a la sala';
}

/**
 * Invitación tal como la devuelve el backend (campos extra tolerados).
 */
export interface RoomInvitationLike {
  code: string;
  link: string;
  expiresAt: string;
  createdAt?: string;
  revoked?: boolean;
}

/**
 * Elige la invitación vigente más reciente de una lista.
 * Vigente = no revocada y sin expirar; desempata por createdAt descendente
 * (las que no traen createdAt se consideran las más viejas).
 * Retorna null si no hay ninguna vigente.
 */
export function pickLatestActiveInvitation(
  list: RoomInvitationLike[] | null | undefined,
  now: Date = new Date(),
): RoomInvitationLike | null {
  if (!list || list.length === 0) return null;
  const nowMs = now.getTime();
  let latest: RoomInvitationLike | null = null;
  let latestMs = -Infinity;
  for (const inv of list) {
    if (!inv || inv.revoked) continue;
    if (!inv.expiresAt || Number.isNaN(Date.parse(inv.expiresAt))) continue;
    if (Date.parse(inv.expiresAt) <= nowMs) continue;
    const createdMs = inv.createdAt && !Number.isNaN(Date.parse(inv.createdAt)) ? Date.parse(inv.createdAt) : -Infinity;
    if (latest === null || createdMs > latestMs) {
      latest = inv;
      latestMs = createdMs;
    }
  }
  return latest;
}

/**
 * Extrae el código de invitación de un link absoluto, una ruta
 * relativa o el código pelado. Retorna null si no es válido.
 */
export function parseInviteCode(input: string): string | null {
  const value = input.trim();
  if (!value) return null;
  const fromPath = value.match(/\/invite\/([A-Za-z0-9_-]+)/);
  if (fromPath) return fromPath[1];
  if (/^[A-Za-z0-9_-]{6,32}$/.test(value)) return value;
  return null;
}

/**
 * Detalles de la sala obtenidos para una invitación, usados tanto en SSR
 * para inyectar meta tags dinámicos como en hidratación inicial.
 */
export interface InviteRoomDetails {
  code: string;
  roomTitle: string | null;
  roomId: string | null;
  expiresAt: string | null;
  valid: boolean;
}

/**
 * Consulta los datos de la sala asociada a un código de invitación.
 * Es defensivo: ante 404, expiración, error de red o timeout retorna valid=false
 * sin lanzar excepciones, garantizando que el servidor SSR siempre pueda responder.
 */
export async function fetchInviteRoomDetails(
  code: string,
  options?: {
    apiUrl?: string;
    fetcher?: typeof fetch | null;
    timeoutMs?: number;
  },
): Promise<InviteRoomDetails> {
  const cleanCode = parseInviteCode(code) ?? code.trim();
  const baseUrl =
    options?.apiUrl ||
    (typeof process !== 'undefined' && (process.env.VITE_IDENTITY_API_URL || process.env.IDENTITY_API_URL)) ||
    'http://localhost:8081/api/v1';

  const fetchFn = options?.fetcher !== undefined ? options.fetcher : (typeof fetch !== 'undefined' ? fetch : null);
  if (!fetchFn) {
    return { code: cleanCode, roomTitle: null, roomId: null, expiresAt: null, valid: false };
  }

  const timeoutMs = options?.timeoutMs ?? 3000;
  const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;

  try {
    const res = await fetchFn(`${baseUrl.replace(/\/+$/, '')}/invitations/${cleanCode}`, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      signal: controller?.signal,
    });

    if (!res.ok) {
      return { code: cleanCode, roomTitle: null, roomId: null, expiresAt: null, valid: false };
    }

    const data = (await res.json()) as {
      roomTitle?: string | null;
      roomId?: string | null;
      expiresAt?: string | null;
    };

    return {
      code: cleanCode,
      roomTitle: data.roomTitle ?? null,
      roomId: data.roomId ?? null,
      expiresAt: data.expiresAt ?? null,
      valid: true,
    };
  } catch {
    return { code: cleanCode, roomTitle: null, roomId: null, expiresAt: null, valid: false };
  } finally {
    if (timer) clearTimeout(timer);
  }
}
