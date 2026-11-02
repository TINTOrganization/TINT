import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { vi, beforeEach } from 'vitest';
import WatchRoom from './WatchRoom';
import { MockWebSocket } from '../test/mockWebSocket';
import { formatChatTime } from '../lib/socialSocket';
import { testGuestToken } from '../test/guestToken';

vi.mock('../lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/api')>();
  return { ...actual, apiFetch: vi.fn().mockRejectedValue(new Error('offline')) };
});

const sendMock = vi.fn(() => true);
const sendReactionMock = vi.fn(() => true);

vi.mock('../hooks/useSocialSocket', () => ({
  useSocialSocket: () => ({
    status: 'open' as const,
    messages: [
      {
        event_id: 'm1',
        type: 'chat_message',
        room_id: 'r1',
        user_id: 'u1',
        nick: 'Ana',
        text: 'Hola grupo',
        occurred_at: '2026-10-10T10:05:00Z',
        received_at: '2026-10-10T10:05:01Z',
      },
      {
        event_id: 'n1',
        type: 'notice',
        room_id: 'r1',
        user_id: 'u2',
        nick: 'Pedro',
        kind: 'joined',
        text: 'Pedro entró al chat',
        occurred_at: '2026-10-10T10:06:00Z',
      },
      {
        event_id: 'm2',
        type: 'chat_message',
        room_id: 'r1',
        user_id: 'u3',
        nick: 'Luis',
        text: 'Buenas noches',
        occurred_at: '2026-10-10T10:07:00Z',
        received_at: '2026-10-10T10:07:01Z',
      },
    ],
    reactions: [
      {
        event_id: 'e9',
        type: 'reaction',
        room_id: 'r1',
        user_id: 'u3',
        nick: 'Luis',
        emoji: '❤️',
        position_ms: 12000,
        occurred_at: '2026-10-10T10:07:00Z',
        received_at: '2026-10-10T10:07:00Z',
      },
    ],
    send: sendMock,
    sendReaction: sendReactionMock,
    laser: [],
    sendLaser: vi.fn(() => true),
    poll: null,
    lastError: null,
    createPoll: vi.fn(() => true),
    votePoll: vi.fn(() => true),
    closePoll: vi.fn(() => true),
    recap: null,
    requestRecap: vi.fn(() => true),
    chatSettings: { slow_mode_s: 0, muted_user_ids: [] },
    chatCooldownUntil: null,
    setSlowMode: vi.fn(() => true),
    muteUser: vi.fn(() => true),
    trivia: { question: null, receivedAt: null, ack: null, result: null, myOption: null },
    triviaSchedule: [],
    triviaLeaderboard: { entries: [], myRank: null, myTotal: null },
    scheduleTrivia: vi.fn(() => true),
    deleteTrivia: vi.fn(() => true),
    listTrivia: vi.fn(() => true),
    answerTrivia: vi.fn(() => true),
    dismissTrivia: vi.fn(),
  }),
}));

function renderWatch() {
  return render(
    <MemoryRouter initialEntries={['/watch/r1']}>
      <Routes>
        <Route path="/watch/:roomId" element={<WatchRoom />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('WatchRoom chat en vivo', () => {
  beforeEach(() => {
  // El Canal Sync (/ws/sync) se prueba en WatchRoom.sync.test.tsx: aquí no abre sockets reales.
  vi.stubGlobal('WebSocket', MockWebSocket);
    vi.clearAllMocks();
    localStorage.clear();
    // El chat se prueba como invitado con sesión (sin token sale la puerta).
    localStorage.setItem('tint_guest_token', testGuestToken());
  });

  it('muestra el historial del socket y envía por el canal social', async () => {
    renderWatch();
    expect(await screen.findByText('Hola grupo')).toBeInTheDocument();
    expect(screen.getByText('Chat conectado')).toBeInTheDocument();
    await userEvent.type(screen.getByPlaceholderText('Escribe un mensaje'), 'Buenas');
    await userEvent.click(screen.getByText('Enviar'));
    expect(sendMock).toHaveBeenCalledWith('Buenas');
  });

  it('muestra la hora de envío de cada mensaje', async () => {
    renderWatch();
    expect(await screen.findByText('Hola grupo')).toBeInTheDocument();
    const expected = formatChatTime('2026-10-10T10:05:00Z');
    expect(expected).not.toBe('');
    const time = screen.getByText(expected);
    expect(time.tagName).toBe('TIME');
    expect(time).toHaveAttribute('dateTime', '2026-10-10T10:05:00Z');
  });

  it('muestra el aviso de entrada diferenciado del mensaje normal', async () => {
    renderWatch();
    const notice = await screen.findByText('Pedro entró al chat');
    expect(notice).toBeInTheDocument();
    // El aviso no lleva el prefijo "Nick:" de un mensaje normal.
    expect(screen.queryByText('Pedro:')).not.toBeInTheDocument();
    expect(notice.closest('li')).not.toHaveClass('bg-white/5');
  });

  it('flota la reacción de otros usuarios sobre el reproductor', async () => {
    renderWatch();
    expect(await screen.findByText('Hola grupo')).toBeInTheDocument();
    // El ❤️ de Luis flota (overlay) y no aparece como mensaje del chat.
    const floats = screen.getAllByText('❤️');
    expect(floats.length).toBeGreaterThanOrEqual(1);
    expect(within(screen.getByRole('list')).queryByText('❤️')).not.toBeInTheDocument();
  });

  it('envía la reacción al pulsar la barra', async () => {
    renderWatch();
    await screen.findByText('Hola grupo');
    await userEvent.click(screen.getByRole('button', { name: /corazón/i }));
    expect(sendReactionMock).toHaveBeenCalledWith('❤️', 0);
  });

  it('la lista de mensajes tiene altura acotada con scroll interno', async () => {
    const { container } = renderWatch();
    const list = await screen.findByRole('list');
    // Altura acotada + scroll: la Card no debe crecer con los mensajes.
    expect(list.className).toContain('overflow-y-auto');
    expect(list.className).toContain('min-h-0');
    expect(list.className).toContain('flex-1');
    const card = list.closest('div');
    expect(card?.className).toContain('h-[60dvh]');
    expect(card?.className).toContain('lg:h-[calc(100dvh-7rem)]');
    expect(container.querySelector('aside')?.className).toContain('min-h-0');
  });

  it('muestra el nick propio en el header', async () => {
    localStorage.setItem('tint_guest_token', testGuestToken({ sub: 'u1', nick: 'Ana' }));
    renderWatch();
    expect(await screen.findByText('Hola grupo')).toBeInTheDocument();
    const chip = screen.getByTitle(/conectado como ana/i);
    expect(chip.textContent).toMatch(/ana/i);
  });

  it('alinea a la derecha los mensajes propios y a la izquierda los ajenos', async () => {
    localStorage.setItem('tint_guest_token', testGuestToken({ sub: 'u1', nick: 'Ana' }));
    renderWatch();
    expect(await screen.findByText('Hola grupo')).toBeInTheDocument();
    const own = screen.getByText('Hola grupo').closest('li');
    expect(own?.className).toContain('ml-auto');
    expect(own?.className).toContain('w-fit');
    expect(screen.queryByText('Ana:')).not.toBeInTheDocument();
    const other = screen.getByText('Buenas noches').closest('li');
    expect(other?.className).not.toContain('ml-auto');
    expect(other?.className).toContain('w-fit');
    expect(screen.getByText('Luis:')).toBeInTheDocument();
  });

  it('el formulario usa Input y Button con un pie de vidrio', async () => {
    renderWatch();
    const input = await screen.findByPlaceholderText('Escribe un mensaje');
    expect(input).toHaveAttribute('id', 'chat-input');
    expect(input).toHaveAttribute('maxLength', '280');
    expect(input.className).toContain('rounded-xl');
    expect(input.closest('form')?.className).toContain('tint-glass');
    expect(screen.getByRole('button', { name: 'Enviar' }).className).toContain('rounded-full');
  });
});
