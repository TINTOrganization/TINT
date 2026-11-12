import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { EventTypeBars, MAX_BARS, eventLabel } from './EventTypeBars';

describe('EventTypeBars', () => {
  it('una barra por tipo, con nombre legible y el valor en la punta', () => {
    render(
      <EventTypeBars
        data={[
          { type: 'drift_correction', source: 'sync-core', count: 1173 },
          { type: 'presence', source: 'social-core', count: 16 },
        ]}
      />,
    );
    const svg = screen.getByRole('img', { name: 'Eventos por tipo: Corrección de drift 1173, Entrada o salida 16.' });
    const bars = svg.querySelectorAll('[data-testid="event-bar"]');
    expect(bars).toHaveLength(2);
    const width = (el: Element) => Number(el.getAttribute('data-width'));
    expect(width(bars[0])).toBeGreaterThan(width(bars[1]));
    expect(within(svg).getByText('Entrada o salida')).toBeInTheDocument();
    expect(within(svg).getByText('16')).toBeInTheDocument();
    const table = screen.getByRole('table', { name: 'Eventos por tipo' });
    expect(within(table).getByText('sync-core')).toBeInTheDocument();
  });

  it('agrupa lo que pase de MAX_BARS en "Otros" y la tabla conserva el detalle', () => {
    const data = Array.from({ length: MAX_BARS + 2 }, (_, i) => ({ type: `tipo_${i}`, source: 'x', count: 30 - i }));
    render(<EventTypeBars data={data} />);
    const svg = screen.getByRole('img');
    expect(svg.querySelectorAll('[data-testid="event-bar"]')).toHaveLength(MAX_BARS);
    expect(within(svg).getByText('Otros')).toBeInTheDocument();
    const table = screen.getByRole('table', { name: 'Eventos por tipo' });
    expect(within(table).getAllByRole('row')).toHaveLength(data.length + 1);
  });

  it('un tipo desconocido se muestra con su nombre técnico', () => {
    expect(eventLabel('nuevo_evento')).toBe('nuevo_evento');
    expect(eventLabel('reaction')).toBe('Reacción');
  });

  it('sin eventos muestra el estado vacío', () => {
    render(<EventTypeBars data={[]} />);
    expect(screen.getByText('Aún no se ha registrado telemetría')).toBeInTheDocument();
  });
});
