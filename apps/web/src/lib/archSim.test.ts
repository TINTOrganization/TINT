import { ARCH_CONNECTORS, ARCH_NODES } from '../data/architecture';
import { ARCH_STORIES, type ArchStory } from '../data/architectureStories';
import {
  archSimReducer,
  askedSteps,
  buildEdges,
  connectorLinks,
  edgeControl,
  edgeKey,
  edgePath,
  edgePoints,
  initialArchSimState,
  isStepRevealed,
  stepTrajectory,
  type ArchSimAction,
  type ArchSimState,
} from './archSim';

const story: ArchStory = {
  id: 't',
  title: 'Prueba',
  actor: 'Host',
  summary: '',
  quizIds: [],
  steps: [
    { from: 'web', to: 'identity', connector: 'C2', ask: '¿?', message: 'a', detail: '', sources: [] },
    { from: 'identity', to: 'identity', connector: null, ask: '', message: 'b', detail: '', sources: [] },
    { from: 'identity', to: 'postgres', connector: 'C9', ask: '¿?', message: 'c', detail: '', sources: [] },
  ],
};

const run = (state: ArchSimState, ...actions: ArchSimAction[]) => actions.reduce(archSimReducer, state);

describe('aristas y geometría', () => {
  it('edgeKey no depende del orden', () => {
    expect(edgeKey('web', 'identity')).toBe('identity|web');
    expect(edgeKey('identity', 'web')).toBe('identity|web');
  });

  it('buildEdges agrupa los conectores que unen al mismo par', () => {
    const edges = buildEdges(ARCH_CONNECTORS);
    expect(new Set(edges.map((e) => e.key)).size).toBe(edges.length);
    const idRedis = edges.find((e) => e.key === 'identity|redis')!;
    expect(idRedis.connectors).toEqual(['C11', 'C14', 'C15']);
    expect(idRedis.mode).toBe('async');
    expect(edges.find((e) => e.key === 'sync|web')!.mode).toBe('ws');
    expect(edges).toHaveLength(18);
  });

  it('connectorLinks acepta los dos sentidos y rechaza pares ajenos', () => {
    const c9 = ARCH_CONNECTORS.find((c) => c.id === 'C9')!;
    expect(connectorLinks(c9, 'identity', 'postgres')).toBe(true);
    expect(connectorLinks(c9, 'postgres', 'media')).toBe(true);
    expect(connectorLinks(c9, 'web', 'postgres')).toBe(false);
  });

  it('una arista recta tiene el control en el punto medio y una curva lo desplaza en perpendicular', () => {
    const a = { x: 0, y: 0 };
    const b = { x: 100, y: 0 };
    expect(edgeControl(a, b, 0)).toEqual({ x: 50, y: 0 });
    expect(edgeControl(a, b, 40)).toEqual({ x: 50, y: 40 });
    expect(edgeControl(a, a, 40)).toEqual({ x: 0, y: 0 });
    expect(edgePath(a, b, 0)).toBe('M 0 0 L 100 0');
    expect(edgePath(a, b, 40)).toBe('M 0 0 Q 50 40 100 0');
  });

  it('edgePoints empieza y termina en los extremos', () => {
    const pts = edgePoints({ x: 0, y: 0 }, { x: 100, y: 0 }, 40, 4);
    expect(pts).toHaveLength(5);
    expect(pts[0]).toEqual({ x: 0, y: 0 });
    expect(pts[4]).toEqual({ x: 100, y: 0 });
    expect(pts[2]).toEqual({ x: 50, y: 20 });
  });

  it('stepTrajectory va del origen al destino en los dos sentidos', () => {
    const web = ARCH_NODES.find((n) => n.id === 'web')!;
    const identity = ARCH_NODES.find((n) => n.id === 'identity')!;
    const ida = stepTrajectory(story.steps[0], ARCH_NODES);
    expect(ida[0]).toEqual({ x: web.x, y: web.y });
    expect(ida[ida.length - 1]).toEqual({ x: identity.x, y: identity.y });
    const vuelta = stepTrajectory({ ...story.steps[0], from: 'identity', to: 'web' }, ARCH_NODES);
    expect(vuelta[0]).toEqual({ x: identity.x, y: identity.y });
    expect(vuelta[vuelta.length - 1]).toEqual({ x: web.x, y: web.y });
  });

  it('stepTrajectory de un paso interno es un solo punto y de un nodo desconocido, ninguno', () => {
    const identity = ARCH_NODES.find((n) => n.id === 'identity')!;
    expect(stepTrajectory(story.steps[1], ARCH_NODES)).toEqual([{ x: identity.x, y: identity.y }]);
    expect(stepTrajectory(story.steps[0], [])).toEqual([]);
  });
});

describe('archSimReducer · Recorrer', () => {
  const start = initialArchSimState(story);

  it('avanza y retrocede sin salirse de la historia', () => {
    expect(isStepRevealed(start)).toBe(true);
    expect(run(start, { type: 'prev' })).toBe(start);
    const end = run(start, { type: 'next' }, { type: 'next' });
    expect(end.step).toBe(2);
    expect(run(end, { type: 'next' })).toBe(end);
    expect(run(end, { type: 'prev' }).step).toBe(1);
  });

  it('ignora las respuestas: en Recorrer no se adivina', () => {
    expect(run(start, { type: 'guess', node: 'identity' })).toBe(start);
  });

  it('cambiar de historia o reiniciar vuelve al primer paso y conserva el modo', () => {
    const moved = run(start, { type: 'next' });
    expect(run(moved, { type: 'restart' })).toEqual(start);
    const other = run(moved, { type: 'selectStory', story: ARCH_STORIES[0] });
    expect(other.step).toBe(0);
    expect(other.story).toBe(ARCH_STORIES[0]);
    expect(other.mode).toBe('recorrer');
  });

  it('cambiar de modo reinicia; repetir el mismo modo no', () => {
    const moved = run(start, { type: 'next' });
    expect(run(moved, { type: 'setMode', mode: 'recorrer' })).toBe(moved);
    const predecir = run(moved, { type: 'setMode', mode: 'predecir' });
    expect(predecir.mode).toBe('predecir');
    expect(predecir.step).toBe(0);
  });
});

describe('archSimReducer · Predecir', () => {
  const start = initialArchSimState(story, 'predecir');

  it('no avanza ni retrocede sin responder', () => {
    expect(isStepRevealed(start)).toBe(false);
    expect(run(start, { type: 'next' })).toBe(start);
    expect(run(start, { type: 'prev' })).toBe(start);
  });

  it('acierta, puntúa y no deja responder dos veces el mismo paso', () => {
    const hit = run(start, { type: 'guess', node: 'identity' });
    expect(hit).toMatchObject({ guess: 'identity', score: 100, streak: 1, hits: 1, asked: 1 });
    expect(isStepRevealed(hit)).toBe(true);
    expect(run(hit, { type: 'guess', node: 'web' })).toBe(hit);
  });

  it('un fallo corta la racha y no suma', () => {
    const miss = run(start, { type: 'guess', node: 'redis' });
    expect(miss).toMatchObject({ guess: 'redis', score: 0, streak: 0, hits: 0, asked: 1 });
  });

  it('los pasos internos no se preguntan y al final queda terminado', () => {
    const internal = run(start, { type: 'guess', node: 'identity' }, { type: 'next' });
    expect(internal.step).toBe(1);
    expect(isStepRevealed(internal)).toBe(true);
    expect(run(internal, { type: 'guess', node: 'identity' })).toBe(internal);
    const lastAsked = run(internal, { type: 'next' });
    expect(isStepRevealed(lastAsked)).toBe(false);
    const done = run(lastAsked, { type: 'guess', node: 'postgres' }, { type: 'next' });
    expect(done).toMatchObject({ finished: true, hits: 2, asked: 2, score: 200 });
    expect(run(done, { type: 'next' })).toBe(done);
    expect(run(done, { type: 'guess', node: 'web' })).toBe(done);
    expect(askedSteps(story)).toBe(2);
  });

  it('la racha multiplica desde el tercer acierto seguido', () => {
    const long: ArchStory = { ...story, steps: Array.from({ length: 3 }, () => story.steps[0]) };
    const s = run(
      initialArchSimState(long, 'predecir'),
      { type: 'guess', node: 'identity' },
      { type: 'next' },
      { type: 'guess', node: 'identity' },
      { type: 'next' },
      { type: 'guess', node: 'identity' },
    );
    expect(s.score).toBe(100 + 100 + 200);
  });
});
