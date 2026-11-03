import { onIdTokenChanged, type Auth } from 'firebase/auth';
import { setHostTokenProvider } from './api';

/**
 * Sincroniza el token de anfitrión en una cookie de sesión (SameSite=Lax) para que las
 * peticiones de navegación de documento (SSR) puedan autenticarse en el servidor.
 */
export function syncAuthCookie(token: string | null) {
  if (typeof document === 'undefined') return;
  if (token) {
    const isSecure = typeof location !== 'undefined' && location.protocol === 'https:';
    document.cookie = `tint_token=${encodeURIComponent(token)}; path=/; SameSite=Lax${isSecure ? '; Secure' : ''}`;
  } else {
    document.cookie = 'tint_token=; path=/; max-age=0; SameSite=Lax';
  }
}

/**
 * Mantiene viva la sesión de host: el ID token de Firebase caduca a la hora, así que
 * (1) `apiFetch` pide el token al usuario actual de Firebase (que lo renueva si hace
 * falta) y (2) cada renovación se copia a `tint_token`, que leen los sockets y la UI.
 * Solo actualiza una sesión existente: si el usuario cerró sesión en TINT, no la revive.
 * Devuelve la función para dejar de escuchar.
 */
export function startHostSession(auth: Auth): () => void {
  setHostTokenProvider(async (forceRefresh) => {
    // Al recargar, Firebase restaura el usuario de forma asíncrona.
    await auth.authStateReady();
    const user = auth.currentUser;
    const token = user ? await user.getIdToken(forceRefresh) : null;
    if (token) {
      syncAuthCookie(token);
    }
    return token;
  });
  const unsubscribe = onIdTokenChanged(auth, (user) => {
    if (!user) return;
    user.getIdToken().then(
      (token) => {
        if (localStorage.getItem('tint_token')) {
          localStorage.setItem('tint_token', token);
          syncAuthCookie(token);
        }
      },
      () => {},
    );
  });
  return () => {
    unsubscribe();
    setHostTokenProvider(null);
    syncAuthCookie(null);
  };
}
