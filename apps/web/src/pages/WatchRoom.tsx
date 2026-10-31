
import { useParams, Link, useNavigate } from 'react-router-dom';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { m, useReducedMotion } from 'framer-motion';

import { ReactionBar } from '../components/ReactionBar';
import { ReactionOverlay } from '../components/ReactionOverlay';
import { LaserOverlay } from '../components/LaserOverlay';
import { PollPanel } from '../components/PollPanel';
import { RecapScreen } from '../components/RecapScreen';
import { CopyButton } from '../components/CopyButton';
import { ChatPanel } from '../components/chat/ChatPanel';
import { TriviaPanel, TriviaPopup } from '../components/quiz/TriviaPanel';
import { InvitePopover } from '../components/InvitePopover';
import { SyncedPlayer } from '../components/SyncedPlayer';
import { AmbilightGlow } from '../components/player/AmbilightGlow';
import { ChangeVideoPanel } from '../components/host/ChangeVideoPanel';
import { ParticipantsPanel } from '../components/host/ParticipantsPanel';
import { ReconnectStatus, SyncQualityIndicator } from '../components/sync/SyncStatus';
import { ToastStack } from '../components/sync/SyncToasts';
import { BackLink } from '../components/ui/BackLink';
import { BrandMark } from '../components/layout/AppShell';
import { AmbientBackground } from '../components/layout/AmbientBackground';
import { Button } from '../components/ui/Button';
import { Card, Field, Input } from '../components/ui/Primitives';
import { ease } from '../lib/motion';
import { apiFetch } from '../lib/api';
import { toAbsoluteInviteLink, pickLatestActiveInvitation, parseInviteCode } from '../lib/invite';
import { getLocalIdentity, guestTokenGrantsRoom } from '../lib/identity';
import { useRoomPlayback, type MediaStatus } from '../hooks/useRoomPlayback';
import { useRecapGate } from '../hooks/useRecapGate';

import { useSocialSocket } from '../hooks/useSocialSocket';
import { useSyncSocket } from '../hooks/useSyncSocket';
import { useSyncToasts } from '../hooks/useSyncToasts';

/** Texto y color del indicador de procesamiento (media-worker) por estado del vídeo. */
const MEDIA_STATUS_UI: Record<MediaStatus, { text: string; tone: string; dot: string }> = {
  pending: { text: 'Preparando el vídeo…', tone: 'text-amber-200', dot: 'bg-amber-300 animate-pulse motion-reduce:animate-none' },
  processing: { text: 'Preparando el vídeo…', tone: 'text-amber-200', dot: 'bg-amber-300 animate-pulse motion-reduce:animate-none' },
  ready: { text: 'Vídeo listo', tone: 'text-emerald-300', dot: 'bg-emerald-400' },
  failed: {
    text: 'No se pudo procesar el vídeo (archivo dañado o formato no soportado)',
    tone: 'text-red-300',
    dot: 'bg-red-400',
  },
};

const HALO_GRADIENT =
  'radial-gradient(ellipse at 50% 45%, rgba(255, 107, 26, 0.32) 0%, rgba(196, 82, 10, 0.16) 45%, transparent 72%)';

/**
 * Halo ambiental detrás del reproductor: respira lento mientras el vídeo suena y se
 * atenúa en pausa. Decorativo (aria-hidden) y estático con movimiento reducido.
 */
function PlayerHalo({ playing }: { playing: boolean }) {
  const reduced = useReducedMotion();
  const breathing = playing && !reduced;
  return (
    <m.div
      aria-hidden="true"
      data-testid="player-halo"
      data-playing={String(playing)}
      className="pointer-events-none absolute -inset-6 -z-10 rounded-[2.5rem] blur-3xl"
      style={{ background: HALO_GRADIENT }}
      initial={false}
      animate={
        breathing
          ? { opacity: [0.55, 0.9, 0.55], scale: [0.98, 1.02, 0.98] }
          : { opacity: playing ? 0.7 : 0.22, scale: 1 }
      }
      transition={breathing ? { duration: 7, repeat: Infinity, ease: 'easeInOut' } : { duration: 1.2, ease }}
    />
  );
}

/** Pantalla terminal de la sala (sin reintentos): expulsión, invitación inválida, etc. */
function RoomNotice({
  title,
  body,
  to = '/',
  linkLabel = 'Volver al inicio',
}: {
  title: string;
  body: string;
  to?: string;
  linkLabel?: string;
}) {
  return (
    <div className="relative isolate grid min-h-[100dvh] place-items-center bg-tint-bg px-4 text-tint-muted">
      <AmbientBackground />
      <Card className="max-w-md p-8 text-center">
        <p role="alert" className="text-lg font-semibold tracking-tight text-white">
          {title}
        </p>
        <p className="mt-2 text-sm leading-relaxed">{body}</p>
        <Link
          to={to}
          className="mt-6 inline-flex rounded-full bg-tint-accent px-5 py-2.5 text-sm font-semibold text-tint-bg transition hover:bg-tint-accentHover"
        >
          {linkLabel}
        </Link>
      </Card>
    </div>
  );
}

export default function WatchRoom() {
  const { roomId } = useParams();
  const navigate = useNavigate();
  const hostToken = localStorage.getItem('tint_token');
  // El guest token solo cuenta si es de esta sala y no caducó: sync-core rechazaría
  // cualquier otro antes del upgrade (cierre 1006 + reconexión infinita).
  const guestToken = guestTokenGrantsRoom(localStorage.getItem('tint_guest_token'), roomId)
    ? localStorage.getItem('tint_guest_token')
    : null;
  // Sin ningún token válido no hay cómo autenticar el socket: se muestra la puerta.
  const hasAccess = !!hostToken || !!guestToken;
  // Canal Social (/ws/social): el estado maestro del chat vive en social-core.
  const {
    messages,
    reactions,
    laser,
    poll,
    recap,
    lastError: socialError,
    send,
    sendReaction,
    sendLaser,
    createPoll,
    votePoll,
    closePoll,
    requestRecap,
    status,
    chatSettings,
    chatCooldownUntil,
    setSlowMode,
    muteUser,
    trivia,
    triviaSchedule,
    scheduleTrivia,
    deleteTrivia,
    answerTrivia,
    dismissTrivia,
  } = useSocialSocket(hasAccess ? roomId : undefined, { role: hostToken ? 'host' : 'guest' });
  // Si hay sesión de host, manda el host aunque queden restos de invitado
  // (p. ej. guest token de una visita anterior al login). Coherente con
  // apiFetch, que prefiere el header de host.
  const isGuest = !hostToken && !!guestToken;
  // Identidad para display (chip + mensajes propios). Solo UI.
  const identity = getLocalIdentity();
  const role = isGuest ? 'guest' : 'host';
  const homePath = isGuest ? '/' : '/dashboard';
  // Respaldo solo si la sala no tiene vídeo asignado en identity-api.
  const demoVideoUrl = import.meta.env.VITE_DEMO_VIDEO_URL || undefined;

  // Canal Sync (/ws/sync): el Reloj Maestro vive en sync-core.
  const videoRef = useRef<HTMLVideoElement>(null);
  const getPositionMs = useCallback(
    () => (videoRef.current ? videoRef.current.currentTime * 1000 : null),
    [],
  );
  // Tras un LOAD, hasta que llega la URL nueva el <video> aún tiene el vídeo anterior: su
  // posición no dice nada del nuevo. Entonces el heartbeat no la informa (null) y
  // useSyncSocket responde con la posición esperada del estado maestro (sin corrección).
  const roomMediaRef = useRef('');
  const loadedMediaRef = useRef<string | null>(null);
  const getHeartbeatPositionMs = useCallback(() => {
    const roomMedia = roomMediaRef.current;
    if (roomMedia && roomMedia !== loadedMediaRef.current) return null;
    return getPositionMs();
  }, [getPositionMs]);
  const sync = useSyncSocket({ roomId: roomId ?? '', role, getPositionMs: getHeartbeatPositionMs, enabled: hasAccess });
  const playback = useRoomPlayback(roomId ?? '', sync.state ? sync.state.media_id : undefined, {
    role,
    enabled: hasAccess && !sync.revoked,
  });
  useEffect(() => {
    roomMediaRef.current = sync.state?.media_id ?? '';
    loadedMediaRef.current = playback.mediaId;
  });
  const toasts = useSyncToasts(sync.lastBroadcast);
  // Las URLs firmadas refrescadas se adoptan solo cuando el `src` cambia igualmente (otra
  // calidad) o el vídeo falla (URL caducada): así el refresco no recarga el reproductor.
  const { adoptFresh, recover: recoverPlayback } = playback;
  const appliedQualityRef = useRef(sync.quality);
  useEffect(() => {
    if (appliedQualityRef.current === sync.quality) return;
    appliedQualityRef.current = sync.quality;
    adoptFresh();
  }, [sync.quality, adoptFresh]);
  // Los controles los habilita el servidor (STATE.can_control / CONTROL), no el rol local.
  const canControl = sync.canControl;
  const delegated = isGuest && canControl;
  const videoSrc = playback.url ?? (!playback.loading && !playback.error && !playback.mediaId ? demoVideoUrl : undefined);
  const emptyMessage = playback.url
    ? undefined
    : playback.loading
      ? 'Cargando vídeo…'
      : playback.status === 'failed'
        ? 'Este vídeo no se pudo procesar. El host puede subir otro.'
        : (playback.error ?? 'Sin video configurado');
  const mediaStatusUi = playback.status ? MEDIA_STATUS_UI[playback.status] : null;
  const { sendCommand } = sync;
  const loadMedia = useCallback(
    (mediaId: string) => sendCommand('LOAD', 0, { media_id: mediaId }) !== null,
    [sendCommand],
  );
  // Puntero láser: solo el host (social-core rechaza el resto con FORBIDDEN).
  const [laserOn, setLaserOn] = useState(false);
  const laserDrawing = laserOn && !isGuest && canControl;
  const [pollCreatorOpen, setPollCreatorOpen] = useState(false);
  // Recap: una sola vez por vídeo (los `ended` repetidos por el drift no lo reabren).
  const recapGate = useRecapGate({
    mediaKey: sync.state?.media_id ?? playback.mediaId,
    recap,
    requestRecap,
  });
  /** El vídeo terminó en esta visita: una expulsión posterior es el cierre de la sala. */
  const [videoFinished, setVideoFinished] = useState(false);
  const [libraryRequest, setLibraryRequest] = useState(0);
  const onVideoEnded = () => {
    setVideoFinished(true);
    // Sync-core sigue en `playing`: sin PAUSE, la corrección de drift lo reanudaría.
    if (canControl && sync.state?.status === 'playing') {
      const duration = videoRef.current?.duration;
      const endMs = Number.isFinite(duration) ? Math.round((duration as number) * 1000) : sync.state.position_ms;
      sendCommand('PAUSE', endMs);
    }
    recapGate.onEnded();
  };
  // Props estables para el reproductor (memo): el chat y las reacciones re-renderizan la sala
  // pero no deben re-renderizar el `<video>` ni su barra.
  const onVideoEndedRef = useRef(onVideoEnded);
  useEffect(() => {
    onVideoEndedRef.current = onVideoEnded;
  });
  const handleVideoEnded = useCallback(() => onVideoEndedRef.current(), []);
  const toggleLaser = useCallback(() => setLaserOn((on) => !on), []);
  const openPollCreator = useCallback(() => setPollCreatorOpen(true), []);
  // El láser a 30 Hz sí cambia esta capa (y re-renderiza el reproductor): es lo esperado.
  const laserOverlay = useMemo(
    () => <LaserOverlay points={laser} drawing={laserDrawing} onPoint={sendLaser} />,
    [laser, laserDrawing, sendLaser],
  );
  const replay = () => {
    recapGate.rearm();
    setVideoFinished(false);
    sendCommand('SEEK', 0);
    sendCommand('PLAY', 0);
  };
  const chooseAnother = () => {
    recapGate.dismiss();
    setLibraryRequest((n) => n + 1);
  };
  const endRoom = async () => {
    await apiFetch(`/rooms/${encodeURIComponent(roomId ?? '')}`, { method: 'DELETE' }, 'host');
    navigate('/dashboard');
  };
  // Estado de reproducción local, solo para el halo (el estado maestro es de sync-core).
  const [playing, setPlaying] = useState(false);
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    const on = () => setPlaying(true);
    const off = () => setPlaying(false);
    setPlaying(!video.paused && !video.ended);
    video.addEventListener('play', on);
    video.addEventListener('pause', off);
    video.addEventListener('ended', off);
    return () => {
      video.removeEventListener('play', on);
      video.removeEventListener('pause', off);
      video.removeEventListener('ended', off);
    };
  }, [videoSrc]);
  const [invite, setInvite] = useState('');
  const [inviteHint, setInviteHint] = useState('');
  const [roomTitle, setRoomTitle] = useState<string | null>(null);
  const [inviteLink, setInviteLink] = useState<string | null>(null);



  // Título y link de invitación: el host los pide al backend; el invitado
  // usa los guardados al canjear (su token no tiene auth de host).
  useEffect(() => {
    if (!roomId || !hasAccess) return;
    if (isGuest) {
      setRoomTitle(localStorage.getItem('tint_room_title'));
      setInviteLink(localStorage.getItem('tint_invite_link'));
      return;
    }
    let cancelled = false;
    Promise.all([apiFetch(`/rooms/${roomId}`), apiFetch(`/rooms/${roomId}/invitations`)])
      .then(([roomRes, invRes]) => {
        if (cancelled) return;
        setRoomTitle(roomRes.room?.title ?? null);
        const list = (invRes.invitations ?? []) as { code: string; link?: string; expiresAt: string; createdAt?: string; revoked?: boolean }[];
        const latest = pickLatestActiveInvitation(
          list.filter((inv) => inv.link).map((inv) => ({ code: inv.code, link: inv.link as string, expiresAt: inv.expiresAt, createdAt: inv.createdAt, revoked: inv.revoked })),
        );
        setInviteLink(latest?.link ?? null);
      })
      .catch(() => {
        if (!cancelled) {
          setRoomTitle(null);
          setInviteLink(null);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [roomId, isGuest, hasAccess]);

  const heading = roomTitle?.trim() ? roomTitle : `Sala ${roomId}`;

  const chatStatus =
    status === 'open' ? 'Chat conectado' : status === 'closed' ? 'Chat desconectado' : 'Chat reconectando…';


  const handleGateJoin = (e: React.FormEvent) => {
    e.preventDefault();
    const code = parseInviteCode(invite);
    if (!code) {
      setInviteHint('Ese link no parece válido. Revisa que incluya /invite/ o el código.');
      return;
    }
    setInviteHint('');
    navigate(`/invite/${code}`);
  };

  // Antes que la puerta: al revocar se borra el guest token y hasAccess cae a false.
  if (sync.revoked) {
    if (videoFinished) {
      return (
        <RoomNotice
          title="El host terminó la sala"
          body="Gracias por ver juntos. Si quieres otra función, pide al host un nuevo enlace."
        />
      );
    }
    return (
      <RoomNotice
        title="Fuiste retirado de la sala por el host"
        body="Tu invitación ya no es válida. Si crees que es un error, pide al host un nuevo enlace."
      />
    );
  }
  // Cierre 4003: el token caducó (el host ya reintentó una vez con un ticket nuevo).
  if (sync.expired) {
    // Al invitado ya se le borró el guest token: sin sesión de host, es un invitado.
    return !hostToken ? (
      <RoomNotice
        title="Tu invitación expiró"
        body="El enlace con el que entraste ya caducó. Pide al host un nuevo enlace para volver a entrar."
      />
    ) : (
      <RoomNotice
        title="Tu sesión de sincronía caducó"
        body="No pudimos renovar tu acceso a la sincronía. Vuelve a entrar a la sala desde el dashboard."
        to="/dashboard"
        linkLabel="Ir al dashboard"
      />
    );
  }
  // GET /playback en 401/403: retirado o caducado mientras la pestaña estaba cerrada.
  if (playback.revoked) {
    return (
      <RoomNotice
        title="Tu invitación ya no es válida"
        body="El host te retiró de la sala o el enlace caducó. Pide al host un nuevo enlace para volver a entrar."
      />
    );
  }
  if (sync.fatalError) {
    return (
      <RoomNotice
        title={sync.fatalError === 'NOT_HOST' ? 'No eres el host de esta sala' : 'La sala ya no existe'}
        body={
          sync.fatalError === 'NOT_HOST'
            ? 'Tu cuenta no es la dueña de esta sala. Si te invitaron, entra con el link de invitación.'
            : 'El host la eliminó o el enlace es incorrecto.'
        }
        to="/dashboard"
        linkLabel="Ir al dashboard"
      />
    );
  }

  if (!hasAccess) {
    return (
      <div className="relative isolate grid min-h-[100dvh] place-items-center bg-tint-bg px-4 text-tint-muted">
        <AmbientBackground />
        <Card className="w-full max-w-md p-8">
          <p className="tint-eyebrow">Sala privada</p>
          <h1 className="mt-2 text-2xl font-bold tracking-tight text-white">Únete a esta sala</h1>
          <p className="mt-2 text-sm leading-relaxed">
            Necesitas un link de invitación o ser el host para ver el contenido y chatear.
          </p>
          <form onSubmit={handleGateJoin} className="mt-6 space-y-4">
            <Field label="Link de invitación" htmlFor="gate-invite" error={undefined}>
              <Input
                id="gate-invite"
                value={invite}
                onChange={(e) => setInvite(e.target.value)}
                placeholder="Pega el link o el código"
                autoComplete="off"
              />
            </Field>
            {inviteHint && <p className="text-[13px] text-red-300">{inviteHint}</p>}
            <Button type="submit" disabled={invite.trim().length === 0} className="w-full">
              Continuar
            </Button>
          </form>
          <p className="mt-6 border-t border-white/10 pt-4 text-[13px]">
            ¿Eres el host?{' '}
            <Link
              to={`/login?next=${encodeURIComponent(`/watch/${roomId ?? ''}`)}`}
              className="text-tint-accent underline-offset-4 hover:underline"
            >
              Inicia sesión
            </Link>
          </p>
        </Card>
      </div>
    );
  }

  return (
    <div className="relative isolate min-h-[100dvh] overflow-x-clip bg-tint-bg text-tint-muted">
      <AmbientBackground />
      <header className="sticky top-0 z-30 border-b border-white/10 bg-tint-bg/80 backdrop-blur-xl">
        {/* < sm: fila 1 = marca + volver + título (+ Invitar); fila 2 = estados. ≥ sm: una fila. */}
        <div className="mx-auto flex max-w-[1400px] flex-col gap-2 px-4 py-2.5 sm:h-16 sm:flex-row sm:items-center sm:justify-between sm:gap-4 sm:py-0">
          <div className="flex min-w-0 flex-1 items-center gap-3">
            {/* El dashboard exige sesión de host: el invitado vuelve al inicio. */}
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
          <div className="hidden shrink-0 items-center gap-2 sm:flex">
            {identity && (
              <span
                className="hidden max-w-[180px] truncate rounded-full border border-tint-accent/30 bg-tint-accent/10 px-3 py-1 text-[12px] font-semibold text-white sm:inline-flex sm:items-center sm:gap-1.5"
                title={`Conectado como ${identity.nick}`}
              >
                <svg
                  aria-hidden="true"
                  viewBox="0 0 16 16"
                  className="h-3.5 w-3.5 shrink-0"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.8"
                  strokeLinecap="round"
                >
                  <circle cx="8" cy="5" r="2.6" />
                  <path d="M2.5 13.5c.8-2.8 2.9-4.2 5.5-4.2s4.7 1.4 5.5 4.2" />
                </svg>
                <span className="truncate">
                  {identity.nick} · {isGuest ? 'participante' : 'host'}
                </span>
              </span>
            )}
            {inviteLink && (
              <span className="hidden min-w-0 items-center gap-2 rounded-full border border-white/10 bg-white/5 py-1 pl-3 pr-1 text-[12px] sm:inline-flex">
                <span className="max-w-[180px] truncate text-tint-muted" title={toAbsoluteInviteLink(inviteLink)}>
                  {toAbsoluteInviteLink(inviteLink)}
                </span>
                <CopyButton link={inviteLink} />
              </span>
            )}
          </div>
          <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-[12px] sm:shrink-0 sm:flex-nowrap">
            {sync.connected && <SyncQualityIndicator rttMs={sync.rttMs} driftMs={sync.driftMs} />}
            <div role="status" aria-label="Estado de sincronía" aria-live="polite">
              <ReconnectStatus connected={sync.connected} reconnect={sync.reconnect} />
            </div>
            <p className="text-[12px]" role="status" aria-live="polite">
              {chatStatus}
            </p>
          </div>
        </div>
      </header>

      <main className="mx-auto grid w-full max-w-[1400px] gap-4 px-4 py-6 lg:grid-cols-[2fr_360px]">
        <section aria-label="Reproductor" className="min-w-0">
          <AmbilightGlow url={playback.ambilightUrl} videoRef={videoRef}>
            <div className="relative isolate">
              {/* Respaldo cálido: con paleta Ambilight el brillo lo pone AmbilightGlow. */}
              {!playback.ambilightUrl && <PlayerHalo playing={playing} />}
              <Card className="overflow-hidden">
                <div className="relative">
                  <SyncedPlayer
                    src={videoSrc}
                    qualities={playback.qualities}
                    canControl={canControl}
                    delegated={delegated}
                    sync={sync}
                    videoRef={videoRef}
                    emptyMessage={emptyMessage}
                    laserOn={laserOn}
                    onToggleLaser={isGuest ? undefined : toggleLaser}
                    onOpenPoll={isGuest ? undefined : openPollCreator}
                    onEnded={handleVideoEnded}
                    onMediaError={recoverPlayback}
                    overlay={laserOverlay}
                  />
                  <ReactionOverlay reactions={reactions} />
                  <TriviaPopup
                    trivia={trivia}
                    isHost={!isGuest}
                    onAnswer={answerTrivia}
                    onDismiss={dismissTrivia}
                    error={socialError?.code ?? null}
                  />
                </div>
                <div className="flex flex-wrap items-center justify-between gap-4 p-4">
                  <div>
                    <p className="text-sm font-medium text-white">Reproducción sincronizada</p>
                    <p className="mt-0.5 text-[13px]">
                      {canControl ? 'Controlas la reproducción de la sala' : 'El host controla la reproducción'}
                    </p>
                    <p
                      role="status"
                      aria-live="polite"
                      aria-label="Estado del vídeo"
                      className={`mt-1 flex items-center gap-2 text-[13px] ${mediaStatusUi?.tone ?? ''}`}
                    >
                      {mediaStatusUi && (
                        <>
                          <span aria-hidden="true" className={`h-2 w-2 shrink-0 rounded-full ${mediaStatusUi.dot}`} />
                          {mediaStatusUi.text}
                        </>
                      )}
                    </p>
                  </div>
                  <ReactionBar
                    onReact={(r) => {
                      // La reacción se ancla al instante del vídeo (REQ-21).
                      sendReaction(r, Math.round((videoRef.current?.currentTime ?? 0) * 1000));
                    }}
                  />
                </div>
              </Card>
            </div>
          </AmbilightGlow>

          {!isGuest && (
            <div className="mt-4 grid gap-4 md:grid-cols-2">
              <Card className="p-5">
                <h2 className="text-[15px] font-semibold text-white">Vídeo de la sala</h2>
                <p className="mb-4 mt-1 text-[13px] leading-relaxed">
                  Elige uno de tus vídeos o sube uno nuevo; todos lo verán desde el inicio, en pausa.
                </p>
                <ChangeVideoPanel roomId={roomId ?? ''} onMediaAssigned={loadMedia} openRequest={libraryRequest} />
              </Card>
              <Card className="p-5">
                <ParticipantsPanel roomId={roomId ?? ''} />
              </Card>
            </div>
          )}

          <Card className="mt-4 p-5">
            <PollPanel
              poll={poll}
              isHost={!isGuest}
              creatorOpen={pollCreatorOpen}
              onCreatorOpenChange={setPollCreatorOpen}
              onCreate={createPoll}
              onVote={votePoll}
              onClose={closePoll}
              error={socialError?.code ?? null}
            />
          </Card>

          <Card className="mt-4 p-5">
            <TriviaPanel
              isHost={!isGuest}
              schedule={triviaSchedule}
              getCurrentMs={getPositionMs}
              onSchedule={scheduleTrivia}
              onDelete={deleteTrivia}
              error={socialError?.code ?? null}
            />
          </Card>

        </section>

        <aside aria-label="Social" className="flex min-h-0 flex-col gap-4">
          <ChatPanel
            roomId={roomId ?? ''}
            messages={messages}
            identity={identity}
            isHost={!isGuest}
            send={send}
            chatSettings={chatSettings}
            cooldownUntil={chatCooldownUntil}
            lastError={socialError}
            onSetSlowMode={setSlowMode}
            onMuteUser={muteUser}
          />
        </aside>
      </main>

      <ToastStack toasts={toasts} className="fixed right-4 top-28 z-40 sm:top-20" />
      {recapGate.open && (
        <RecapScreen
          recap={recapGate.recap}
          onDismiss={recapGate.dismiss}
          isHost={!isGuest}
          onReplay={replay}
          onChooseAnother={chooseAnother}
          onEndRoom={endRoom}
        />
      )}
    </div>
  );
}
