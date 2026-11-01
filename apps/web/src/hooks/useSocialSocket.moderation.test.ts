import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { apiFetch } from '../lib/api';
import { useSocialSocket } from './useSocialSocket';

vi.mock('../lib/api', async (orig) => ({
  ...(await orig<typeof import('../lib/api')>()),
  apiFetch: vi.fn(),
}));
const mockedApiFetch = vi.mocked(apiFetch);

class FakeSocket {
  static instances: FakeSocket[] = [];
  url: string;
  readyState = 0;
  onopen: ((e: unknown) => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onclose: ((e: { code: number }) => void) | null = null;
  onerror: (() => void) | null = null;
  sent: string[] = [];
  constructor(url: string) {
    this.url = url;
    FakeSocket.instances.push(this);
  }
  open() {
    this.readyState = 1;
    this.onopen?.({});
  }
  receive(data: unknown) {
    this.onmessage?.({ data: JSON.stringify(data) });
  }
  send(data: string) {
    this.sent.push(data);
  }
  sentJson() {
    return this.sent.map((s) => JSON.parse(s) as Record<string, unknown>);
  }
  close() {
    this.readyState = 3;
    this.onclose?.({ code: 1006 });
  }
}

const create = (url: string) => new FakeSocket(url) as unknown as WebSocket;
const last = () => FakeSocket.instances[FakeSocket.instances.length - 1];

function connected(role?: 'guest') {
  const hook = renderHook(() => useSocialSocket('r1', { createSocket: create, role }));
  const ws = last();
  act(() => ws.open());
  return { ...hook, ws };
}

const question = {
  type: 'trivia_question',
  trivia_id: 't1',
  question: '¿Quién?',
  options: ['A', 'B', 'C'],
  opens_at_ms: 1_000,
  closes_at_ms: 21_000,
};

beforeEach(() => {
  FakeSocket.instances = [];
  localStorage.clear();
  mockedApiFetch.mockReset();
  vi.useFakeTimers();
  vi.setSystemTime(100_000);
});

afterEach(() => vi.useRealTimers());

describe('useSocialSocket — moderación del chat', () => {
  it('chatSettings arranca apagado y sigue a chat_settings', () => {
    const { result, ws } = connected();
    expect(result.current.chatSettings).toEqual({ slow_mode_s: 0, muted_user_ids: [] });
    act(() => ws.receive({ type: 'chat_settings', slow_mode_s: 10, muted_user_ids: ['u2'] }));
    expect(result.current.chatSettings).toEqual({ slow_mode_s: 10, muted_user_ids: ['u2'] });
    // Defensivo: campos ausentes o con tipo raro.
    act(() => ws.receive({ type: 'chat_settings' }));
    expect(result.current.chatSettings).toEqual({ slow_mode_s: 0, muted_user_ids: [] });
  });

  it('setSlowMode y muteUser envían sus frames; valores inválidos no salen', () => {
    const { result, ws } = connected();
    expect(result.current.setSlowMode(7)).toBe(false);
    act(() => {
      result.current.setSlowMode(30);
      result.current.muteUser('u2', true);
    });
    expect(ws.sentJson()).toEqual([
      expect.objectContaining({ type: 'chat_slow_mode', seconds: 30 }),
      expect.objectContaining({ type: 'chat_mute', user_id: 'u2', muted: true }),
    ]);
  });

  it('send con spoiler marca el mensaje', () => {
    const { result, ws } = connected();
    act(() => {
      result.current.send('el final', { spoiler: true });
    });
    expect(ws.sentJson()[0]).toMatchObject({ type: 'chat_send', text: 'el final', spoiler: true });
  });

  it('SLOW_MODE fija la cuenta regresiva con retry_after_ms', () => {
    const { result, ws } = connected('guest');
    act(() => ws.receive({ type: 'error', code: 'SLOW_MODE', retry_after_ms: 4_000 }));
    expect(result.current.lastError).toEqual({ code: 'SLOW_MODE', event_id_ref: undefined, retry_after_ms: 4_000 });
    expect(result.current.chatCooldownUntil).toBe(104_000);
  });

  it('con modo lento, el invitado espera tras enviar (pre-validación local)', () => {
    const { result, ws } = connected('guest');
    act(() => ws.receive({ type: 'chat_settings', slow_mode_s: 5, muted_user_ids: [] }));
    act(() => {
      result.current.send('hola');
    });
    expect(result.current.chatCooldownUntil).toBe(105_000);
  });

  it('sin modo lento no hay cuenta regresiva al enviar', () => {
    const { result } = connected('guest');
    act(() => {
      result.current.send('hola');
    });
    expect(result.current.chatCooldownUntil).toBeNull();
  });
});

describe('useSocialSocket — trivia', () => {
  it('pregunta, confirmación y resultado', () => {
    const { result, ws } = connected('guest');
    expect(result.current.trivia).toEqual({ question: null, receivedAt: null, ack: null, result: null, myOption: null });
    act(() => ws.receive(question));
    expect(result.current.trivia.question).toMatchObject({ trivia_id: 't1' });
    expect(result.current.trivia.receivedAt).toBe(100_000);
    act(() => {
      result.current.answerTrivia('t1', 2);
    });
    expect(ws.sentJson()[0]).toMatchObject({ type: 'trivia_answer', trivia_id: 't1', option: 2 });
    expect(result.current.trivia.myOption).toBe(2);
    act(() => ws.receive({ type: 'trivia_ack', trivia_id: 't1', option: 2, score: 1500 }));
    expect(result.current.trivia.ack).toMatchObject({ score: 1500 });
    act(() =>
      ws.receive({ type: 'trivia_result', trivia_id: 't1', correct: 2, top: [{ user_id: 'u', nick: 'Ana', score: 1500 }], my_score: 1500 }),
    );
    expect(result.current.trivia.result).toMatchObject({ correct: 2, my_score: 1500 });
    // Una pregunta nueva limpia la anterior.
    act(() => ws.receive({ ...question, trivia_id: 't2' }));
    expect(result.current.trivia).toMatchObject({ ack: null, result: null, myOption: null });
  });

  it('ignora ack y resultados de otra pregunta', () => {
    const { result, ws } = connected('guest');
    act(() => ws.receive(question));
    act(() => ws.receive({ type: 'trivia_ack', trivia_id: 'otra', option: 1, score: 0 }));
    act(() => ws.receive({ type: 'trivia_result', trivia_id: 'otra', correct: 0, top: [] }));
    expect(result.current.trivia).toMatchObject({ ack: null, result: null });
  });

  it('dismissTrivia oculta la tarjeta', () => {
    const { result, ws } = connected('guest');
    act(() => ws.receive(question));
    act(() => result.current.dismissTrivia());
    expect(result.current.trivia.question).toBeNull();
  });

  it('agenda del host ordenada por tiempo; programar y borrar piden la lista', () => {
    const { result, ws } = connected();
    act(() =>
      ws.receive({
        type: 'trivia_schedule_state',
        questions: [
          { trivia_id: 'b', at_ms: 90_000, question: 'B', options: ['1', '2'], correct: 0, answer_window_s: 20 },
          { trivia_id: 'a', at_ms: 30_000, question: 'A', options: ['1', '2'], correct: 1, answer_window_s: 20 },
        ],
      }),
    );
    expect(result.current.triviaSchedule.map((q) => q.trivia_id)).toEqual(['a', 'b']);
    expect(result.current.scheduleTrivia({ atMs: 0, question: '', options: ['a', 'b'], correct: 0, answerWindowS: 20 })).toBe(false);
    expect(result.current.updateTrivia('a', { atMs: 0, question: '', options: ['a', 'b'], correct: 0, answerWindowS: 20 })).toBe(false);
    act(() => {
      result.current.scheduleTrivia({ atMs: 5_000, question: '¿Q?', options: ['a', 'b'], correct: 0, answerWindowS: 20 });
      result.current.updateTrivia('a', { atMs: 6_000, question: '¿Q2?', options: ['a', 'b'], correct: 1, answerWindowS: 30 });
      result.current.deleteTrivia('a');
      result.current.listTrivia();
    });
    expect(ws.sentJson().map((m) => m.type)).toEqual([
      'trivia_schedule',
      'trivia_list',
      'trivia_update',
      'trivia_list',
      'trivia_delete',
      'trivia_list',
      'trivia_list',
    ]);
    act(() => ws.receive({ type: 'trivia_schedule_state' }));
    expect(result.current.triviaSchedule).toEqual([]);
  });

  it('el host no pide la agenda al conectarse: llega en la instantánea', async () => {
    localStorage.setItem('tint_token', 'firebase');
    mockedApiFetch.mockResolvedValue({ token: 'ticket', expiresAt: 'x' });
    renderHook(() => useSocialSocket('r1', { createSocket: create, role: 'host' }));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    act(() => last().open());
    expect(last().sentJson()).toEqual([]);
  });

  it('sin socket abierto las acciones devuelven false', () => {
    const { result } = renderHook(() => useSocialSocket('r1', { createSocket: create, role: 'guest' }));
    expect(result.current.setSlowMode(5)).toBe(false);
    expect(result.current.answerTrivia('t1', 0)).toBe(false);
    expect(result.current.trivia.myOption).toBeNull();
  });
});
