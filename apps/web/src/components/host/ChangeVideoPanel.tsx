import { useCallback, useEffect, useId, useRef, useState, type ChangeEvent, type FormEvent, type KeyboardEvent } from 'react';
import {
  cancelUpload,
  completeUpload,
  fetchUploadLimit,
  fileTooLargeMessage,
  formatSize,
  requestUpload,
  uploadErrorMessage,
  uploadToBlob,
  UploadError,
} from '../../lib/upload';
import {
  assignVideo,
  assignVideoErrorMessage,
  formatDuration,
  listVideos,
  mergeLibrary,
  videoStatusLabel,
  videoTitle,
  type LibraryVideo,
} from '../../lib/videos';
import { Button } from '../ui/Button';
import { ErrorAlert, Skeleton } from '../ui/Primitives';

export interface ChangeVideoPanelProps {
  roomId: string;
  /** Envía LOAD{media_id} a la sala; false si no se pudo (sin conexión o sin control). */
  onMediaAssigned: (mediaId: string) => boolean;
  /** Cada incremento abre el panel en "Mis vídeos" (p. ej. "Elegir otra película" del recap). */
  openRequest?: number;
  /** Cada cuánto se refresca la biblioteca mientras algún vídeo se procesa (ms; 5 s por defecto). */
  libraryPollMs?: number;
}

/** Espera entre consultas de la biblioteca mientras hay vídeos sin terminar de procesar. */
export const LIBRARY_POLL_MS = 5_000;

type Tab = 'library' | 'upload';

type Phase =
  | 'idle'
  | 'uploading'
  | 'confirming'
  | 'assigning'
  | 'done'
  | 'cancelled'
  /** El vídeo quedó elegido pero el aviso (LOAD) no llegó a la sala. */
  | 'notify-failed'
  | 'error';

const NOTIFY_FAILED =
  'El vídeo quedó elegido, pero no pudimos avisar a la sala porque se perdió la conexión. ' +
  'Pulsa «Avisar a la sala» cuando vuelva.';

const inputClass =
  'rounded-xl border border-white/10 bg-tint-bg px-3 py-2 text-sm text-white focus:border-tint-accent focus:outline-none focus-visible:ring-2 focus-visible:ring-tint-accent/60';

const TABS: { id: Tab; label: string }[] = [
  { id: 'library', label: 'Mis vídeos' },
  { id: 'upload', label: 'Subir nuevo' },
];

/**
 * Panel del host para cambiar el vídeo de la sala, con dos pestañas:
 * - "Mis vídeos": biblioteca del host (`GET /videos`) con búsqueda; "Ver en la sala" →
 *   `PUT /rooms/:id/media {videoId}` → LOAD{media_id}.
 * - "Subir nuevo": URL pre-firmada → `PUT` directo con progreso → `POST …/complete` → LOAD.
 */
export function ChangeVideoPanel({
  roomId,
  onMediaAssigned,
  openRequest = 0,
  libraryPollMs = LIBRARY_POLL_MS,
}: ChangeVideoPanelProps) {
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<Tab>('library');
  const [file, setFile] = useState<File | null>(null);
  const [fileInputKey, setFileInputKey] = useState(0);
  const [progress, setProgress] = useState(0);
  const [phase, setPhase] = useState<Phase>('idle');
  const [error, setError] = useState('');
  const [pendingMediaId, setPendingMediaId] = useState<string | null>(null);
  const [videos, setVideos] = useState<LibraryVideo[] | null>(null);
  const [libraryError, setLibraryError] = useState('');
  const [query, setQuery] = useState('');
  const toggleRef = useRef<HTMLButtonElement>(null);
  const tabRefs = useRef(new Map<Tab, HTMLButtonElement>());
  const abortRef = useRef<AbortController | null>(null);
  /** Tamaño máximo de subida según identity-api (null = desconocido: decide el servidor). */
  const [maxBytes, setMaxBytes] = useState<number | null>(null);
  const panelId = useId();
  const baseId = useId();
  const fileId = useId();
  const fileHelpId = useId();
  const searchId = useId();

  const busy = phase === 'uploading' || phase === 'confirming' || phase === 'assigning';

  const loadLibrary = useCallback(() => {
    setLibraryError('');
    listVideos()
      .then(setVideos)
      .catch(() => setLibraryError('No pudimos cargar tus vídeos.'));
  }, []);

  useEffect(() => {
    if (open) {
      loadLibrary();
      fetchUploadLimit().then(setMaxBytes);
      tabRefs.current.get('library')?.focus();
    }
    // Solo al abrir: cambiar de pestaña no recarga ni roba el foco.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Mientras el panel está abierto y algún vídeo no está listo, la biblioteca se refresca sola:
  // si no, la tarjeta se quedaría en "Preparando…" aunque el vídeo ya esté `ready` (la lista solo
  // se descargaba al abrir el panel). Se detiene al quedar todos listos o al cerrar el panel; un
  // fallo de red no muestra error (hay una lista a la vista) y se reintenta.
  const hasUnfinished = videos?.some((v) => v.status !== 'ready') ?? false;
  useEffect(() => {
    if (!open || !hasUnfinished) return;
    let cancelled = false;
    let timer: number | undefined;
    const poll = () => {
      listVideos()
        .then((next) => {
          if (!cancelled) setVideos((prev) => mergeLibrary(prev, next));
        })
        .catch(() => undefined)
        .finally(() => {
          if (!cancelled) timer = window.setTimeout(poll, libraryPollMs);
        });
    };
    timer = window.setTimeout(poll, libraryPollMs);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [open, hasUnfinished, libraryPollMs]);

  useEffect(() => {
    if (openRequest > 0) {
      setTab('library');
      setOpen(true);
      toggleRef.current?.scrollIntoView?.({ block: 'center' });
    }
  }, [openRequest]);

  // Si el panel desaparece (cambio de página), no se deja un PUT huérfano.
  useEffect(() => () => abortRef.current?.abort(), []);

  const close = () => {
    setOpen(false);
    toggleRef.current?.focus();
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      close();
    }
  };

  const selectTab = (next: Tab, focus = false) => {
    setTab(next);
    if (focus) tabRefs.current.get(next)?.focus();
  };

  const onTabKey = (e: KeyboardEvent) => {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
    e.preventDefault();
    const i = TABS.findIndex((t) => t.id === tab);
    const next = TABS[(i + (e.key === 'ArrowRight' ? 1 : TABS.length - 1)) % TABS.length];
    selectTab(next.id, true);
  };

  /** Envía LOAD; si la sala no está disponible guarda el mediaId para reintentar. */
  const notifyRoom = (mediaId: string) => {
    if (onMediaAssigned(mediaId)) {
      setPendingMediaId(null);
      setError('');
      setPhase('done');
      return true;
    }
    setPendingMediaId(mediaId);
    setError(NOTIFY_FAILED);
    setPhase('notify-failed');
    return false;
  };

  const onFileChange = (e: ChangeEvent<HTMLInputElement>) => {
    const next = e.target.files?.[0] ?? null;
    setPhase('idle');
    setPendingMediaId(null);
    if (next && !next.type.startsWith('video/')) {
      setFile(null);
      setError('El archivo elegido no es un vídeo. Elige un archivo de vídeo (MP4, WebM…).');
      return;
    }
    if (next && maxBytes !== null && next.size > maxBytes) {
      setFile(null);
      setError(fileTooLargeMessage(next.size, maxBytes));
      return;
    }
    setError('');
    setFile(next);
  };

  const upload = async (e: FormEvent) => {
    e.preventDefault();
    if (!file || busy) return;
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    setError('');
    setPendingMediaId(null);
    setProgress(0);
    setPhase('uploading');
    // Reserva pendiente de confirmar: si la subida se corta, se cancela para que el reintento empiece limpio.
    let reservedId: string | null = null;
    try {
      const ticket = await requestUpload(roomId, file);
      reservedId = ticket.videoId;
      await uploadToBlob(ticket.uploadUrl, file, ticket.headers, setProgress, ctrl.signal);
      setPhase('confirming');
      const done = await completeUpload(roomId, ticket.videoId);
      reservedId = null;
      loadLibrary();
      if (notifyRoom(done.mediaId)) {
        setFile(null);
        setFileInputKey((k) => k + 1);
      }
    } catch (err) {
      if (reservedId) void cancelUpload(roomId, reservedId);
      if (ctrl.signal.aborted) {
        // Desmontado o cancelado por el usuario: no hay nada más que hacer.
        if (err instanceof UploadError && err.kind === 'abort') setPhase('cancelled');
        return;
      }
      setError(uploadErrorMessage(err));
      setPhase('error');
    } finally {
      if (abortRef.current === ctrl) abortRef.current = null;
    }
  };

  const cancel = () => abortRef.current?.abort();

  const watchInRoom = async (video: LibraryVideo) => {
    if (busy) return;
    setPhase('assigning');
    setError('');
    setPendingMediaId(null);
    try {
      const res = await assignVideo(roomId, video.id);
      notifyRoom(res.mediaId);
    } catch (err) {
      setError(assignVideoErrorMessage(err));
      setPhase('error');
    }
  };

  const statusText =
    phase === 'uploading'
      ? `Subiendo… ${progress} %`
      : phase === 'confirming'
        ? 'Confirmando la subida…'
        : phase === 'assigning'
          ? 'Poniendo el vídeo…'
          : phase === 'done'
            ? 'Vídeo cargado para todos.'
            : phase === 'cancelled'
              ? 'Subida cancelada.'
              : '';

  const needle = query.trim().toLowerCase();
  const filtered = (videos ?? []).filter((v) => !needle || videoTitle(v).toLowerCase().includes(needle));

  return (
    <div>
      <Button
        ref={toggleRef}
        variant="ghost"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => (open ? close() : setOpen(true))}
      >
        Cambiar vídeo
      </Button>
      {open && (
        <div id={panelId} onKeyDown={onKeyDown} className="mt-4 flex flex-col gap-4">
          <div role="tablist" aria-label="Elegir vídeo" className="flex gap-1 rounded-full bg-white/5 p-1">
            {TABS.map((t) => (
              <button
                key={t.id}
                ref={(el) => {
                  if (el) tabRefs.current.set(t.id, el);
                  else tabRefs.current.delete(t.id);
                }}
                type="button"
                role="tab"
                id={`${baseId}-tab-${t.id}`}
                aria-selected={tab === t.id}
                aria-controls={`${baseId}-panel-${t.id}`}
                tabIndex={tab === t.id ? 0 : -1}
                onClick={() => selectTab(t.id)}
                onKeyDown={onTabKey}
                className={`flex-1 rounded-full px-3 py-1.5 text-[13px] font-semibold transition focus:outline-none focus-visible:ring-2 focus-visible:ring-tint-accent/60 ${
                  tab === t.id ? 'bg-tint-accent text-tint-bg' : 'text-tint-muted hover:text-white'
                }`}
              >
                {t.label}
              </button>
            ))}
          </div>

          {tab === 'library' ? (
            <div role="tabpanel" id={`${baseId}-panel-library`} aria-labelledby={`${baseId}-tab-library`} className="flex flex-col gap-3">
              {videos !== null && videos.length > 0 && (
                <div className="flex flex-col gap-1">
                  <label htmlFor={searchId} className="text-[13px] font-medium text-white">
                    Buscar por nombre
                  </label>
                  <input
                    id={searchId}
                    type="search"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    placeholder="Escribe parte del nombre"
                    autoComplete="off"
                    className={`${inputClass} placeholder:text-tint-muted/60`}
                  />
                </div>
              )}
              {libraryError && (
                <div className="flex flex-wrap items-center gap-2">
                  <ErrorAlert message={libraryError} />
                  <Button variant="ghost" className="px-3 py-1.5 text-[13px]" onClick={loadLibrary}>
                    Reintentar
                  </Button>
                </div>
              )}
              {videos === null && !libraryError && (
                <div className="grid gap-3 sm:grid-cols-2">
                  <p className="sr-only">Cargando tus vídeos…</p>
                  <Skeleton className="h-36" />
                  <Skeleton className="h-36" />
                </div>
              )}
              {videos !== null && videos.length === 0 && (
                <div className="flex flex-col items-start gap-3 rounded-2xl border border-dashed border-white/15 bg-white/[0.02] p-5">
                  <p className="text-sm text-white">Todavía no tienes vídeos.</p>
                  <p className="text-[13px] leading-relaxed text-tint-muted">
                    Sube tu primera película y aparecerá aquí para volver a verla cuando quieras.
                  </p>
                  <Button variant="ghost" className="px-4 py-2" onClick={() => selectTab('upload', true)}>
                    Subir mi primer vídeo
                  </Button>
                </div>
              )}
              {videos !== null && videos.length > 0 && filtered.length === 0 && (
                <p className="text-[13px] text-tint-muted">Ningún vídeo coincide con «{query.trim()}».</p>
              )}
              {filtered.length > 0 && (
                <ul aria-label="Mis vídeos" className="grid max-h-[28rem] gap-3 overflow-y-auto sm:grid-cols-2">
                  {filtered.map((v) => {
                    const title = videoTitle(v);
                    const duration = formatDuration(v.durationMs);
                    return (
                      <li key={v.id} className="flex flex-col overflow-hidden rounded-xl border border-white/10 bg-white/[0.03]">
                        <div className="aspect-video bg-black/60">
                          {v.previewUrl ? (
                            <video
                              aria-hidden="true"
                              preload="metadata"
                              muted
                              playsInline
                              src={v.previewUrl}
                              className="h-full w-full object-cover"
                            />
                          ) : (
                            <div aria-hidden="true" className="grid h-full place-items-center text-2xl text-tint-muted/60">
                              🎬
                            </div>
                          )}
                        </div>
                        <div className="flex flex-1 flex-col gap-2 p-3">
                          <p className="truncate text-sm font-medium text-white" title={title}>
                            {title}
                          </p>
                          <p className="flex items-center gap-2 text-[12px] text-tint-muted">
                            {duration && <span>{duration}</span>}
                            <span
                              className={`rounded-full px-2 py-0.5 ${
                                v.status === 'ready' ? 'bg-emerald-400/15 text-emerald-200' : 'bg-amber-400/15 text-amber-100'
                              }`}
                            >
                              {videoStatusLabel(v.status)}
                            </span>
                          </p>
                          <Button
                            className="mt-auto px-3 py-1.5 text-[13px]"
                            disabled={busy}
                            aria-label={`Ver «${title}» en la sala`}
                            onClick={() => watchInRoom(v)}
                          >
                            Ver en la sala
                          </Button>
                        </div>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          ) : (
            <form
              role="tabpanel"
              id={`${baseId}-panel-upload`}
              aria-labelledby={`${baseId}-tab-upload`}
              onSubmit={upload}
              className="flex flex-col gap-3"
            >
              <label htmlFor={fileId} className="text-sm font-medium text-white">
                Archivo de vídeo
              </label>
              <input
                key={fileInputKey}
                id={fileId}
                type="file"
                accept="video/*"
                onChange={onFileChange}
                disabled={busy}
                aria-describedby={fileHelpId}
                className={`${inputClass} file:mr-3 file:rounded-full file:border-0 file:bg-white/10 file:px-3 file:py-1 file:text-sm file:font-medium file:text-white disabled:opacity-50`}
              />
              <p id={fileHelpId} className="text-[13px] leading-relaxed text-tint-muted">
                {file
                  ? `${file.name} · ${formatSize(file.size)}`
                  : 'Al terminar, todos verán el nuevo vídeo desde el inicio, en pausa.'}
                {maxBytes !== null && ` Tamaño máximo: ${formatSize(maxBytes)}.`}
              </p>

              {(phase === 'uploading' || phase === 'confirming') && (
                <div
                  role="progressbar"
                  aria-label="Progreso de subida"
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={phase === 'confirming' ? 100 : progress}
                  aria-valuetext={statusText}
                  className="h-2 overflow-hidden rounded-full bg-white/10"
                >
                  <div
                    className="h-full rounded-full bg-tint-accent transition-[width] duration-200 motion-reduce:transition-none"
                    style={{ width: `${phase === 'confirming' ? 100 : progress}%` }}
                  />
                </div>
              )}

              <div className="flex flex-wrap gap-2">
                {phase === 'uploading' ? (
                  <Button type="button" variant="ghost" onClick={cancel}>
                    Cancelar subida
                  </Button>
                ) : (
                  <Button type="submit" disabled={!file || busy}>
                    Subir
                  </Button>
                )}
              </div>
            </form>
          )}

          <p
            role="status"
            aria-live="polite"
            className={phase === 'done' ? 'text-[13px] text-emerald-300' : 'text-[13px] text-tint-muted'}
          >
            {statusText}
          </p>
          <ErrorAlert message={error} />
          {phase === 'notify-failed' && pendingMediaId && (
            <Button type="button" variant="ghost" onClick={() => notifyRoom(pendingMediaId)} className="self-start">
              Avisar a la sala
            </Button>
          )}
          <Button type="button" variant="quiet" onClick={close} className="self-start">
            Cerrar
          </Button>
        </div>
      )}
    </div>
  );
}
