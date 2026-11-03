import type { LiveStatus } from '../../hooks/useLiveStream';

const STATUS_TEXT: Record<LiveStatus, string> = {
  idle: 'Sin transmitir',
  connecting: 'Conectando…',
  waiting: 'Esperando al host',
  live: 'En vivo',
  reconnecting: 'Reconectando…',
  ended: 'Terminado',
  error: 'Sin conexión',
};

/** Estado de la transmisión ("En vivo" con punto rojo que late; estático con movimiento reducido). */
export function LiveStatusBadge({ status }: { status: LiveStatus }) {
  const live = status === 'live';
  return (
    <span
      data-status={status}
      className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[12px] font-semibold uppercase tracking-wide ${
        live ? 'border-red-400/40 bg-red-500/15 text-red-200' : 'border-white/10 bg-white/5 text-tint-muted'
      }`}
    >
      <span
        aria-hidden="true"
        className={`h-2 w-2 rounded-full ${
          live
            ? 'bg-red-400 animate-pulse motion-reduce:animate-none'
            : status === 'reconnecting' || status === 'connecting'
              ? 'bg-amber-300'
              : 'bg-white/40'
        }`}
      />
      {STATUS_TEXT[status]}
    </span>
  );
}

/** Contador de espectadores (`viewer_count`, 1 Hz desde stream-core). */
export function ViewerCount({ count }: { count: number | null }) {
  if (count === null) return null;
  const text = `${count} ${count === 1 ? 'espectador' : 'espectadores'}`;
  return (
    <span
      className="inline-flex items-center gap-1.5 rounded-full border border-white/10 bg-white/5 px-2.5 py-1 text-[12px] text-white"
      aria-label={text}
    >
      <svg aria-hidden="true" viewBox="0 0 16 16" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="1.6">
        <path d="M1.5 8s2.4-4.5 6.5-4.5S14.5 8 14.5 8 12.1 12.5 8 12.5 1.5 8 1.5 8Z" />
        <circle cx="8" cy="8" r="2" />
      </svg>
      <span className="tabular-nums">{count}</span>
    </span>
  );
}
