import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { useCountdown } from '../../hooks/useCountdown';
import type { TriviaView } from '../../hooks/useSocialSocket';
import {
  formatMmSs,
  parseMmSs,
  socialErrorMessage,
  TRIVIA_MAX_OPTIONS,
  TRIVIA_MIN_OPTIONS,
  TRIVIA_OPTION_MAX,
  TRIVIA_QUESTION_MAX,
  TRIVIA_WINDOW_DEFAULT_S,
  validateTriviaDraft,
  type ScheduledTrivia,
  type TriviaDraft,
} from '../../lib/socialSocket';
import { Button } from '../ui/Button';

/** Errores del canal que conciernen a la trivia. */
const TRIVIA_ERRORS = new Set(['TRIVIA_NOT_FOUND', 'TRIVIA_CLOSED', 'ALREADY_ANSWERED']);
const WINDOW_OPTIONS_S = [10, 20, 30, 45, 60];
const TOP_LIMIT = 10;
const STATUS_LABELS = { pending: 'Pendiente', open: 'En curso', closed: 'Terminada' } as const;

function Ranking({ label, entries }: { label: string; entries: { user_id: string; nick: string; score: number }[] }) {
  return (
    <ol aria-label={label} className="mt-1 space-y-1">
      {entries.slice(0, TOP_LIMIT).map((entry, i) => (
        <li key={entry.user_id} className="flex justify-between gap-3 rounded-lg bg-white/5 px-3 py-1 text-[13px]">
          <span className="truncate text-white">
            <span className="mr-2 tabular-nums text-tint-muted">{i + 1}.</span>
            {entry.nick}
          </span>
          <span className="tabular-nums text-tint-accent">{entry.score}</span>
        </li>
      ))}
    </ol>
  );
}

const inputClass =
  'w-full rounded-xl border border-white/10 bg-tint-bg px-3 py-2 text-sm text-white placeholder:text-tint-muted/60 focus:border-tint-accent focus:outline-none focus-visible:ring-2 focus-visible:ring-tint-accent/60';

export interface TriviaPanelProps {
  isHost: boolean;
  /** Agenda del host (ordenada por `at_ms`). */
  schedule: ScheduledTrivia[];
  /** Posición actual del vídeo en ms (null si no hay vídeo). */
  getCurrentMs: () => number | null;
  onSchedule: (draft: TriviaDraft) => boolean;
  /** Reemplaza una pregunta pendiente por su nueva versión. */
  onUpdate: (triviaId: string, draft: TriviaDraft) => boolean;
  onDelete: (triviaId: string) => boolean;
  /** Último `error.code` del canal social. */
  error: string | null;
}

/** Formulario en curso: nueva pregunta (en `atMs`) o edición de una pendiente. */
type FormTarget = { kind: 'new'; atMs: number } | { kind: 'edit'; trivia: ScheduledTrivia };

function TriviaForm({
  target,
  onSubmit,
  onCancel,
}: {
  target: FormTarget;
  onSubmit: (draft: TriviaDraft) => boolean;
  onCancel: () => void;
}) {
  const editing = target.kind === 'edit' ? target.trivia : null;
  const [time, setTime] = useState(() => formatMmSs(editing ? editing.at_ms : target.kind === 'new' ? target.atMs : 0));
  const [question, setQuestion] = useState(editing?.question ?? '');
  const [options, setOptions] = useState(editing ? [...editing.options] : ['', '']);
  const [correct, setCorrect] = useState(editing?.correct ?? 0);
  const [windowS, setWindowS] = useState(editing?.answer_window_s ?? TRIVIA_WINDOW_DEFAULT_S);
  const [error, setError] = useState('');
  const questionRef = useRef<HTMLInputElement>(null);
  const ids = { time: useId(), question: useId(), window: useId(), correct: useId() };

  useEffect(() => questionRef.current?.focus(), []);

  const removeOption = (index: number) => {
    setOptions((list) => list.filter((_, i) => i !== index));
    setCorrect((c) => (c === index ? 0 : c > index ? c - 1 : c));
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const atMs = parseMmSs(time);
    if (atMs === null) {
      setError('Escribe el momento como mm:ss (por ejemplo 01:30).');
      return;
    }
    const draft: TriviaDraft = { atMs, question: question.trim(), options: options.map((o) => o.trim()), correct, answerWindowS: windowS };
    const invalid = validateTriviaDraft(draft);
    if (invalid) {
      setError(invalid);
      return;
    }
    if (!onSubmit(draft)) {
      setError('Sin conexión con la sala. Inténtalo de nuevo en un momento.');
      return;
    }
    onCancel();
  };

  return (
    <form onSubmit={submit} className="mt-4 flex flex-col gap-3 rounded-xl border border-white/10 p-4" noValidate>
      <div className="grid gap-3 sm:grid-cols-[8rem_1fr]">
        <div>
          <label htmlFor={ids.time} className="text-[13px] font-medium text-white">
            Momento del vídeo (mm:ss)
          </label>
          <input
            id={ids.time}
            value={time}
            onChange={(e) => setTime(e.target.value)}
            inputMode="numeric"
            autoComplete="off"
            className={`${inputClass} mt-1 tabular-nums`}
          />
        </div>
        <div>
          <label htmlFor={ids.question} className="text-[13px] font-medium text-white">
            Pregunta de trivia
          </label>
          <input
            id={ids.question}
            ref={questionRef}
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            maxLength={TRIVIA_QUESTION_MAX}
            placeholder="¿Quién dijo la frase final?"
            autoComplete="off"
            className={`${inputClass} mt-1`}
          />
        </div>
      </div>

      <fieldset className="flex flex-col gap-2">
        <legend className="text-[13px] font-medium text-white">Respuestas (marca la correcta)</legend>
        {options.map((value, i) => (
          <div key={i} className="flex items-center gap-2">
            <input
              type="radio"
              name={ids.correct}
              checked={correct === i}
              onChange={() => setCorrect(i)}
              aria-label={`Respuesta ${i + 1} es la correcta`}
              className="h-4 w-4 accent-tint-accent"
            />
            <label htmlFor={`${ids.correct}-${i}`} className="sr-only">
              Respuesta {i + 1}
            </label>
            <input
              id={`${ids.correct}-${i}`}
              value={value}
              onChange={(e) => setOptions((list) => list.map((o, j) => (j === i ? e.target.value : o)))}
              maxLength={TRIVIA_OPTION_MAX}
              placeholder={`Respuesta ${i + 1}`}
              autoComplete="off"
              className={inputClass}
            />
            {options.length > TRIVIA_MIN_OPTIONS && (
              <Button
                type="button"
                variant="quiet"
                className="px-2 py-1 text-[13px]"
                aria-label={`Quitar respuesta ${i + 1}`}
                onClick={() => removeOption(i)}
              >
                ✕
              </Button>
            )}
          </div>
        ))}
        {options.length < TRIVIA_MAX_OPTIONS && (
          <Button
            type="button"
            variant="quiet"
            className="self-start px-3 py-1.5 text-[13px]"
            onClick={() => setOptions((list) => [...list, ''])}
          >
            Añadir respuesta
          </Button>
        )}
      </fieldset>

      <div className="flex items-center gap-2 text-[13px]">
        <label htmlFor={ids.window} className="text-white">
          Tiempo para responder
        </label>
        <select
          id={ids.window}
          value={windowS}
          onChange={(e) => setWindowS(Number(e.target.value))}
          className="rounded-lg border border-white/10 bg-tint-bg px-2 py-1 text-white focus:border-tint-accent focus:outline-none focus-visible:ring-2 focus-visible:ring-tint-accent/60"
        >
          {WINDOW_OPTIONS_S.map((s) => (
            <option key={s} value={s}>
              {s} s
            </option>
          ))}
        </select>
      </div>

      {error && (
        <p role="alert" className="text-[13px] text-red-300">
          {error}
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        <Button type="submit">{editing ? 'Guardar cambios' : 'Programar pregunta'}</Button>
        <Button type="button" variant="quiet" onClick={onCancel}>
          Cancelar
        </Button>
      </div>
    </form>
  );
}

/** Tarjeta de trivia: el host programa preguntas por momento del vídeo; el invitado ve cómo jugar. */
export function TriviaPanel({ isHost, schedule, getCurrentMs, onSchedule, onUpdate, onDelete, error }: TriviaPanelProps) {
  const [form, setForm] = useState<FormTarget | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const channelError = error && TRIVIA_ERRORS.has(error) ? socialErrorMessage(error) : '';

  if (!isHost) {
    return (
      <div>
        <h2 className="text-[15px] font-semibold text-white">Trivia</h2>
        <p className="mt-1 text-[13px] leading-relaxed">
          Durante la película aparecerán preguntas sobre el reproductor. ¡Responde rápido para sumar más puntos!
        </p>
      </div>
    );
  }

  const closeForm = () => {
    setForm(null);
    triggerRef.current?.focus();
  };

  return (
    <div>
      <h2 className="text-[15px] font-semibold text-white">Trivia</h2>
      <p className="mt-1 text-[13px] leading-relaxed">
        Programa preguntas en momentos del vídeo: aparecerán a todos justo en ese segundo.
      </p>
      {form === null ? (
        <Button
          ref={triggerRef}
          variant="ghost"
          className="mt-3"
          onClick={() => setForm({ kind: 'new', atMs: Math.max(0, getCurrentMs() ?? 0) })}
        >
          Agregar pregunta en este momento
        </Button>
      ) : (
        <TriviaForm
          key={form.kind === 'edit' ? form.trivia.trivia_id : 'new'}
          target={form}
          onSubmit={form.kind === 'edit' ? (draft) => onUpdate(form.trivia.trivia_id, draft) : onSchedule}
          onCancel={closeForm}
        />
      )}

      {channelError && (
        <p role="alert" className="mt-3 text-[13px] text-red-300">
          {channelError}
        </p>
      )}

      {schedule.length === 0 ? (
        <p className="mt-4 text-[13px] text-tint-muted">Aún no hay preguntas programadas.</p>
      ) : (
        <ul aria-label="Preguntas programadas" className="mt-4 space-y-2">
          {schedule.map((q) => (
            <li key={q.trivia_id} className="flex items-start justify-between gap-3 rounded-xl bg-white/5 px-3 py-2">
              <div className="min-w-0">
                <p className="text-[13px] text-white">
                  <span className="mr-2 font-mono tabular-nums text-tint-accent">{formatMmSs(q.at_ms)}</span>
                  {q.question}
                </p>
                <p className="mt-0.5 truncate text-[12px] text-tint-muted">
                  {STATUS_LABELS[q.status ?? 'pending']} · Correcta: {q.options[q.correct] ?? '—'} · {q.options.length}{' '}
                  respuestas
                </p>
              </div>
              <div className="flex shrink-0 gap-1">
                {(q.status ?? 'pending') === 'pending' && (
                  <Button
                    variant="quiet"
                    className="px-3 py-1.5 text-[13px]"
                    aria-label={`Editar la pregunta de ${formatMmSs(q.at_ms)}`}
                    onClick={() => setForm({ kind: 'edit', trivia: q })}
                  >
                    Editar
                  </Button>
                )}
                <Button
                  variant="quiet"
                  className="px-3 py-1.5 text-[13px]"
                  aria-label={`Eliminar la pregunta de ${formatMmSs(q.at_ms)}`}
                  onClick={() => onDelete(q.trivia_id)}
                >
                  Eliminar
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export interface TriviaPopupProps {
  trivia: TriviaView;
  isHost: boolean;
  onAnswer: (triviaId: string, option: number) => boolean;
  onDismiss: () => void;
  error: string | null;
}

/**
 * Tarjeta emergente sobre el reproductor: pregunta con cuenta regresiva (anclada al reloj
 * local de llegada) y, al cierre, la respuesta correcta, los puntos propios y el top 10.
 */
export function TriviaPopup({ trivia, isHost, onAnswer, onDismiss, error }: TriviaPopupProps) {
  const { question, receivedAt, result, myOption, ack } = trivia;
  const until = question && receivedAt !== null ? receivedAt + Math.max(0, question.closes_at_ms - question.opens_at_ms) : null;
  const remaining = useCountdown(result ? null : until);
  if (!question) return null;
  const timeUp = remaining === 0;
  const answered = myOption !== null;
  const channelError = error && TRIVIA_ERRORS.has(error) ? socialErrorMessage(error) : '';

  return (
    <section
      role="region"
      aria-label="Trivia"
      aria-live="polite"
      className="tint-glass-panel absolute inset-x-3 bottom-16 z-30 mx-auto max-w-md rounded-2xl !border-tint-accent/40 p-4 sm:inset-x-auto sm:right-4"
    >
      {result ? (
        <div>
          <div className="flex items-start justify-between gap-3">
            <p className="text-[11px] uppercase tracking-[0.16em] text-tint-accent">Resultado de la trivia</p>
            <Button variant="quiet" className="px-3 py-1 text-[13px]" aria-label="Cerrar trivia" onClick={onDismiss}>
              Cerrar
            </Button>
          </div>
          <p className="mt-1 text-sm text-white">{question.question}</p>
          <p className="mt-2 text-[13px]">
            <span className="text-tint-muted">Respuesta correcta:</span>{' '}
            <strong className="text-emerald-300">{question.options[result.correct] ?? '—'}</strong>
          </p>
          {!isHost && (
            <p className="mt-1 text-[13px] text-white">
              {!answered
                ? 'No respondiste esta vez.'
                : myOption === result.correct
                  ? `¡Acertaste! Tus puntos: ${result.my_score ?? ack?.score ?? 0}`
                  : `Esta vez no. Tus puntos: ${result.my_score ?? ack?.score ?? 0}`}
            </p>
          )}
          {!isHost && typeof result.my_total === 'number' && (
            <p className="mt-0.5 text-[12px] text-tint-muted">Total en la sala: {result.my_total}</p>
          )}
          {result.top.length === 0 ? (
            <p className="mt-3 text-[13px] text-tint-muted">Nadie sumó puntos en esta pregunta.</p>
          ) : (
            <div className="mt-3">
              <p className="text-[12px] font-semibold text-white">Top de esta pregunta</p>
              <Ranking label="Top 10" entries={result.top} />
            </div>
          )}
          {result.leaderboard && result.leaderboard.length > 0 && (
            <div className="mt-3">
              <p className="text-[12px] font-semibold text-white">Ranking de la sala</p>
              <Ranking label="Ranking de la sala" entries={result.leaderboard} />
            </div>
          )}
        </div>
      ) : (
        <div>
          <div className="flex items-center justify-between gap-3">
            <p className="text-[12px] font-semibold text-tint-accent">¡Responde rápido: más puntos!</p>
            <span role="timer" aria-label="Tiempo restante" className="rounded-full bg-white/10 px-2.5 py-0.5 text-[13px] font-semibold tabular-nums text-white">
              {remaining} s
            </span>
          </div>
          <p className="mt-2 text-[15px] font-semibold text-white">{question.question}</p>
          {isHost ? (
            <p className="mt-2 text-[13px] text-tint-muted">Pregunta en curso: tus invitados están respondiendo.</p>
          ) : (
            <div className="mt-3 grid gap-2 sm:grid-cols-2">
              {question.options.map((option, i) => (
                <button
                  key={i}
                  type="button"
                  aria-pressed={myOption === i}
                  disabled={answered || timeUp}
                  onClick={() => onAnswer(question.trivia_id, i)}
                  className={`rounded-xl border px-3 py-2 text-left text-sm font-medium transition focus:outline-none focus-visible:ring-2 focus-visible:ring-tint-accent/60 disabled:cursor-not-allowed ${
                    myOption === i
                      ? 'border-tint-accent bg-tint-accent/25 text-white'
                      : 'border-white/15 bg-white/5 text-white hover:bg-white/10 disabled:opacity-60'
                  }`}
                >
                  {option}
                </button>
              ))}
            </div>
          )}
          {!isHost && answered && <p className="mt-2 text-[13px] text-tint-muted">Respuesta enviada. Espera el resultado…</p>}
          {!isHost && !answered && timeUp && (
            <p className="mt-2 text-[13px] text-tint-muted">Se acabó el tiempo. Esperando el resultado…</p>
          )}
        </div>
      )}
      {channelError && (
        <p role="alert" className="mt-2 text-[13px] text-red-300">
          {channelError}
        </p>
      )}
    </section>
  );
}
