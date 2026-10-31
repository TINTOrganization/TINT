import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { DensityStrip, MAX_COLUMNS } from './DensityStrip';

const levels = (container: HTMLElement) =>
  Array.from(container.querySelectorAll('[data-testid="density-cell"]')).map((c) => c.getAttribute('data-level'));

describe('DensityStrip', () => {
  it('una celda por tramo del vídeo, más intensa cuanto mayor es la densidad', () => {
    const { container } = render(
      <DensityStrip
        buckets={[
          { bucket_start_ms: 0, reactions: 1, density: 0.2 },
          { bucket_start_ms: 10_000, reactions: 5, density: 1 },
        ]}
      />,
    );
    expect(levels(container)).toEqual(['1', '0', '4']);
    expect(screen.getByRole('img', { name: 'Densidad de reacciones a lo largo del vídeo: 6 reacciones, pico en 0:10.' })).toBeInTheDocument();
    expect(container.querySelector('title')).toHaveTextContent('0:00–0:05 · densidad 0.20');
  });

  it('agrupa los tramos cuando superan MAX_COLUMNS y conserva el máximo de cada grupo', () => {
    const buckets = [
      { bucket_start_ms: 0, reactions: 1, density: 0.25 },
      { bucket_start_ms: 5_000, reactions: 1, density: 1 },
      { bucket_start_ms: (MAX_COLUMNS * 2 - 1) * 5_000, reactions: 1, density: 0.5 },
    ];
    const { container } = render(<DensityStrip buckets={buckets} />);
    const all = levels(container);
    expect(all).toHaveLength(MAX_COLUMNS);
    expect(all[0]).toBe('4');
    expect(all[MAX_COLUMNS - 1]).toBe('2');
  });

  it('una sola reacción se describe en singular', () => {
    render(<DensityStrip buckets={[{ bucket_start_ms: 0, reactions: 1, density: 1 }]} />);
    expect(screen.getByRole('img').getAttribute('aria-label')).toContain('1 reacción,');
  });

  it('sin reacciones lo dice en texto', () => {
    render(<DensityStrip buckets={[]} />);
    expect(screen.getByText('Sin reacciones')).toBeInTheDocument();
  });
});
