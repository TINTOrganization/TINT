import type { RoomHeatmapBucket } from '../../lib/businessAnalytics';
import { heatLevel } from '../../lib/chartScale';
import { formatTime } from '../../lib/time';
import { CHART_COLORS } from './ChartCard';

/** Columnas máximas: con más tramos se agrupan varios por columna. */
export const MAX_COLUMNS = 40;
const BUCKET_MS = 5000;
const W = 160;
const H = 16;
const GAP = 1;

/**
 * Tira compacta del heatmap normalizado de una sala: una celda por tramo del vídeo,
 * más clara cuanto mayor es su densidad (0 a 1). Para leer dentro de una tabla.
 */
export function DensityStrip({ buckets }: { buckets: RoomHeatmapBucket[] }) {
  if (buckets.length === 0) {
    return <span className="text-tint-muted/70">Sin reacciones</span>;
  }
  const rawColumns = Math.floor(Math.max(...buckets.map((b) => b.bucket_start_ms)) / BUCKET_MS) + 1;
  const factor = Math.ceil(rawColumns / MAX_COLUMNS);
  const colMs = BUCKET_MS * factor;
  const columns = Math.ceil(rawColumns / factor);
  const density = new Array<number>(columns).fill(0);
  for (const b of buckets) {
    const col = Math.floor(b.bucket_start_ms / colMs);
    density[col] = Math.max(density[col], b.density);
  }
  const peak = buckets.reduce((best, b) => (b.density > best.density ? b : best), buckets[0]);
  const total = buckets.reduce((sum, b) => sum + b.reactions, 0);
  const label =
    `Densidad de reacciones a lo largo del vídeo: ${total} ${total === 1 ? 'reacción' : 'reacciones'}, ` +
    `pico en ${formatTime(peak.bucket_start_ms)}.`;
  const cellW = W / columns;

  return (
    <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img" aria-label={label} className="block h-4 w-40">
      {density.map((value, col) => {
        const level = heatLevel(value, 1);
        return (
          <rect
            key={col}
            data-testid="density-cell"
            data-level={level}
            x={col * cellW + GAP / 2}
            y={0}
            width={Math.max(0.5, cellW - GAP)}
            height={H}
            rx={1}
            fill={level === 0 ? CHART_COLORS.empty : CHART_COLORS.heatRamp[level - 1]}
          >
            <title>{`${formatTime(col * colMs)}–${formatTime((col + 1) * colMs)} · densidad ${value.toFixed(2)}`}</title>
          </rect>
        );
      })}
    </svg>
  );
}
