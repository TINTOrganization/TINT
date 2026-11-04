import { useState, type CSSProperties, type ReactNode, type RefObject } from 'react';
import { useAmbilight } from '../../hooks/useAmbilight';
import { readStored, writeStored } from '../../lib/safeStorage';

/** Preferencia por navegador: 'off' apaga el brillo (por defecto encendido). */
export const AMBILIGHT_PREF_KEY = 'tint_ambilight';

export interface AmbilightGlowProps {
  /** Paleta del vídeo (`useRoomPlayback().ambilightUrl`); sin ella no hay brillo. */
  url: string | null;
  videoRef: RefObject<HTMLVideoElement>;
  /** El reproductor, que queda por encima del brillo. */
  children: ReactNode;
}

const prefersReducedMotion = () =>
  typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    ? !!window.matchMedia('(prefers-reduced-motion: reduce)')?.matches
    : false;

/** Máscara radial: cada lado es una mancha difuminada que se apaga hacia sus bordes. */
const SOFT_MASK = 'radial-gradient(closest-side, #000 0%, rgba(0, 0, 0, 0.55) 55%, transparent 100%)';

const SIDES = [
  { side: 'top', className: 'left-[6%] right-[6%] top-0 h-[34%]' },
  { side: 'bottom', className: 'bottom-0 left-[6%] right-[6%] h-[34%]' },
  { side: 'left', className: 'bottom-[8%] left-0 top-[8%] w-[26%]' },
  { side: 'right', className: 'bottom-[8%] right-0 top-[8%] w-[26%]' },
] as const;

/**
 * Brillo ambiental detrás del reproductor con los colores de borde del fotograma actual
 * (paleta ya extraída al procesar el vídeo; no se lee el canvas del vídeo). Transición
 * suave salvo con `prefers-reduced-motion`, donde además no se interpola. Interruptor
 * "Ambilight" con la preferencia en `localStorage`.
 */
export function AmbilightGlow({ url, videoRef, children }: AmbilightGlowProps) {
  const [on, setOn] = useState(() => readStored(AMBILIGHT_PREF_KEY) !== 'off');
  const [reducedMotion] = useState(prefersReducedMotion);
  const colors = useAmbilight(url, videoRef, { enabled: on && !!url, interpolate: !reducedMotion });
  const visible = !!colors;

  const toggle = () => {
    const next = !on;
    setOn(next);
    writeStored(AMBILIGHT_PREF_KEY, next ? 'on' : 'off');
  };

  const transition = reducedMotion ? '' : 'transition-[background-color,opacity] duration-700 ease-linear';

  return (
    <div className="relative isolate">
      <div
        aria-hidden="true"
        data-testid="ambilight-glow"
        data-visible={visible}
        className={`pointer-events-none absolute -inset-x-3 -bottom-3 -top-5 -z-10 overflow-hidden sm:-inset-x-4 sm:-bottom-4 sm:-top-8 ${transition} ${
          visible ? 'opacity-70' : 'opacity-0'
        }`}
      >
        {SIDES.map(({ side, className }) => {
          const style: CSSProperties = {
            backgroundColor: colors?.[side] ?? 'transparent',
            maskImage: SOFT_MASK,
            WebkitMaskImage: SOFT_MASK,
          };
          return <div key={side} data-side={side} className={`absolute ${className} ${transition}`} style={style} />;
        })}
      </div>
      {children}
      {url && (
        <div className="mt-2 flex justify-end">
          <button
            type="button"
            role="switch"
            aria-checked={on}
            aria-label="Ambilight"
            title="Brillo de color alrededor del vídeo"
            onClick={toggle}
            className="inline-flex items-center gap-2 rounded-full px-2 py-1 text-[12px] text-tint-muted transition hover:text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-tint-accent"
          >
            <span
              aria-hidden="true"
              className={`relative h-4 w-7 rounded-full border transition-colors motion-reduce:transition-none ${
                on ? 'border-tint-accent bg-tint-accent' : 'border-white/25 bg-white/10'
              }`}
            >
              <span
                className={`absolute top-1/2 h-3 w-3 -translate-y-1/2 rounded-full bg-white transition-[left] motion-reduce:transition-none ${
                  on ? 'left-[13px]' : 'left-[1px]'
                }`}
              />
            </span>
            Ambilight
          </button>
        </div>
      )}
    </div>
  );
}
