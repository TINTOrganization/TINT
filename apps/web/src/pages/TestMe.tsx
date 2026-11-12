import { AnimatePresence, MotionConfig, motion } from 'framer-motion';
import { useEffect, useMemo, useState } from 'react';
import AnswerPanel from '../components/quiz/AnswerPanel';
import QuizCard from '../components/quiz/QuizCard';
import QuizSummary from '../components/quiz/QuizSummary';
import ScoreHud from '../components/quiz/ScoreHud';
import { QUIZ_CATEGORIES, quizQuestions, type QuizCategoryId } from '../data/quizQuestions';
import { useQuiz } from '../hooks/useQuiz';
import { BASE_POINTS, buildDeck, multiplierFor } from '../lib/quiz';
import { createQuizSounds } from '../lib/quizSounds';

type Filter = QuizCategoryId | 'all';

const FILTERS: { id: Filter; label: string }[] = [
  { id: 'all', label: `Todas (${quizQuestions.length})` },
  ...QUIZ_CATEGORIES.map((c) => ({ id: c.id, label: `${c.label} (${c.expected})` })),
];

// Ruta oculta /test-me: cuestionario para aprender cómo funciona el monorepo.
// No hay enlaces a ella desde ninguna vista; solo se llega por URL.
export default function TestMe() {
  const sounds = useMemo(() => createQuizSounds(), []);
  const [muted, setMuted] = useState(() => sounds.isMuted());
  const [filter, setFilter] = useState<Filter>('all');
  const [initialDeck] = useState(() => buildDeck(quizQuestions, 'all'));
  const { state, answer, next, restart } = useQuiz(initialDeck, sounds);

  const question = state.questions[state.index];
  const answered = state.selected !== null;
  const lastCorrect = answered && state.selected === question.answer;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const n = Number(e.key);
      if (n >= 1 && n <= 4) answer(n - 1);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [answer]);

  const choose = (f: Filter) => {
    setFilter(f);
    restart(buildDeck(quizQuestions, f));
  };

  const toggleMute = () => {
    sounds.setMuted(!muted);
    setMuted(!muted);
  };

  return (
    <MotionConfig reducedMotion="user">
      <main className={`min-h-[100dvh] bg-tint-bg px-4 py-8 text-tint-text ${answered ? 'pb-96' : ''}`}>
        <div className="mx-auto flex max-w-2xl flex-col gap-6">
          <header className="flex flex-col gap-2">
            <motion.p
              initial={{ opacity: 0, y: -6 }}
              animate={{ opacity: 1, y: 0 }}
              className="text-xs font-semibold uppercase tracking-[0.2em] text-tint-accent"
            >
              TINT · test-me
            </motion.p>
            <h1 className="text-2xl font-black text-white sm:text-3xl">¿Cuánto sabes de TINT?</h1>
            <p className="text-sm text-tint-muted">
              Arquitectura, librerías, APIs y procesos del monorepo. Responde con clic o con las teclas 1–4. Si prefieres
              verlo antes,{' '}
              <a href="/arquitectura" className="text-tint-accentHover underline underline-offset-2 hover:text-white">
                recorre el mapa de la arquitectura
              </a>
              .
            </p>
          </header>

          <nav aria-label="Categorías" className="flex flex-wrap gap-2">
            {FILTERS.map((f) => (
              <button
                key={f.id}
                type="button"
                aria-pressed={filter === f.id}
                onClick={() => choose(f.id)}
                className={`rounded-full border px-3 py-1.5 text-xs font-medium transition focus:outline-none focus-visible:ring-2 focus-visible:ring-tint-accent ${
                  filter === f.id
                    ? 'border-tint-accent bg-tint-accent text-tint-bg'
                    : 'border-white/10 bg-white/5 text-tint-muted hover:text-white'
                }`}
              >
                {f.label}
              </button>
            ))}
          </nav>

          <ScoreHud
            score={state.score}
            streak={state.streak}
            answered={state.results.length}
            total={state.questions.length}
            muted={muted}
            onToggleMute={toggleMute}
          />

          <AnimatePresence mode="wait" initial={false}>
            {state.finished ? (
              <QuizSummary
                key="summary"
                score={state.score}
                bestStreak={state.bestStreak}
                results={state.results}
                onRestart={() => restart(buildDeck(quizQuestions, filter))}
              />
            ) : (
              <QuizCard
                key={question.id}
                question={question}
                number={state.index + 1}
                total={state.questions.length}
                selected={state.selected}
                onAnswer={answer}
              />
            )}
          </AnimatePresence>
        </div>

        <AnimatePresence>
          {answered && !state.finished && (
            <AnswerPanel
              key={question.id}
              question={question}
              selected={state.selected!}
              gained={lastCorrect ? BASE_POINTS * multiplierFor(state.streak) : 0}
              isLast={state.index === state.questions.length - 1}
              onNext={next}
            />
          )}
        </AnimatePresence>
      </main>
    </MotionConfig>
  );
}
