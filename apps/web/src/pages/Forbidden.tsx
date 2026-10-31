import { useSearchParams } from 'react-router-dom';
import { m } from 'framer-motion';
import { AmbientBackground } from '../components/layout/AmbientBackground';
import { ButtonLink } from '../components/ui/Button';
import { TintLogo } from '../components/brand/TintLogo';
import { fadeBlur, stagger } from '../lib/motion';

type ForbiddenReason = 'banned' | 'not_host' | 'default';

interface ForbiddenCopy {
  eyebrow: string;
  title: string;
  body: string;
}

const COPY: Record<ForbiddenReason, ForbiddenCopy> = {
  banned: {
    eyebrow: 'Acceso bloqueado',
    title: 'El host te bloqueó en esta sala',
    body: 'No puedes volver a unirte desde este navegador. Si crees que es un error, contacta al host directamente.',
  },
  not_host: {
    eyebrow: 'Sin permiso',
    title: 'Solo el host puede acceder a esta sección',
    body: 'Esta área está reservada para el creador de la sala. Si eres el host, inicia sesión con tu cuenta de Google.',
  },
  default: {
    eyebrow: 'Error 403',
    title: 'Acceso restringido',
    body: 'No tienes permiso para ver esta página. Si crees que es un error, vuelve al inicio o contacta al host.',
  },
};

function parseReason(raw: string | null): ForbiddenReason {
  if (raw === 'banned') return 'banned';
  if (raw === 'not_host') return 'not_host';
  return 'default';
}

/**
 * Pantalla de error 403 Forbidden con la línea gráfica Dark/Luxury de TINT.
 * Acepta ?reason=banned|not_host para adaptar el mensaje.
 */
export default function Forbidden() {
  const [params] = useSearchParams();
  const reason = parseReason(params.get('reason'));
  const copy = COPY[reason];

  const hasHostToken = !!localStorage.getItem('tint_token');
  const backTo = hasHostToken ? '/dashboard' : '/login';
  const backLabel = hasHostToken ? 'Volver al inicio' : 'Iniciar sesión';

  return (
    <div className="relative isolate flex min-h-[100dvh] flex-col items-center justify-center bg-tint-bg px-4 text-tint-muted">
      <AmbientBackground />

      {/* Halo cálido sutil detrás del código */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute left-1/2 top-1/2 -z-10 h-[28rem] w-[28rem] -translate-x-1/2 -translate-y-1/2 rounded-full bg-tint-accent/[0.07] blur-[90px]"
      />

      <main className="relative z-10 flex w-full max-w-md flex-col items-center text-center">
        <m.div
          variants={stagger(0.09, 0.05)}
          initial="hidden"
          animate="show"
          className="flex flex-col items-center gap-6"
        >
          {/* Logo */}
          <m.div variants={fadeBlur}>
            <TintLogo size={48} decorative />
          </m.div>

          {/* Código grande estilizado */}
          <m.p
            variants={fadeBlur}
            aria-hidden="true"
            className="select-none text-[7rem] font-black leading-none tracking-tighter text-white/[0.06]"
          >
            403
          </m.p>

          {/* Eyebrow + título */}
          <m.div variants={fadeBlur} className="-mt-10 flex flex-col items-center gap-2">
            <p className="tint-eyebrow">{copy.eyebrow}</p>
            <h1 className="text-2xl font-bold tracking-tight text-white md:text-3xl">
              {copy.title}
            </h1>
          </m.div>

          {/* Mensaje descriptivo */}
          <m.p variants={fadeBlur} className="max-w-[42ch] text-sm leading-relaxed">
            {copy.body}
          </m.p>

          {/* Separador decorativo con brillo cálido */}
          <m.div
            variants={fadeBlur}
            aria-hidden="true"
            className="h-px w-16 rounded-full bg-gradient-to-r from-transparent via-tint-accent/40 to-transparent"
          />

          {/* CTA de regreso */}
          <m.div variants={fadeBlur}>
            <ButtonLink to={backTo}>{backLabel}</ButtonLink>
          </m.div>
        </m.div>
      </main>
    </div>
  );
}

