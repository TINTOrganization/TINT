import { fireEvent, render, screen } from '@testing-library/react';
import { applyReaction, FLOAT_GROUP_WINDOW_MS, MAX_FLOATS, ReactionOverlay, SEEN_MEMORY, trimSeen } from './ReactionOverlay';
import type { ReactionBroadcast } from '../lib/socialSocket';

function reaction(event_id: string, emoji: string): ReactionBroadcast {
  return {
    event_id,
    type: 'reaction',
    room_id: 'r1',
    user_id: 'u1',
    nick: 'Ana',
    emoji,
    position_ms: 0,
    occurred_at: '2026-10-10T10:00:00Z',
    received_at: '2026-10-10T10:00:00Z',
  };
}

describe('applyReaction', () => {
  it('crea un float por emoji nuevo con x determinista', () => {
    const next = applyReaction([], '👏', 'k1', 1000);
    expect(next).toHaveLength(1);
    expect(next[0]).toMatchObject({ key: 'k1', emoji: '👏', count: 1 });
    expect(next[0].x).toBeGreaterThanOrEqual(8);
    expect(next[0].x).toBeLessThanOrEqual(92);
    expect(applyReaction([], '👏', 'k1', 1000)[0].x).toBe(next[0].x);
  });

  it('agrupa el mismo emoji dentro de la ventana con xN', () => {
    let floats = applyReaction([], '👏', 'k1', 1000);
    floats = applyReaction(floats, '👏', 'k2', 1000 + FLOAT_GROUP_WINDOW_MS - 1);
    expect(floats).toHaveLength(1);
    expect(floats[0].count).toBe(2);
  });

  it('coexisten emojis distintos y los viejos expiran fuera de la ventana', () => {
    let floats = applyReaction([], '👏', 'k1', 1000);
    floats = applyReaction(floats, '❤️', 'k2', 1100);
    expect(floats).toHaveLength(2);
    floats = applyReaction(floats, '👏', 'k3', 2000);
    expect(floats).toHaveLength(1);
    expect(floats[0]).toMatchObject({ key: 'k3', count: 1 });
  });

  it('acota al máximo de floats', () => {
    let floats = applyReaction([], '👏', 'base', 1000);
    for (let i = 0; i < MAX_FLOATS + 5; i++) {
      floats = applyReaction(floats, '❤️', `k${i}`, 1000 + FLOAT_GROUP_WINDOW_MS + i + 1);
    }
    expect(floats.length).toBeLessThanOrEqual(MAX_FLOATS);
  });
});

describe('ReactionOverlay', () => {
  it('pinta un float por reacción y lo retira al terminar la animación', () => {
    const { rerender } = render(<ReactionOverlay reactions={[]} />);
    rerender(<ReactionOverlay reactions={[reaction('e1', '👏')]} />);
    const float = screen.getByText('👏');
    expect(float.closest('div')).toHaveAttribute('aria-hidden', 'true');
    fireEvent.animationEnd(float);
    expect(screen.queryByText('👏')).not.toBeInTheDocument();
  });

  it('agrupa ráfagas iguales en xN y no duplica eventos ya vistos', () => {
    const { rerender } = render(<ReactionOverlay reactions={[reaction('e1', '❤️')]} />);
    rerender(<ReactionOverlay reactions={[reaction('e1', '❤️'), reaction('e2', '❤️')]} />);
    expect(screen.getByText('x2')).toBeInTheDocument();
    // Re-render con el mismo array: sin duplicados.
    rerender(<ReactionOverlay reactions={[reaction('e1', '❤️'), reaction('e2', '❤️')]} />);
    expect(screen.getAllByText('❤️')).toHaveLength(1);
  });
});

describe('trimSeen', () => {
  it('no recorta mientras no supere el máximo', () => {
    const seen = new Set(['a', 'b']);
    expect(trimSeen(seen, ['b'])).toBe(seen);
  });

  it('al superar el máximo conserva solo los ids aún presentes (sin fuga de memoria)', () => {
    const seen = new Set(Array.from({ length: SEEN_MEMORY + 1 }, (_, i) => `e${i}`));
    const trimmed = trimSeen(seen, ['e499', 'e500']);
    expect([...trimmed]).toEqual(['e499', 'e500']);
  });
});

describe('ReactionOverlay — memoria de eventos', () => {
  it('tras muchas reacciones no repite las que siguen en la lista', () => {
    const { rerender } = render(<ReactionOverlay reactions={[]} />);
    const all = Array.from({ length: SEEN_MEMORY + 20 }, (_, i) => reaction(`e${i}`, '👏'));
    for (let i = 0; i < all.length; i += 50) rerender(<ReactionOverlay reactions={all.slice(Math.max(0, i - 30), i + 50)} />);
    const last = all.slice(-50);
    rerender(<ReactionOverlay reactions={last} />);
    const before = screen.queryAllByText('👏').length;
    rerender(<ReactionOverlay reactions={[...last]} />);
    expect(screen.queryAllByText('👏')).toHaveLength(before);
  });
});
