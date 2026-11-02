import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';

import { ReactionBar } from '../components/ReactionBar';
import { ReactionOverlay } from '../components/ReactionOverlay';
import { PollPanel } from '../components/PollPanel';
import { CopyButton } from '../components/CopyButton';
import { InvitePopover } from '../components/InvitePopover';
import { ChatPanel } from '../components/chat/ChatPanel';
import { TriviaPanel, TriviaPopup } from '../components/quiz/TriviaPanel';
import { VoiceSection } from '../components/voice/VoiceSection';
import { RoomNotice } from '../components/room/RoomNotice';
import { EventChatHistory } from '../components/room/EventChatHistory';
import { HostStudio } from '../components/live/HostStudio';
import { AudioMixerPanel } from '../components/live/AudioMixerPanel';
import { HostStatsPanel } from '../components/live/HostStatsPanel';
import { StagePanel } from '../components/live/StagePanel';
import { ViewerStage } from '../components/live/ViewerStage';
import { LiveStatusBadge, ViewerCount } from '../components/live/LiveBadges';
import { BackLink } from '../components/ui/BackLink';
import { BrandMark } from '../components/layout/AppShell';
import { AmbientBackground } from '../components/layout/AmbientBackground';
import { Card } from '../components/ui/Primitives';
import { useConfirm } from '../components/ui/ConfirmDialog';
import { apiFetch } from '../lib/api';
import { getLocalIdentity, guestTokenGrantsRoom } from '../lib/identity';
import { pickLatestActiveInvitation, toAbsoluteInviteLink } from '../lib/invite';
import { ROOM_ENDED_TITLE, roomEndedBody } from '../lib/roomClosed';
import { endEventErrorMessage, endLiveEvent, roomKindOf, watchPath } from '../lib/rooms';
import { inviteToStage, removeFromStage } from '../lib/voiceStage';
import { useSocialSocket } from '../hooks/useSocialSocket';
import { useLiveStream } from '../hooks/useLiveStream';

/**
 * Sala `live` (ADR 0019, docs/dominio-transmision.md): el host transmite su pantalla por
 * stream-core y la audiencia la ve por WHEP. No abre `/ws/sync`: no hay vídeo sincronizado.
 * Chat, reacciones, encuestas y trivia siguen por social-core; la voz va en modo escenario.
 */
export default function LiveRoom() {
  const { roomId = '' } = useParams();
  const navigate = useNavigate();
  const { confirm, dialog } = useConfirm();
  const hostToken = localStorage.getItem('tint_token');
  const guestToken = guestTokenGrantsRoom(localStorage.getItem('tint_guest_token'), roomId)
    ? localStorage.getItem('tint_guest_token')
    : null;
  const hasAccess = !!hostToken || !!guestToken;
  const isGuest = !hostToken && !!guestToken;
  const role = isGuest ? 'guest' : 'host';
  const homePath = isGuest ? '/' : '/dashboard';
  const identity = getLocalIdentity();

  const [ended, setEnded] = useState(false);
  const markEnded = useCallback(() => setEnded(true), []);
  const [roomTitle, setRoomTitle] = useState<string | null>(() =>
    isGuest ? localStorage.getItem('tint_room_title') : null,
  );
  const [inviteLink, setInviteLink] = useState<string | null>(() =>
    isGuest ? localStorage.getItem('tint_invite_link') : null,
  );
  const heading = roomTitle?.trim() ? roomTitle : `Sala ${roomId}`;

  const social = useSocialSocket(hasAccess && !ended ? roomId : undefined, { role });
  const live = useLiveStream(roomId, { role, title: roomTitle ?? undefined });

  // Datos de la sala (host): si no es `live` se va a /watch; si ya terminó, el aviso.
  useEffect(() => {
    if (!hasAccess || isGuest) return;
    let cancelled = false;
    Promise.all([apiFetch(`/rooms/${encodeURIComponent(roomId)}`), apiFetch(`/rooms/${encodeURIComponent(roomId)}/invitations`)])
      .then(([roomRes, invRes]) => {
        if (cancelled) return;
        const room = roomRes?.room ?? {};
        if (roomKindOf(room.kind) !== 'live') {
          navigate(watchPath(roomId), { replace: true });
          return;
        }
        if (room.status === 'disabled') setEnded(true);
        setRoomTitle(room.title ?? null);
        const list = (invRes?.invitations ?? []) as { code: string; link?: string; expiresAt: string; createdAt?: string; revoked?: boolean }[];
        const latest = pickLatestActiveInvitation(
          list.filter((i) => i.link).map((i) => ({ ...i, link: i.link as string })),
        );
        setInviteLink(latest?.link ?? null);
      })
      .catch(() => {
        // El título y el link son decorativos: sin ellos la sala sigue.
      });
    return () => {
      cancelled = true;
    };
  }, [roomId, hasAccess, isGuest, navigate]);

  // La audiencia se conecta sola; el host decide cuándo empezar a transmitir.
  const { watch } = live;
  useEffect(() => {
    if (hasAccess && isGuest && !ended) void watch();
  }, [hasAccess, isGuest, ended, watch]);

  // WHEP 404: la sala no tiene transmisión (es una sala watch) → su página.
  useEffect(() => {
    if (isGuest && live.error?.code === 'STREAM_NOT_FOUND') navigate(watchPath(roomId), { replace: true });
  }, [isGuest, live.error, navigate, roomId]);

  // Minuto de la transmisión según el reloj local (trivia por minuto y reacciones).
  const liveSinceRef = useRef<number | null>(null);
  useEffect(() => {
    if (live.status === 'live' && liveSinceRef.current === null) liveSinceRef.current = Date.now();
  }, [live.status]);
  const getStreamMs = useCallback(
    () => (liveSinceRef.current === null ? 0 : Date.now() - liveSinceRef.current),
    [],
  );

  const [pollCreatorOpen, setPollCreatorOpen] = useState(false);
  const [ending, setEnding] = useState(false);
  const [endError, setEndError] = useState('');
  const { stop } = live;
  const endEvent = async () => {
    const ok = await confirm({
      title: '¿Terminar el evento?',
      body: 'La transmisión, el chat y la voz se cerrarán para todos y la sala quedará deshabilitada. No se puede deshacer.',
      confirmLabel: 'Terminar evento',
      tone: 'danger',
    });
    if (!ok) return;
    setEnding(true);
    setEndError('');
    try {
      await endLiveEvent(roomId);
      await stop();
      setEnded(true);
    } catch (err) {
      setEndError(endEventErrorMessage(err));
    } finally {
      setEnding(false);
    }
  };

  // Escenario: quienes invitó el host en esta sesión (voice-core guarda el SET).
  const [onStage, setOnStage] = useState<Set<string>>(() => new Set());
  const invite = useCallback(
    async (userId: string) => {
      await inviteToStage(roomId, userId);
      setOnStage((prev) => new Set(prev).add(userId));
    },
    [roomId],
  );
  const remove = useCallback(
    async (userId: string) => {
      await removeFromStage(roomId, userId);
      setOnStage((prev) => {
        const next = new Set(prev);
        next.delete(userId);
        return next;
      });
    },
    [roomId],
  );
  const removeFromVoice = useCallback((userId: string) => void remove(userId).catch(() => {}), [remove]);

  const { setStageStreams } = live;
  const chatSelfId = identity?.sub ?? null;

  if (ended || social.disabled || live.status === 'ended') {
    return (
      <RoomNotice
        title={ROOM_ENDED_TITLE}
        body={roomEndedBody(!isGuest)}
        to={homePath}
        linkLabel={isGuest ? 'Volver al inicio' : 'Ir al dashboard'}
        extra={isGuest ? undefined : <EventChatHistory roomId={roomId} title={roomTitle ?? undefined} />}
      />
    );
  }
  if (social.revoked) {
    return (
      <RoomNotice
        title="Fuiste retirado de la sala por el host"
        body="Tu invitación ya no es válida. Si crees que es un error, pide al host un nuevo enlace."
      />
    );
  }
  if (social.expired) {
    return (
      <RoomNotice
        title="Tu invitación expiró"
        body="El enlace con el que entraste ya caducó. Pide al host un nuevo enlace para volver a entrar."
      />
    );
  }
  if (!hasAccess) {
    return (
      <RoomNotice
        title="Necesitas una invitación"
        body="Esta transmisión es privada. Entra con el link de invitación que te compartió el host."
      />
    );
  }

  const chatStatus =
    social.status === 'open' ? 'Chat conectado' : social.status === 'closed' ? 'Chat desconectado' : 'Chat reconectando…';

  return (
    <div className="relative isolate min-h-[100dvh] overflow-x-clip bg-tint-bg text-tint-muted">
      {dialog}
      <AmbientBackground />
      <header className="sticky top-0 z-30 border-b border-white/10 bg-tint-bg/80 backdrop-blur-xl">
        <div className="mx-auto flex max-w-[1400px] flex-col gap-2 px-4 py-2.5 sm:h-16 sm:flex-row sm:items-center sm:justify-between sm:gap-4 sm:py-0">
          <div className="flex min-w-0 flex-1 items-center gap-3">
            <BrandMark to={homePath} />
            <BackLink to={homePath} />
            <h1 className="min-w-0 flex-1 truncate text-[15px] font-semibold tracking-tight text-white" title={heading}>
              {heading}
            </h1>
            <InvitePopover
              className="shrink-0 sm:hidden"
              identity={identity && { nick: identity.nick, role: isGuest ? 'participante' : 'host' }}
              inviteLink={inviteLink}
            />
          </div>
          {inviteLink && (
            <span className="hidden min-w-0 items-center gap-2 rounded-full border border-white/10 bg-white/5 py-1 pl-3 pr-1 text-[12px] sm:inline-flex">
              <span className="max-w-[180px] truncate" title={toAbsoluteInviteLink(inviteLink)}>
                {toAbsoluteInviteLink(inviteLink)}
              </span>
              <CopyButton link={inviteLink} />
            </span>
          )}
          <div className="flex flex-wrap items-center gap-2 text-[12px]">
            <div role="status" aria-live="polite" aria-label="Estado de la transmisión">
              <LiveStatusBadge status={live.status} />
            </div>
            <ViewerCount count={live.viewerCount} />
            <p role="status" aria-live="polite">
              {chatStatus}
            </p>
          </div>
        </div>
      </header>

      <main className="mx-auto grid w-full max-w-[1400px] gap-4 px-4 py-6 lg:grid-cols-[2fr_360px]">
        <section aria-label="Transmisión" className="min-w-0">
          <Card className="overflow-hidden">
            {isGuest ? (
              <ViewerStage
                status={live.status}
                stream={live.remoteStream}
                scene={live.scene}
                error={live.error}
                onRetry={() => void watch()}
              >
                <ReactionOverlay reactions={social.reactions} />
                <TriviaPopup
                  trivia={social.trivia}
                  isHost={false}
                  onAnswer={social.answerTrivia}
                  onDismiss={social.dismissTrivia}
                  error={social.lastError?.code ?? null}
                />
              </ViewerStage>
            ) : (
              <HostStudio live={live} onEndEvent={() => void endEvent()} ending={ending}>
                <ReactionOverlay reactions={social.reactions} />
                <TriviaPopup
                  trivia={social.trivia}
                  isHost
                  onAnswer={social.answerTrivia}
                  onDismiss={social.dismissTrivia}
                  error={social.lastError?.code ?? null}
                />
              </HostStudio>
            )}
            {endError && (
              <p role="alert" className="px-4 pb-3 text-[13px] text-red-300">
                {endError}
              </p>
            )}
            <div className="flex flex-wrap items-center justify-between gap-4 border-t border-white/5 p-4">
              <p className="text-sm font-medium text-white">Reacciona en vivo</p>
              <ReactionBar onReact={(r) => social.sendReaction(r, getStreamMs())} />
            </div>
          </Card>

          {!isGuest && live.publishing && (
            <div className="mt-4 grid gap-4 md:grid-cols-2">
              <Card className="p-5">
                <AudioMixerPanel
                  mixer={live.mixer}
                  levels={live.levels}
                  onGain={live.setGain}
                  onMute={live.setMuted}
                  onEnableMic={() => void live.enableMic()}
                  systemAudioUnavailable={live.systemAudioUnavailable}
                  echoHint={live.echoHint}
                />
              </Card>
              <Card className="p-5">
                <HostStatsPanel stats={live.hostStats} viewerCount={live.viewerCount} />
              </Card>
            </div>
          )}

          <VoiceSection
            roomId={roomId}
            role={role}
            stage
            onRoomDisabled={markEnded}
            onRemoveFromStage={isGuest ? undefined : removeFromVoice}
            onRemoteStreams={isGuest ? undefined : setStageStreams}
          />

          {!isGuest && (
            <Card className="mt-4 p-5">
              <StagePanel
                messages={social.messages}
                selfId={chatSelfId}
                onInvite={invite}
                onRemove={remove}
                onStage={onStage}
              />
            </Card>
          )}

          <Card className="mt-4 p-5">
            <PollPanel
              poll={social.poll}
              isHost={!isGuest}
              creatorOpen={pollCreatorOpen}
              onCreatorOpenChange={setPollCreatorOpen}
              onCreate={social.createPoll}
              onVote={social.votePoll}
              onClose={social.closePoll}
              error={social.lastError?.code ?? null}
            />
          </Card>

          <Card className="mt-4 p-5">
            <TriviaPanel
              isHost={!isGuest}
              live
              schedule={social.triviaSchedule}
              leaderboard={social.triviaLeaderboard}
              getCurrentMs={getStreamMs}
              onSchedule={social.scheduleTrivia}
              onUpdate={social.updateTrivia}
              onDelete={social.deleteTrivia}
              onLaunchNow={isGuest ? undefined : social.launchTriviaNow}
              error={social.lastError?.code ?? null}
            />
          </Card>
        </section>

        <aside aria-label="Social" className="flex min-h-0 flex-col gap-4">
          <ChatPanel
            roomId={roomId}
            messages={social.messages}
            identity={identity}
            isHost={!isGuest}
            send={social.send}
            chatSettings={social.chatSettings}
            cooldownUntil={social.chatCooldownUntil}
            lastError={social.lastError}
            onSetSlowMode={social.setSlowMode}
            onMuteUser={social.muteUser}
          />
        </aside>
      </main>
    </div>
  );
}

