import { Navigate, useLocation } from 'react-router-dom';
import { loginRedirectPath } from '../lib/api';
import type { AppInitialData } from '../App';

export default function ProtectedRoute({
  children,
  initialData,
}: {
  children: React.ReactNode;
  initialData?: AppInitialData | null;
}) {
  const location = useLocation();

  // Si se cuenta con datos iniciales del SSR o autenticación indicada en initialData:
  if (
    initialData?.isAuthenticated ||
    initialData?.rooms !== undefined ||
    initialData?.token ||
    initialData?.error !== undefined ||
    initialData?.role !== undefined
  ) {
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
