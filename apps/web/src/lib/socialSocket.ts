/** Contrato del Canal Social (/ws/social): chat (con moderación y spoilers), reacciones, láser, encuestas, trivia y recap. */

export const CHAT_MAX_LENGTH = 280;
export const CHAT_HISTORY_LIMIT = 50;

export interface ChatMessage {
  event_id: string;
  type: 'chat_message';
  room_id: string;
  user_id: string;
  nick: string;
  text: string;
  /** Opcional y retrocompatible: el texto se muestra difuminado hasta revelarlo. */
  spoiler?: boolean;
  occurred_at: string;
  received_at: string;
}

export interface HistoryEnvelope {
  type: 'history';
  room_id: string;
  messages: ChatMessage[];
}

export interface SocialError {
  type: 'error';
  code: string;
  event_id_ref?: string;
  /** SLOW_MODE: cuánto falta para poder volver a escribir. */
  retry_after_ms?: number;
}

/** Ajustes del chat (autoritativos en social-core); llegan al unirse y en cada cambio. */
export interface ChatSettings {
  type: 'chat_settings';
  slow_mode_s: number;
  muted_user_ids: string[];
}

export const SLOW_MODE_OPTIONS = [
  { seconds: 0, label: 'Apagado' },
  { seconds: 5, label: '5 s' },
  { seconds: 10, label: '10 s' },
  { seconds: 30, label: '30 s' },
  { seconds: 60, label: '1 min' },
] as const;

/** Pregunta lanzada a todos (sin `correct`). `*_at_ms` son del reloj del servidor. */
export interface TriviaQuestion {
  type: 'trivia_question';
  trivia_id: string;
  question: string;
  options: string[];
  opens_at_ms: number;
  closes_at_ms: number;
}

/** Confirmación de la respuesta propia. */
export interface TriviaAck {
  type: 'trivia_ack';
  trivia_id: string;
  option: number;
  score: number;
}

export interface TriviaRankEntry {
  user_id: string;
  nick: string;
  score: number;
}

/** Cierre de la pregunta: correcta, top 10 y el puntaje propio. */
export interface TriviaResult {
  type: 'trivia_result';
  trivia_id: string;
  correct: number;
  /** Top de la pregunta (≤ 10). */
  top: TriviaRankEntry[];
  /** Acumulado de la sala (≤ 10). */
  leaderboard?: TriviaRankEntry[];
  my_score?: number;
  /** Total acumulado propio en la sala. */
  my_total?: number;
  /** Puesto propio en el acumulado (ausente si aún no tiene puntos). */
  my_rank?: number;
}

/** Ranking acumulado de la sala al entrar (persiste en Redis; ≤ 10 filas). */
export interface TriviaLeaderboard {
  type: 'trivia_leaderboard';
  leaderboard: TriviaRankEntry[];
  my_rank?: number;
  my_total?: number;
}

/** Pregunta programada por el host (solo el host la recibe, con `correct`). */
export interface ScheduledTrivia {
  trivia_id: string;
  at_ms: number;
  question: string;
  options: string[];
  correct: number;
  answer_window_s: number;
  status?: 'pending' | 'open' | 'closed';
}

export interface TriviaScheduleState {
  type: 'trivia_schedule_state';
  questions: ScheduledTrivia[];
}

export interface TriviaDraft {
  atMs: number;
  question: string;
  options: string[];
  correct: number;
  answerWindowS: number;
}

export const TRIVIA_QUESTION_MAX = 140;
export const TRIVIA_OPTION_MAX = 60;
export const TRIVIA_MIN_OPTIONS = 2;
export const TRIVIA_MAX_OPTIONS = 4;
export const TRIVIA_WINDOW_MIN_S = 10;
export const TRIVIA_WINDOW_MAX_S = 60;
export const TRIVIA_WINDOW_DEFAULT_S = 20;
/** social-core admite `at_ms` entre 0 y 24 h. */
export const TRIVIA_MAX_AT_MS = 24 * 3_600_000;

const SOCIAL_ERROR_MESSAGES: Record<string, string> = {
  SLOW_MODE: 'El chat está en modo lento: espera un momento para volver a escribir.',
  MUTED: 'El host te silenció; puedes leer el chat.',
  TRIVIA_NOT_FOUND: 'Esa pregunta ya no existe.',
  TRIVIA_CLOSED: 'Se acabó el tiempo para responder.',
  ALREADY_ANSWERED: 'Ya respondiste esta pregunta.',
  FORBIDDEN: 'No tienes permiso para hacer eso.',
  RATE_LIMITED: 'Vas muy rápido: ve más despacio.',
  UNAVAILABLE: 'El chat no está disponible ahora. Inténtalo en un momento.',
};

/** Mensaje simple para un `error{code}` del canal social. */
export function socialErrorMessage(code: string): string {
  return SOCIAL_ERROR_MESSAGES[code] ?? 'No se pudo completar la acción. Inténtalo de nuevo.';
}

export type NoticeKind = 'joined' | 'left';

export interface PresenceNotice {
  event_id: string;
  type: 'notice';
  room_id: string;
  user_id: string;
  nick: string;
  kind: NoticeKind;
  text: string;
  occurred_at: string;
}

/** Set de reacciones: REQ-20 (risa, susto, sorpresa, aplauso, corazón) más tristeza. */
export const REACTION_EMOJIS = ['👏', '😂', '😮', '😱', '❤️', '😢'] as const;
export type ReactionEmoji = (typeof REACTION_EMOJIS)[number];

export function isReactionEmoji(value: string): value is ReactionEmoji {
  return (REACTION_EMOJIS as readonly string[]).includes(value);
}

export interface ReactionBroadcast {
  event_id: string;
  type: 'reaction';
  room_id: string;
  user_id: string;
  nick: string;
  emoji: string;
  position_ms: number;
  occurred_at: string;
  received_at: string;
}

/** Punto del puntero láser del host (x, y normalizados 0..1 sobre el vídeo). */
export interface LaserBroadcast {
  type: 'laser';
  event_id: string;
  user_id: string;
  nick: string;
  x: number;
  y: number;
  /** true en el último punto del trazo (al soltar). */
  end: boolean;
}

/** Punto en memoria: los propios se pintan al enviarlos (`own`) y su eco se descarta. */
export interface LaserPoint extends LaserBroadcast {
  own?: boolean;
}

/** Estado de una encuesta (autoritativo en social-core). `option`/`my_vote` son índices de `options`. */
export interface PollState {
  type: 'poll_state';
  event_id?: string;
  room_id?: string;
  poll_id: string;
  question: string;
  options: string[];
  counts: number[];
  /** Unix ms (reloj del servidor): solo para mostrar la cuenta atrás. */
  closes_at_ms: number;
  closed: boolean;
  /** Solo en el poll_state dirigido a este cliente (al entrar o en respuesta a su voto). */
  my_vote?: number;
}

/** Encuesta para la UI: `my_vote` resuelto (último visto para ese poll_id, o null). */
export interface PollView extends Omit<PollState, 'my_vote'> {
  my_vote: number | null;
}

export const POLL_MIN_OPTIONS = 2;
export const POLL_MAX_OPTIONS = 4;
export const POLL_QUESTION_MAX = 140;
export const POLL_OPTION_MAX = 60;
export const POLL_DURATIONS_S = [30, 60, 120, 300] as const;

/** Infografía "Watch Party Recap" calculada por social-core (cada bloque puede ser null). */
export interface RecapMessage {
  type: 'recap';
  room_id: string;
  event_id_ref?: string;
  top_emoji_user: { user_id: string; nick: string; count: number } | null;
  most_paused: { position_ms: number; count: number } | null;
  peak_reactions: { position_ms: number; count: number; laughs: number } | null;
  totals: { reactions: number; pauses: number; rewinds: number; polls: number };
}

export type SocialIncoming =
  | ChatMessage
  | HistoryEnvelope
  | PresenceNotice
  | ReactionBroadcast
  | LaserBroadcast
  | PollState
  | RecapMessage
  | ChatSettings
  | TriviaQuestion
  | TriviaAck
  | TriviaResult
  | TriviaLeaderboard
  | TriviaScheduleState
  | SocialError;

export function newEventId(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `c-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
}

export function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

/** Coordenada normalizada con 4 decimales (frames pequeños a 30 puntos/s). */
const round4 = (value: number) => Math.round(clamp01(value) * 10_000) / 10_000;

/** Pre-validación del creador (social-core es quien decide); null si es válido. */
export function validatePollDraft(question: string, options: string[], durationS: number): string | null {
  const q = question.trim();
  if (!q) return 'Escribe la pregunta.';
  if (q.length > POLL_QUESTION_MAX) return `La pregunta admite hasta ${POLL_QUESTION_MAX} caracteres.`;
  if (options.length < POLL_MIN_OPTIONS || options.length > POLL_MAX_OPTIONS) {
    return `Añade entre ${POLL_MIN_OPTIONS} y ${POLL_MAX_OPTIONS} opciones.`;
  }
  const opts = options.map((o) => o.trim());
  if (opts.some((o) => !o)) return 'Completa todas las opciones.';
  if (opts.some((o) => o.length > POLL_OPTION_MAX)) return `Cada opción admite hasta ${POLL_OPTION_MAX} caracteres.`;
  if (new Set(opts.map((o) => o.toLowerCase())).size !== opts.length) return 'Las opciones deben ser distintas.';
  if (!(POLL_DURATIONS_S as readonly number[]).includes(durationS)) return 'Elige una duración válida.';
  return null;
}

/** Porcentaje entero de cada opción (0 si no hay votos). */
export function pollPercentages(counts: number[]): number[] {
  const total = counts.reduce((a, b) => a + b, 0);
  return counts.map((c) => (total > 0 ? Math.round((c / total) * 100) : 0));
}

export function buildPollCreate(
  roomId: string,
  question: string,
  options: string[],
  durationS: number,
  eventId = newEventId(),
): string {
  return JSON.stringify({
    type: 'poll_create',
    event_id: eventId,
    room_id: roomId,
    question: question.trim(),
    options: options.map((o) => o.trim()),
    duration_s: durationS,
  });
}

export function buildPollVote(roomId: string, pollId: string, option: number, eventId = newEventId()): string {
  return JSON.stringify({ type: 'poll_vote', event_id: eventId, room_id: roomId, poll_id: pollId, option });
}

export function buildPollClose(roomId: string, pollId: string, eventId = newEventId()): string {
  return JSON.stringify({ type: 'poll_close', event_id: eventId, room_id: roomId, poll_id: pollId });
}

export function buildRecapRequest(roomId: string, eventId = newEventId()): string {
  return JSON.stringify({ type: 'recap_request', event_id: eventId, room_id: roomId });
}

/** Posición del vídeo como mm:ss (los minutos pasan de 59 en vídeos largos). */
export function formatMmSs(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}

export function buildLaserPoint(roomId: string, x: number, y: number, end = false, eventId = newEventId()): string {
  const frame: Record<string, unknown> = { type: 'laser_point', event_id: eventId, room_id: roomId, x: round4(x), y: round4(y) };
  if (end) frame.end = true;
  return JSON.stringify(frame);
}

export function buildSocialUrl(base: string, roomId: string, token: string): string {
  const sep = base.includes('?') ? '&' : '?';
  return `${base}${sep}room_id=${encodeURIComponent(roomId)}&token=${encodeURIComponent(token)}`;
}

export function buildChatSend(roomId: string, text: string, spoiler = false): string {
  const frame: Record<string, unknown> = {
    event_id: newEventId(),
    type: 'chat_send',
    room_id: roomId,
    text: text.trim(),
    occurred_at: new Date().toISOString(),
  };
  if (spoiler) frame.spoiler = true;
  return JSON.stringify(frame);
}

export function buildChatSlowMode(roomId: string, seconds: number, eventId = newEventId()): string {
  return JSON.stringify({ type: 'chat_slow_mode', event_id: eventId, room_id: roomId, seconds });
}

export function buildChatMute(roomId: string, userId: string, muted: boolean, eventId = newEventId()): string {
  return JSON.stringify({ type: 'chat_mute', event_id: eventId, room_id: roomId, user_id: userId, muted });
}

/** Pre-validación de una pregunta de trivia (social-core decide); null si es válida. */
export function validateTriviaDraft(draft: TriviaDraft): string | null {
  const q = draft.question.trim();
  if (!q) return 'Escribe la pregunta.';
  if (q.length > TRIVIA_QUESTION_MAX) return `La pregunta admite hasta ${TRIVIA_QUESTION_MAX} caracteres.`;
  if (draft.options.length < TRIVIA_MIN_OPTIONS || draft.options.length > TRIVIA_MAX_OPTIONS) {
    return `Añade entre ${TRIVIA_MIN_OPTIONS} y ${TRIVIA_MAX_OPTIONS} opciones.`;
  }
  const opts = draft.options.map((o) => o.trim());
  if (opts.some((o) => !o)) return 'Completa todas las opciones.';
  if (opts.some((o) => o.length > TRIVIA_OPTION_MAX)) return `Cada opción admite hasta ${TRIVIA_OPTION_MAX} caracteres.`;
  if (new Set(opts.map((o) => o.toLowerCase())).size !== opts.length) return 'Las opciones deben ser distintas.';
  if (!Number.isInteger(draft.correct) || draft.correct < 0 || draft.correct >= opts.length) {
    return 'Marca la respuesta correcta.';
  }
  if (!Number.isFinite(draft.atMs) || draft.atMs < 0 || draft.atMs > TRIVIA_MAX_AT_MS) return 'Indica un momento válido del vídeo (mm:ss).';
  if (draft.answerWindowS < TRIVIA_WINDOW_MIN_S || draft.answerWindowS > TRIVIA_WINDOW_MAX_S) {
    return `El tiempo para responder debe estar entre ${TRIVIA_WINDOW_MIN_S} y ${TRIVIA_WINDOW_MAX_S} s.`;
  }
  return null;
}

/** "mm:ss" (o segundos sueltos) → ms; null si no es válido. */
export function parseMmSs(value: string): number | null {
  const v = value.trim();
  if (/^\d+$/.test(v)) return Number(v) * 1000;
  const m = /^(\d{1,4}):([0-5]\d)$/.exec(v);
  if (!m) return null;
  return (Number(m[1]) * 60 + Number(m[2])) * 1000;
}

export function buildTriviaSchedule(roomId: string, draft: TriviaDraft, eventId = newEventId()): string {
  return JSON.stringify({
    type: 'trivia_schedule',
    event_id: eventId,
    room_id: roomId,
    at_ms: Math.max(0, Math.round(draft.atMs)),
    question: draft.question.trim(),
    options: draft.options.map((o) => o.trim()),
    correct: draft.correct,
    answer_window_s: draft.answerWindowS,
  });
}

export function buildTriviaUpdate(roomId: string, triviaId: string, draft: TriviaDraft, eventId = newEventId()): string {
  return JSON.stringify({ ...JSON.parse(buildTriviaSchedule(roomId, draft, eventId)), type: 'trivia_update', trivia_id: triviaId });
}

export function buildTriviaDelete(roomId: string, triviaId: string, eventId = newEventId()): string {
  return JSON.stringify({ type: 'trivia_delete', event_id: eventId, room_id: roomId, trivia_id: triviaId });
}

export function buildTriviaList(roomId: string, eventId = newEventId()): string {
  return JSON.stringify({ type: 'trivia_list', event_id: eventId, room_id: roomId });
}

export function buildTriviaAnswer(roomId: string, triviaId: string, option: number, eventId = newEventId()): string {
  return JSON.stringify({ type: 'trivia_answer', event_id: eventId, room_id: roomId, trivia_id: triviaId, option });
}

/** Devuelve el mensaje parseado o null si no es un evento social conocido. */
export function parseSocialMessage(raw: string): SocialIncoming | null {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof data !== 'object' || data === null) return null;
  const type = (data as { type?: unknown }).type;
  if (
    type === 'chat_message' ||
    type === 'history' ||
    type === 'error' ||
    type === 'notice' ||
    type === 'reaction' ||
    type === 'laser' ||
    type === 'poll_state' ||
    type === 'recap' ||
    type === 'chat_settings' ||
    type === 'trivia_question' ||
    type === 'trivia_ack' ||
    type === 'trivia_result' ||
    type === 'trivia_leaderboard' ||
    type === 'trivia_schedule_state'
  ) {
    return data as SocialIncoming;
  }
  return null;
}

/** Arma un reaction_send con emoji y posición en ms (0 si se desconoce). */
export function buildReactionSend(roomId: string, emoji: string, positionMs = 0): string {
  const eventId =
    typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID()
      : `c-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
  return JSON.stringify({
    event_id: eventId,
    type: 'reaction_send',
    room_id: roomId,
    emoji,
    position_ms: Math.max(0, Math.floor(positionMs)),
    occurred_at: new Date().toISOString(),
  });
}

/** Texto del aviso de presencia según kind y nick (fallback al text del servidor). */
export function noticeText(msg: PresenceNotice): string {
  if (msg.kind === 'left') return `${msg.nick} salió del chat`;
  return `${msg.nick} entró al chat`;
}

/**
 * Formatea un ISO-8601 a HH:MM en hora local del navegador.
 * Retorna '' si la fecha es inválida o vacía.
 */
export function formatChatTime(iso: string): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
}
