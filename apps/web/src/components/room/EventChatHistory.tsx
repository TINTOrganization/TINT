import { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { fetchChatHistory, type ChatHistoryOptions } from '../../lib/chatHistory';
import type { ChatMessage } from '../../lib/socialSocket';
import { SpoilerText } from '../chat/SpoilerText';
import { Button } from '../ui/Button';
import { ErrorAlert } from '../ui/Primitives';

type Load = { state: 'loading' } | { state: 'error'; message: string } | { state: 'ready'; messages: ChatMessage[] };

function timeOf(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleTimeString('es', { hour: '2-digit', minute: '2-digit' });
}

/**
 * "Ver chat del evento" (HU-LIVE-09 AC3): el host lee el chat de una sala deshabilitada en un
 * diálogo modal (Escape o "Cerrar"; el foco vuelve al botón). Los spoilers siguen ocultos.
 */
export function EventChatHistory({
  roomId,
  title,
  options,
  className = '',
}: {
  roomId: string;
  title?: string;
  options?: ChatHistoryOptions;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const [load, setLoad] = useState<Load>({ state: 'loading' });
  const [attempt, setAttempt] = useState(0);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const titleId = useId();
  const optionsRef = useRef(options);
  optionsRef.current = options;

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoad({ state: 'loading' });
    fetchChatHistory(roomId, optionsRef.current)
      .then((messages) => !cancelled && setLoad({ state: 'ready', messages }))
      .catch((err: Error) => !cancelled && setLoad({ state: 'error', message: err.message }));
    return () => {
      cancelled = true;
    };
  }, [open, roomId, attempt]);

  useEffect(() => {
    if (!open) return;
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open]);

  function close() {
    setOpen(false);
    triggerRef.current?.focus();
  }

  return (
    <>
      <Button ref={triggerRef} variant="ghost" size="sm" className={className} onClick={() => setOpen(true)}>
        Ver chat del evento
      </Button>
      {open &&
        createPortal(
          <div className="fixed inset-0 z-50 grid place-items-center bg-black/70 px-4 py-8 backdrop-blur-sm">
            <div
              role="dialog"
              aria-modal="true"
              aria-labelledby={titleId}
              className="tint-glass-panel flex max-h-[85dvh] w-full max-w-lg flex-col rounded-3xl p-6"
            >
              <div className="flex items-start justify-between gap-4">
                <div className="min-w-0">
                  <p className="tint-eyebrow">Evento terminado</p>
                  <h2 id={titleId} className="mt-1 truncate text-xl font-bold tracking-tight text-white">
                    {title ? `Chat de ${title}` : 'Chat del evento'}
                  </h2>
                </div>
                <Button ref={closeRef} variant="ghost" size="sm" onClick={close}>
                  Cerrar
                </Button>
              </div>
              <div className="mt-4 min-h-0 flex-1 overflow-y-auto">
                {load.state === 'loading' && (
                  <p role="status" className="text-sm text-tint-muted">
                    Cargando el chat…
                  </p>
                )}
                {load.state === 'error' && (
                  <div className="space-y-3">
                    <ErrorAlert message={load.message} />
                    <Button size="sm" variant="ghost" onClick={() => setAttempt((n) => n + 1)}>
                      Reintentar
                    </Button>
                  </div>
                )}
                {load.state === 'ready' &&
                  (load.messages.length === 0 ? (
                    <p className="text-sm text-tint-muted">
                      No hay mensajes guardados. El historial se conserva 12 horas después del evento.
                    </p>
                  ) : (
                    <ol aria-label="Mensajes del chat" className="space-y-2">
                      {load.messages.map((msg) => (
                        <li key={msg.event_id} className="rounded-xl bg-white/5 px-3 py-2 text-sm">
                          <p className="flex items-baseline justify-between gap-3 text-[12px] text-tint-muted">
                            <span className="truncate font-semibold text-white">{msg.nick || 'Sin nombre'}</span>
                            <time dateTime={msg.occurred_at}>{timeOf(msg.occurred_at)}</time>
                          </p>
                          <p className="mt-0.5 break-words text-white/90">
                            {msg.spoiler ? <SpoilerText text={msg.text} /> : msg.text}
                          </p>
                        </li>
                      ))}
                    </ol>
                  ))}
              </div>
            </div>
          </div>,
          document.body,
        )}
    </>
  );
}
