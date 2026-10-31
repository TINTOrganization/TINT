import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { AppShell } from '../components/layout/AppShell';
import { Button } from '../components/ui/Button';
import { Card, EmptyState, ErrorAlert, Field, Input, Skeleton } from '../components/ui/Primitives';
import { ChartCard } from '../components/analytics/ChartCard';
import { DailyUsersChart } from '../components/analytics/DailyUsersChart';
import { DensityStrip } from '../components/analytics/DensityStrip';
import { EventTypeBars } from '../components/analytics/EventTypeBars';
import { AnalyticsError } from '../lib/analytics';
import { fetchBusinessOverview, type BusinessOverview, type ClosedRoom } from '../lib/businessAnalytics';
import { formatDuration, formatNumber } from '../lib/chartScale';

/** La contraseña vive solo en la pestaña: al cerrarla hay que volver a escribirla. */
export const PASSWORD_KEY = 'tint_analytics_password';

const CLOSE_REASONS: Record<string, string> = {
  deleted: 'Borrada por el host',
  host_closed: 'Cerrada por el host',
  grace_expired: 'Por inactividad',
};

function errorMessage(err: unknown): string {
  if (err instanceof AnalyticsError) {
    if (err.status === 401) return 'Contraseña incorrecta.';
    if (err.status === 404) return 'El panel de analítica no está habilitado en este servidor.';
  }
  return 'El servicio de analítica no está disponible en este momento.';
}

function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString('es', { dateStyle: 'medium', timeStyle: 'short' });
}

function Tile({ label, value, hint }: { label: string; value: ReactNode; hint?: string }) {
  return (
    <li>
      <Card className="flex h-full flex-col gap-1 p-4">
        <p className="text-[13px] text-tint-muted">{label}</p>
        <p className="text-2xl font-semibold tracking-tight text-white">{value}</p>
        {hint && <p className="text-[12px] text-tint-muted">{hint}</p>}
      </Card>
    </li>
  );
}

function RoomsTable({ rooms }: { rooms: ClosedRoom[] }) {
  const header = ['Sala', 'Cierre', 'Pico', 'Mensajes', 'Reacciones', 'Latencia (RTT)', 'Drift p95', 'Buffering', 'Reacciones en el vídeo'];
  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-left text-[13px]">
        <caption className="sr-only">Salas cerradas con sus indicadores</caption>
        <thead>
          <tr>
            {header.map((h) => (
              <th key={h} scope="col" className="whitespace-nowrap border-b border-white/10 px-2 py-2 font-medium text-white">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rooms.map((room) => (
            <tr key={room.room_id} className="border-b border-white/5">
              <th scope="row" className="px-2 py-2 font-mono text-[12px] font-normal text-tint-text" title={room.room_id}>
                {room.room_id.slice(0, 8)}
              </th>
              <td className="whitespace-nowrap px-2 py-2">
                <span className="text-tint-text">{room.close_reason ? (CLOSE_REASONS[room.close_reason] ?? room.close_reason) : 'Cerrada'}</span>
                {room.closed_at && <span className="block text-[12px] text-tint-muted">{formatDateTime(room.closed_at)}</span>}
              </td>
              <td className="px-2 py-2 tabular-nums text-tint-text">{room.peak_users}</td>
              <td className="px-2 py-2 tabular-nums text-tint-text">{room.messages}</td>
              <td className="px-2 py-2 tabular-nums text-tint-text">{room.reactions}</td>
              <td className="whitespace-nowrap px-2 py-2 tabular-nums text-tint-text">{formatDuration(room.avg_rtt_ms)}</td>
              <td className="whitespace-nowrap px-2 py-2 tabular-nums text-tint-text">{formatDuration(room.p95_drift_ms)}</td>
              <td className="whitespace-nowrap px-2 py-2 tabular-nums text-tint-text">
                {room.buffering_events === 0 ? 'Sin cortes' : `${room.buffering_events} · ${formatDuration(room.total_buffering_ms)}`}
              </td>
              <td className="px-2 py-2">
                <DensityStrip buckets={room.heatmap} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Overview({ data }: { data: BusinessOverview }) {
  const today = data.daily[data.daily.length - 1];
  return (
    <div className="mt-8 flex flex-col gap-6">
      <ul aria-label="Indicadores de negocio" className="grid grid-cols-2 gap-4 md:grid-cols-5">
        <Tile label="Usuarios activos hoy" value={today ? today.dau : 0} hint="DAU" />
        <Tile label="Usuarios activos en 30 días" value={today ? today.mau : 0} hint="MAU" />
        <Tile label="Eventos registrados" value={formatNumber(data.events.total, 0)} hint="Últimos 90 días" />
        <Tile label="Salas con actividad" value={data.events.rooms} />
        <Tile label="Salas cerradas" value={data.rooms.length} hint="Con KPIs consolidados" />
      </ul>
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <DailyUsersChart days={data.daily} />
        <EventTypeBars data={data.events.by_type} />
      </div>
      <ChartCard
        title="Salas cerradas"
        description="Indicadores consolidados al cerrar cada sala: asistencia, participación, calidad de la red y de la sincronización (QoS) y cortes de reproducción (QoE)."
      >
        {data.rooms.length === 0 ? (
          <p className="py-10 text-center text-sm text-tint-muted">Todavía no se ha cerrado ninguna sala</p>
        ) : (
          <RoomsTable rooms={data.rooms} />
        )}
      </ChartCard>
    </div>
  );
}

function readPassword(): string {
  try {
    return sessionStorage.getItem(PASSWORD_KEY) ?? '';
  } catch {
    return '';
  }
}

function storePassword(value: string) {
  try {
    if (value) sessionStorage.setItem(PASSWORD_KEY, value);
    else sessionStorage.removeItem(PASSWORD_KEY);
  } catch {
    // Sin almacenamiento la sesión dura lo que dure la página.
  }
}

/**
 * Panel de negocio de Analítica (`/analitica`, ruta oculta): usuarios activos, volumen
 * de telemetría y KPIs de las salas cerradas. Pide la contraseña compartida del equipo;
 * los datos son agregados, sin nombres ni contenido del chat.
 */
export default function BusinessAnalytics() {
  const [password, setPassword] = useState(readPassword);
  const [draft, setDraft] = useState('');
  const [data, setData] = useState<BusinessOverview | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [reload, setReload] = useState(0);

  const signOut = useCallback(() => {
    storePassword('');
    setPassword('');
    setData(null);
  }, []);

  useEffect(() => {
    if (!password) return;
    let cancelled = false;
    setLoading(true);
    fetchBusinessOverview(password)
      .then((overview) => {
        if (cancelled) return;
        storePassword(password);
        setData(overview);
        setError('');
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setError(errorMessage(err));
        // Una contraseña que no sirve no se conserva: vuelve el formulario.
        if (err instanceof AnalyticsError && (err.status === 401 || err.status === 404)) signOut();
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [password, reload, signOut]);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!draft) return;
    setError('');
    setPassword(draft);
    setReload((n) => n + 1);
    setDraft('');
  };

  if (!password) {
    return (
      <AppShell>
        <div className="mx-auto max-w-md pt-16">
          <h1 className="text-3xl font-bold tracking-tighter text-white">Analítica de TINT</h1>
          <p className="mt-2 text-sm leading-relaxed">Panel interno del equipo. Escribe la contraseña para ver las métricas.</p>
          <form onSubmit={submit} className="mt-6 flex flex-col gap-4">
            <Field label="Contraseña" htmlFor="analytics-password">
              <Input
                id="analytics-password"
                type="password"
                autoComplete="current-password"
                autoFocus
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
              />
            </Field>
            <ErrorAlert message={error} />
            <Button type="submit" disabled={!draft}>
              Entrar
            </Button>
          </form>
        </div>
      </AppShell>
    );
  }

  return (
    <AppShell
      actions={
        <>
          <Button type="button" variant="quiet" onClick={() => setReload((n) => n + 1)} disabled={loading} className="font-normal">
            Actualizar
          </Button>
          <Button type="button" variant="quiet" onClick={signOut} className="font-normal">
            Salir
          </Button>
        </>
      }
    >
      <div className="pt-8">
        <h1 className="text-3xl font-bold tracking-tighter text-white md:text-4xl">Analítica de TINT</h1>
        <p className="mt-2 max-w-[65ch] text-sm leading-relaxed">
          {data ? `Datos actualizados el ${formatDateTime(data.generated_at)}. Solo totales: sin nombres ni contenido del chat.` : 'Cargando métricas…'}
        </p>
        {error && (
          <div className="mt-6 max-w-2xl">
            <ErrorAlert message={error} />
          </div>
        )}
        {loading && !data && (
          <div className="mt-8 grid grid-cols-2 gap-4 md:grid-cols-5" aria-hidden="true">
            {Array.from({ length: 5 }, (_, i) => (
              <Skeleton key={i} className="h-24" />
            ))}
            <Skeleton className="col-span-2 h-64 md:col-span-5" />
          </div>
        )}
        {data && data.events.total === 0 && data.rooms.length === 0 ? (
          <div className="mt-8 max-w-2xl">
            <EmptyState
              title="Aún no hay actividad registrada"
              body="Cuando alguien inicie sesión o use una sala, aquí aparecerán los usuarios activos, los eventos y las salas cerradas."
            />
          </div>
        ) : (
          data && <Overview data={data} />
        )}
      </div>
    </AppShell>
  );
}
