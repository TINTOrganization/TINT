import { Navigate, useLocation } from 'react-router-dom';
import { loginRedirectPath } from '../lib/api';

export default function ProtectedRoute({ children }: { children: React.ReactNode }) {
  const location = useLocation();
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
