import { useCallback, useEffect, useRef, useState } from 'react';
import { apiFetch } from '../lib/api';
import { errorStatus } from '../lib/errorStatus';
import { normalizeQualities, type PlaybackQuality } from '../lib/quality';

/** Refresca la URL firmada este tiempo antes de `expiresAt`. */
export const PLAYBACK_REFRESH_LEAD_MS = 60_000;
/** Espera mínima entre refrescos (evita bucles si el servidor da URLs casi vencidas). */
export const PLAYBACK_MIN_REFRESH_MS = 5_000;
/** Intervalo de re-consulta mientras media-worker procesa el vídeo. */
export const PLAYBACK_PROCESSING_POLL_MS = 5_000;
/** Máximo de re-consultas por vídeo (~10 min con el intervalo por defecto). */
export const PLAYBACK_MAX_PROCESSING_POLLS = 120;
/**
 * Espera mínima entre dos `recover()` que piden una URL nueva: un archivo dañado fallaría
 * siempre y no debe provocar un bucle de peticiones.
 */
export const PLAYBACK_RECOVER_COOLDOWN_MS = 30_000;

/** Estado del procesamiento del vídeo (null: asignado por clave, sin fila de vídeo). */
export type MediaStatus = 'pending' | 'processing' | 'ready' | 'failed';

const MEDIA_STATUSES: readonly string[] = ['pending', 'processing', 'ready', 'failed'];

function toMediaStatus(value: unknown): MediaStatus | null {
  return typeof value === 'string' && MEDIA_STATUSES.includes(value) ? (value as MediaStatus) : null;
}

const isProcessing = (status: MediaStatus | null) => status === 'pending' || status === 'processing';

export interface UseRoomPlaybackOptions {
  /** Credencial con la que se pide (host → Firebase, guest → tint_guest_token). */
  role?: 'host' | 'guest';
  enabled?: boolean;
  refreshLeadMs?: number;
  processingPollMs?: number;
  maxProcessingPolls?: number;
}

export interface RoomPlayback {
  url: string | null;
  mediaId: string | null;
  expiresAt: string | null;
  status: MediaStatus | null;
  /** URL firmada de ambilight.json; solo cuando status = ready. */
  ambilightUrl: string | null;
  /** Versiones disponibles (original + transcodificaciones); [] sin vídeo. */
  qualities: PlaybackQuality[];
  loading: boolean;
  error: string | null;
  /** El invitado recibió 401/403: su invitación ya no vale (se borra `tint_guest_token`). */
  revoked: boolean;
  /**
   * El `<video>` falló (p. ej. URL firmada caducada): adopta las URLs refrescadas si las hay
   * o pide unas nuevas (como mucho una vez cada `PLAYBACK_RECOVER_COOLDOWN_MS`). Estable.
   */
  recover: () => void;
  /** Adopta las URLs refrescadas si las hay (p. ej. al cambiar de calidad); si no, nada. Estable. */
  adoptFresh: () => void;
}

interface PlaybackResponse {
  mediaId?: string | null;
  url?: string | null;
  expiresAt?: string | null;
  status?: string | null;
  ambilightUrl?: string | null;
  qualities?: unknown;
}

interface PlaybackData {
  url: string | null;
  mediaId: string | null;
  expiresAt: string | null;
  status: MediaStatus | null;
  ambilightUrl: string | null;
  qualities: PlaybackQuality[];
}

const EMPTY: PlaybackData = { url: null, mediaId: null, expiresAt: null, status: null, ambilightUrl: null, qualities: [] };

function toPlaybackData(res: PlaybackResponse | undefined): PlaybackData {
  return {
    mediaId: res?.mediaId ?? null,
    url: res?.url ?? null,
    expiresAt: res?.expiresAt ?? null,
    status: toMediaStatus(res?.status),
    ambilightUrl: res?.ambilightUrl ?? null,
    // identity-api sin `qualities` (versión previa) → solo el original.
    qualities: normalizeQualities(res?.qualities, res?.url ?? null),
  };
}

/**
 * Calidades de una re-consulta conservando las URLs ya aplicadas (solo se suman las
 * versiones nuevas): si cambiaran, el reproductor recargaría el `src` sin necesidad.
 */
function keepAppliedUrls(next: PlaybackQuality[], applied: PlaybackQuality[]): PlaybackQuality[] {
  return next.map((q) => {
    const current = applied.find((a) => a.id === q.id);
    return current ? { ...q, url: current.url } : q;
  });
}

/**
 * Vídeo asignado a la sala (contrato v2 §9: `GET /rooms/:id/playback`).
 *
 * `syncMediaId` es el `media_id` del estado sync (undefined antes del primer STATE,
 * '' si la sala no tiene vídeo). Se vuelve a pedir cuando cambia respecto al vídeo
 * cargado.
 *
 * ~1 min antes de que caduque la URL firmada se pide otra, pero si es el mismo vídeo **no**
 * se cambia el `src` (recargaría el `<video>`: fotograma negro cada hora): las URLs nuevas
 * quedan guardadas aparte y se adoptan con `recover()` (el `<video>` falló, p. ej. URL
 * caducada) o `adoptFresh()` (el reproductor va a cambiar de `src` igualmente).
 *
 * Mientras el vídeo está `pending`/`processing` (media-worker) se re-consulta cada ~5 s
 * hasta `ready`/`failed` o un máximo de intentos; esas re-consultas solo actualizan
 * `status`/`ambilightUrl` y suman las calidades nuevas sin cambiar el `src` (el original ya
 * es reproducible); las URLs publicadas por el worker también quedan para `recover()`.
 */
export function useRoomPlayback(
  roomId: string,
  syncMediaId: string | undefined,
  {
    role = 'host',
    enabled = true,
    refreshLeadMs = PLAYBACK_REFRESH_LEAD_MS,
    processingPollMs = PLAYBACK_PROCESSING_POLL_MS,
    maxProcessingPolls = PLAYBACK_MAX_PROCESSING_POLLS,
  }: UseRoomPlaybackOptions = {},
): RoomPlayback {
  const [data, setData] = useState<PlaybackData>(EMPTY);
  const [loading, setLoading] = useState(enabled);
  const [error, setError] = useState<string | null>(null);
  const [revoked, setRevoked] = useState(false);

  const requestRef = useRef(0);
  const pollRequestRef = useRef(0);
  const [pollTick, setPollTick] = useState(0);
  const pollsRef = useRef<{ mediaId: string | null; count: number }>({ mediaId: null, count: 0 });
  /** media_id del último vídeo obtenido ('' = sin vídeo; undefined = nada aún). */
  const loadedRef = useRef<string | undefined>(undefined);
  /** URLs más nuevas del vídeo cargado que aún no se aplicaron al `<video>`. */
  const freshRef = useRef<PlaybackData | null>(null);
  /** Caducidad de la URL más nueva conocida (aplicada o no): programa el próximo refresco. */
  const [refreshBase, setRefreshBase] = useState<string | null>(null);
  const lastRecoverRef = useRef(Number.NEGATIVE_INFINITY);

  const setFresh = useCallback((next: PlaybackData) => {
    freshRef.current = next;
    setRefreshBase(next.expiresAt);
  }, []);

  /** Aplica una respuesta completa (primera carga, otro vídeo o recuperación). */
  const adopt = useCallback((next: PlaybackData) => {
    loadedRef.current = next.mediaId ?? '';
    freshRef.current = null;
    setRefreshBase(next.expiresAt);
    setData(next);
  }, []);

  /**
   * `mode`: 'load' (carga visible: primera vez u otro vídeo), 'refresh' (silenciosa: si es el
   * mismo vídeo guarda las URLs aparte) o 'recover' (silenciosa y las adopta).
   */
  const fetchPlayback = useCallback(
    (mode: 'load' | 'refresh' | 'recover') => {
      const id = ++requestRef.current;
      pollRequestRef.current += 1; // una carga completa manda sobre cualquier re-consulta en vuelo
      if (mode === 'load') setLoading(true);
      apiFetch(`/rooms/${encodeURIComponent(roomId)}/playback`, { method: 'GET' }, role)
        .then((res: PlaybackResponse) => {
          if (id !== requestRef.current) return;
          const next = toPlaybackData(res);
          const sameMedia = (next.mediaId ?? '') === loadedRef.current;
          if (mode === 'refresh' && sameMedia && next.url) {
            setFresh(next);
            setData((prev) => ({
              ...prev,
              status: next.status,
              ambilightUrl: next.ambilightUrl,
              qualities: keepAppliedUrls(next.qualities, prev.qualities),
            }));
          } else {
            adopt(next);
          }
          setError(null);
          setLoading(false);
        })
        .catch((err: unknown) => {
          if (id !== requestRef.current) return;
          const status = errorStatus(err);
          if (role === 'guest' && (status === 401 || status === 403)) {
            // Invitación revocada o caducada (p. ej. retirado con la pestaña cerrada):
            // sync-core rechazaría el socket para siempre, así que se deja de intentar.
            localStorage.removeItem('tint_guest_token');
            setRevoked(true);
          }
          setError('No se pudo cargar el vídeo de la sala.');
          setLoading(false);
        });
    },
    [roomId, role, adopt, setFresh],
  );

  const load = useCallback(() => fetchPlayback('load'), [fetchPlayback]);
  const refresh = useCallback(() => fetchPlayback('refresh'), [fetchPlayback]);

  const takeFresh = useCallback((): boolean => {
    const fresh = freshRef.current;
    if (!fresh) return false;
    freshRef.current = null;
    setData(fresh);
    return true;
  }, []);

  const adoptFresh = useCallback(() => {
    takeFresh();
  }, [takeFresh]);

  const recover = useCallback(() => {
    if (takeFresh()) return;
    const now = Date.now();
    if (now - lastRecoverRef.current < PLAYBACK_RECOVER_COOLDOWN_MS) return;
    lastRecoverRef.current = now;
    fetchPlayback('recover');
  }, [takeFresh, fetchPlayback]);

  /** Re-consulta silenciosa del estado de procesamiento. */
  const poll = useCallback(() => {
    const id = ++pollRequestRef.current;
    apiFetch(`/rooms/${encodeURIComponent(roomId)}/playback`, { method: 'GET' }, role)
      .then((res: PlaybackResponse) => {
        if (id !== pollRequestRef.current) return;
        const next = toPlaybackData(res);
        if ((next.mediaId ?? '') === loadedRef.current) {
          // La URL no cambia mientras se procesa (no se corta la reproducción), salvo si
          // el worker rechazó el vídeo: identity-api ya no lo sirve (url null). Las URLs
          // publicadas (p. ej. `{id}/source.*` al pasar a ready) quedan para recover().
          if (next.status === 'failed') freshRef.current = null;
          else if (next.url) setFresh(next);
          setData((prev) =>
            next.status === 'failed'
              ? { ...prev, status: next.status, ambilightUrl: null, url: null, expiresAt: null, qualities: [] }
              : {
                  ...prev,
                  status: next.status,
                  ambilightUrl: next.ambilightUrl,
                  qualities: keepAppliedUrls(next.qualities, prev.qualities),
                },
          );
        } else {
          // La sala cambió de vídeo entretanto: se adopta la respuesta completa.
          adopt(next);
        }
        setPollTick((t) => t + 1);
      })
      .catch(() => {
        if (id !== pollRequestRef.current) return;
        setPollTick((t) => t + 1);
      });
  }, [roomId, role, adopt, setFresh]);

  // Nueva sala / credencial: se olvida lo cargado.
  useEffect(() => {
    loadedRef.current = undefined;
    freshRef.current = null;
    return () => {
      requestRef.current += 1;
      pollRequestRef.current += 1;
    };
  }, [roomId, role]);

  useEffect(() => {
    if (!enabled) {
      setLoading(false);
      return;
    }
    if (loadedRef.current !== undefined) {
      // Ya hay vídeo: solo se re-pide si el estado sync anuncia otro.
      if (syncMediaId === undefined || syncMediaId === loadedRef.current) return;
    }
    load();
  }, [enabled, syncMediaId, load]);

  // Refresco antes de que caduque la URL firmada más nueva (sin cambiar el `src`).
  useEffect(() => {
    if (!enabled || !refreshBase) return;
    const expiresAt = Date.parse(refreshBase);
    if (Number.isNaN(expiresAt)) return;
    const delay = Math.max(PLAYBACK_MIN_REFRESH_MS, expiresAt - Date.now() - refreshLeadMs);
    const timer = setTimeout(refresh, delay);
    return () => clearTimeout(timer);
  }, [enabled, refreshBase, refreshLeadMs, refresh]);

  // Re-consulta mientras media-worker procesa el vídeo.
  useEffect(() => {
    if (!enabled || !isProcessing(data.status)) return;
    if (pollsRef.current.mediaId !== data.mediaId) pollsRef.current = { mediaId: data.mediaId, count: 0 };
    if (pollsRef.current.count >= maxProcessingPolls) return;
    const timer = setTimeout(() => {
      pollsRef.current.count += 1;
      poll();
    }, processingPollMs);
    return () => clearTimeout(timer);
  }, [enabled, data.status, data.mediaId, pollTick, poll, processingPollMs, maxProcessingPolls]);

  return { ...data, loading, error, revoked, recover, adoptFresh };
}
