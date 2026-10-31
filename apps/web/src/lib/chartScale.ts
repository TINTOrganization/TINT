/** Utilidades puras de escala y formato para los gráficos SVG de analítica. */

/** Niveles de la rampa del heatmap (sin contar el 0 = celda vacía). */
export const HEAT_LEVELS = 4;

/** Ticks limpios desde 0 hasta un máximo "redondo" (paso 1, 2 o 5 × 10^k, entero ≥ 1). */
export function niceTicks(max: number, target = 4): number[] {
  if (!(max > 0)) return [0, 1];
  const raw = max / target;
  const magnitude = 10 ** Math.floor(Math.log10(raw));
  const step = Math.max(1, [1, 2, 5, 10].map((m) => m * magnitude).find((s) => s >= raw) ?? 10 * magnitude);
  const top = Math.ceil(max / step) * step;
  const ticks: number[] = [];
  for (let v = 0; v <= top + step / 2; v += step) ticks.push(v);
  return ticks;
}

const compact = new Intl.NumberFormat('es', { notation: 'compact', maximumFractionDigits: 1 });

/** Número en español: compacto desde 1.000 (1,5 mil) y con `decimals` como máximo. */
export function formatNumber(value: number, decimals = 1): string {
  if (Math.abs(value) >= 1_000) return compact.format(value);
  return new Intl.NumberFormat('es', { maximumFractionDigits: decimals }).format(value);
}

/** Duración legible a partir de milisegundos: 640 ms, 1,3 s o 25,5 min. */
export function formatDuration(ms: number): string {
  if (Math.abs(ms) < 1_000) return `${formatNumber(ms, 0)} ms`;
  if (Math.abs(ms) < 60_000) return `${formatNumber(ms / 1_000)} s`;
  return `${formatNumber(ms / 60_000)} min`;
}

/** Hora local HH:MM de un ISO (eje temporal); si no es fecha, el texto tal cual. */
export function formatClockTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/** Nivel 0..HEAT_LEVELS de una celda según su conteo relativo al máximo. */
export function heatLevel(count: number, max: number): number {
  if (count <= 0 || max <= 0) return 0;
  return Math.max(1, Math.ceil((count / max) * HEAT_LEVELS));
}
