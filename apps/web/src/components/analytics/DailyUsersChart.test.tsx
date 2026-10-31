import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { DailyUsersChart } from './DailyUsersChart';

const days = [
  { day: '2026-10-10', dau: 0, mau: 1 },
  { day: '2026-10-11', dau: 1, mau: 1 },
  { day: '2026-10-12', dau: 3, mau: 4 },
];

describe('DailyUsersChart', () => {
  it('dibuja una barra por día con actividad y resume el rango en el aria-label', () => {
    render(<DailyUsersChart days={days} />);
    const svg = screen.getByRole('img', {
      name: 'Usuarios activos por día del 10 oct al 12 oct: máximo 3 el 12 oct, último día 3.',
    });
    const bars = svg.querySelectorAll('[data-testid="daily-bar"]');
    // El día sin usuarios no dibuja barra, pero conserva su zona de puntero.
    expect(bars).toHaveLength(2);
    expect(svg.querySelectorAll('[data-testid="daily-hit"]')).toHaveLength(3);
    const height = (el: Element) => Number(el.getAttribute('data-height'));
    expect(height(bars[1])).toBeGreaterThan(height(bars[0]));
    expect(svg.querySelector('[data-testid="daily-last-label"]')).toHaveTextContent('3');
  });

  it('al pasar el puntero muestra el día, su DAU y el MAU', () => {
    const { container } = render(<DailyUsersChart days={days} />);
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    const groups = container.querySelectorAll('[data-testid="daily-hit"]');
    fireEvent.pointerEnter(groups[1].parentElement as Element);
    const tip = screen.getByRole('status');
    expect(tip).toHaveTextContent('11 oct');
    expect(tip).toHaveTextContent('1 usuario activo');
    expect(tip).toHaveTextContent('1 en los últimos 30 días');
    fireEvent.pointerEnter(groups[2].parentElement as Element);
    expect(screen.getByRole('status')).toHaveTextContent('3 usuarios activos');
    fireEvent.pointerLeave(groups[2].parentElement as Element);
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('la tabla alternativa trae DAU y MAU de cada día', () => {
    render(<DailyUsersChart days={days} />);
    const table = screen.getByRole('table', { name: 'Usuarios activos por día' });
    const rows = within(table).getAllByRole('row');
    expect(rows).toHaveLength(days.length + 1);
    expect(rows[3]).toHaveTextContent('12 oct34');
  });

  it('omite los días anteriores al primer usuario activo', () => {
    const padded = [{ day: '2026-10-08', dau: 0, mau: 0 }, { day: '2026-10-09', dau: 0, mau: 0 }, ...days];
    const { container } = render(<DailyUsersChart days={padded} />);
    expect(container.querySelectorAll('[data-testid="daily-hit"]')).toHaveLength(3);
    expect(screen.getByRole('img').getAttribute('aria-label')).toContain('del 10 oct al 12 oct');
  });

  it('con un solo día dibuja una sola columna', () => {
    const { container } = render(<DailyUsersChart days={[{ day: '2026-10-12', dau: 2, mau: 2 }]} />);
    expect(container.querySelectorAll('[data-testid="daily-bar"]')).toHaveLength(1);
  });

  it('si ningún día tiene usuarios muestra el estado vacío', () => {
    render(<DailyUsersChart days={[{ day: '2026-10-12', dau: 0, mau: 0 }]} />);
    expect(screen.getByText('Aún no hay inicios de sesión registrados')).toBeInTheDocument();
  });

  it('sin datos muestra el estado vacío', () => {
    render(<DailyUsersChart days={[]} />);
    expect(screen.getByText('Aún no hay inicios de sesión registrados')).toBeInTheDocument();
    expect(screen.queryByRole('img')).not.toBeInTheDocument();
  });
});
