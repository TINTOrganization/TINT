import { useEffect, useRef, useState } from 'react';
import type { ReactionBroadcast } from '../lib/socialSocket';

/** Un float visible del overlay. `x` es el % horizontal (determinista por key). */
export interface FloatReaction {
  key: string;
  emoji: string;
  count: number;
  x: number;
  bornAt: number;
}

/** Ventana para agrupar el mismo emoji en un solo float con xN. */
export const FLOAT_GROUP_WINDOW_MS = 800;
/** Tope de floats concurrentes para no saturar el reproductor. */
export const MAX_FLOATS = 20;
/** Máximo de `event_id` recordados antes de recortar (como `LaserOverlay`). */
export const SEEN_MEMORY = 500;

/**
 * Recorta la memoria de eventos vistos: al superar `SEEN_MEMORY` solo conserva los ids que
 * siguen en la lista actual (los únicos que podrían volver a llegar). Sin esto el `Set`
 * crecía durante toda la sesión.
 */
export function trimSeen(seen: Set<string>, currentIds: readonly string[]): Set<string> {
  if (seen.size <= SEEN_MEMORY) return seen;
  return new Set(currentIds.filter((id) => seen.has(id)));
}

function xForKey(key: string): number {
  let h = 0;
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) >>> 0;
  return 8 + (h % 84);
}

/**
 * Agrega una reacción a los floats: si el mismo emoji ya flota dentro de la
 * ventana, suma xN en vez de crear otro. Pura y testeable.
 */
export function applyReaction(
  prev: FloatReaction[],
  emoji: string,
  key: string,
  now: number,
): FloatReaction[] {
  const fresh = prev.filter((f) => now - f.bornAt < FLOAT_GROUP_WINDOW_MS);
  const target = fresh.find((f) => f.emoji === emoji);
  const next =
    target !== undefined
      ? fresh.map((f) => (f.key === target.key ? { ...f, count: f.count + 1 } : f))
      : [...fresh, { key, emoji, count: 1, x: xForKey(key), bornAt: now }];
  return next.slice(-MAX_FLOATS);
}

export function ReactionOverlay({ reactions }: { reactions: ReactionBroadcast[] }) {
  const [floats, setFloats] = useState<FloatReaction[]>([]);
  const seenRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    const fresh = reactions.filter((r) => !seenRef.current.has(r.event_id));
    if (fresh.length === 0) return;
    for (const r of fresh) seenRef.current.add(r.event_id);
    seenRef.current = trimSeen(seenRef.current, reactions.map((r) => r.event_id));
    const now = Date.now();
    setFloats((prev) => {
      let next = prev;
      for (const r of fresh) next = applyReaction(next, r.emoji, r.event_id, now);
      return next;
    });
  }, [reactions]);

  const dismiss = (key: string) => {
    setFloats((prev) => prev.filter((f) => f.key !== key));
  };

  return (
    <div aria-hidden="true" className="pointer-events-none absolute inset-0 overflow-hidden">
      {floats.map((f) => (
        <span
          key={f.key}
          className="tint-float"
          style={{ left: `${f.x}%` }}
          onAnimationEnd={() => dismiss(f.key)}
        >
          {f.emoji}
          {f.count > 1 && (
            <span className="ml-0.5 align-super text-[11px] font-bold text-white">x{f.count}</span>
          )}
        </span>
      ))}
    </div>
  );
}
