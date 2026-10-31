import { AnimatePresence } from 'framer-motion';
import { useMemo, useState } from 'react';
import { quizQuestions } from '../../data/quizQuestions';
import { useQuiz } from '../../hooks/useQuiz';
import { BASE_POINTS, multiplierFor, shuffleOptions } from '../../lib/quiz';
import { createQuizSounds } from '../../lib/quizSounds';
import AnswerPanel from '../quiz/AnswerPanel';
import QuizCard from '../quiz/QuizCard';

/** Preguntas de /test-me relacionadas con la historia que se acaba de recorrer. */
export default function RelatedQuiz({ quizIds }: { quizIds: string[] }) {
  const sounds = useMemo(() => createQuizSounds(), []);
  const [deck] = useState(() =>
    quizIds.flatMap((id) => {
      const q = quizQuestions.find((x) => x.id === id);
      return q ? [shuffleOptions(q)] : [];
    }),
  );
  const { state, answer, next } = useQuiz(deck, sounds);

  if (deck.length === 0) return null;

  const question = state.questions[state.index];
  const answered = state.selected !== null;
  const hits = state.results.filter((r) => r.correct).length;

  if (state.finished) {
    return (
      <p role="status" className="rounded-2xl border border-white/10 bg-tint-card/70 p-5 text-sm text-tint-text">
        Preguntas del test: {hits} de {deck.length} correctas.
      </p>
    );
  }

  return (
    <div className={answered ? 'pb-96' : ''}>
      <QuizCard question={question} number={state.index + 1} total={deck.length} selected={state.selected} onAnswer={answer} />
      <AnimatePresence>
        {answered && (
          <AnswerPanel
            key={question.id}
            question={question}
            selected={state.selected!}
            gained={state.selected === question.answer ? BASE_POINTS * multiplierFor(state.streak) : 0}
            isLast={state.index === deck.length - 1}
            onNext={next}
          />
        )}
      </AnimatePresence>
    </div>
  );
}
