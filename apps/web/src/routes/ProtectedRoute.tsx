import { useContext } from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { loginRedirectPath } from '../lib/api';
import { SsrContext } from '../App';

export default function ProtectedRoute({ children }: { children: React.ReactNode }) {
  const location = useLocation();
  const isSsr = useContext(SsrContext) || typeof window === 'undefined';

  // Durante SSR, permitimos el renderizado del cascarón de la ruta protegida
  // para que el cliente hidrate y verifique la autenticación en localStorage.
  if (isSsr) {
    return <>{children}</>;
  }

  const token = localStorage.getItem('tint_token');
  const guestToken = localStorage.getItem('tint_guest_token');

  if (!token) {
    if (guestToken) {
      // Un participante con guest token intentando acceder a una ruta de host se bloquea con 403
      return <Navigate to="/403?reason=not_host" replace />;
    }
    // Tras iniciar sesión, Login vuelve a la ruta pedida (?next=).
    return <Navigate to={loginRedirectPath(location.pathname, location.search)} replace />;
  }
  return <>{children}</>;
}
