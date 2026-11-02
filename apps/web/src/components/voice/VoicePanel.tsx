import { useEffect, useRef } from 'react';
import { Button } from '../ui/Button';
import { ErrorAlert } from '../ui/Primitives';
import { canModerate, type VoicePeer } from '../../lib/voiceProtocol';
import type { VoiceChannel } from '../../hooks/useVoiceChannel';

export type VoicePanelProps = {
  voice: Pick<
    VoiceChannel,
    | 'status'
    | 'notice'
    | 'self'
    | 'peers'
    | 'remoteStreams'
    | 'connection'
    | 'muted'
    | 'hostMuted'
    | 'join'
    | 'leave'
    | 'toggleMute'
    | 'setHostMute'
    | 'dismissNotice'
  >;
  /** peer_id de quienes están hablando (HU-VOZ-03). */
  speaking: Set<string>;
};

function MicIcon({ off }: { off: boolean }) {
  return (
    <svg aria-hidden="true" viewBox="0 0 16 16" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
      <rect x="5.5" y="1.5" width="5" height="8" rx="2.5" />
      <path d="M3 7.5a5 5 0 0 0 10 0M8 12.5v2" />
      {off && <path d="M2 2l12 12" />}
    </svg>
  );
}

/** Audio de un peer. Con el silencio del host se apaga aquí, en quien escucha (HU-VOZ-04 AC1). */
function RemoteAudio({ stream, muted, nick }: { stream: MediaStream; muted: boolean; nick: string }) {
  const ref = useRef<HTMLAudioElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (el && el.srcObject !== stream) el.srcObject = stream;
  }, [stream]);
  useEffect(() => {
    if (ref.current) ref.current.muted = muted;
  }, [muted]);
  return <audio ref={ref} autoPlay playsInline aria-label={`Audio de ${nick}`} data-testid="voice-audio" />;
}

const CONNECTION_TEXT: Partial<Record<RTCPeerConnectionState, string>> = {
  new: 'conectando…',
  connecting: 'conectando…',
  disconnected: 'reconectando…',
  failed: 'sin conexión',
};

function MemberRow({
  peer,
  isSelf,
  speaking,
  connection,
  moderator,
  onHostMute,
}: {
  peer: VoicePeer;
  isSelf: boolean;
  speaking: boolean;
  connection?: RTCPeerConnectionState;
  moderator: boolean;
  onHostMute: (userId: string, muted: boolean) => void;
}) {
  const initial = (peer.nick || '?').trim().charAt(0).toUpperCase();
  const linkText = !isSelf && connection ? CONNECTION_TEXT[connection] : undefined;
  return (
    <li
      data-speaking={speaking}
      className="flex min-w-0 items-center gap-3 rounded-xl border border-white/5 bg-white/[0.03] px-3 py-2"
    >
      {/* El anillo no cambia el tamaño de la fila: varias personas a la vez no la desordenan (AC3). */}
      <span
        aria-hidden="true"
        className={`grid h-9 w-9 shrink-0 place-items-center rounded-full bg-white/10 text-sm font-semibold text-white ring-2 ring-offset-2 ring-offset-tint-card transition-shadow duration-150 motion-reduce:transition-none ${
          speaking ? 'ring-tint-accent shadow-glow' : 'ring-transparent'
        }`}
      >
        {initial}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm text-white">
          {peer.nick || 'Sin nombre'}
          {isSelf && <span className="text-tint-muted"> (tú)</span>}
          {speaking && <span className="sr-only"> · hablando</span>}
        </span>
        {(peer.host_muted || linkText) && (
          <span className="block truncate text-[12px] text-tint-muted">
            {peer.host_muted ? 'Silenciado por el host' : linkText}
          </span>
        )}
      </span>
      {(peer.muted || peer.host_muted) && (
        <span role="img" aria-label="Micrófono silenciado" className="text-tint-muted">
          <MicIcon off />
        </span>
      )}
      {moderator && !isSelf && (
        <Button
          variant="quiet"
          size="sm"
          onClick={() => onHostMute(peer.user_id, !peer.host_muted)}
          aria-label={`${peer.host_muted ? 'Permitir hablar a' : 'Silenciar a'} ${peer.nick}`}
        >
          {peer.host_muted ? 'Permitir hablar' : 'Silenciar'}
        </Button>
      )}
    </li>
  );
}

/** Canal de voz de la sala: unirse, micrófono, quién está y quién habla. */
export function VoicePanel({ voice, speaking }: VoicePanelProps) {
  const { status, notice, self, peers, remoteStreams, connection, muted, hostMuted } = voice;
  const inVoice = status === 'connected' || status === 'reconnecting';
  const busy = status === 'joining';
  const moderator = !!self && canModerate(self.role);

  return (
    <section aria-labelledby="voice-title">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 id="voice-title" className="text-[15px] font-semibold text-white">
            Voz
          </h2>
          <p className="text-[13px] text-tint-muted" role="status" aria-live="polite">
            {status === 'joining' && 'Conectando a la voz…'}
            {status === 'reconnecting' && 'Reconectando la voz…'}
            {status === 'connected' && `${peers.length + 1} en la voz`}
            {(status === 'idle' || status === 'ended') && 'Habla con la sala mientras ven el vídeo.'}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {inVoice ? (
            <>
              <Button
                variant={muted ? 'ghost' : 'primary'}
                size="sm"
                aria-pressed={muted}
                onClick={voice.toggleMute}
                title={hostMuted ? 'El host te silenció' : undefined}
              >
                <MicIcon off={muted} />
                {muted ? 'Activar micrófono' : 'Silenciar'}
              </Button>
              <Button variant="danger" size="sm" onClick={voice.leave}>
                Salir de la voz
              </Button>
            </>
          ) : (
            <Button size="sm" onClick={() => void voice.join()} disabled={busy}>
              <MicIcon off={false} />
              {busy ? 'Conectando…' : 'Unirse a la voz'}
            </Button>
          )}
        </div>
      </div>

      {notice && (
        <div className="mt-3 flex items-start gap-2">
          <div className="min-w-0 flex-1">
            <ErrorAlert message={notice} />
          </div>
          <Button variant="quiet" size="sm" onClick={voice.dismissNotice} aria-label="Cerrar aviso">
            ✕
          </Button>
        </div>
      )}

      {inVoice && self && (
        <ul aria-label="En la voz" className="mt-4 grid gap-2 sm:grid-cols-2">
          <MemberRow
            peer={{ ...self, muted, host_muted: hostMuted }}
            isSelf
            speaking={speaking.has(self.peer_id)}
            moderator={false}
            onHostMute={voice.setHostMute}
          />
          {peers.map((p) => (
            <MemberRow
              key={p.peer_id}
              peer={p}
              isSelf={false}
              speaking={speaking.has(p.peer_id)}
              connection={connection[p.peer_id]}
              moderator={moderator}
              onHostMute={voice.setHostMute}
            />
          ))}
        </ul>
      )}

      {peers.map((p) =>
        remoteStreams[p.peer_id] ? (
          <RemoteAudio key={p.peer_id} stream={remoteStreams[p.peer_id]} muted={p.host_muted} nick={p.nick} />
        ) : null,
      )}
    </section>
  );
}
