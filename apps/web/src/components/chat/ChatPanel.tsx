import { useEffect, useId, useRef, useState, type FormEvent, type KeyboardEvent, type UIEvent } from 'react';
import { m as motionM } from 'framer-motion';
import { fadeUp } from '../../lib/motion';
import { banErrorMessage, banGuest } from '../../lib/bans';
import type { LocalIdentity } from '../../lib/identity';
import {
  CHAT_MAX_LENGTH,
  formatChatTime,
  noticeText,
  SLOW_MODE_OPTIONS,
  socialErrorMessage,
  type ChatMessage,
} from '../../lib/socialSocket';
import type { ChatSettingsView, SocialChatItem, SocialErrorInfo } from '../../hooks/useSocialSocket';
import { Button } from '../ui/Button';
import { Card, Input } from '../ui/Primitives';
import { useCountdown } from '../../hooks/useCountdown';

export interface ChatPanelProps {
  roomId: string;
  messages: SocialChatItem[];
  identity: LocalIdentity | null;
  isHost: boolean;
  send: (text: string, opts?: { spoiler?: boolean }) => boolean;
  chatSettings: ChatSettingsView;
  /** Hasta cuándo (reloj local) el modo lento impide enviar. */
  cooldownUntil: number | null;
  lastError: SocialErrorInfo | null;
  onSetSlowMode: (seconds: number) => boolean;
  onMuteUser: (userId: string, muted: boolean) => boolean;
}

const MotionLi = motionM.li;

/** Errores del canal que conciernen al chat (el resto los muestra su panel). */
const CHAT_ERRORS = new Set(['SLOW_MODE', 'MUTED', 'RATE_LIMITED', 'UNAVAILABLE']);

function slowModeLabel(seconds: number): string {
  return SLOW_MODE_OPTIONS.find((o) => o.seconds === seconds)?.label ?? `${seconds} s`;
}

/**
 * Texto con spoiler: difuminado hasta hover; el foco de teclado lo revela (y lo lee el
 * lector de pantalla) y el toque/clic lo alterna.
 */
function SpoilerText({ text }: { text: string }) {
  const [pinned, setPinned] = useState(false);
  const [focused, setFocused] = useState(false);
  const pointerRef = useRef(false);
  const revealed = pinned || focused;
  const toggle = () => setPinned((p) => !p);
  return (
    <span
      role="button"
      tabIndex={0}
      aria-pressed={pinned}
      aria-label={revealed ? undefined : 'Spoiler oculto, enfoca para leer'}
      title={revealed ? undefined : 'Spoiler: pasa el cursor o toca para leer'}
      onPointerDown={() => {
        pointerRef.current = true;
      }}
      onFocus={() => {
        // El foco que llega por un toque no cuenta: el toque alterna con el clic.
        if (!pointerRef.current) setFocused(true);
        pointerRef.current = false;
      }}
      onBlur={() => setFocused(false)}
      onClick={toggle}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          toggle();
        }
      }}
      className={`cursor-pointer rounded px-0.5 transition-[filter] duration-200 motion-reduce:transition-none focus:outline-none focus-visible:ring-2 focus-visible:ring-tint-accent/60 ${
        revealed ? 'bg-white/5' : 'blur-[5px] hover:blur-none select-none bg-white/10'
      }`}
    >
      {text}
    </span>
  );
}

function SpoilerIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 16 16" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
      <path d="M1.5 8s2.4-4.5 6.5-4.5S14.5 8 14.5 8s-2.4 4.5-6.5 4.5S1.5 8 1.5 8Z" />
      <circle cx="8" cy="8" r="2" />
      <path d="M2.5 13.5l11-11" />
    </svg>
  );
}

/** Menú del host sobre un mensaje ajeno: silenciar y bloquear (con confirmación). */
function HostMessageMenu({
  message,
  muted,
  onMute,
  onBan,
}: {
  message: ChatMessage;
  muted: boolean;
  onMute: (muted: boolean) => void;
  onBan: () => Promise<boolean>;
}) {
  const [open, setOpen] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const firstItemRef = useRef<HTMLButtonElement>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);
  const menuId = useId();

  useEffect(() => {
    if (open) firstItemRef.current?.focus();
  }, [open]);
  useEffect(() => {
    if (confirming) confirmRef.current?.focus();
  }, [confirming]);

  const closeMenu = () => {
    setOpen(false);
    triggerRef.current?.focus();
  };

  const onMenuKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      closeMenu();
    }
  };

  const ban = async () => {
    setBusy(true);
    await onBan();
    setBusy(false);
    setConfirming(false);
  };

  return (
    <span className="relative ml-1 inline-block align-middle">
      <button
        ref={triggerRef}
        type="button"
        aria-label={`Opciones para ${message.nick}`}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onClick={() => setOpen((o) => !o)}
        className="rounded-full px-1.5 text-[14px] leading-none text-tint-muted hover:bg-white/10 hover:text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-tint-accent/60"
      >
        <span aria-hidden="true">⋯</span>
      </button>
      {open && (
        <span
          id={menuId}
          role="menu"
          aria-label={`Moderar a ${message.nick}`}
          onKeyDown={onMenuKey}
          className="tint-glass-panel absolute left-0 top-6 z-20 flex w-48 flex-col rounded-xl p-1 text-left"
        >
          <button
            ref={firstItemRef}
            type="button"
            role="menuitem"
            className="rounded-lg px-3 py-2 text-left text-[13px] text-white hover:bg-white/10 focus:bg-white/10 focus:outline-none"
            onClick={() => {
              onMute(!muted);
              closeMenu();
            }}
          >
            {muted ? 'Quitar silencio' : 'Silenciar'}
          </button>
          <button
            type="button"
            role="menuitem"
            className="rounded-lg px-3 py-2 text-left text-[13px] text-red-200 hover:bg-white/10 focus:bg-white/10 focus:outline-none"
            onClick={() => {
              setOpen(false);
              setConfirming(true);
            }}
          >
            Bloquear de la sala
          </button>
        </span>
      )}
      {confirming && (
        <span
          role="group"
          aria-label={`Confirmar bloquear a ${message.nick}`}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              e.stopPropagation();
              setConfirming(false);
            }
          }}
          className="tint-glass-panel absolute left-0 top-6 z-20 flex w-64 flex-col gap-2 rounded-xl p-3 text-left"
        >
          <span className="text-[13px] text-white">
            ¿Bloquear a {message.nick}? Saldrá de la sala y no podrá volver a entrar con el enlace.
          </span>
          <span className="flex gap-2">
            <Button ref={confirmRef} variant="danger" size="sm" disabled={busy} onClick={ban}>
              Sí, bloquear
            </Button>
            <Button
              variant="quiet"
              className="px-3 py-1.5 text-[13px]"
              onClick={() => {
                setConfirming(false);
                triggerRef.current?.focus();
              }}
            >
              Cancelar
            </Button>
          </span>
        </span>
      )}
    </span>
  );
}

/** Chat en vivo de la sala: mensajes, spoilers, modo lento, silencio y moderación del host. */
export function ChatPanel({
  roomId,
  messages,
  identity,
  isHost,
  send,
  chatSettings,
  cooldownUntil,
  lastError,
  onSetSlowMode,
  onMuteUser,
}: ChatPanelProps) {
  const [text, setText] = useState('');
  const [spoiler, setSpoiler] = useState(false);
  const [modNotice, setModNotice] = useState('');
  const [modError, setModError] = useState('');
  const slowId = useId();
  const remaining = useCountdown(isHost ? null : cooldownUntil);
  const muted = !isHost && identity !== null && chatSettings.muted_user_ids.includes(identity.sub);
  const slow = chatSettings.slow_mode_s;
  // Los mensajes del primer render (historial) aparecen sin animación; solo entran los nuevos.
  const [initialMessageIds] = useState(() => new Set(messages.map((msg) => msg.event_id)));

  // Auto-scroll inteligente: baja al fondo solo si el usuario ya estaba abajo.
  const listRef = useRef<HTMLUListElement | null>(null);
  const stickRef = useRef(true);
  const onListScroll = (e: UIEvent<HTMLUListElement>) => {
    const el = e.currentTarget;
    stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 64;
  };
  useEffect(() => {
    const el = listRef.current;
    if (el && stickRef.current) el.scrollTop = el.scrollHeight;
  }, [messages]);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const value = text.trim();
    if (!value || muted || remaining > 0) return;
    const ok = spoiler ? send(value, { spoiler: true }) : send(value);
    if (ok) {
      setText('');
      setSpoiler(false);
    }
  };

  const ban = async (m: ChatMessage): Promise<boolean> => {
    setModNotice('');
    setModError('');
    try {
      await banGuest(roomId, { sub: m.user_id });
      setModNotice(`${m.nick} fue bloqueado de la sala.`);
      return true;
    } catch (err) {
      setModError(banErrorMessage(err, m.nick));
      return false;
    }
  };

  const chatError = lastError && CHAT_ERRORS.has(lastError.code) && !muted ? socialErrorMessage(lastError.code) : '';

  return (
    <Card className="flex h-[60dvh] min-h-0 flex-col p-5 lg:h-[calc(100dvh-7rem)]">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-[15px] font-semibold text-white">Chat en vivo</h2>
        {isHost && (
          <span className="flex items-center gap-2 text-[12px]">
            <label htmlFor={slowId}>Modo lento</label>
            <select
              id={slowId}
              value={slow}
              onChange={(e) => onSetSlowMode(Number(e.target.value))}
              className="rounded-lg border border-white/10 bg-tint-bg px-2 py-1 text-[12px] text-white focus:border-tint-accent focus:outline-none focus-visible:ring-2 focus-visible:ring-tint-accent/60"
            >
              {SLOW_MODE_OPTIONS.map((o) => (
                <option key={o.seconds} value={o.seconds}>
                  {o.label}
                </option>
              ))}
            </select>
          </span>
        )}
      </div>
      {!isHost && slow > 0 && (
        <p className="mt-2 rounded-lg bg-amber-400/10 px-3 py-1.5 text-[12px] text-amber-100">
          Modo lento: puedes escribir un mensaje cada {slowModeLabel(slow)}.
        </p>
      )}
      {messages.length === 0 ? (
        <p className="mt-3 flex-1 rounded-xl border border-dashed border-white/15 bg-white/[0.02] p-4 text-[13px] leading-relaxed">
          Sin mensajes aún. Saluda y prueba la sincronía con tu grupo.
        </p>
      ) : (
        <ul ref={listRef} onScroll={onListScroll} className="mt-3 min-h-0 flex-1 space-y-2 overflow-y-auto" aria-live="polite">
          {messages.map((m) => {
            // Solo entran animados los mensajes que no estaban en el primer render.
            const enter = !initialMessageIds.has(m.event_id);
            const motionProps = {
              'data-enter': String(enter),
              variants: fadeUp,
              initial: enter ? ('hidden' as const) : false,
              animate: 'show' as const,
            };
            if (m.type === 'notice') {
              return (
                <MotionLi
                  key={m.event_id}
                  {...motionProps}
                  className="mx-auto w-fit px-3 py-1 text-center text-[12px] italic text-tint-muted/80"
                >
                  {noticeText(m)}
                </MotionLi>
              );
            }
            const isMine = identity !== null && m.user_id === identity.sub;
            const authorMuted = chatSettings.muted_user_ids.includes(m.user_id);
            return (
              <MotionLi
                key={m.event_id}
                {...motionProps}
                className={
                  isMine
                    ? 'ml-auto w-fit max-w-[85%] rounded-xl bg-tint-accent/20 px-3 py-2 text-right text-[13px] break-words'
                    : 'mr-auto w-fit max-w-[85%] rounded-xl bg-white/5 px-3 py-2 text-[13px] break-words'
                }
              >
                {!isMine && <span className="font-semibold text-white">{m.nick}: </span>}
                {m.spoiler ? <SpoilerText text={m.text} /> : <span>{m.text}</span>}{' '}
                {formatChatTime(m.occurred_at) && (
                  <time dateTime={m.occurred_at} className="text-[11px] text-tint-muted/70">
                    {formatChatTime(m.occurred_at)}
                  </time>
                )}
                {isHost && !isMine && authorMuted && (
                  <span className="ml-1 rounded-full border border-white/15 px-1.5 text-[10px] text-tint-muted">Silenciado</span>
                )}
                {isHost && !isMine && (
                  <HostMessageMenu
                    message={m}
                    muted={authorMuted}
                    onMute={(next) => onMuteUser(m.user_id, next)}
                    onBan={() => ban(m)}
                  />
                )}
              </MotionLi>
            );
          })}
        </ul>
      )}
      <p role="status" aria-label="Moderación" className="text-[12px] text-emerald-300 empty:hidden">
        {modNotice}
      </p>
      {(modError || chatError) && (
        <p role="alert" className="mt-2 text-[12px] text-red-300">
          {modError || chatError}
        </p>
      )}
      <form
        onSubmit={submit}
        data-action="chat-form"
        className="tint-glass -mx-5 -mb-5 mt-4 flex gap-2 rounded-b-2xl border-x-0 border-b-0 px-4 py-3"
      >
        <label htmlFor="chat-input" className="sr-only">
          Escribe un mensaje
        </label>
        <Input
          id="chat-input"
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={muted ? 'El host te silenció; puedes leer el chat' : 'Escribe un mensaje'}
          disabled={muted}
          maxLength={CHAT_MAX_LENGTH}
          autoComplete="off"
          className="min-h-10 min-w-0 flex-1 px-3 py-2 text-sm placeholder:text-tint-muted/70 disabled:cursor-not-allowed disabled:opacity-60"
        />
        <button
          type="button"
          aria-pressed={spoiler}
          onClick={() => setSpoiler((s) => !s)}
          disabled={muted}
          title="Marcar como spoiler"
          className={`inline-flex min-h-10 shrink-0 items-center gap-1 rounded-full border px-3 py-2 text-[12px] font-semibold transition focus:outline-none focus-visible:ring-2 focus-visible:ring-tint-accent/60 disabled:opacity-50 ${
            spoiler ? 'border-tint-accent bg-tint-accent/20 text-white' : 'border-white/15 text-tint-muted hover:text-white'
          }`}
        >
          <SpoilerIcon />
          Spoiler
        </button>
        <Button
          type="submit"
          size="sm"
          data-action="chat-submit"
          disabled={muted || remaining > 0}
          aria-label={remaining > 0 ? `Espera ${remaining} s para enviar` : undefined}
          className="min-h-10 shrink-0 px-4 tabular-nums"
        >
          {remaining > 0 ? `${remaining} s` : 'Enviar'}
        </Button>
      </form>
    </Card>
  );
}
