import { useElementWidth } from '../../hooks/useElementWidth';
import type { EventTypeCount } from '../../lib/businessAnalytics';
import { formatNumber } from '../../lib/chartScale';
import { ChartCard, CHART_COLORS, DataTable } from './ChartCard';

/** Barras visibles; el resto se agrupa en "Otros" (la tabla conserva el detalle). */
export const MAX_BARS = 10;

/** Ancho de respaldo si no se puede medir el contenedor. */
const FALLBACK_W = 640;
const ROW = 30;
const BAR = 18;
const LABEL_W = 150;
const VALUE_W = 56;
const RADIUS = 4;

/** Nombres legibles de los tipos del contrato de eventos. */
const LABELS: Record<string, string> = {
  drift_correction: 'Corrección de drift',
  playback_command: 'Comando de reproducción',
  presence: 'Entrada o salida',
  chat_message: 'Mensaje de chat',
  reaction: 'Reacción',
  trivia_answer: 'Respuesta de trivia',
  buffering: 'Buffering',
  user_login: 'Inicio de sesión',
  room_created: 'Sala creada',
  room_closed: 'Sala cerrada',
  invitation_claimed: 'Invitación canjeada',
  media_processed: 'Vídeo procesado',
};

export function eventLabel(type: string): string {
  return LABELS[type] ?? type;
}

/** Rectángulo con el extremo de datos (derecho) redondeado y la base recta. */
function barPath(x: number, y: number, w: number, h: number): string {
  const r = Math.min(RADIUS, w / 2, h / 2);
  return `M${x},${y} H${x + w - r} Q${x + w},${y} ${x + w},${y + r} V${y + h - r} Q${x + w},${y + h} ${x + w - r},${y + h} H${x} Z`;
}

interface Row {
  key: string;
  label: string;
  source: string;
  count: number;
}

function fold(data: EventTypeCount[]): Row[] {
  const rows = data.map((d) => ({ key: `${d.type}/${d.source}`, label: eventLabel(d.type), source: d.source, count: d.count }));
  if (rows.length <= MAX_BARS) return rows;
  const rest = rows.slice(MAX_BARS - 1);
  return [
    ...rows.slice(0, MAX_BARS - 1),
    { key: 'otros', label: 'Otros', source: `${rest.length} tipos`, count: rest.reduce((sum, d) => sum + d.count, 0) },
  ];
}

/** Eventos de telemetría por tipo: barras horizontales de una sola serie, de mayor a menor. */
export function EventTypeBars({ data }: { data: EventTypeCount[] }) {
  // El viewBox usa el ancho real: el texto del SVG no se escala con la pantalla.
  const [measure, W] = useElementWidth<HTMLDivElement>(FALLBACK_W);

  if (data.length === 0) {
    return (
      <ChartCard title="Eventos por tipo">
        <p className="py-10 text-center text-sm text-tint-muted">Aún no se ha registrado telemetría</p>
      </ChartCard>
    );
  }

  const rows = fold(data);
  const max = Math.max(...rows.map((d) => d.count));
  const plotW = Math.max(1, W - LABEL_W - VALUE_W);
  const height = rows.length * ROW;
  const label = `Eventos por tipo: ${data.map((d) => `${eventLabel(d.type)} ${d.count}`).join(', ')}.`;

  return (
    <ChartCard
      title="Eventos por tipo"
      description="Telemetría guardada en los últimos 90 días, por tipo de evento."
      table={
        <DataTable
          caption="Eventos por tipo"
          columns={['Evento', 'Servicio', 'Cantidad']}
          rows={data.map((d) => [eventLabel(d.type), d.source, d.count])}
        />
      }
    >
      <div ref={measure}>
        <svg viewBox={`0 0 ${W} ${height}`} role="img" aria-label={label} className="block h-auto w-full">
          <line x1={LABEL_W} x2={LABEL_W} y1={0} y2={height} stroke={CHART_COLORS.axis} strokeWidth={1} />
          {rows.map((d, i) => {
            const w = Math.max(2, (d.count / max) * plotW);
            const y = i * ROW + (ROW - BAR) / 2;
            return (
              <g key={d.key} className="group">
                <title>{`${d.label} (${d.source}): ${d.count}`}</title>
                <text x={LABEL_W - 10} y={i * ROW + ROW / 2} dy="0.35em" textAnchor="end" className="fill-tint-muted text-[12px]">
                  {d.label}
                </text>
                <path
                  data-testid="event-bar"
                  data-width={w}
                  d={barPath(LABEL_W, y, w, BAR)}
                  fill={CHART_COLORS.series}
                  className="transition-opacity group-hover:opacity-80"
                />
                <text x={LABEL_W + w + 8} y={i * ROW + ROW / 2} dy="0.35em" className="fill-tint-text text-[12px] font-semibold tabular-nums">
                  {formatNumber(d.count, 0)}
                </text>
              </g>
            );
          })}
        </svg>
      </div>
    </ChartCard>
  );
}
