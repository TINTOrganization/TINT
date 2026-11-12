import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { ReactionHeatmap as Heatmap } from '../../lib/analytics';
import { MAX_COLUMNS, ReactionHeatmap } from './ReactionHeatmap';

const heatmap: Heatmap = {
  room_id: 'r1',
  bucket_ms: 5_000,
  buckets: [
    { bucket_start_ms: 0, emoji: '👏', count: 1 },
    { bucket_start_ms: 10_000, emoji: '👏', count: 4 },
    { bucket_start_ms: 10_000, emoji: '😂', count: 2 },
  ],
  density: [
    { bucket_start_ms: 0, count: 1, density: 0.1667 },
    { bucket_start_ms: 10_000, count: 6, density: 1 },
  ],
  by_emoji: [
    { emoji: '👏', count: 5 },
    { emoji: '😂', count: 2 },
  ],
};

function cells(container: HTMLElement) {
  return Array.from(container.querySelectorAll('[data-testid="heat-cell"]'));
}

describe('ReactionHeatmap', () => {
  it('una fila por emoji y una columna por bucket, con nivel por intensidad', () => {
    const { container } = render(<ReactionHeatmap heatmap={heatmap} />);
    const svg = screen.getByRole('img', { name: /7 reacciones entre 0:00 y 0:15.*👏 en 0:10 \(4\)/ });
    expect(svg).toBeInTheDocument();
    // 2 emojis × 3 buckets (0, 5 s, 10 s).
    expect(cells(container)).toHaveLength(6);
    const levels = cells(container).map((c) => c.getAttribute('data-level'));
    expect(levels).toEqual(['1', '0', '4', '0', '0', '2']);
    expect(Array.from(container.querySelectorAll('li')).map((li) => li.textContent)).toEqual(['👏', '😂']);
    expect(cells(container)[2].querySelector('title')?.textContent).toBe('👏 · 0:10–0:15 · 4 reacciones');
  });

  it('muestra leyenda de intensidad y eje de posición', () => {
    render(<ReactionHeatmap heatmap={heatmap} />);
    expect(screen.getByText('Menos')).toBeInTheDocument();
    expect(screen.getByText('Más')).toBeInTheDocument();
    expect(screen.getByText('0:00')).toBeInTheDocument();
    expect(screen.getByText('0:15')).toBeInTheDocument();
  });

  it('la tabla lista los buckets originales', () => {
    render(<ReactionHeatmap heatmap={heatmap} />);
    const table = screen.getByRole('table', { name: 'Reacciones por posición del vídeo' });
    expect(within(table).getAllByRole('row')).toHaveLength(4);
    expect(within(table).getAllByText('0:10–0:15')).toHaveLength(2);
  });

  it(`agrupa columnas si hay más de ${MAX_COLUMNS} buckets`, () => {
    const long: Heatmap = {
      ...heatmap,
      buckets: [
        { bucket_start_ms: 0, emoji: '👏', count: 1 },
        { bucket_start_ms: 5_000, emoji: '👏', count: 1 },
        { bucket_start_ms: (MAX_COLUMNS * 2 - 1) * 5_000, emoji: '👏', count: 3 },
      ],
      by_emoji: [{ emoji: '👏', count: 5 }],
    };
    const { container } = render(<ReactionHeatmap heatmap={long} />);
    expect(cells(container)).toHaveLength(MAX_COLUMNS);
    // Los dos primeros buckets de 5 s caen en la misma columna de 10 s.
    expect(cells(container)[0].querySelector('title')?.textContent).toBe('👏 · 0:00–0:10 · 2 reacciones');
    expect(screen.getByText(/Cada columna agrupa 10 s/)).toBeInTheDocument();
  });

  it('emojis sin by_emoji se ordenan por aparición', () => {
    const { container } = render(
      <ReactionHeatmap heatmap={{ ...heatmap, by_emoji: [], buckets: [{ bucket_start_ms: 0, emoji: '🔥', count: 1 }] }} />,
    );
    expect(cells(container)).toHaveLength(1);
    expect(cells(container)[0].querySelector('title')?.textContent).toBe('🔥 · 0:00–0:05 · 1 reacción');
  });

  it('sin buckets muestra el estado vacío', () => {
    render(<ReactionHeatmap heatmap={{ ...heatmap, buckets: [], by_emoji: [] }} />);
    expect(screen.getByText('Sin reacciones durante el vídeo')).toBeInTheDocument();
    expect(screen.queryByRole('img')).not.toBeInTheDocument();
  });
});
