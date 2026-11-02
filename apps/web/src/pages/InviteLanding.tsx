import { useEffect, useState } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { apiFetch } from '../lib/api';
import { inviteClaimErrorMessage } from '../lib/invite';
import { roomPath } from '../lib/rooms';
import { getDeviceId } from '../lib/deviceId';
import { m, useReducedMotion } from 'framer-motion';
import { Button, ButtonLink } from '../components/ui/Button';
import { Field, ErrorAlert, Card, Input } from '../components/ui/Primitives';
import { AmbientBackground } from '../components/layout/AmbientBackground';
import { ease, fadeUp, stagger } from '../lib/motion';

const HERO_SRC = 'https://picsum.photos/seed/tint-guest/1200/1400';
const HEADLINE = 'Te invitaron a ver algo juntos';

export default function InviteLanding() {
  const { code } = useParams();
  const [nick, setNick] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const navigate = useNavigate();
  const reduced = useReducedMotion();
  // Con sesión de host, canjear la invitación la sustituye por una de invitado: se
  // avisa y solo se hace con confirmación explícita ("Entrar como invitado").
  const [hasHostSession] = useState(() => !!localStorage.getItem('tint_token'));
  /** Ruta de la sala del host con esta invitación: undefined = buscando, null = no es suya. */
  const [hostRoomId, setHostRoomId] = useState<string | null | undefined>(undefined);

  useEffect(() => {
    if (!hasHostSession) return;
    let cancelled = false;
    apiFetch('/rooms', { method: 'GET' }, 'host')
      .then((res: { rooms?: { id: string; kind?: string; invitation?: { code: string } | null }[] }) => {
        const own = (res.rooms ?? []).find((room) => room.invitation?.code === code);
        if (!cancelled) setHostRoomId(own ? roomPath(own) : null);
      })
      .catch(() => {
        if (!cancelled) setHostRoomId(null);
      });
    return () => {
      cancelled = true;
    };
  }, [hasHostSession, code]);

  const handleJoin = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);
    const deviceId = getDeviceId();
    try {
      const res = await apiFetch('/invitations/claim', {
        method: 'POST',
        // deviceId: permite al host bloquear por dispositivo (se omite si no hay UUID).
        body: JSON.stringify({ code, nick, ...(deviceId ? { deviceId } : {}) }),
      });
      localStorage.removeItem('tint_token');
      localStorage.setItem('tint_guest_token', res.token);
      // El invitado no tiene auth de host: se guarda el título y el link
      // para mostrarlos en la sala sin pedirlos al backend.
      // Sin título se borra el guardado: si no, se vería el de otra invitación.
      if (res.roomTitle) localStorage.setItem('tint_room_title', res.roomTitle);
      else localStorage.removeItem('tint_room_title');
      if (code) localStorage.setItem('tint_invite_link', `/invite/${code}`);
      // Sala live (ADR 0019): su página no abre el Canal Sync. Sin `roomKind` (API vieja) → watch.
      navigate(roomPath({ id: res.roomId, kind: res.roomKind }));
    } catch (err) {
      setError(inviteClaimErrorMessage(err));
    } finally {
      setLoading(false);
    }
  };
  return (
    <div className="relative isolate grid min-h-[100dvh] bg-tint-bg text-tint-muted md:grid-cols-[1.1fr_1fr]">
      <AmbientBackground />
      <section className="relative hidden overflow-hidden md:block" aria-hidden="true">
        <m.img
          src={HERO_SRC}
          alt=""
          className="absolute inset-0 h-full w-full object-cover"
          loading="eager"
          initial={{ opacity: 0, scale: reduced ? 1 : 1.04 }}
          animate={{ opacity: 0.45, scale: 1 }}
          transition={{ duration: 1.6, ease }}
        />
        <div className="absolute inset-0 bg-gradient-to-t from-tint-bg via-tint-bg/60 to-transparent" />
        <m.div
          className="absolute inset-x-0 bottom-0 p-10"
          variants={stagger(0.08, 0.25)}
          initial="hidden"
          animate="show"
        >
          <m.h1 variants={fadeUp} className="max-w-[18ch] text-4xl font-bold leading-[1.05] tracking-tighter text-white">
            {HEADLINE}
          </m.h1>
          <m.p variants={fadeUp} className="mt-3 max-w-[44ch] text-sm leading-relaxed">
            Elige un nick y entra como participante. Sin cuenta, sin fricción.
          </m.p>
        </m.div>
      </section>

      <section
        data-testid="hero-mobile"
        aria-hidden="true"
        className="relative h-40 overflow-hidden md:hidden"
      >
        <img src={HERO_SRC} alt="" className="absolute inset-0 h-full w-full object-cover opacity-40" loading="eager" />
        <div className="absolute inset-0 bg-gradient-to-b from-tint-bg/10 via-tint-bg/50 to-tint-bg" />
        <div className="absolute -bottom-16 left-1/2 h-32 w-64 -translate-x-1/2 rounded-full bg-tint-accent/20 blur-3xl" />
        <div className="absolute inset-x-0 bottom-0 px-4 pb-4">
          <p className="max-w-[22ch] text-2xl font-bold leading-[1.1] tracking-tighter text-white">{HEADLINE}</p>
        </div>
      </section>

      <section className="flex items-center justify-center px-4 py-10">
        <m.div variants={fadeUp} initial="hidden" animate="show" className="w-full max-w-md">
          <Card className="w-full p-8 shadow-lift">
            <p className="tint-eyebrow">Invitación</p>
            <h2 className="mt-2 text-2xl font-bold tracking-tight text-white">Unirse a la sala</h2>
            <p className="mt-2 text-sm leading-relaxed">
              Código <span className="rounded-md bg-white/10 px-2 py-0.5 font-mono text-[13px] text-white">{code}</span>
            </p>

            {hasHostSession && (
              <div role="note" className="mt-6 rounded-xl border border-tint-accent/30 bg-tint-accent/10 p-4 text-[13px] leading-relaxed">
                <p className="font-semibold text-white">Tienes una sesión de host abierta</p>
                <p className="mt-1">
                  Si entras como invitado se cerrará tu sesión de host en este navegador.
                </p>
                {hostRoomId && (
                  <ButtonLink to={hostRoomId} size="sm" className="mt-3">
                    Entrar como host
                  </ButtonLink>
                )}
                {hostRoomId === null && (
                  <Link to="/dashboard" className="mt-3 inline-flex text-tint-accent underline-offset-4 hover:underline">
                    Ir a mis salas
                  </Link>
                )}
              </div>
            )}

            <form onSubmit={handleJoin} className="mt-6 space-y-5">
              <Field label="Nick" htmlFor="nick" helper="Así te verán en el chat y las reacciones.">
                <Input
                  id="nick"
                  value={nick}
                  onChange={(e) => setNick(e.target.value)}
                  placeholder="Nick"
                  autoComplete="nickname"
                  required
                  minLength={2}
                  maxLength={24}
                />
              </Field>
              <Button
                className="w-full"
                type="submit"
                variant={hasHostSession ? 'ghost' : undefined}
                disabled={loading || nick.trim().length < 2}
              >
                {loading ? 'Uniendo…' : hasHostSession ? 'Entrar como invitado' : 'Unirse'}
              </Button>
              {error && <ErrorAlert message={error} />}
            </form>

            <p className="mt-6 border-t border-white/10 pt-4 text-[13px]">
              ¿Eres el host?{' '}
              <Link to="/login" className="text-tint-accent underline-offset-4 hover:underline">
                Inicia sesión
              </Link>
            </p>
          </Card>
        </m.div>
      </section>
    </div>
  );
}
