import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it } from 'vitest';
import Forbidden from './Forbidden';

function renderForbidden(search = '') {
  return render(
    <MemoryRouter initialEntries={[`/403${search}`]}>
      <Routes>
        <Route path="/403" element={<Forbidden />} />
        <Route path="/login" element={<p>login</p>} />
        <Route path="/dashboard" element={<p>dashboard</p>} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  localStorage.clear();
});

describe('Forbidden', () => {
  it('muestra el código 403 y el encabezado por defecto', () => {
    renderForbidden();
    expect(screen.getByRole('heading', { name: /acceso restringido/i })).toBeInTheDocument();
    expect(screen.getByText('403')).toBeInTheDocument();
    expect(screen.getByText(/no tienes permiso para ver esta página/i)).toBeInTheDocument();
  });

  it('muestra mensaje "banned" cuando el parámetro es ?reason=banned', () => {
    renderForbidden('?reason=banned');
    expect(screen.getByRole('heading', { name: /el host te bloqueó en esta sala/i })).toBeInTheDocument();
    expect(screen.getByText(/no puedes volver a unirte desde este navegador/i)).toBeInTheDocument();
  });

  it('muestra mensaje "not_host" cuando el parámetro es ?reason=not_host', () => {
    renderForbidden('?reason=not_host');
    expect(screen.getByRole('heading', { name: /solo el host puede acceder a esta sección/i })).toBeInTheDocument();
    expect(screen.getByText(/esta área está reservada para el creador de la sala/i)).toBeInTheDocument();
  });

  it('enlace lleva a /login si no hay token de host', () => {
    renderForbidden();
    const link = screen.getByRole('link', { name: /iniciar sesión/i });
    expect(link).toHaveAttribute('href', '/login');
  });

  it('enlace lleva a /dashboard si hay token de host', () => {
    localStorage.setItem('tint_token', 'host-tok');
    renderForbidden();
    const link = screen.getByRole('link', { name: /volver al inicio/i });
    expect(link).toHaveAttribute('href', '/dashboard');
  });

  it('incluye contenedor semántico <main>', () => {
    renderForbidden();
    expect(screen.getByRole('main')).toBeInTheDocument();
  });
});

