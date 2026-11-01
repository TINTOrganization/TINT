/**
 * Detección de quién habla (HU-VOZ-03), en el navegador y sin tráfico al servidor:
 * - el micrófono propio, con el RMS de un `AnalyserNode`;
 * - los demás, con la energía de audio que WebRTC decodifica (`getStats` → `inbound-rtp`
 *   `totalAudioEnergy`/`totalSamplesDuration`). Web Audio sobre pistas remotas no es fiable
 *   en Chromium (sobre todo por TURN: un contexto creado antes de que llegue audio recibe
 *   silencio).
 * Una pequeña máquina de estados con histéresis y retención evita que el resaltado
 * parpadee entre sílabas.
 */

/** Nivel (0..1) a partir del cual se enciende el resaltado. */
export const SPEAKING_ON_LEVEL = 0.06;
/** Por encima de este nivel se mantiene encendido (histéresis). */
export const SPEAKING_OFF_LEVEL = 0.03;
/** Tiempo bajo el umbral antes de apagar el resaltado. */
export const SPEAKING_HOLD_MS = 400;
/** Cada cuánto se muestrea el nivel. */
export const SPEAKING_SAMPLE_MS = 150;

/** Contadores acumulados de `inbound-rtp` (energía y segundos de audio recibidos). */
export interface EnergySample {
  energy: number;
  duration: number;
}

/** Nivel medio (0..1) entre dos lecturas: raíz de la energía media del intervalo. */
export function energyLevel(prev: EnergySample | undefined, cur: EnergySample): number {
  if (!prev) return 0;
  const dEnergy = cur.energy - prev.energy;
  const dDuration = cur.duration - prev.duration;
  // Contadores reiniciados (conexión nueva) o sin audio en el intervalo.
  if (dDuration <= 0 || dEnergy < 0) return 0;
  return Math.sqrt(dEnergy / dDuration);
}

/** RMS de muestras de `getByteTimeDomainData` (centradas en 128) normalizado a 0..1. */
export function rmsLevel(samples: Uint8Array): number {
  if (samples.length === 0) return 0;
  let sum = 0;
  for (const s of samples) {
    const v = (s - 128) / 128;
    sum += v * v;
  }
  return Math.sqrt(sum / samples.length);
}

interface TrackerOptions {
  onLevel?: number;
  offLevel?: number;
  holdMs?: number;
}

export function createSpeakingTracker({
  onLevel = SPEAKING_ON_LEVEL,
  offLevel = SPEAKING_OFF_LEVEL,
  holdMs = SPEAKING_HOLD_MS,
}: TrackerOptions = {}) {
  /** id → última vez (ms) que estuvo sobre el umbral, solo mientras habla. */
  const lastLoud = new Map<string, number>();

  return {
    /** Registra un nivel y devuelve si `id` está hablando. */
    update(id: string, level: number, now: number): boolean {
      const speaking = lastLoud.has(id);
      if (level >= onLevel || (speaking && level >= offLevel)) {
        lastLoud.set(id, now);
        return true;
      }
      if (speaking && now - (lastLoud.get(id) ?? 0) <= holdMs) return true;
      lastLoud.delete(id);
      return false;
    },
    remove(id: string) {
      lastLoud.delete(id);
    },
    speaking(): Set<string> {
      return new Set(lastLoud.keys());
    },
  };
}
