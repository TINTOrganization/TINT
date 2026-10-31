import { memo, useCallback, useEffect, useId, useRef, useState, type ReactNode, type RefObject } from 'react';
import type { SyncSocketApi } from '../hooks/useSyncSocket';
import { PLAYER_SHORTCUTS, SHORTCUT_SEEK_MS, usePlayerShortcuts } from '../hooks/usePlayerShortcuts';
import { useTransientFlag } from '../hooks/useTransientFlag';
import { applyCorrection, shouldRestoreRate, shouldSkipSeekCorrection } from '../lib/drift';
import { readNetworkHints, resolveQuality, type PlaybackQuality } from '../lib/quality';
import { estimateServerNow, expectedPosition, stepRate, type QualityPref, type SyncSnapshot } from '../lib/syncProtocol';
import { createStallTracker } from '../lib/stallTracker';
import { formatRate, formatTime } from '../lib/time';
import { HostControlBar } from './host/HostControlBar';
import { SeekBar } from './player/SeekBar';
import { Button } from './ui/Button';

export interface SyncedPlayerProps {
  /** URL del vídeo; sin ella se muestra `emptyMessage`. */
  src?: string;
  /** Versiones del vídeo (`playback.qualities`); sin ellas se usa `src`. */
  qualities?: PlaybackQuality[];
  /** Si este cliente puede emitir comandos (de `sync.canControl`). */
  canControl: boolean;
  /** Participante con control delegado por ausencia del host (F7). */
  delegated?: boolean;
  sync: SyncSocketApi;
  videoRef: RefObject<HTMLVideoElement>;
  /** Texto cuando no hay `src`. */
  emptyMessage?: string;
  /** Reloj monotónico local (inyectable para pruebas). */
  now?: () => number;
  /** Puntero láser del host (botón en la barra de controles). */
  laserOn?: boolean;
  onToggleLaser?: () => void;
  /** Abre el creador de encuestas (botón en la barra de controles). */
  onOpenPoll?: () => void;
  /** Capas sobre el área del vídeo (p. ej. el puntero láser). */
  overlay?: ReactNode;
  /** El vídeo llegó al final (evento `ended`). */
  onEnded?: () => void;
  /**
   * El `<video>` no pudo cargar el `src` (MEDIA_ERR_NETWORK o MEDIA_ERR_SRC_NOT_SUPPORTED,
   * p. ej. URL firmada caducada): quien lo use debe dar una URL nueva. Al cambiar el `src`
   * se re-aplica el estado maestro (posición y play/pausa).
   */
  onMediaError?: () => void;
}

const RATE_CHECK_INTERVAL_MS = 200;
/** Duración del fundido al corregir con seek. */
const FADE_MS = 180;
/** Un salto mayor a esto al aplicar estado se suaviza con fundido. */
const FADE_JUMP_MS = 2_000;
/**
 * Deriva tolerada al aplicar un estado mientras la sala reproduce: por debajo no se hace
 * seek (cada seek vacía el búfer y congela la imagen). Así un broadcast que no mueve el
 * ancla (VOLUME, QUALITY, RATE) no hace saltar a todos los clientes.
 */
export const APPLY_SEEK_TOLERANCE_PLAYING_MS = 250;
/** Igual, con la sala en pausa: el seek no interrumpe nada y se busca el fotograma exacto. */
export const APPLY_SEEK_TOLERANCE_PAUSED_MS = 50;
/** `MediaError.MEDIA_ERR_NETWORK` y `MEDIA_ERR_SRC_NOT_SUPPORTED`: se recuperan con otra URL. */
const RECOVERABLE_MEDIA_ERRORS: readonly number[] = [2, 4];
/** Marcadores de saltos del host que se conservan. */
const MAX_SEEK_MARKS = 5;
/** La posición mostrada solo se actualiza si avanzó al menos esto (o tras un seek). */
const PROGRESS_STEP_MS = 250;

const ERROR_MESSAGES: Record<string, string> = {
  FORBIDDEN: 'No tienes permiso para controlar la reproducción.',
  RATE_LIMITED: 'Demasiados comandos seguidos; espera un momento.',
  INVALID: 'Comando inválido para el estado actual de la sala.',
  INTERNAL: 'Error del servidor de sincronía.',
  TICKET: 'No se pudo obtener el ticket de sincronía; reintentando…',
  NO_TOKEN: 'Sin sesión para sincronizar. Vuelve a abrir la invitación.',
};

const defaultNow = () => performance.now();

function durationOf(video: HTMLVideoElement): number {
  return Number.isFinite(video.duration) ? Math.round(video.duration * 1000) : 0;
}

function sameRanges(a: Array<[number, number]>, b: Array<[number, number]>): boolean {
  return a.length === b.length && a.every(([s, e], i) => s === b[i][0] && e === b[i][1]);
}

function bufferedOf(video: HTMLVideoElement): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  const b = video.buffered;
  for (let i = 0; i < (b?.length ?? 0); i++) {
    ranges.push([Math.round(b.start(i) * 1000), Math.round(b.end(i) * 1000)]);
  }
  return ranges;
}

/**
 * Reproductor sincronizado con el Canal Sync. No decide nada por sí mismo: aplica el
 * estado maestro y las correcciones de sync-core, y quien tiene el control solo emite
 * comandos que el servidor valida y difunde. Es `memo`: quien lo usa debe pasar props
 * estables (callbacks con `useCallback`, `sync` memoizado) para que el chat y las
 * reacciones no lo re-rendericen.
 */
export const SyncedPlayer = memo(function SyncedPlayer({
  src,
  qualities,
  canControl,
  delegated = false,
  sync,
  videoRef,
  emptyMessage = 'Sin video configurado',
  now = defaultNow,
  laserOn,
  onToggleLaser,
  onOpenPoll,
  overlay,
  onEnded,
  onMediaError,
}: SyncedPlayerProps) {
  const { state, correction, connected, hostOnline, lastError, lastBroadcast, sendCommand, volume, quality, sendBuffering } = sync;
  const [needsGesture, setNeedsGesture] = useState(false);
  const [currentMs, setCurrentMs] = useState(0);
  const [durationMs, setDurationMs] = useState(0);
  const [buffered, setBuffered] = useState<Array<[number, number]>>([]);
  const [marks, setMarks] = useState<number[]>([]);
  const [showHelp, setShowHelp] = useState(false);
  // Con puntero láser, L lo alterna (HostControlBar) y deja de avanzar 10 s.
  const shortcuts: readonly { keys: string; action: string }[] = onToggleLaser
    ? [
        ...PLAYER_SHORTCUTS.map((s) => (s.keys === '→ / L' ? { ...s, keys: '→' } : s)),
        { keys: 'L', action: 'Activar o desactivar el puntero láser' },
      ]
    : PLAYER_SHORTCUTS;
  const [fading, fade] = useTransientFlag(FADE_MS);
  /** Silencio local del participante: no cambia el volumen maestro de la sala. */
  const [localMuted, setLocalMuted] = useState(false);
  // Pistas de red/pantalla al montar: no se cambia de calidad por redimensionar la ventana.
  const [networkHints] = useState(readNetworkHints);
  const helpId = useId();

  const nowRef = useRef(now);
  const stateRef = useRef(state);
  const lastPosRef = useRef(0);
  const cancelRateRef = useRef<(() => void) | null>(null);

  const sendBufferingRef = useRef(sendBuffering);

  const needsGestureRef = useRef(needsGesture);

  useEffect(() => {
    nowRef.current = now;
    stateRef.current = state;
    sendBufferingRef.current = sendBuffering;
    needsGestureRef.current = needsGesture;
  });

  // Stalls (waiting → playing) para la analítica; se ignoran los causados por seeks.
  const [stalls] = useState(() =>
    createStallTracker({
      now: () => nowRef.current(),
      onStall: ({ positionMs, durationMs }) => {
        sendBufferingRef.current(positionMs, durationMs);
      },
    }),
  );

  const cancelRateCorrection = useCallback(() => {
    cancelRateRef.current?.();
    cancelRateRef.current = null;
  }, []);

  useEffect(() => cancelRateCorrection, [cancelRateCorrection]);

  const tryPlay = useCallback((video: HTMLVideoElement) => {
    const result = video.play() as Promise<void> | undefined;
    // Solo la política de autoplay (NotAllowedError) pide un gesto; un play() interrumpido
    // por un pause() o un cambio de src (AbortError) no es un bloqueo.
    if (result && typeof result.then === 'function') {
      result.then(
        () => setNeedsGesture(false),
        (err: unknown) => {
          if ((err as { name?: unknown } | null)?.name === 'NotAllowedError') setNeedsGesture(true);
        },
      );
    }
  }, []);

  const applyMaster = useCallback(
    (video: HTMLVideoElement, snap: SyncSnapshot) => {
      cancelRateCorrection();
      const expected = expectedPosition(snap, estimateServerNow(snap, nowRef.current()));
      const jump = Math.abs(video.currentTime * 1000 - expected);
      const tolerance =
        snap.status === 'playing' ? APPLY_SEEK_TOLERANCE_PLAYING_MS : APPLY_SEEK_TOLERANCE_PAUSED_MS;
      video.playbackRate = snap.rate;
      if (jump > tolerance) {
        if (jump > FADE_JUMP_MS) fade();
        video.currentTime = expected / 1000;
      }
      if (snap.status === 'playing') {
        tryPlay(video);
      } else {
        video.pause();
        // Sala en pausa: no hay nada a lo que unirse (y no debe poder arrancarla).
        setNeedsGesture(false);
      }
    },
    [cancelRateCorrection, fade, tryPlay],
  );

  // `auto` → cada cliente elige; si la calidad pedida no existe, cae al original. Al cambiar
  // el `src`, onLoadedMetadata re-aplica el estado maestro (posición y play/pausa).
  const chosenQuality = src ? resolveQuality(quality, qualities ?? [], networkHints) : null;
  const videoSrc = src ? (chosenQuality?.url ?? src) : undefined;

  // Volumen maestro para todos; el participante puede silenciarse solo a sí mismo.
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    video.volume = volume;
    video.muted = !canControl && localMuted;
  }, [volume, localMuted, canControl, videoSrc, videoRef]);

  // Aplica cada snapshot/broadcast aceptado por el hook.
  useEffect(() => {
    const video = videoRef.current;
    if (!video || !state) return;
    applyMaster(video, state);
  }, [state, videoRef, applyMaster]);

  // Aplica las correcciones de drift decididas por el servidor.
  useEffect(() => {
    const video = videoRef.current;
    if (!video || !correction) return;
    if (correction.strategy === 'seek' && shouldSkipSeekCorrection(video, correction.target_ms, needsGestureRef.current)) {
      return;
    }
    cancelRateCorrection();
    // La corrección por velocidad es relativa a la velocidad de la sala.
    const roomRate = correction.rate ?? stateRef.current?.rate ?? 1;
    const action = applyCorrection(video, correction, roomRate);
    if (action.kind === 'seek') {
      fade();
      return;
    }
    if (action.playbackRate === roomRate) return;

    const startedAt = nowRef.current();
    const check = () => {
      const snap = stateRef.current;
      const t = nowRef.current();
      const expected = snap ? expectedPosition(snap, estimateServerNow(snap, t)) : null;
      if (shouldRestoreRate(video.currentTime * 1000, expected, t - startedAt)) {
        video.playbackRate = snap?.rate ?? roomRate;
        cancelRateCorrection();
      }
    };
    const interval = setInterval(check, RATE_CHECK_INTERVAL_MS);
    video.addEventListener('timeupdate', check);
    cancelRateRef.current = () => {
      clearInterval(interval);
      video.removeEventListener('timeupdate', check);
    };
  }, [correction, videoRef, cancelRateCorrection, fade]);

  // Marcadores de los saltos del host (no los propios); se reinician con otro vídeo.
  useEffect(() => {
    if (!lastBroadcast || lastBroadcast.own) return;
    if (lastBroadcast.type === 'LOAD') setMarks([]);
    if (lastBroadcast.type === 'SEEK') {
      setMarks((m) => [...m, lastBroadcast.position_ms].slice(-MAX_SEEK_MARKS));
    }
  }, [lastBroadcast]);

  /** Últimos valores mostrados: evita 3 setState (y renders) por cada timeupdate/progress. */
  const shownRef = useRef<{ ms: number; duration: number; buffered: Array<[number, number]> }>({
    ms: Number.NEGATIVE_INFINITY,
    duration: 0,
    buffered: [],
  });

  /** `force`: tras un seek o un `src` nuevo la posición se muestra aunque el salto sea pequeño. */
  const syncProgress = (video: HTMLVideoElement, force = false) => {
    const ms = Math.round(video.currentTime * 1000);
    lastPosRef.current = ms;
    const shown = shownRef.current;
    if (force || Math.abs(ms - shown.ms) >= PROGRESS_STEP_MS) {
      shown.ms = ms;
      setCurrentMs(ms);
    }
    const duration = durationOf(video);
    if (duration !== shown.duration) {
      shown.duration = duration;
      setDurationMs(duration);
    }
    const ranges = bufferedOf(video);
    if (!sameRanges(ranges, shown.buffered)) {
      shown.buffered = ranges;
      setBuffered(ranges);
    }
  };

  // Nuevo src (otro vídeo o URL firmada refrescada): se re-aplica el estado maestro o,
  // si aún no hay, la última posición conocida.
  const onLoadedMetadata = (video: HTMLVideoElement) => {
    const snap = stateRef.current;
    if (snap) applyMaster(video, snap);
    else if (lastPosRef.current > 0) video.currentTime = lastPosRef.current / 1000;
    syncProgress(video, true);
  };

  const localPositionMs = () => {
    const video = videoRef.current;
    return video ? Math.round(video.currentTime * 1000) : currentMs;
  };

  const seekBy = (deltaMs: number) => {
    const max = durationMs > 0 ? durationMs : Number.POSITIVE_INFINITY;
    sendCommand('SEEK', Math.min(max, Math.max(0, localPositionMs() + deltaMs)));
  };

  const togglePlay = () => {
    sendCommand(state?.status === 'playing' ? 'PAUSE' : 'PLAY', localPositionMs());
  };

  const currentRate = state?.rate ?? 1;
  const changeRate = (rate: number) => {
    if (rate === currentRate) return;
    sendCommand('RATE', localPositionMs(), { rate });
  };

  const changeVolume = (next: number) => {
    sendCommand('VOLUME', localPositionMs(), { volume: next });
  };

  const changeQuality = (next: QualityPref) => {
    sendCommand('QUALITY', localPositionMs(), { quality: next });
  };

  const controlsDisabled = !canControl || !connected;

  usePlayerShortcuts(canControl && connected, {
    onTogglePlay: togglePlay,
    onSeekBy: seekBy,
    onRateStep: (dir) => changeRate(stepRate(currentRate, dir)),
    onToggleHelp: () => setShowHelp((v) => !v),
  });

  // Re-aplica el estado maestro vigente: solo reproduce si la sala está reproduciendo
  // (si no, alinea la posición) y entra en el segundo actual, no en el del bloqueo.
  const joinPlayback = () => {
    const video = videoRef.current;
    const snap = stateRef.current;
    if (video && snap) applyMaster(video, snap);
  };

  const errorMessage = lastError ? (ERROR_MESSAGES[lastError] ?? `Error de sincronía (${lastError}).`) : '';

  return (
    <div>
      <div className="relative aspect-video bg-black">
        {videoSrc ? (
          <video
            ref={videoRef}
            src={videoSrc}
            aria-label="Vídeo de la sala"
            playsInline
            preload="auto"
            className="absolute inset-0 h-full w-full object-contain"
            onTimeUpdate={(e) => syncProgress(e.currentTarget)}
            onProgress={(e) => syncProgress(e.currentTarget)}
            onLoadedMetadata={(e) => onLoadedMetadata(e.currentTarget)}
            onDurationChange={(e) => syncProgress(e.currentTarget)}
            onEnded={onEnded}
            onError={(e) => {
              const code = e.currentTarget.error?.code;
              if (code !== undefined && RECOVERABLE_MEDIA_ERRORS.includes(code)) onMediaError?.();
            }}
            onWaiting={() => stalls.waiting()}
            onPlaying={(e) => stalls.playing(e.currentTarget.currentTime * 1000)}
            onSeeking={() => stalls.seeking()}
            onSeeked={(e) => {
              stalls.seeked();
              syncProgress(e.currentTarget, true);
            }}
            onEmptied={() => stalls.reset()}
          />
        ) : (
          <div className="absolute inset-0 grid place-items-center">
            <p className="text-[13px] text-tint-muted">{emptyMessage}</p>
          </div>
        )}

        {overlay}

        {/* Fundido breve al corregir con seek o en saltos grandes (no con reduced-motion). */}
        <div
          aria-hidden="true"
          data-testid="sync-fade"
          data-active={fading}
          className={`pointer-events-none absolute inset-0 bg-black transition-opacity duration-200 ease-out motion-reduce:transition-none ${
            fading ? 'opacity-80' : 'opacity-0'
          }`}
        />

        <div className="absolute left-3 top-3 flex flex-col items-start gap-2">
          {hostOnline === false && (
            <span
              aria-live="polite"
              className="rounded-full border border-white/15 bg-black/70 px-3 py-1 text-[12px] text-white"
            >
              Host desconectado
            </span>
          )}
          {delegated && (
            <span
              role="status"
              className="rounded-full border border-tint-accent/50 bg-black/80 px-3 py-1 text-[12px] text-white"
            >
              El host no está: tienes el control temporal
            </span>
          )}
        </div>

        {needsGesture && (
          <div className="absolute inset-0 grid place-items-center bg-black/60">
            <Button onClick={joinPlayback} aria-label="Unirse a la reproducción">
              Unirse a la reproducción
            </Button>
          </div>
        )}
      </div>

      <div className="border-t border-white/10 px-4 pb-3 pt-2">
        <SeekBar
          currentMs={currentMs}
          durationMs={durationMs}
          buffered={buffered}
          marks={marks}
          interactive={canControl}
          disabled={!connected}
          onSeek={(ms) => sendCommand('SEEK', ms)}
        />

        <div className="mt-2 flex flex-wrap items-center gap-2">
          <Button
            variant="quiet"
            className="px-3 py-2"
            aria-label="Retroceder 10 segundos"
            aria-keyshortcuts="ArrowLeft j"
            disabled={controlsDisabled}
            onClick={() => seekBy(-SHORTCUT_SEEK_MS)}
          >
            <span aria-hidden="true">−10</span>
          </Button>
          <Button
            variant="primary"
            className="px-4 py-2"
            aria-label="Reproducir"
            aria-keyshortcuts="Space k"
            disabled={controlsDisabled}
            onClick={() => sendCommand('PLAY', localPositionMs())}
          >
            <span aria-hidden="true">▶</span>
          </Button>
          <Button
            variant="ghost"
            className="px-4 py-2"
            aria-label="Pausar"
            aria-keyshortcuts="Space k"
            disabled={controlsDisabled}
            onClick={() => sendCommand('PAUSE', localPositionMs())}
          >
            <span aria-hidden="true">❚❚</span>
          </Button>
          <Button
            variant="quiet"
            className="px-3 py-2"
            aria-label="Avanzar 10 segundos"
            aria-keyshortcuts={onToggleLaser ? 'ArrowRight' : 'ArrowRight l'}
            disabled={controlsDisabled}
            onClick={() => seekBy(SHORTCUT_SEEK_MS)}
          >
            <span aria-hidden="true">+10</span>
          </Button>

          <span className="ml-1 tabular-nums text-[13px] text-tint-muted">
            {formatTime(currentMs)} / {formatTime(durationMs)}
          </span>

          <div className="ml-auto flex items-center gap-2">
            {canControl ? (
              <>
                <Button
                  variant="quiet"
                  className="px-3 py-1.5 text-[13px]"
                  aria-expanded={showHelp}
                  aria-controls={helpId}
                  aria-keyshortcuts="?"
                  onClick={() => setShowHelp((v) => !v)}
                >
                  Atajos de teclado
                </Button>
              </>
            ) : (
              <>
                {currentRate !== 1 && (
                  <span
                    aria-label={`Velocidad ${formatRate(currentRate)}×`}
                    className="rounded-full border border-white/15 px-2.5 py-0.5 text-[12px] tabular-nums text-white"
                  >
                    {formatRate(currentRate)}×
                  </span>
                )}
                <Button
                  variant="quiet"
                  className="px-3 py-1.5 text-[13px]"
                  aria-label="Silenciar solo para mí"
                  aria-pressed={localMuted}
                  onClick={() => setLocalMuted((m) => !m)}
                >
                  <span aria-hidden="true">{localMuted ? '🔇' : '🔊'}</span>
                </Button>
              </>
            )}
          </div>
        </div>

        {canControl && (
          <HostControlBar
            connected={connected}
            volume={volume}
            onVolumeChange={changeVolume}
            quality={quality}
            qualities={qualities ?? []}
            onQualityChange={changeQuality}
            rate={currentRate}
            onRateChange={changeRate}
            laserOn={laserOn}
            onToggleLaser={onToggleLaser}
            onOpenPoll={onOpenPoll}
          />
        )}

        {canControl && showHelp && (
          <dl
            id={helpId}
            className="mt-3 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 rounded-xl border border-white/10 bg-white/[0.03] p-3 text-[13px]"
          >
            {shortcuts.map((s) => (
              <div key={s.keys} className="contents">
                <dt>
                  <kbd className="rounded border border-white/20 bg-white/5 px-1.5 py-0.5 font-mono text-[12px] text-white">
                    {s.keys}
                  </kbd>
                </dt>
                <dd className="text-tint-muted">{s.action}</dd>
              </div>
            ))}
          </dl>
        )}
      </div>

      {errorMessage && (
        <p role="alert" className="px-4 pb-3 text-[13px] text-red-300">
          {errorMessage}
        </p>
      )}
    </div>
  );
});
