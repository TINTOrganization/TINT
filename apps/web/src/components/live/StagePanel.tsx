import { useMemo, useState } from 'react';
import type { SocialChatItem } from '../../hooks/useSocialSocket';
import { Button } from '../ui/Button';

export interface StagePanelProps {
  messages: SocialChatItem[];
  /** `sub` del host (no se invita a sí mismo). */
  selfId: string | null;
  onInvite: (userId: string) => Promise<void>;
  onRemove: (userId: string) => Promise<void>;
  /** Quienes están en el escenario (los invitados desde aquí). */
  onStage: Set<string>;
}

interface Candidate {
  userId: string;
  nick: string;
}

/**
 * Escenario de la voz (salas live): el host invita a alguien del chat a hablar; la audiencia lo
 * oye porque el host mezcla su voz en la transmisión.
 */
export function StagePanel({ messages, selfId, onInvite, onRemove, onStage }: StagePanelProps) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState('');
  const candidates = useMemo(() => {
    const seen = new Map<string, Candidate>();
    for (const m of messages) {
      if (m.type !== 'chat_message' || !m.user_id || m.user_id === selfId) continue;
      seen.set(m.user_id, { userId: m.user_id, nick: m.nick || 'Sin nombre' });
    }
    return [...seen.values()].reverse();
  }, [messages, selfId]);

  const toggle = async (c: Candidate) => {
    setBusy(c.userId);
    setError('');
    try {
      if (onStage.has(c.userId)) await onRemove(c.userId);
      else await onInvite(c.userId);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'No se pudo cambiar el escenario.');
    } finally {
      setBusy(null);
    }
  };

  return (
    <section aria-labelledby="stage-title">
      <h2 id="stage-title" className="text-[15px] font-semibold text-white">
        Escenario
      </h2>
      <p className="mt-1 text-[13px] leading-relaxed">
        Invita a alguien del chat a hablar. Entra a la voz y la audiencia lo oye en la transmisión.
      </p>
      {error && (
        <p role="alert" className="mt-3 text-[13px] text-red-300">
          {error}
        </p>
      )}
      {candidates.length === 0 ? (
        <p className="mt-3 text-[13px] text-tint-muted">Cuando alguien escriba en el chat podrás invitarlo.</p>
      ) : (
        <ul aria-label="Participantes del chat" className="mt-3 space-y-2">
          {candidates.map((c) => {
            const on = onStage.has(c.userId);
            return (
              <li key={c.userId} className="flex items-center justify-between gap-3 rounded-xl bg-white/5 px-3 py-2">
                <span className="min-w-0 truncate text-sm text-white">
                  {c.nick}
                  {on && <span className="text-tint-muted"> · en el escenario</span>}
                </span>
                <Button
                  variant={on ? 'quiet' : 'ghost'}
                  size="sm"
                  aria-pressed={on}
                  disabled={busy === c.userId}
                  aria-label={on ? `Bajar del escenario a ${c.nick}` : `Invitar al escenario a ${c.nick}`}
                  onClick={() => void toggle(c)}
                >
                  {on ? 'Bajar' : 'Invitar'}
                </Button>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
