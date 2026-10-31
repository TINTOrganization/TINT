/** Umbral a partir del cual el cliente se re-alinea con el reloj maestro. */
export const DRIFT_THRESHOLD_MS = 500;

/**
 * Calcula el desfase (ms) entre la posición local y la posición esperada según el
 * estado maestro, compensando el tiempo transcurrido desde que se emitió.
 */
export function computeDrift(
  localPositionMs: number,
  masterPositionMs: number,
  masterUpdatedAtMs: number,
  nowMs: number,
  playing: boolean,
): number {
  const elapsed = playing ? Math.max(0, nowMs - masterUpdatedAtMs) : 0;
  return localPositionMs - (masterPositionMs + elapsed);
}

export function shouldResync(driftMs: number, thresholdMs = DRIFT_THRESHOLD_MS): boolean {
  return Math.abs(driftMs) > thresholdMs;
}

/** Factor sobre la velocidad de la sala para alcanzar al maestro cuando vamos atrasados. */
export const RATE_BEHIND = 1.05;
/** Factor sobre la velocidad de la sala para dejar que el maestro nos alcance. */
export const RATE_AHEAD = 0.95;
/** `HTMLMediaElement.HAVE_FUTURE_DATA`: por debajo, reproduciendo, el vídeo está en buffering. */
export const HAVE_FUTURE_DATA = 3;
/** Un seek de corrección a menos de esto de la posición actual no aporta nada. */
export const SEEK_SKIP_NEAR_MS = 250;
/** Desfase bajo el cual se restaura la velocidad normal. */
export const RATE_RESTORE_TOLERANCE_MS = 100;
/** Duración máxima de una corrección por velocidad. */
export const RATE_MAX_DURATION_MS = 5_000;

/** Corrección ordenada por sync-core (el cálculo autoritativo vive en el servidor). */
export interface Correction {
  target_ms: number;
  strategy: 'rate' | 'seek';
  /** Negativo = cliente atrasado; positivo = adelantado. */
  drift_ms: number;
  /** Velocidad de la sala en esa `version` (no la de corrección), si el servidor la envía. */
  rate?: number;
}

export type CorrectionAction =
  | { kind: 'seek'; seconds: number }
  | { kind: 'rate'; playbackRate: number };

/**
 * Acción para una corrección. La de velocidad es relativa a la de la sala (`roomRate`):
 * a 2× se acelera a 2.1 y se frena a 1.9, no a 1.05/0.95 absolutos.
 */
export function correctionAction(correction: Correction, roomRate = 1): CorrectionAction {
  if (correction.strategy === 'seek') {
    return { kind: 'seek', seconds: correction.target_ms / 1000 };
  }
  const base = Number.isFinite(roomRate) && roomRate > 0 ? roomRate : 1;
  const factor = correction.drift_ms < 0 ? RATE_BEHIND : correction.drift_ms > 0 ? RATE_AHEAD : 1;
  return { kind: 'rate', playbackRate: factor === 1 ? base : base * factor };
}

/** Aplica la corrección sobre el vídeo (o cualquier objeto con la misma forma). */
export function applyCorrection(
  video: Pick<HTMLMediaElement, 'currentTime' | 'playbackRate'>,
  correction: Correction,
  roomRate = 1,
): CorrectionAction {
  const action = correctionAction(correction, roomRate);
  if (action.kind === 'seek') {
    video.currentTime = action.seconds;
  } else {
    video.playbackRate = action.playbackRate;
  }
  return action;
}

/**
 * Indica si una corrección por velocidad debe terminar: el desfase ya es < 100 ms o
 * se alcanzó la duración máxima. Sin posición esperada solo cuenta el tiempo.
 */
export function shouldRestoreRate(
  localPositionMs: number,
  expectedPositionMs: number | null,
  elapsedMs: number,
): boolean {
  if (elapsedMs >= RATE_MAX_DURATION_MS) return true;
  if (expectedPositionMs === null) return false;
  return Math.abs(localPositionMs - expectedPositionMs) < RATE_RESTORE_TOLERANCE_MS;
}

/**
 * Indica si conviene omitir un seek de corrección: el vídeo reproduce sin datos suficientes
 * (buffering: otro seek solo vaciaría el búfer), el autoplay está bloqueado (`blocked`: se
 * espera el gesto, que re-aplica el estado), el vídeo terminó y el objetivo está en o tras el
 * final, o ya está a menos de `SEEK_SKIP_NEAR_MS` del objetivo. Las de velocidad no se omiten.
 */
export function shouldSkipSeekCorrection(
  video: Pick<HTMLMediaElement, 'readyState' | 'paused' | 'ended' | 'duration' | 'currentTime'>,
  targetMs: number,
  blocked: boolean,
): boolean {
  if (blocked) return true;
  if (!video.paused && video.readyState < HAVE_FUTURE_DATA) return true;
  if (video.ended && Number.isFinite(video.duration) && targetMs >= video.duration * 1000) return true;
  return Math.abs(video.currentTime * 1000 - targetMs) < SEEK_SKIP_NEAR_MS;
}
