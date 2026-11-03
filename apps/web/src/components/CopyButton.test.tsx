import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { vi } from 'vitest';
import { COPIED_RESET_MS, CopyButton } from './CopyButton';

describe('CopyButton', () => {
  it('copia el link absoluto al portapapeles y confirma', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    render(<CopyButton link="/invite/abc123" />);
    await userEvent.click(screen.getByRole('button', { name: /copiar/i }));
    expect(writeText).toHaveBeenCalledWith(
      `${window.location.origin}/invite/abc123`,
    );
    expect(await screen.findByRole('button', { name: /copiado/i })).toBeInTheDocument();
  });

  it('vuelve a Copiar luego del tiempo configurado', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    render(<CopyButton link="/invite/abc123" resetMs={30} />);
    await userEvent.click(screen.getByRole('button', { name: /copiar/i }));
    expect(await screen.findByRole('button', { name: /copiado/i })).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /^copiar$/i })).toBeInTheDocument(),
    );
  });

  it('al copiar muestra un ✓ decorativo antes de "Copiado" y anuncia el cambio', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    render(<CopyButton link="/invite/abc123" />);
    const button = screen.getByRole('button', { name: 'Copiar' });
    expect(button).toHaveAttribute('aria-live', 'polite');
    expect(screen.queryByText('✓')).not.toBeInTheDocument();
    await userEvent.click(button);
    const copied = await screen.findByRole('button', { name: 'Copiado' });
    expect(screen.getByText('✓')).toHaveAttribute('aria-hidden', 'true');
    expect(copied).toHaveAttribute('aria-live', 'polite');
  });

  it('la confirmación por defecto dura 3 segundos', () => {
    expect(COPIED_RESET_MS).toBe(3000);
  });

  it('muestra estado de error si el portapapeles falla', async () => {
    const writeText = vi.fn().mockRejectedValue(new Error('denied'));
    Object.assign(navigator, { clipboard: { writeText } });
    render(<CopyButton link="/invite/abc123" />);
    await userEvent.click(screen.getByRole('button', { name: /copiar/i }));
    expect(await screen.findByRole('button', { name: /reintentar/i })).toBeInTheDocument();
  });
});
