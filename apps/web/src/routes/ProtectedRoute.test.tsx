import { render, screen } from '@testing-library/react';
import { MemoryRouter, Routes, Route, useLocation } from 'react-router-dom';
import { beforeEach } from 'vitest';
import ProtectedRoute from './ProtectedRoute';

beforeEach(() => {
  localStorage.clear();
});

describe('ProtectedRoute', () => {
  it('muestra el contenido si hay token', () => {
    localStorage.setItem('tint_token', 'tok');
    render(
      <MemoryRouter initialEntries={['/dashboard']}>
        <Routes>
          <Route
            path="/dashboard"
            element={
              <ProtectedRoute>
                <p>Contenido privado</p>
              </ProtectedRoute>
            }
          />
        </Routes>
      </MemoryRouter>,
    );
    expect(screen.getByText('Contenido privado')).toBeInTheDocument();
  });

  it('redirige al login si no hay token', () => {
    render(
      <MemoryRouter initialEntries={['/dashboard']}>
        <Routes>
          <Route
            path="/dashboard"
            element={
              <ProtectedRoute>
                <p>Contenido privado</p>
              </ProtectedRoute>
            }
          />
          <Route path="/login" element={<p>Página de login</p>} />
        </Routes>
      </MemoryRouter>,
    );
    expect(screen.getByText('Página de login')).toBeInTheDocument();
  });

  it('al redirigir conserva la ruta pedida en ?next= para volver tras el login', () => {
    function LoginProbe() {
      const location = useLocation();
      return <p>{`login${location.search}`}</p>;
    }
    render(
      <MemoryRouter initialEntries={['/rooms/r1?tab=links']}>
        <Routes>
          <Route
            path="/rooms/:id"
            element={
              <ProtectedRoute>
                <p>Contenido privado</p>
              </ProtectedRoute>
            }
          />
          <Route path="/login" element={<LoginProbe />} />
        </Routes>
      </MemoryRouter>,
    );
    expect(screen.getByText(`login?next=${encodeURIComponent('/rooms/r1?tab=links')}`)).toBeInTheDocument();
  });

  it('redirige a /403?reason=not_host si un participante intenta ingresar a una ruta restringida de host', () => {
    localStorage.setItem('tint_guest_token', 'guest-jwt');
    function ForbiddenProbe() {
      const location = useLocation();
      return <p>{`forbidden${location.search}`}</p>;
    }
    render(
      <MemoryRouter initialEntries={['/dashboard']}>
        <Routes>
          <Route
            path="/dashboard"
            element={
              <ProtectedRoute>
                <p>Contenido privado</p>
              </ProtectedRoute>
            }
          />
          <Route path="/403" element={<ForbiddenProbe />} />
          <Route path="/login" element={<p>Página de login</p>} />
        </Routes>
      </MemoryRouter>,
    );
    expect(screen.getByText('forbidden?reason=not_host')).toBeInTheDocument();
    expect(screen.queryByText('Página de login')).not.toBeInTheDocument();
  });
});
