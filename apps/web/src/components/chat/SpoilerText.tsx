import { useRef, useState } from 'react';

/**
 * Texto con spoiler: difuminado hasta hover; el foco de teclado lo revela (y lo lee el
 * lector de pantalla) y el toque/clic lo alterna.
 */
export function SpoilerText({ text }: { text: string }) {
  const [pinned, setPinned] = useState(false);
  const [focused, setFocused] = useState(false);
  const pointerRef = useRef(false);
  const revealed = pinned || focused;
  const toggle = () => setPinned((p) => !p);
  return (
    <span
      role="button"
      tabIndex={0}
      aria-pressed={pinned}
      aria-label={revealed ? undefined : 'Spoiler oculto, enfoca para leer'}
      title={revealed ? undefined : 'Spoiler: pasa el cursor o toca para leer'}
      onPointerDown={() => {
        pointerRef.current = true;
      }}
      onFocus={() => {
        // El foco que llega por un toque no cuenta: el toque alterna con el clic.
        if (!pointerRef.current) setFocused(true);
        pointerRef.current = false;
      }}
      onBlur={() => setFocused(false)}
      onClick={toggle}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          toggle();
        }
      }}
      className={`cursor-pointer rounded px-0.5 transition-[filter] duration-200 motion-reduce:transition-none focus:outline-none focus-visible:ring-2 focus-visible:ring-tint-accent/60 ${
        revealed ? 'bg-white/5' : 'blur-[5px] hover:blur-none select-none bg-white/10'
      }`}
    >
      {text}
    </span>
  );
}

