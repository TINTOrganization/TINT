import { MotionConfig } from 'framer-motion';
import { useEffect, useReducer, useState } from 'react';
import ArchDiagram from '../components/arch/ArchDiagram';
import NodeCard from '../components/arch/NodeCard';
import RelatedQuiz from '../components/arch/RelatedQuiz';
import StepPanel from '../components/arch/StepPanel';
import { Button } from '../components/ui/Button';
import { ARCH_CONNECTORS, ARCH_NODES, type ArchNodeId } from '../data/architecture';
import { ARCH_STORIES } from '../data/architectureStories';
import { archSimReducer, askedSteps, initialArchSimState, isInternalStep, isStepRevealed, type ArchMode } from '../lib/archSim';

const MODES: { id: ArchMode; label: string; hint: string }[] = [
  { id: 'recorrer', label: 'Recorrer', hint: 'Avanza paso a paso y mira por dónde viaja cada mensaje.' },
  { id: 'predecir', label: 'Predecir', hint: 'Antes de cada salto, haz clic en el componente que recibe el mensaje.' },
];

const chip = (active: boolean) =>
  `rounded-full border px-3 py-1.5 text-xs font-medium transition focus:outline-none focus-visible:ring-2 focus-visible:ring-tint-accent ${
    active ? 'border-tint-accent bg-tint-accent text-tint-bg' : 'border-white/10 bg-white/5 text-tint-muted hover:text-white'
  }`;

const nodeOf = (id: ArchNodeId) => ARCH_NODES.find((n) => n.id === id)!;

// Ruta oculta /arquitectura: el diagrama de componentes y conectores de TINT y cinco
// historias de usuario que se recorren salto a salto. Hermana de /test-me; sin enlaces desde la UI.
export default function Arquitectura() {
  const [state, dispatch] = useReducer(archSimReducer, ARCH_STORIES[0], initialArchSimState);
  const [selected, setSelected] = useState<ArchNodeId | null>(null);

  const { story, mode, finished } = state;
  const step = story.steps[state.step];
  const revealed = isStepRevealed(state);
  const internal = isInternalStep(step);
  const lastStep = state.step === story.steps.length - 1;
  const predicting = mode === 'predecir' && !revealed && !finished;
  const from = nodeOf(step.from);
  const to = nodeOf(step.to);
  const connector = ARCH_CONNECTORS.find((c) => c.id === step.connector) ?? null;
  const canNext = revealed && !finished && !(mode === 'recorrer' && lastStep);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === 'ArrowRight') dispatch({ type: 'next' });
      else if (e.key === 'ArrowLeft') dispatch({ type: 'prev' });
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const onNodeClick = (id: ArchNodeId) => {
    if (predicting) dispatch({ type: 'guess', node: id });
    else setSelected((current) => (current === id ? null : id));
  };

  const status = () => {
    if (finished) return `Historia completa: ${state.hits} de ${state.asked} aciertos.`;
    if (predicting) return `${step.ask} Sale de ${from.label}.`;
    if (mode === 'predecir' && !internal) {
      return state.guess === step.to ? `¡Correcto! Va a ${to.label}.` : `No era ${nodeOf(state.guess!).label}: va a ${to.label}.`;
    }
    return internal ? `Paso interno en ${from.label}.` : `${from.label} → ${to.label}`;
  };

  return (
    <MotionConfig reducedMotion="user">
      <main className="min-h-[100dvh] bg-tint-bg px-4 py-8 text-tint-text">
        <div className="mx-auto flex max-w-6xl flex-col gap-6">
          <header className="flex flex-col gap-2">
            <p className="text-xs font-semibold uppercase tracking-[0.2em] text-tint-accent">TINT · arquitectura</p>
            <h1 className="text-2xl font-black text-white sm:text-3xl">¿Por dónde viajan los datos?</h1>
            <p className="max-w-2xl text-sm text-tint-muted">
              Elige una historia de usuario y síguela por los componentes y conectores de la plataforma. Cuando la tengas clara,{' '}
              <a href="/test-me" className="text-tint-accentHover underline underline-offset-2 hover:text-white">
                ponte a prueba en /test-me
              </a>
              .
            </p>
          </header>

          <div className="flex flex-col gap-3">
            <div role="group" aria-label="Modo" className="flex flex-wrap items-center gap-2">
              {MODES.map((m) => (
                <button
                  key={m.id}
                  type="button"
                  aria-pressed={mode === m.id}
                  onClick={() => {
                    setSelected(null);
                    dispatch({ type: 'setMode', mode: m.id });
                  }}
                  className={chip(mode === m.id)}
                >
                  {m.label}
                </button>
              ))}
              <span className="text-xs text-tint-muted">{MODES.find((m) => m.id === mode)!.hint}</span>
            </div>

            <nav aria-label="Historias" className="flex flex-wrap gap-2">
              {ARCH_STORIES.map((s) => (
                <button
                  key={s.id}
                  type="button"
                  aria-pressed={story.id === s.id}
                  onClick={() => {
                    setSelected(null);
                    dispatch({ type: 'selectStory', story: s });
                  }}
                  className={chip(story.id === s.id)}
                >
                  {s.title}
                </button>
              ))}
            </nav>
            <p className="max-w-3xl text-sm text-tint-text">
              <span className="font-semibold text-white">{story.actor}.</span> {story.summary}
            </p>
          </div>

          <div className="flex flex-col gap-3 rounded-2xl border border-white/10 bg-tint-surface p-4 sm:flex-row sm:items-center sm:justify-between">
            <div className="min-w-0">
              <p className="text-xs font-medium uppercase tracking-wide text-tint-muted">
                Paso {state.step + 1} de {story.steps.length}
                {mode === 'predecir' && (
                  <>
                    {' · '}
                    <span aria-label="Puntos" className="font-bold tabular-nums text-white">
                      {state.score}
                    </span>{' '}
                    pts · {state.hits} de {askedSteps(story)} aciertos
                  </>
                )}
              </p>
              <p role="status" className="mt-1 break-words text-sm font-semibold text-white sm:text-base">
                {status()}
              </p>
              {predicting && <p className="mt-1 text-xs text-tint-muted">Haz clic en el componente del diagrama que lo recibe.</p>}
            </div>
            <div className="flex shrink-0 flex-wrap gap-2">
              {mode === 'recorrer' && (
                <Button variant="ghost" size="sm" disabled={state.step === 0} onClick={() => dispatch({ type: 'prev' })}>
                  Anterior
                </Button>
              )}
              <Button size="sm" disabled={!canNext} onClick={() => dispatch({ type: 'next' })}>
                {mode === 'predecir' && lastStep ? 'Ver resultado' : 'Siguiente'}
              </Button>
              <Button variant="quiet" size="sm" onClick={() => dispatch({ type: 'restart' })}>
                Reiniciar
              </Button>
            </div>
          </div>

          <div className="grid grid-cols-[minmax(0,1fr)] items-start gap-6 lg:grid-cols-[minmax(0,1fr)_22rem]">
            <ArchDiagram
              nodes={ARCH_NODES}
              connectors={ARCH_CONNECTORS}
              step={revealed && !finished ? step : null}
              origin={predicting ? step.from : null}
              selected={selected}
              guess={finished ? null : state.guess}
              packetKey={`${mode}-${story.id}-${state.step}`}
              nodeAction={predicting ? 'Responder' : 'Ver ficha de'}
              onNodeClick={onNodeClick}
            />

            <div className="flex min-w-0 flex-col gap-4">
              {finished ? (
                <section aria-label="Resultado" className="flex flex-col gap-3 rounded-2xl border border-white/10 bg-tint-card/70 p-5">
                  <h2 className="text-lg font-bold text-white">
                    {state.hits} de {state.asked} saltos acertados
                  </h2>
                  <p className="text-sm text-tint-text">
                    {state.score} puntos. Ahora responde las preguntas del test que tocan esta historia.
                  </p>
                </section>
              ) : revealed ? (
                <StepPanel step={step} from={from} to={to} connector={connector} />
              ) : (
                <p className="rounded-2xl border border-dashed border-white/15 p-5 text-sm text-tint-muted">
                  La explicación del paso aparece cuando respondas.
                </p>
              )}
              {selected && <NodeCard node={nodeOf(selected)} connectors={ARCH_CONNECTORS} onClose={() => setSelected(null)} />}
            </div>
          </div>

          {finished && (
            <div className="mx-auto w-full max-w-2xl">
              <RelatedQuiz key={story.id} quizIds={story.quizIds} />
            </div>
          )}
        </div>
      </main>
    </MotionConfig>
  );
}
