import { useState } from 'react';
import { signInWithPopup, GoogleAuthProvider } from 'firebase/auth';
import { auth } from '../lib/firebase';
import { useNavigate, Link, useSearchParams } from 'react-router-dom';
import { apiFetch } from '../lib/api';
import { parseInviteCode } from '../lib/invite';
import { Button } from '../components/ui/Button';
import { TintLogo } from '../components/brand/TintLogo';
import { Field, ErrorAlert, Input } from '../components/ui/Primitives';
import { AmbientBackground } from '../components/layout/AmbientBackground';
import { m, useReducedMotion } from 'framer-motion';
import { ease, fadeUp, stagger } from '../lib/motion';

const HERO_SRC = 'https://picsum.photos/seed/tint-cinema/1200/1400';
const HEADLINE = 'Mira junto, siente al mismo tiempo';

export default function Login() {
  const navigate = useNavigate();
  const reduced = useReducedMotion();
  const [searchParams] = useSearchParams();
  // Retorno tras login (p. ej. ?returnUrl=/watch/:id, ?redirect=/watch/:id o ?next=/watch/:id).
  // Solo rutas internas para evitar open-redirect.
  const returnParam = searchParams.get('returnUrl') || searchParams.get('redirect') || searchParams.get('next');
  const safeNext = returnParam && returnParam.startsWith('/') && !returnParam.startsWith('//') ? returnParam : '/dashboard';
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [invite, setInvite] = useState('');
  const [inviteHint, setInviteHint] = useState('');
  const handleInvite = (e: React.FormEvent) => {
    e.preventDefault();
    const code = parseInviteCode(invite);
    if (!code) {
      setInviteHint('Ese link no parece válido. Revisa que incluya /invite/ o el código.');
      return;
    }
    setInviteHint('');
    navigate(`/invite/${code}`);
  };
  const handleLogin = async () => {
    setError('');
    setLoading(true);
    try {
      const provider = new GoogleAuthProvider();
      const result = await signInWithPopup(auth, provider);
      const token = await result.user.getIdToken();
      localStorage.setItem('tint_token', token);
      // La sesión de host manda: borrar restos de invitado para no
      // entrar a las salas con identidad y título viejos (ver WatchRoom).
      localStorage.removeItem('tint_guest_token');
      localStorage.removeItem('tint_room_title');
      localStorage.removeItem('tint_invite_link');
      await apiFetch('/auth/verify', { method: 'POST', body: JSON.stringify({}) });
      navigate(safeNext);
    } catch (e) {
      localStorage.removeItem('tint_token');
      setError(e instanceof Error ? e.message : 'No se pudo iniciar sesión');
    } finally {
      setLoading(false);
    }
  };
  return (
    <div className="relative isolate grid min-h-[100dvh] bg-tint-bg text-tint-muted md:grid-cols-2">
      <AmbientBackground />
      <section className="relative hidden overflow-hidden md:block" aria-hidden="true">
        <m.img
          src={HERO_SRC}
          alt=""
          className="absolute inset-0 h-full w-full object-cover"
          loading="eager"
          initial={{ opacity: 0, scale: reduced ? 1 : 1.04 }}
          animate={{ opacity: 0.5, scale: 1 }}
          transition={{ duration: 1.6, ease }}
        />
        <div className="absolute inset-0 bg-gradient-to-t from-tint-bg via-tint-bg/60 to-tint-bg/20" />
        <m.div
          className="absolute inset-x-0 bottom-0 p-10"
          variants={stagger(0.08, 0.25)}
          initial="hidden"
          animate="show"
        >
          <m.p variants={fadeUp} className="tint-eyebrow">
            Salas sincronizadas
          </m.p>
          <m.h1
            variants={fadeUp}
            className="mt-3 max-w-[16ch] text-4xl font-bold leading-[1.05] tracking-tighter text-white lg:text-5xl"
          >
            {HEADLINE}
          </m.h1>
          <m.p variants={fadeUp} className="mt-3 max-w-[42ch] text-sm leading-relaxed text-tint-muted">
            Crea una sala, invita con un link y mantén a todos en el mismo segundo.
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
          <p className="tint-eyebrow">Salas sincronizadas</p>
          <p className="mt-1.5 max-w-[22ch] text-2xl font-bold leading-[1.1] tracking-tighter text-white">{HEADLINE}</p>
        </div>
      </section>

      <section className="flex items-center justify-center px-4 py-10">
        <m.div
          variants={fadeUp}
          initial="hidden"
          animate="show"
          className="w-full max-w-md rounded-2xl border border-white/10 bg-tint-card/70 p-8 shadow-lift"
        >
          <div className="flex items-center gap-3">
            <TintLogo size={40} className="shrink-0" />
            <div className="leading-none">
              <p className="text-lg font-bold tracking-tight text-white">TINT</p>
              <p className="mt-1 text-[11px] tracking-[0.14em] text-tint-muted/80">WATCH PARTY</p>
            </div>
          </div>

          <h2 className="mt-8 text-2xl font-bold tracking-tight text-white">Bienvenido de nuevo</h2>
          <p className="mt-2 text-sm leading-relaxed">
            Accede con tu cuenta para crear salas y ser host.
          </p>

          <div className="mt-6">
            <Button onClick={handleLogin} disabled={loading} className="w-full" aria-label="Iniciar sesión con Google">
              {loading ? 'Conectando…' : 'Iniciar sesión con Google'}
            </Button>
            <p className="mt-3 text-center text-[13px] text-tint-muted/80">
              Solo usamos tu sesión para verificar tu identidad.
            </p>
          </div>

          {error && (
            <div className="mt-5">
              <ErrorAlert message={`Error: ${error}`} />
            </div>
          )}

          <div className="mt-6 flex items-center gap-3" aria-hidden="true">
            <span className="h-px flex-1 bg-white/10" />
            <span className="text-[11px] uppercase tracking-[0.18em] text-tint-muted/80">
              o entra como invitado
            </span>
            <span className="h-px flex-1 bg-white/10" />
          </div>
          <p className="mt-4 text-[13px] leading-relaxed">
            ¿Tienes un link de invitación? Pega el link o el código, no necesitas cuenta.
          </p>
          <form onSubmit={handleInvite} className="mt-3 space-y-3">
            <Field label="Link de invitación" htmlFor="invite-link" error={undefined}>
              <Input
                id="invite-link"
                value={invite}
                onChange={(e) => setInvite(e.target.value)}
                placeholder="Pega el link o el código"
                autoComplete="off"
              />
            </Field>
            {inviteHint && <p className="text-[13px] text-red-300">{inviteHint}</p>}
            <Button type="submit" variant="ghost" disabled={invite.trim().length === 0} className="w-full">
              Continuar sin cuenta
            </Button>
          </form>
          <Link to="/dashboard" className="sr-only">
            dashboard
          </Link>
        </m.div>
      </section>
    </div>
  );
}
