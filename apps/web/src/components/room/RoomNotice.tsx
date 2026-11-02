import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { AmbientBackground } from '../layout/AmbientBackground';
import { Card } from '../ui/Primitives';

/** Pantalla terminal de la sala (sin reintentos): expulsión, invitación inválida, etc. */
export function RoomNotice({
  title,
  body,
  to = '/',
  linkLabel = 'Volver al inicio',
  extra,
}: {
  title: string;
  body: string;
  to?: string;
  linkLabel?: string;
  /** Acción secundaria (p. ej. "Ver chat del evento" para el host). */
  extra?: ReactNode;
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
        {extra && <div className="mt-3">{extra}</div>}
      </Card>
    </div>
  );
}

