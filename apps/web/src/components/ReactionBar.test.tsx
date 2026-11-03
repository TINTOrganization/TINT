import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ReactionBar, REACTIONS } from './ReactionBar';

describe('ReactionBar', () => {
  it('renderiza un botón por reacción', () => {
    render(<ReactionBar onReact={vi.fn()} />);
    expect(screen.getAllByRole('button')).toHaveLength(REACTIONS.length);
  });

  it('usa el set del documento más tristeza (aplauso, risa, sorpresa, susto, corazón, tristeza)', () => {
    expect([...REACTIONS].sort()).toEqual(['❤️', '👏', '😂', '😮', '😱', '😢'].sort());
    render(<ReactionBar onReact={vi.fn()} />);
    expect(screen.getByRole('button', { name: /corazón/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /tristeza/i })).toBeInTheDocument();
  });

  it('limita los clics a 5 por segundo', async () => {
    const onReact = vi.fn();
    render(<ReactionBar onReact={onReact} />);
    const clap = screen.getByRole('button', { name: /👏/ });

    for (let i = 0; i < 8; i++) await userEvent.click(clap);

    expect(onReact).toHaveBeenCalledTimes(5);
    expect(onReact).toHaveBeenCalledWith('👏');
  });

  it('los botones son de vidrio', () => {
    render(<ReactionBar onReact={vi.fn()} />);
    for (const b of screen.getAllByRole('button')) expect(b.className).toContain('tint-glass');
    expect(screen.getByRole('toolbar', { name: 'Reacciones' })).toBeInTheDocument();
  });

  it('cada clic lanza una ráfaga decorativa que se retira sola', async () => {
    const { container } = render(<ReactionBar onReact={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: /corazón/i }));
    const burst = container.querySelector('[data-burst]');
    expect(burst).not.toBeNull();
    expect(burst).toHaveAttribute('aria-hidden', 'true');
    const particles = container.querySelectorAll('[data-particle]');
    expect(particles.length).toBeGreaterThanOrEqual(3);
    expect(particles.length).toBeLessThanOrEqual(4);
    // Las partículas no son botones: la barra sigue teniendo uno por reacción.
    expect(screen.getAllByRole('button')).toHaveLength(REACTIONS.length);
    await waitFor(() => expect(container.querySelector('[data-burst]')).toBeNull(), { timeout: 2000 });
  });

  it('la ráfaga se ve aunque el envío esté limitado (el envío sigue a 5/s)', () => {
    const onReact = vi.fn();
    const { container } = render(<ReactionBar onReact={onReact} />);
    const clap = screen.getByRole('button', { name: /👏/ });
    for (let i = 0; i < 7; i++) fireEvent.click(clap);
    expect(onReact).toHaveBeenCalledTimes(5);
    expect(container.querySelectorAll('[data-burst]').length).toBe(7);
  });

  it('cancela los temporizadores de la ráfaga al desmontar', () => {
    vi.useFakeTimers();
    try {
      const { unmount } = render(<ReactionBar onReact={vi.fn()} />);
      fireEvent.click(screen.getByRole('button', { name: /👏/ }));
      expect(vi.getTimerCount()).toBeGreaterThan(0);
      unmount();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
