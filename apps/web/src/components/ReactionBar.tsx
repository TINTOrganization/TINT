import { useEffect, useRef, useState } from 'react';
import { AnimatePresence, m } from 'framer-motion';
import { useThrottle } from '../hooks/useThrottle';
import { REACTION_EMOJIS, type ReactionEmoji } from '../lib/socialSocket';
import { spring } from '../lib/motion';

// Set del documento (REQ-20) más tristeza por decisión de producto.
export const REACTIONS: readonly ReactionEmoji[] = REACTION_EMOJIS;

const REACTION_LABELS: Record<ReactionEmoji, string> = {
  '👏': 'aplauso',
  '😂': 'risa',
  '😮': 'sorpresa',
  '😱': 'susto',
  '❤️': 'corazón',
  '😢': 'tristeza',
};

/** Vida de una ráfaga decorativa antes de retirarse. */
const BURST_MS = 600;

/** Destino (px) de cada partícula de la ráfaga: un abanico corto hacia arriba. */
const PARTICLES = [
  { x: -16, y: -22 },
  { x: -5, y: -30 },
  { x: 6, y: -28 },
  { x: 16, y: -20 },
] as const;

export type Reaction = ReactionEmoji;

interface ReactionBarProps {
  onReact: (reaction: Reaction) => void;
}

interface Burst {
  id: number;
  emoji: ReactionEmoji;
}

export function ReactionBar({ onReact }: ReactionBarProps) {
  // El envío sigue limitado a 5/s (useThrottle); la ráfaga es solo visual.
  const react = useThrottle(onReact);
  const [bursts, setBursts] = useState<Burst[]>([]);
  const nextId = useRef(0);
  const timers = useRef(new Set<number>());

  useEffect(() => {
    const pending = timers.current;
    return () => {
      pending.forEach((t) => window.clearTimeout(t));
      pending.clear();
    };
  }, []);

  const spawnBurst = (emoji: ReactionEmoji) => {
    const id = nextId.current++;
    setBursts((list) => [...list, { id, emoji }]);
    const timer = window.setTimeout(() => {
      timers.current.delete(timer);
      setBursts((list) => list.filter((b) => b.id !== id));
    }, BURST_MS);
    timers.current.add(timer);
  };

  return (
    <div role="toolbar" aria-label="Reacciones" className="flex flex-wrap gap-1.5 sm:gap-2">
      {REACTIONS.map((r) => (
        <div key={r} className="relative">
          <m.button
            type="button"
            onClick={() => {
              spawnBurst(r);
              react(r);
            }}
            aria-label={`Reaccionar con ${REACTION_LABELS[r]} ${r}`}
            whileHover={{ y: -2 }}
            whileTap={{ scale: 1.25 }}
            transition={spring}
            className="tint-glass grid h-11 w-11 place-items-center rounded-full text-xl transition-colors duration-300 hover:bg-white/[0.09] focus:outline-none focus-visible:ring-2 focus-visible:ring-tint-accent"
          >
            {r}
          </m.button>
          <AnimatePresence>
            {bursts
              .filter((b) => b.emoji === r)
              .map((b) => (
                <m.span
                  key={b.id}
                  data-burst
                  aria-hidden="true"
                  exit={{ opacity: 0, transition: { duration: 0.15 } }}
                  className="pointer-events-none absolute inset-0 grid place-items-center"
                >
                  {PARTICLES.map((p, i) => (
                    <m.span
                      key={i}
                      data-particle
                      className="absolute text-[11px] leading-none"
                      initial={{ opacity: 0.9, x: 0, y: 0, scale: 0.6 }}
                      animate={{ opacity: 0, x: p.x, y: p.y, scale: 1 }}
                      transition={{ duration: 0.55, ease: 'easeOut', delay: i * 0.02 }}
                    >
                      {r}
                    </m.span>
                  ))}
                </m.span>
              ))}
          </AnimatePresence>
        </div>
      ))}
    </div>
  );
}
