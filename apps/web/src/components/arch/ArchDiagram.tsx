import { motion, useReducedMotion } from 'framer-motion';
import { useMemo, type KeyboardEvent } from 'react';
import {
  ARCH_KIND_LABELS,
  ARCH_MODE_LABELS,
  ARCH_NODE_SIZE,
  ARCH_VIEWBOX,
  type ArchConnector,
  type ArchConnectorMode,
  type ArchNode,
  type ArchNodeId,
} from '../../data/architecture';
import type { ArchStep } from '../../data/architectureStories';
import { EDGE_BENDS, buildEdges, edgeKey, edgePath, stepTrajectory, type Point } from '../../lib/archSim';

const { width: W, height: H } = ARCH_NODE_SIZE;

// Mismo código visual que la leyenda de docs/arquitectura.md §4.
const EDGE_STYLE: Record<ArchConnectorMode, { width: number; dash?: string }> = {
  sync: { width: 1.5 },
  ws: { width: 4 },
  async: { width: 1.5, dash: '7 6' },
};

const LEGEND: ArchConnectorMode[] = ['sync', 'ws', 'async'];

const inside = (p: Point, n: ArchNode) => Math.abs(p.x - n.x) <= W / 2 + 6 && Math.abs(p.y - n.y) <= H / 2 + 6;

export interface ArchDiagramProps {
  nodes: readonly ArchNode[];
  connectors: readonly ArchConnector[];
  /** Paso ya resuelto: se resalta su conector y viaja el paquete. */
  step: ArchStep | null;
  /** Predecir, antes de responder: componente del que sale el mensaje. */
  origin: ArchNodeId | null;
  /** Componente con la ficha abierta. */
  selected: ArchNodeId | null;
  /** Predecir, tras responder: lo que se eligió, para marcar el fallo. */
  guess: ArchNodeId | null;
  /** Cambia en cada paso para reiniciar la animación del paquete. */
  packetKey: string;
  /** Texto del `aria-label` de cada nodo: "Ver ficha de" o "Responder". */
  nodeAction: string;
  onNodeClick: (id: ArchNodeId) => void;
}

export default function ArchDiagram({
  nodes,
  connectors,
  step,
  origin,
  selected,
  guess,
  packetKey,
  nodeAction,
  onNodeClick,
}: ArchDiagramProps) {
  const reduced = useReducedMotion();
  const edges = useMemo(() => buildEdges(connectors), [connectors]);
  const byId = useMemo(() => new Map(nodes.map((n) => [n.id, n])), [nodes]);

  const internal = step !== null && step.from === step.to;
  const activeKey = step && !internal ? edgeKey(step.from, step.to) : null;
  const wrong = step && guess && guess !== step.to ? guess : null;

  // El paquete se detiene en el borde del destino para no tapar su nombre.
  const packet = useMemo(() => {
    if (!step || internal) return [];
    const from = byId.get(step.from);
    const to = byId.get(step.to);
    if (!from || !to) return [];
    const path = stepTrajectory(step, nodes).filter((p) => !inside(p, from) && !inside(p, to));
    return path.length ? path : [{ x: (from.x + to.x) / 2, y: (from.y + to.y) / 2 }];
  }, [step, internal, byId, nodes]);

  const onKey = (id: ArchNodeId) => (e: KeyboardEvent) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    e.preventDefault();
    onNodeClick(id);
  };

  const strokeOf = (n: ArchNode) => {
    if (wrong === n.id) return '#f87171';
    if (step?.to === n.id) return '#FF6B1A';
    if (step?.from === n.id || origin === n.id) return '#FF8A3D';
    if (selected === n.id) return '#DBDEE1';
    return 'rgba(255,255,255,0.18)';
  };

  const last = packet[packet.length - 1];

  return (
    <figure className="min-w-0 rounded-2xl border border-white/10 bg-tint-card/70 p-3 sm:p-4">
      <p className="mb-2 text-xs text-tint-muted sm:hidden">Desliza el diagrama hacia los lados para verlo completo.</p>
      <div className="overflow-x-auto">
        <svg
          viewBox={`0 0 ${ARCH_VIEWBOX.width} ${ARCH_VIEWBOX.height}`}
          role="group"
          aria-label="Diagrama de componentes y conectores de TINT"
          className="h-auto w-full min-w-[720px]"
        >
          <g fill="none">
            {edges.map((e) => {
              const a = byId.get(e.a)!;
              const b = byId.get(e.b)!;
              const active = e.key === activeKey;
              const style = EDGE_STYLE[e.mode];
              return (
                <path
                  key={e.key}
                  data-edge={e.key}
                  data-active={active || undefined}
                  d={edgePath(a, b, EDGE_BENDS[e.key] ?? 0)}
                  stroke={active ? '#FF6B1A' : '#B5BAC1'}
                  strokeOpacity={active ? 1 : activeKey ? 0.16 : 0.32}
                  strokeWidth={active ? style.width + 1.5 : style.width}
                  strokeDasharray={style.dash}
                  strokeLinecap="round"
                />
              );
            })}
          </g>

          {nodes.map((n) => {
            const highlighted = step?.to === n.id || step?.from === n.id || origin === n.id || wrong === n.id;
            return (
              <g
                key={n.id}
                role="button"
                tabIndex={0}
                aria-label={`${nodeAction}: ${n.label}`}
                aria-pressed={selected === n.id}
                data-node={n.id}
                onClick={() => onNodeClick(n.id)}
                onKeyDown={onKey(n.id)}
                className="group cursor-pointer outline-none"
              >
                <rect
                  x={n.x - W / 2}
                  y={n.y - H / 2}
                  width={W}
                  height={H}
                  rx={n.kind === 'almacen' ? H / 2 : 12}
                  fill={n.kind === 'cliente' ? '#3A2A1F' : '#313338'}
                  stroke={strokeOf(n)}
                  strokeWidth={highlighted || selected === n.id ? 3 : 1.5}
                  strokeDasharray={n.kind === 'externo' ? '5 4' : undefined}
                  className="transition-[stroke] duration-300 group-hover:stroke-white/60 group-focus-visible:stroke-white"
                />
                <text x={n.x} y={n.y - 3} textAnchor="middle" fill="#FFFFFF" fontSize="16" fontWeight="700">
                  {n.label}
                </text>
                <text x={n.x} y={n.y + 15} textAnchor="middle" fill="#B5BAC1" fontSize="11">
                  {n.port ? `:${n.port}` : ARCH_KIND_LABELS[n.kind].toLowerCase()}
                </text>
              </g>
            );
          })}

          {step && internal && byId.get(step.from) && (
            <motion.rect
              key={`in-${packetKey}`}
              data-packet="internal"
              x={byId.get(step.from)!.x - W / 2 - 7}
              y={byId.get(step.from)!.y - H / 2 - 7}
              width={W + 14}
              height={H + 14}
              rx={18}
              fill="none"
              stroke="#FF6B1A"
              strokeWidth={2}
              strokeDasharray="4 5"
              pointerEvents="none"
              initial={{ opacity: 0 }}
              animate={{ opacity: reduced ? 1 : [0, 1, 0.55, 1] }}
              transition={{ duration: 0.9 }}
            />
          )}

          {last && (
            <motion.circle
              key={`pk-${packetKey}`}
              data-packet="edge"
              r={8}
              fill="#FF6B1A"
              stroke="#1E1F22"
              strokeWidth={2.5}
              pointerEvents="none"
              initial={reduced ? { cx: last.x, cy: last.y } : { cx: packet[0].x, cy: packet[0].y }}
              animate={reduced ? { cx: last.x, cy: last.y } : { cx: packet.map((p) => p.x), cy: packet.map((p) => p.y) }}
              transition={{ duration: 1.1, ease: 'easeInOut' }}
            />
          )}
        </svg>
      </div>

      <figcaption className="mt-3 flex flex-wrap gap-x-5 gap-y-2 border-t border-white/10 pt-3 text-xs text-tint-muted">
        {LEGEND.map((mode) => (
          <span key={mode} className="flex items-center gap-2">
            <svg width="34" height="8" aria-hidden="true">
              <line
                x1="2"
                y1="4"
                x2="32"
                y2="4"
                stroke="#B5BAC1"
                strokeWidth={EDGE_STYLE[mode].width}
                strokeDasharray={EDGE_STYLE[mode].dash}
                strokeLinecap="round"
              />
            </svg>
            {ARCH_MODE_LABELS[mode]}
          </span>
        ))}
      </figcaption>
    </figure>
  );
}
