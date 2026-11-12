import { useState } from 'react';
import { useElementWidth } from '../../hooks/useElementWidth';
import { formatDay, type DailyUsers } from '../../lib/businessAnalytics';
import { niceTicks } from '../../lib/chartScale';
import { ChartCard, CHART_COLORS, DataTable } from './ChartCard';

/** Ancho de respaldo si no se puede medir el contenedor. */
const FALLBACK_W = 640;
const H = 220;
const PAD = { top: 16, right: 8, bottom: 24, left: 32 };
const PLOT_H = H - PAD.top - PAD.bottom;
const GAP = 2;
const MAX_BAR_W = 40;
const RADIUS = 4;

function plural(n: number) {
  return `${n} ${n === 1 ? 'usuario activo' : 'usuarios activos'}`;
}

/** Barra con el extremo de datos (superior) redondeado y la base recta sobre el eje. */
function barPath(x: number, y: number, w: number, h: number): string {
  const r = Math.min(RADIUS, w / 2, h);
  return `M${x},${y + h} V${y + r} Q${x},${y} ${x + r},${y} H${x + w - r} Q${x + w},${y} ${x + w},${y + r} V${y + h} Z`;
}

/**
 * Usuarios activos por día (DAU): una barra por día, una sola serie y sin leyenda. Cada
 * columna tiene una zona de puntero de alto completo que muestra el día, su DAU y el
 * MAU; el último día va rotulado y los mismos datos están en la tabla alternativa.
 * Se omiten los días previos al primer usuario activo.
 */
export function DailyUsersChart({ days: allDays }: { days: DailyUsers[] }) {
  // Los días anteriores al primer inicio de sesión no aportan: el eje empieza donde hay datos.
  const start = allDays.findIndex((d) => d.dau > 0 || d.mau > 0);
  const days = start === -1 ? [] : allDays.slice(start);
  const [active, setActive] = useState<number | null>(null);
  // El viewBox usa el ancho real: el texto del SVG no se escala con la pantalla.
  const [measure, W] = useElementWidth<HTMLDivElement>(FALLBACK_W);

  if (days.length === 0) {
    return (
      <ChartCard title="Usuarios activos por día">
        <p className="py-10 text-center text-sm text-tint-muted">Aún no hay inicios de sesión registrados</p>
      </ChartCard>
    );
  }

  const plotW = W - PAD.left - PAD.right;
  const slot = plotW / days.length;
  const barW = Math.max(1, Math.min(MAX_BAR_W, slot - GAP));
  const ticks = niceTicks(Math.max(...days.map((d) => d.dau)));
  const yMax = ticks[ticks.length - 1];
  const y = (v: number) => PAD.top + PLOT_H - (v / yMax) * PLOT_H;
  const x = (i: number) => PAD.left + i * slot + (slot - barW) / 2;
  const last = days.length - 1;
  const peak = days.reduce((best, d) => (d.dau > best.dau ? d : best), days[0]);
  const label =
    `Usuarios activos por día del ${formatDay(days[0].day)} al ${formatDay(days[last].day)}: ` +
    `máximo ${peak.dau} el ${formatDay(peak.day)}, último día ${days[last].dau}.`;
  const xLabels = Array.from(new Set([0, Math.floor(last / 2), last]));
  const shown = active === null ? null : days[active];

  return (
    <ChartCard
      title="Usuarios activos por día"
      description="Personas distintas que iniciaron sesión cada día (DAU)."
      table={
        <DataTable
          caption="Usuarios activos por día"
          columns={['Día', 'Activos en el día (DAU)', 'Activos en 30 días (MAU)']}
          rows={days.map((d) => [formatDay(d.day), d.dau, d.mau])}
        />
      }
    >
      <div ref={measure} className="relative">
        <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={label} className="block h-auto w-full overflow-visible">
          {ticks.map((t) => (
            <g key={t}>
              <line x1={PAD.left} x2={W - PAD.right} y1={y(t)} y2={y(t)} stroke={t === 0 ? CHART_COLORS.axis : CHART_COLORS.grid} strokeWidth={1} />
              <text x={PAD.left - 8} y={y(t)} dy="0.32em" textAnchor="end" className="fill-tint-muted text-[11px] tabular-nums">
                {t}
              </text>
            </g>
          ))}
          {xLabels.map((i) => (
            <text key={i} x={x(i) + barW / 2} y={H - 6} textAnchor="middle" className="fill-tint-muted text-[11px] tabular-nums">
              {formatDay(days[i].day)}
            </text>
          ))}
          {days.map((d, i) => (
            <g key={d.day} onPointerEnter={() => setActive(i)} onPointerLeave={() => setActive(null)}>
              {d.dau > 0 && (
                <path
                  data-testid="daily-bar"
                  data-height={y(0) - y(d.dau)}
                  d={barPath(x(i), y(d.dau), barW, y(0) - y(d.dau))}
                  fill={CHART_COLORS.series}
                  opacity={active === null || active === i ? 1 : 0.55}
                />
              )}
              {/* Zona de puntero de alto completo: más grande que la barra. */}
              <rect data-testid="daily-hit" x={PAD.left + i * slot} y={PAD.top} width={slot} height={PLOT_H} fill="transparent">
                <title>{`${formatDay(d.day)}: ${plural(d.dau)}`}</title>
              </rect>
            </g>
          ))}
          <text
            data-testid="daily-last-label"
            x={x(last) + barW / 2}
            y={y(days[last].dau) - 6}
            textAnchor="middle"
            className="fill-tint-text text-[12px] font-semibold tabular-nums"
          >
            {days[last].dau}
          </text>
        </svg>
        {shown && active !== null && (
          <div
            role="status"
            className="pointer-events-none absolute top-0 rounded-lg border border-white/10 bg-tint-bg/95 px-3 py-2 text-[12px] shadow-lg"
            style={{
              left: `${((x(active) + barW / 2) / W) * 100}%`,
              transform: `translateX(${active > last / 2 ? 'calc(-100% - 8px)' : '8px'})`,
            }}
          >
            <p className="text-tint-muted">{formatDay(shown.day)}</p>
            <p className="font-semibold text-white">{plural(shown.dau)}</p>
            <p className="text-tint-muted">{shown.mau} en los últimos 30 días</p>
          </div>
        )}
      </div>
    </ChartCard>
  );
}
