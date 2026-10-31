import { useCallback, useEffect, useRef, useState } from 'react';
import { apiFetch } from '../lib/api';
import { errorStatus } from '../lib/errorStatus';
import { getLocalIdentity } from '../lib/identity';
import {
  buildChatMute,
  buildChatSend,
  buildChatSlowMode,
  buildTriviaAnswer,
  buildTriviaDelete,
  buildTriviaList,
  buildTriviaSchedule,
  buildTriviaUpdate,
  SLOW_MODE_OPTIONS,
  validateTriviaDraft,
  type ChatSettings,
  type ScheduledTrivia,
  type TriviaAck,
  type TriviaDraft,
  type TriviaRankEntry,
  type TriviaQuestion,
  type TriviaResult,
  buildLaserPoint,
  buildPollClose,
  buildPollCreate,
  buildPollVote,
  buildRecapRequest,
  buildReactionSend,
  buildSocialUrl,
  CHAT_HISTORY_LIMIT,
  clamp01,
  isReactionEmoji,
  newEventId,
  parseSocialMessage,
  validatePollDraft,
  type ChatMessage,
  type LaserPoint,
  type PollState,
  type PollView,
  type RecapMessage,
  type PresenceNotice,
  type ReactionBroadcast,
  type ReactionEmoji,
} from '../lib/socialSocket';

/** Mensaje visible en el chat: texto o aviso de presencia. */
export type SocialChatItem = ChatMessage | PresenceNotice;

/** Tope de reacciones en memoria para el overlay (efímeras, fuera del chat). */
export const REACTION_STREAM_LIMIT = 30;
/** Puntos del láser en memoria (~2 s a 30 puntos/s; el overlay acumula su propio trazo y lo desvanece en 2,5 s). */
export const LASER_STREAM_LIMIT = 64;

export type SocialStatus = 'connecting' | 'open' | 'reconnecting' | 'closed';

/** Último `error{code, event_id_ref}` de social-core (FORBIDDEN, POLL_ACTIVE, POLL_CLOSED…). */
export interface SocialErrorInfo {
  code: string;
  event_id_ref?: string;
  retry_after_ms?: number;
}

export type ChatSettingsView = Omit<ChatSettings, 'type'>;

/** Trivia activa: `receivedAt` (reloj local) ancla la cuenta regresiva sin comparar relojes. */
export interface TriviaView {
  question: TriviaQuestion | null;
  receivedAt: number | null;
  ack: TriviaAck | null;
  result: TriviaResult | null;
  /** Opción elegida (optimista hasta el ack). */
  myOption: number | null;
}

/** Ranking acumulado de la sala: visible siempre, no depende de la pregunta en pantalla. */
export interface TriviaLeaderboardView {
  entries: TriviaRankEntry[];
  myRank: number | null;
  myTotal: number | null;
}

const EMPTY_LEADERBOARD: TriviaLeaderboardView = { entries: [], myRank: null, myTotal: null };
const EMPTY_TRIVIA: TriviaView = { question: null, receivedAt: null, ack: null, result: null, myOption: null };
const DEFAULT_CHAT_SETTINGS: ChatSettingsView = { slow_mode_s: 0, muted_user_ids: [] };

function normalizeChatSettings(msg: Partial<ChatSettings>): ChatSettingsView {
  return {
    slow_mode_s: typeof msg.slow_mode_s === 'number' && msg.slow_mode_s > 0 ? msg.slow_mode_s : 0,
    muted_user_ids: Array.isArray(msg.muted_user_ids)
      ? msg.muted_user_ids.filter((id): id is string => typeof id === 'string')
      : [],
  };
}

interface UseSocialSocketOptions {
  /** Factoría inyectable para tests (por defecto el WebSocket global). */
  createSocket?: (url: string) => WebSocket;
  baseUrl?: string;
  maxMessages?: number;
  reconnectBaseMs?: number;
  reconnectMaxMs?: number;
  /**
   * Credencial del canal. `host` → sync-ticket fresco de identity-api en cada (re)conexión
   * (social-core solo acepta láser y encuestas con tokens HS256 de host/cohost, no el ID
   * token de Firebase); `guest` → `tint_guest_token`. Sin rol: el token guardado.
   */
  role?: 'host' | 'guest';
}

function resolveToken(): string {
  return (
    localStorage.getItem('tint_token') || localStorage.getItem('tint_guest_token') || ''
  );
}

/** Sync-ticket rechazado sin remedio: no es el dueño (403) o la sala no existe (404/410). */
const FATAL_TICKET_STATUS = [403, 404, 410];

const SEEN_CAP = 200;

function resolveBaseUrl(override?: string): string {
  if (override) return override;
  return import.meta.env.VITE_SOCIAL_WS_URL || 'ws://localhost:8082/ws/social';
}

/**
 * Canal Social (/ws/social) solo-chat: historial al entrar + broadcast en vivo,
 * con reconexión exponencial sin tumbar el reproductor.
 */
export function useSocialSocket(roomId: string | undefined, opts: UseSocialSocketOptions = {}) {
  const [status, setStatus] = useState<SocialStatus>('connecting');
  const [messages, setMessages] = useState<SocialChatItem[]>([]);
  const [reactions, setReactions] = useState<ReactionBroadcast[]>([]);
  const [laser, setLaser] = useState<LaserPoint[]>([]);
  const [poll, setPoll] = useState<PollView | null>(null);
  const [lastError, setLastError] = useState<SocialErrorInfo | null>(null);
  const [recap, setRecap] = useState<RecapMessage | null>(null);
  const [chatSettings, setChatSettings] = useState<ChatSettingsView>(DEFAULT_CHAT_SETTINGS);
  const chatSettingsRef = useRef(chatSettings);
  chatSettingsRef.current = chatSettings;
  /** Hasta cuándo (reloj local) el modo lento impide escribir; null = libre. */
  const [chatCooldownUntil, setChatCooldownUntil] = useState<number | null>(null);
  const [trivia, setTrivia] = useState<TriviaView>(EMPTY_TRIVIA);
  const [triviaSchedule, setTriviaSchedule] = useState<ScheduledTrivia[]>([]);
  const [triviaLeaderboard, setTriviaLeaderboard] = useState<TriviaLeaderboardView>(EMPTY_LEADERBOARD);
  /** Último voto propio visto por poll_id: los broadcasts no traen my_vote. */
  const myVotesRef = useRef<Map<string, number>>(new Map());
  const wsRef = useRef<WebSocket | null>(null);
  const attemptRef = useRef(0);
  const timerRef = useRef<number | null>(null);
  const closedRef = useRef(false);
  // Refs para no reconectar cuando el padre re-renderiza con callbacks inline.
  const role = opts.role;
  const optsRef = useRef(opts);
  optsRef.current = opts;
  // event_id ya vistos: traga ecos/redeliveries del servidor.
  const seenRef = useRef<Set<string>>(new Set());

  const remember = useCallback((id: string): boolean => {
    if (seenRef.current.has(id)) return true;
    seenRef.current.add(id);
    if (seenRef.current.size > SEEN_CAP) {
      const oldest = seenRef.current.values().next().value;
      if (oldest !== undefined) seenRef.current.delete(oldest);
    }
    return false;
  }, []);

  const pushMessage = useCallback(
    (msg: SocialChatItem) => {
      if (remember(msg.event_id)) return;
      const max = optsRef.current.maxMessages ?? CHAT_HISTORY_LIMIT;
      setMessages((prev) => [...prev.slice(-(max - 1)), msg]);
    },
    [remember],
  );

  const pushReaction = useCallback(
    (msg: ReactionBroadcast) => {
      if (remember(msg.event_id)) return;
      setReactions((prev) => [...prev.slice(-(REACTION_STREAM_LIMIT - 1)), msg]);
    },
    [remember],
  );

  const pushLaser = useCallback(
    (msg: LaserPoint) => {
      if (remember(msg.event_id)) return;
      setLaser((prev) => [...prev.slice(-(LASER_STREAM_LIMIT - 1)), msg]);
    },
    [remember],
  );

  const applyPoll = useCallback((msg: PollState) => {
    if (typeof msg.my_vote === 'number') myVotesRef.current.set(msg.poll_id, msg.my_vote);
    setPoll({ ...msg, my_vote: myVotesRef.current.get(msg.poll_id) ?? null });
  }, []);

  useEffect(() => {
    if (!roomId) {
      setStatus('closed');
      return;
    }
    closedRef.current = false;
    attemptRef.current = 0;
    // Por efecto: un ticket que llega tras desmontar (o tras cambiar de sala) se descarta.
    let disposed = false;

    const scheduleReconnect = () => {
      const { reconnectBaseMs = 500, reconnectMaxMs = 8000 } = optsRef.current;
      const delay = Math.min(reconnectBaseMs * 2 ** attemptRef.current, reconnectMaxMs);
      attemptRef.current += 1;
      setStatus('reconnecting');
      timerRef.current = window.setTimeout(connect, delay);
    };

    const connect = () => {
      setStatus(attemptRef.current === 0 ? 'connecting' : 'reconnecting');
      if (role === 'host') {
        apiFetch(`/rooms/${encodeURIComponent(roomId)}/sync-ticket`, { method: 'POST' })
          .then((ticket: { token: string }) => {
            if (!disposed) openSocket(ticket.token);
          })
          .catch((err: unknown) => {
            if (disposed) return;
            const status = errorStatus(err);
            if (status !== null && FATAL_TICKET_STATUS.includes(status)) {
              setStatus('closed');
              return;
            }
            scheduleReconnect();
          });
        return;
      }
      openSocket(role === 'guest' ? (localStorage.getItem('tint_guest_token') ?? '') : resolveToken());
    };

    const openSocket = (token: string) => {
      const {
        createSocket = (url: string) => new WebSocket(url),
        baseUrl,
        maxMessages = CHAT_HISTORY_LIMIT,
      } = optsRef.current;
      const url = buildSocialUrl(resolveBaseUrl(baseUrl), roomId, token);
      const ws = createSocket(url);
      wsRef.current = ws;

      ws.onopen = () => {
        attemptRef.current = 0;
        setStatus('open');
      };
      ws.onmessage = (event: MessageEvent) => {
        const parsed = parseSocialMessage(String(event.data));
        if (!parsed) return;
        if (parsed.type === 'history') {
          for (const m of parsed.messages) remember(m.event_id);
          setMessages(parsed.messages.slice(-maxMessages));
        } else if (parsed.type === 'chat_message' || parsed.type === 'notice') {
          pushMessage(parsed);
        } else if (parsed.type === 'reaction') {
          pushReaction(parsed);
        } else if (parsed.type === 'laser') {
          pushLaser({ ...parsed, end: parsed.end === true });
        } else if (parsed.type === 'poll_state') {
          applyPoll(parsed);
        } else if (parsed.type === 'recap') {
          setRecap(parsed);
        } else if (parsed.type === 'chat_settings') {
          setChatSettings(normalizeChatSettings(parsed));
        } else if (parsed.type === 'trivia_question') {
          setTrivia({ ...EMPTY_TRIVIA, question: parsed, receivedAt: Date.now() });
        } else if (parsed.type === 'trivia_ack') {
          setTrivia((prev) =>
            prev.question?.trivia_id === parsed.trivia_id ? { ...prev, ack: parsed, myOption: parsed.option } : prev,
          );
        } else if (parsed.type === 'trivia_result') {
          setTrivia((prev) => (prev.question?.trivia_id === parsed.trivia_id ? { ...prev, result: parsed } : prev));
          setTriviaLeaderboard({
            entries: parsed.leaderboard ?? [],
            myRank: parsed.my_rank ?? null,
            myTotal: parsed.my_total ?? null,
          });
        } else if (parsed.type === 'trivia_leaderboard') {
          setTriviaLeaderboard({
            entries: parsed.leaderboard ?? [],
            myRank: parsed.my_rank ?? null,
            myTotal: parsed.my_total ?? null,
          });
        } else if (parsed.type === 'trivia_schedule_state') {
          const list = Array.isArray(parsed.questions) ? parsed.questions : [];
          setTriviaSchedule([...list].sort((a, b) => a.at_ms - b.at_ms));
        } else if (parsed.type === 'error') {
          setLastError({ code: parsed.code, event_id_ref: parsed.event_id_ref, retry_after_ms: parsed.retry_after_ms });
          if (parsed.code === 'SLOW_MODE' && typeof parsed.retry_after_ms === 'number') {
            setChatCooldownUntil(Date.now() + parsed.retry_after_ms);
          }
        }
      };
      ws.onclose = () => {
        // Solo el socket vigente puede cambiar el estado/programar
        // reconexión: un cierre tardío del socket viejo (StrictMode,
        // limpieza) no debe matar al nuevo.
        if (wsRef.current !== ws) return;
        wsRef.current = null;
        if (closedRef.current) {
          setStatus('closed');
          return;
        }
        scheduleReconnect();
      };
      ws.onerror = () => {
        ws.close();
      };
    };

    connect();
    return () => {
      disposed = true;
      closedRef.current = true;
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
      wsRef.current?.close();
      wsRef.current = null;
    };
  }, [roomId, role, pushMessage, pushReaction, pushLaser, applyPoll, remember]);

  const send = useCallback(
    (text: string, sendOpts: { spoiler?: boolean } = {}) => {
      const trimmed = text.trim();
      if (!trimmed || !roomId) return false;
      const ws = wsRef.current;
      if (!ws || ws.readyState !== WebSocket.OPEN) return false;
      ws.send(buildChatSend(roomId, trimmed, sendOpts.spoiler === true));
      // Pre-validación del modo lento (el host está exento; social-core decide).
      const slow = chatSettingsRef.current.slow_mode_s;
      if (slow > 0 && role !== 'host') setChatCooldownUntil(Date.now() + slow * 1000);
      return true;
    },
    [roomId, role],
  );

  const sendReaction = useCallback(
    (emoji: string, positionMs = 0) => {
      if (!roomId || !isReactionEmoji(emoji)) return false;
      const ws = wsRef.current;
      if (!ws || ws.readyState !== WebSocket.OPEN) return false;
      ws.send(buildReactionSend(roomId, emoji as ReactionEmoji, positionMs));
      return true;
    },
    [roomId],
  );

  /** Envía un punto del láser (x, y en 0..1) y lo pinta al instante; su eco se descarta. */
  const sendLaser = useCallback(
    (x: number, y: number, end = false) => {
      if (!roomId) return false;
      const ws = wsRef.current;
      if (!ws || ws.readyState !== WebSocket.OPEN) return false;
      const eventId = newEventId();
      ws.send(buildLaserPoint(roomId, x, y, end, eventId));
      const me = getLocalIdentity();
      pushLaser({
        type: 'laser',
        event_id: eventId,
        user_id: me?.sub ?? '',
        nick: me?.nick ?? '',
        x: clamp01(x),
        y: clamp01(y),
        end,
        own: true,
      });
      return true;
    },
    [roomId, pushLaser],
  );

  /** Envía un frame ya armado si el socket está abierto (y limpia el último error). */
  const sendFrame = useCallback((build: (room: string) => string) => {
    if (!roomId) return false;
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return false;
    setLastError(null);
    ws.send(build(roomId));
    return true;
  }, [roomId]);

  const createPoll = useCallback(
    (question: string, options: string[], durationS: number) => {
      if (validatePollDraft(question, options, durationS)) return false;
      return sendFrame((room) => buildPollCreate(room, question, options, durationS));
    },
    [sendFrame],
  );

  const votePoll = useCallback(
    (pollId: string, option: number) => {
      const ok = sendFrame((room) => buildPollVote(room, pollId, option));
      if (ok) {
        // Optimista hasta que llegue el poll_state con my_vote.
        myVotesRef.current.set(pollId, option);
        setPoll((prev) => (prev && prev.poll_id === pollId ? { ...prev, my_vote: option } : prev));
      }
      return ok;
    },
    [sendFrame],
  );

  const closePoll = useCallback(
    (pollId: string) => sendFrame((room) => buildPollClose(room, pollId)),
    [sendFrame],
  );

  const requestRecap = useCallback(() => sendFrame((room) => buildRecapRequest(room)), [sendFrame]);

  const setSlowMode = useCallback(
    (seconds: number) => {
      if (!SLOW_MODE_OPTIONS.some((o) => o.seconds === seconds)) return false;
      return sendFrame((room) => buildChatSlowMode(room, seconds));
    },
    [sendFrame],
  );

  const muteUser = useCallback(
    (userId: string, muted: boolean) => sendFrame((room) => buildChatMute(room, userId, muted)),
    [sendFrame],
  );

  const listTrivia = useCallback(() => sendFrame((room) => buildTriviaList(room)), [sendFrame]);

  const scheduleTrivia = useCallback(
    (draft: TriviaDraft) => {
      if (validateTriviaDraft(draft)) return false;
      const ok = sendFrame((room) => buildTriviaSchedule(room, draft));
      if (ok) listTrivia();
      return ok;
    },
    [sendFrame, listTrivia],
  );

  const updateTrivia = useCallback(
    (triviaId: string, draft: TriviaDraft) => {
      if (validateTriviaDraft(draft)) return false;
      const ok = sendFrame((room) => buildTriviaUpdate(room, triviaId, draft));
      if (ok) listTrivia();
      return ok;
    },
    [sendFrame, listTrivia],
  );

  const deleteTrivia = useCallback(
    (triviaId: string) => {
      const ok = sendFrame((room) => buildTriviaDelete(room, triviaId));
      if (ok) listTrivia();
      return ok;
    },
    [sendFrame, listTrivia],
  );

  const answerTrivia = useCallback(
    (triviaId: string, option: number) => {
      const ok = sendFrame((room) => buildTriviaAnswer(room, triviaId, option));
      if (ok) setTrivia((prev) => (prev.question?.trivia_id === triviaId ? { ...prev, myOption: option } : prev));
      return ok;
    },
    [sendFrame],
  );

  const dismissTrivia = useCallback(() => setTrivia(EMPTY_TRIVIA), []);

  return {
    status,
    messages,
    reactions,
    laser,
    poll,
    recap,
    lastError,
    send,
    sendReaction,
    sendLaser,
    createPoll,
    votePoll,
    closePoll,
    requestRecap,
    chatSettings,
    chatCooldownUntil,
    setSlowMode,
    muteUser,
    trivia,
    triviaSchedule,
    triviaLeaderboard,
    scheduleTrivia,
    updateTrivia,
    deleteTrivia,
    listTrivia,
    answerTrivia,
    dismissTrivia,
  };
}
