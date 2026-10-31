import { useEffect, useRef, useState, type RefObject } from 'react';
import { colorsAt, parseAmbilight, type AmbilightColors, type AmbilightFrame } from '../lib/ambilight';

export interface UseAmbilightOptions {
  enabled?: boolean;
  /** false → salta de frame en frame (p. ej. con `prefers-reduced-motion`). */
  interpolate?: boolean;
}

interface LoadedPalette {
  /** URL sin la firma: identifica el vídeo aunque la URL se refirme. */
  key: string;
  frames: AmbilightFrame[];
}

const paletteKey = (url: string) => url.split('?')[0];

/**
 * Intervalo de muestreo (~4 Hz). La transición CSS de `AmbilightGlow` dura 700 ms, así que
 * muestrear en cada fotograma solo provocaba ~60 renders/s sin diferencia visible.
 */
export const AMBILIGHT_SAMPLE_MS = 250;

/**
 * Colores de borde del vídeo en el instante actual a partir de la paleta ya extraída por el
 * procesado del vídeo (`ambilightUrl`): descarga el JSON una vez por vídeo y cada
 * `AMBILIGHT_SAMPLE_MS` busca el frame por `videoRef.current.currentTime`. Solo actualiza el
 * estado cuando el color cambia. Sin URL, desactivado o si falla: `null`.
 */
export function useAmbilight(
  url: string | null,
  videoRef: RefObject<HTMLVideoElement>,
  { enabled = true, interpolate = true }: UseAmbilightOptions = {},
): AmbilightColors | null {
  const [palette, setPalette] = useState<LoadedPalette | null>(null);
  const [colors, setColors] = useState<AmbilightColors | null>(null);
  const urlRef = useRef(url);
  const key = url ? paletteKey(url) : null;
  const loadedKey = palette?.key ?? null;

  useEffect(() => {
    urlRef.current = url;
  });

  useEffect(() => {
    const current = urlRef.current;
    if (!enabled || !key || !current || loadedKey === key) return;
    const controller = new AbortController();
    fetch(current, { signal: controller.signal })
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error(`HTTP ${res.status}`))))
      .then((json: unknown) => setPalette({ key, frames: parseAmbilight(json) }))
      .catch(() => {
        if (!controller.signal.aborted) setPalette({ key, frames: [] });
      });
    return () => controller.abort();
  }, [key, enabled, loadedKey]);

  const frames = palette && palette.key === key ? palette.frames : null;
  const active = enabled && !!frames && frames.length > 0;

  useEffect(() => {
    if (!active || !frames) return;
    let last = '';
    const sample = () => {
      const video = videoRef.current;
      if (!video) return;
      const next = colorsAt(frames, video.currentTime * 1000, interpolate);
      const signature = next ? `${next.top}${next.right}${next.bottom}${next.left}` : '';
      if (next && signature !== last) {
        last = signature;
        setColors(next);
      }
    };
    sample();
    const id = setInterval(sample, AMBILIGHT_SAMPLE_MS);
    return () => clearInterval(id);
  }, [active, frames, interpolate, videoRef]);

  return active ? colors : null;
}
