import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { EventChatHistory } from './EventChatHistory';
import { ChatHistoryError } from '../../lib/chatHistory';

vi.mock('../../lib/chatHistory', async (orig) => ({
  ...(await orig<typeof import('../../lib/chatHistory')>()),
  fetchChatHistory: vi.fn(),
}));
const { fetchChatHistory } = await import('../../lib/chatHistory');
const mocked = vi.mocked(fetchChatHistory);

const message = (id: string, text: string, spoiler = false) => ({
  type: 'chat_message' as const,
  event_id: id,
  room_id: 'r1',
  user_id: 'u',
  nick: id === 'b' ? '' : 'Ana',
  text,
  spoiler,
  occurred_at: '2026-11-01T18:05:00.000Z',
  received_at: '2026-11-01T18:05:00.000Z',
});

describe('EventChatHistory', () => {
  it('abre un diálogo con el chat; los spoilers siguen ocultos; Escape cierra y devuelve el foco', async () => {
    mocked.mockResolvedValueOnce([message('a', 'hola'), message('b', 'muere al final', true)]);
    render(<EventChatHistory roomId="r1" title="Final" />);
    const trigger = screen.getByRole('button', { name: 'Ver chat del evento' });
    await userEvent.click(trigger);
    const dialog = screen.getByRole('dialog', { name: 'Chat de Final' });
    const list = await within(dialog).findByRole('list', { name: 'Mensajes del chat' });
    expect(within(list).getByText('hola')).toBeInTheDocument();
    expect(within(list).getByText('Sin nombre')).toBeInTheDocument();
    expect(within(list).getByRole('button', { name: 'Spoiler oculto, enfoca para leer' })).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Cerrar' })).toHaveFocus();
    expect(mocked).toHaveBeenCalledWith('r1', undefined);
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });

  it('sin mensajes explica la retención de 12 h', async () => {
    let resolve: (v: never[]) => void = () => {};
    mocked.mockReturnValueOnce(new Promise((r) => (resolve = r)));
    render(<EventChatHistory roomId="r1" />);
    await userEvent.click(screen.getByRole('button', { name: 'Ver chat del evento' }));
    expect(screen.getByRole('dialog', { name: 'Chat del evento' })).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('Cargando el chat');
    resolve([]);
    expect(await screen.findByText(/12 horas/)).toBeInTheDocument();
  });

  it('un error se muestra con "Reintentar"', async () => {
    mocked.mockRejectedValueOnce(new ChatHistoryError(503, 'El historial del chat no está disponible ahora.'));
    mocked.mockResolvedValueOnce([message('a', 'ya volvió')]);
    render(<EventChatHistory roomId="r1" />);
    await userEvent.click(screen.getByRole('button', { name: 'Ver chat del evento' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('no está disponible');
    await userEvent.click(screen.getByRole('button', { name: 'Reintentar' }));
    expect(await screen.findByText('ya volvió')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Cerrar' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
});
