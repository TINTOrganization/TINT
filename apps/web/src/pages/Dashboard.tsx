import { useEffect, useState, type PointerEvent } from 'react';
import { m, useReducedMotion } from 'framer-motion';
import { apiFetch, ApiError, loginRedirectPath } from '../lib/api';
import { toAbsoluteInviteLink } from '../lib/invite';
import { formatNextScheduledEvent, type DashboardRoom } from '../lib/dashboard';
import { getLocalIdentity } from '../lib/identity';
import { Link, useNavigate } from 'react-router-dom';
import { AppShell } from '../components/layout/AppShell';
import { CopyButton } from '../components/CopyButton';
import { Card, EmptyState, ErrorAlert, Skeleton } from '../components/ui/Primitives';
import { Button, ButtonLink } from '../components/ui/Button';
import { useConfirm } from '../components/ui/ConfirmDialog';
import { StaggerItem, StaggerList } from '../components/motion/Stagger';
import { scaleIn, spring } from '../lib/motion';

export interface DashboardProps {
  initialRooms?: DashboardRoom[];
  initialIsHost?: boolean;
  initialError?: string | null;
  initialRole?: string | null;
}

export default function Dashboard({
  initialRooms,
  initialIsHost,
  initialError,
  initialRole,
}: DashboardProps = {}) {
  // Cargar datos pre-renderizados del script SSR en cliente si existen
  const [ssrData] = useState(() => {
    if (typeof window === 'undefined') return null;
    const el = document.getElementById('__TINT_SSR_DATA__');
    if (el?.textContent) {
      try {
        return JSON.parse(el.textContent) as {
          rooms?: DashboardRoom[];
          isHost?: boolean;
          error?: string | null;
          role?: string | null;
        };
      } catch {
        return null;
      }
    }
    return null;
  });

  const effectiveInitialRooms = initialRooms ?? ssrData?.rooms;
  const effectiveInitialError = initialError ?? ssrData?.error ?? '';
  const effectiveInitialIsHost =
    initialIsHost ??
    ssrData?.isHost ??
    (initialRole ? initialRole !== 'participant' : undefined) ??
    (ssrData?.role ? ssrData.role !== 'participant' : undefined);

  const [rooms, setRooms] = useState<DashboardRoom[]>(() => effectiveInitialRooms ?? []);
  const [error, setError] = useState<string>(() => effectiveInitialError || '');
  const [loading, setLoading] = useState<boolean>(
    () => !effectiveInitialRooms && !effectiveInitialError,
  );
  const [isHost] = useState<boolean>(() => {
    if (effectiveInitialIsHost !== undefined) return effectiveInitialIsHost;
    if (typeof window !== 'undefined') {
      const id = getLocalIdentity();
      if (id?.isGuest) return false;
      return true;
    }
    return true;
  });

  const navigate = useNavigate();
  const reduced = useReducedMotion();
  const { confirm, dialog } = useConfirm();

  /** Lleva la posición del puntero a `--mx/--my` para el brillo radial de la card. */
  const trackPointer = (e: PointerEvent<HTMLDivElement>) => {
    const el = e.currentTarget;
    const rect = el.getBoundingClientRect();
    el.style.setProperty('--mx', `${e.clientX - rect.left}px`);
    el.style.setProperty('--my', `${e.clientY - rect.top}px`);
  };

  useEffect(() => {
    // Si ya contamos con datos del SSR o un error inicial, no reintentamos de inmediato
    if (effectiveInitialRooms !== undefined || effectiveInitialError) {
      setLoading(false);
      return;
    }

    apiFetch('/rooms')
      .then((r) => setRooms(r.rooms || []))
      .catch((e: unknown) => {
        if (e instanceof ApiError && e.status === 401) {
          localStorage.removeItem('tint_token');
          navigate(loginRedirectPath('/dashboard'));
        } else if (e instanceof ApiError && e.status === 403) {
          navigate('/403?reason=not_host', { replace: true });
        } else {
          setError(e instanceof Error ? e.message : 'Error desconocido');
        }
      })
      .finally(() => setLoading(false));
  }, [navigate, effectiveInitialRooms, effectiveInitialError]);

  const handleLogout = () => {
    localStorage.removeItem('tint_token');
    navigate('/login');
  };

  const handleDelete = async (room: DashboardRoom) => {
    const roomTitle = room.title || room.name || 'Sala';
    const ok = await confirm({
      title: `¿Eliminar la sala "${roomTitle}"?`,
      body: 'Sus links dejarán de funcionar.',
      confirmLabel: 'Eliminar',
      tone: 'danger',
    });
    if (!ok) return;
    try {
      await apiFetch(`/rooms/${room.id}`, { method: 'DELETE' });
      setRooms((prev) => prev.filter((r) => r.id !== room.id));
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'No se pudo eliminar la sala');
    }
  };

  return (
    <AppShell
      actions={
        <>
          {/* AC2: Botón de creación reservado únicamente para hosts */}
          {isHost && <ButtonLink to="/rooms/new">Crear sala</ButtonLink>}
          <Button type="button" variant="quiet" onClick={handleLogout} className="font-normal">
            Salir
          </Button>
        </>
      }
    >
      {dialog}
      <div className="pt-10">
        <p className="tint-eyebrow">Tus salas</p>
        <h1 className="mt-2 text-3xl font-bold tracking-tighter text-white md:text-4xl">Mis salas</h1>
        <p className="mt-2 max-w-[65ch] text-sm leading-relaxed">
          {loading
            ? 'Cargando tus salas…'
            : rooms.length === 0
              ? isHost
                ? 'Aún no tienes salas activas. Crea la primera y comparte el link.'
                : 'No tienes salas asignadas actualmente.'
              : `${rooms.length} ${rooms.length === 1 ? 'sala disponible' : 'salas disponibles'} para continuar viendo juntos.`}
        </p>

        {error && (
          <div className="mt-6 max-w-2xl">
            <ErrorAlert message={`Error: ${error}`} />
          </div>
        )}

        {loading && (
          <div className="mt-8 grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3" aria-hidden="true">
            {[0, 1, 2].map((i) => (
              <Skeleton key={i} className="h-72" />
            ))}
          </div>
        )}

        {!loading && rooms.length === 0 && !error && (
          <m.div variants={scaleIn} initial="hidden" animate="show" className="mt-8 max-w-2xl">
            <EmptyState
              title={isHost ? 'Sin salas por ahora' : 'Sin salas asignadas'}
              body={
                isHost
                  ? 'Crea una sala de watch party, obtén un código de invitación y comparte el link. Tus invitados entran con nick, sin cuenta.'
                  : 'No tienes salas disponibles en este momento.'
              }
              action={
                isHost ? (
                  <ButtonLink to="/rooms/new" className="mt-2">
                    Crear sala
                  </ButtonLink>
                ) : null
              }
            />
          </m.div>
        )}

        {!loading && rooms.length > 0 && (
          <StaggerList className="mt-8 grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
            {rooms.map((room) => {
              const roomTitle = room.title || room.name || 'Sala sin nombre';
              const roomStatus = (room.status === 'disabled' ? 'disabled' : 'active') as 'active' | 'disabled';
              const nextEventText = formatNextScheduledEvent(room.nextScheduledEvent);

              return (
                <StaggerItem key={room.id} className="min-h-0">
                  <m.div
                    data-testid={`room-card-${room.id}`}
                    className="group h-full rounded-2xl transition-shadow duration-500 hover:shadow-lift"
                    whileHover={{ y: -4 }}
                    transition={spring}
                    onPointerMove={reduced ? undefined : trackPointer}
                  >
                    <Card className="relative flex h-full flex-col overflow-hidden transition-colors duration-500 group-hover:border-white/20">
                      <div className="relative h-32 shrink-0 overflow-hidden">
                        <img
                          src={`https://picsum.photos/seed/tint-${room.id}/640/360`}
                          alt=""
                          loading="lazy"
                          className="h-full w-full object-cover opacity-60 transition-[opacity,transform] duration-700 ease-out group-hover:scale-[1.04] group-hover:opacity-75"
                        />
                        <div className="absolute inset-0 bg-gradient-to-t from-tint-card via-transparent to-transparent" />
                      </div>

                      {/* AC1: Nombre de la sala, próximo evento y estado actual */}
                      <div className="flex items-center justify-between gap-3 p-4">
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2">
                            <p className="truncate text-[15px] font-semibold text-white" title={roomTitle}>
                              {roomTitle}
                            </p>
                            {/* AC1: Estado actual (active o disabled) */}
                            <span
                              data-testid={`room-status-${room.id}`}
                              data-status={roomStatus}
                              className={`inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium tracking-wide ${
                                roomStatus === 'disabled'
                                  ? 'border border-red-500/20 bg-red-500/10 text-red-400'
                                  : 'border border-emerald-500/20 bg-emerald-500/10 text-emerald-400'
                              }`}
                            >
                              <span data-testid="room-status">{roomStatus}</span>
                            </span>
                          </div>

                          {/* AC1: Próximo evento programado */}
                          <div
                            className="mt-1 flex items-center gap-1.5 text-xs text-tint-muted"
                            data-testid={`next-scheduled-event-${room.id}`}
                          >
                            <span className="text-tint-muted/70">Próximo evento:</span>
                            {nextEventText ? (
                              <span className="font-medium text-tint-accent" data-testid="next-scheduled-event">
                                {nextEventText}
                              </span>
                            ) : (
                              <span className="text-tint-muted/60" data-testid="next-scheduled-event">
                                Sin eventos programados
                              </span>
                            )}
                          </div>
                        </div>

                        <ButtonLink
                          to={`/watch/${room.id}`}
                          aria-label={`Abrir ${roomTitle}`}
                          size="sm"
                          className="shrink-0"
                        >
                          Abrir
                        </ButtonLink>
                      </div>

                      <div className="mt-auto border-t border-white/5 px-4 py-2">
                        {room.invitation ? (
                          <div className="flex items-center gap-2">
                            <span
                              className="min-w-0 flex-1 truncate text-[12px] text-tint-muted"
                              title={toAbsoluteInviteLink(room.invitation.link)}
                            >
                              {toAbsoluteInviteLink(room.invitation.link)}
                            </span>
                            <CopyButton link={room.invitation.link} />
                          </div>
                        ) : (
                          <p className="truncate text-[12px] text-tint-muted/70">
                            Sin link vigente.{' '}
                            {isHost && (
                              <Link
                                to={`/rooms/${room.id}`}
                                className="underline underline-offset-2 hover:text-white"
                              >
                                Generar en Gestionar
                              </Link>
                            )}
                          </p>
                        )}
                      </div>

                      {/* AC2: Role-Based UI Gating — Controles de gestión visibles únicamente para el Host */}
                      {isHost && (
                        <div className="flex items-center gap-1 border-t border-white/5 px-4 py-2">
                          <ButtonLink
                            to={`/rooms/${room.id}`}
                            aria-label={`Gestionar ${roomTitle}`}
                            variant="quiet"
                            size="sm"
                            className="font-normal"
                          >
                            Gestionar
                          </ButtonLink>
                          <ButtonLink
                            to={`/rooms/${room.id}/analytics`}
                            aria-label={`Análisis de ${roomTitle}`}
                            variant="quiet"
                            size="sm"
                            className="font-normal"
                          >
                            Análisis
                          </ButtonLink>
                          <button
                            type="button"
                            onClick={() => void handleDelete(room)}
                            aria-label={`Eliminar ${roomTitle}`}
                            className="min-h-10 rounded-full px-3 py-1.5 text-[13px] text-tint-muted transition hover:bg-red-500/10 sm:min-h-0 hover:text-red-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-400"
                          >
                            Eliminar
                          </button>
                        </div>
                      )}

                      <div
                        aria-hidden="true"
                        className="pointer-events-none absolute inset-0 opacity-0 transition-opacity duration-500 group-hover:opacity-100"
                        style={{
                          background:
                            'radial-gradient(240px circle at var(--mx, 50%) var(--my, 0%), rgba(255,138,61,0.10), transparent 60%)',
                        }}
                      />
                    </Card>
                  </m.div>
                </StaggerItem>
              );
            })}
          </StaggerList>
        )}
      </div>
    </AppShell>
  );
}
