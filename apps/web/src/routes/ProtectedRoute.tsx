import { useContext } from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { loginRedirectPath } from '../lib/api';
import { DashboardContext, SsrContext } from '../App';

export default function ProtectedRoute({ children }: { children: React.ReactNode }) {
  const location = useLocation();
  const dashboardContext = useContext(DashboardContext);
  const isSsr = useContext(SsrContext) || typeof window === 'undefined';

  // Durante SSR o cuando hay datos pre-renderizados del dashboard en el contexto,
  // permitimos el renderizado para que el cliente hidrate sin discrepancias y verifique la sesión.
  if (isSsr || (location.pathname === '/dashboard' && dashboardContext?.dashboardData)) {
    return <>{children}</>;
  }

  const token = typeof window !== 'undefined' ? localStorage.getItem('tint_token') : null;
  const guestToken = typeof window !== 'undefined' ? localStorage.getItem('tint_guest_token') : null;

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
