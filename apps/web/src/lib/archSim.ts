import type { ArchConnector, ArchConnectorMode, ArchNode, ArchNodeId } from '../data/architecture';
import type { ArchStep, ArchStory } from '../data/architectureStories';
import { BASE_POINTS, multiplierFor } from './quiz';

// Lógica pura de la ruta /arquitectura: aristas del diagrama, geometría y el reducer de las
// dos pestañas (Recorrer y Predecir). Sin React ni I/O.

export interface ArchEdge {
  /** Par de nodos ordenado alfabéticamente: `a|b`. */
  key: string;
  a: ArchNodeId;
  b: ArchNodeId;
  /** Ids de los conectores que pasan por esta arista. */
  connectors: string[];
  mode: ArchConnectorMode;
}

export interface Point {
  x: number;
  y: number;
}

export function edgeKey(a: ArchNodeId, b: ArchNodeId): string {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

/** Una arista por par de componentes, con todos los conectores que los unen. */
export function buildEdges(connectors: readonly ArchConnector[]): ArchEdge[] {
  const edges = new Map<string, ArchEdge>();
  for (const c of connectors) {
    for (const [from, to] of c.links) {
      const key = edgeKey(from, to);
      const edge = edges.get(key);
      if (edge) edge.connectors.push(c.id);
      else {
        const [a, b] = from < to ? [from, to] : [to, from];
        edges.set(key, { key, a, b, connectors: [c.id], mode: c.mode });
      }
    }
  }
  return [...edges.values()];
}

/** ¿El conector une a esos dos componentes, en cualquier sentido? */
export function connectorLinks(connector: ArchConnector, from: ArchNodeId, to: ArchNodeId): boolean {
  return connector.links.some(([a, b]) => (a === from && b === to) || (a === to && b === from));
}

export const isInternalStep = (step: ArchStep) => step.connector === null;

// Curvatura (px del punto de control, perpendicular a la recta a → b en orden alfabético) de
// las aristas que, en línea recta, pasarían por detrás de otro nodo.
export const EDGE_BENDS: Record<string, number> = {
  'firebase|social': -230,
  'media|postgres': 190,
  'identity|minio': 90,
};

/** Punto de control de la curva cuadrática de la arista (el punto medio si es recta). */
export function edgeControl(a: Point, b: Point, bend: number): Point {
  const mx = (a.x + b.x) / 2;
  const my = (a.y + b.y) / 2;
  const len = Math.hypot(b.x - a.x, b.y - a.y) || 1;
  return { x: mx - ((b.y - a.y) / len) * bend, y: my + ((b.x - a.x) / len) * bend };
}

const round = (n: number) => Math.round(n * 10) / 10;

export function edgePath(a: Point, b: Point, bend: number): string {
  if (bend === 0) return `M ${a.x} ${a.y} L ${b.x} ${b.y}`;
  const c = edgeControl(a, b, bend);
  return `M ${a.x} ${a.y} Q ${round(c.x)} ${round(c.y)} ${b.x} ${b.y}`;
}

/** `n + 1` puntos equidistantes en t sobre la arista, de `a` a `b`. */
export function edgePoints(a: Point, b: Point, bend: number, n = 12): Point[] {
  const c = edgeControl(a, b, bend);
  return Array.from({ length: n + 1 }, (_, i) => {
    const t = i / n;
    const u = 1 - t;
    return {
      x: round(u * u * a.x + 2 * u * t * c.x + t * t * b.x),
      y: round(u * u * a.y + 2 * u * t * c.y + t * t * b.y),
    };
  });
}

/** Recorrido del paquete de un paso: del origen al destino, siguiendo la curva de su arista. */
export function stepTrajectory(step: ArchStep, nodes: readonly ArchNode[]): Point[] {
  const from = nodes.find((n) => n.id === step.from);
  const to = nodes.find((n) => n.id === step.to);
  if (!from || !to) return [];
  if (step.from === step.to) return [{ x: from.x, y: from.y }];
  const key = edgeKey(step.from, step.to);
  // La curvatura está definida en el sentido alfabético de la arista.
  const forward = step.from < step.to;
  const points = edgePoints(forward ? from : to, forward ? to : from, EDGE_BENDS[key] ?? 0);
  return forward ? points : points.reverse();
}

export type ArchMode = 'recorrer' | 'predecir';

export interface ArchSimState {
  mode: ArchMode;
  story: ArchStory;
  /** Índice del paso que se muestra (Recorrer) o que se pregunta (Predecir). */
  step: number;
  /** Predecir: lo que se respondió en el paso actual; null si aún no se responde. */
  guess: ArchNodeId | null;
  score: number;
  streak: number;
  hits: number;
  asked: number;
  /** Predecir: ya se resolvió el último paso y se pidió continuar. */
  finished: boolean;
}

export type ArchSimAction =
  | { type: 'selectStory'; story: ArchStory }
  | { type: 'setMode'; mode: ArchMode }
  | { type: 'next' }
  | { type: 'prev' }
  | { type: 'guess'; node: ArchNodeId }
  | { type: 'restart' };

export function initialArchSimState(story: ArchStory, mode: ArchMode = 'recorrer'): ArchSimState {
  return { mode, story, step: 0, guess: null, score: 0, streak: 0, hits: 0, asked: 0, finished: false };
}

/** En Predecir, un paso está resuelto si es interno (no se pregunta) o si ya se respondió. */
export function isStepRevealed(state: ArchSimState): boolean {
  if (state.mode === 'recorrer') return true;
  const step = state.story.steps[state.step];
  return !step || isInternalStep(step) || state.guess !== null;
}

export function archSimReducer(state: ArchSimState, action: ArchSimAction): ArchSimState {
  switch (action.type) {
    case 'selectStory':
      return initialArchSimState(action.story, state.mode);
    case 'setMode':
      return action.mode === state.mode ? state : initialArchSimState(state.story, action.mode);
    case 'restart':
      return initialArchSimState(state.story, state.mode);
    case 'prev':
      if (state.mode !== 'recorrer' || state.step === 0) return state;
      return { ...state, step: state.step - 1 };
    case 'next': {
      if (state.finished || !isStepRevealed(state)) return state;
      const last = state.step >= state.story.steps.length - 1;
      if (last) return state.mode === 'predecir' ? { ...state, finished: true } : state;
      return { ...state, step: state.step + 1, guess: null };
    }
    case 'guess': {
      const step = state.story.steps[state.step];
      if (state.mode !== 'predecir' || state.finished || !step || isStepRevealed(state)) return state;
      const correct = action.node === step.to;
      const streak = correct ? state.streak + 1 : 0;
      return {
        ...state,
        guess: action.node,
        streak,
        asked: state.asked + 1,
        hits: state.hits + (correct ? 1 : 0),
        score: state.score + (correct ? BASE_POINTS * multiplierFor(streak) : 0),
      };
    }
  }
}

/** Pasos de la historia que se preguntan en Predecir (los internos no). */
export const askedSteps = (story: ArchStory) => story.steps.filter((s) => !isInternalStep(s)).length;
