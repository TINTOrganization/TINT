import { describe, expect, it } from 'vitest';
import {
  buildChatMute,
  buildChatSend,
  buildChatSlowMode,
  buildTriviaAnswer,
  buildTriviaDelete,
  buildTriviaList,
  buildTriviaSchedule,
  buildTriviaUpdate,
  parseMmSs,
  parseSocialMessage,
  SLOW_MODE_OPTIONS,
  socialErrorMessage,
  validateTriviaDraft,
} from './socialSocket';

describe('chat: modo lento, silencio y spoilers', () => {
  it('chat_slow_mode lleva los segundos', () => {
    expect(JSON.parse(buildChatSlowMode('r1', 10, 'e1'))).toEqual({
      type: 'chat_slow_mode',
      event_id: 'e1',
      room_id: 'r1',
      seconds: 10,
    });
    expect(SLOW_MODE_OPTIONS.map((o) => o.seconds)).toEqual([0, 5, 10, 30, 60]);
    expect(SLOW_MODE_OPTIONS.map((o) => o.label)).toEqual(['Apagado', '5 s', '10 s', '30 s', '1 min']);
  });

  it('chat_mute lleva user_id y muted', () => {
    expect(JSON.parse(buildChatMute('r1', 'u2', true, 'e2'))).toEqual({
      type: 'chat_mute',
      event_id: 'e2',
      room_id: 'r1',
      user_id: 'u2',
      muted: true,
    });
  });

  it('chat_send solo incluye spoiler cuando es true (retrocompatible)', () => {
    expect(JSON.parse(buildChatSend('r1', ' hola '))).not.toHaveProperty('spoiler');
    expect(JSON.parse(buildChatSend('r1', 'muere', true))).toMatchObject({ text: 'muere', spoiler: true });
  });

  it('parsea chat_settings y errores con retry_after_ms', () => {
    expect(parseSocialMessage(JSON.stringify({ type: 'chat_settings', slow_mode_s: 5, muted_user_ids: ['u1'] }))).toEqual({
      type: 'chat_settings',
      slow_mode_s: 5,
      muted_user_ids: ['u1'],
    });
    expect(parseSocialMessage(JSON.stringify({ type: 'error', code: 'SLOW_MODE', retry_after_ms: 4000 }))).toMatchObject({
      retry_after_ms: 4000,
    });
  });

  it('mensajes simples para los errores nuevos', () => {
    expect(socialErrorMessage('SLOW_MODE')).toMatch(/modo lento/i);
    expect(socialErrorMessage('MUTED')).toMatch(/silenci/i);
    expect(socialErrorMessage('TRIVIA_CLOSED')).toMatch(/tiempo/i);
    expect(socialErrorMessage('ALREADY_ANSWERED')).toMatch(/ya respondiste/i);
    expect(socialErrorMessage('TRIVIA_NOT_FOUND')).toMatch(/ya no existe/i);
    expect(socialErrorMessage('FORBIDDEN')).toMatch(/permiso/i);
    expect(socialErrorMessage('RATE_LIMITED')).toMatch(/despacio/i);
    expect(socialErrorMessage('UNAVAILABLE')).toMatch(/no está disponible/i);
    expect(socialErrorMessage('OTRO')).toMatch(/no se pudo/i);
  });
});

describe('trivia', () => {
  it('parsea los mensajes trivia_*', () => {
    for (const type of ['trivia_question', 'trivia_ack', 'trivia_result', 'trivia_schedule_state', 'trivia_leaderboard']) {
      expect(parseSocialMessage(JSON.stringify({ type }))).toMatchObject({ type });
    }
  });

  it('arma trivia_schedule con los campos del contrato (recortados)', () => {
    const frame = JSON.parse(
      buildTriviaSchedule('r1', { atMs: 65_000, question: ' ¿Quién? ', options: [' A ', 'B'], correct: 1, answerWindowS: 20 }, 'e3'),
    );
    expect(frame).toEqual({
      type: 'trivia_schedule',
      event_id: 'e3',
      room_id: 'r1',
      at_ms: 65_000,
      question: '¿Quién?',
      options: ['A', 'B'],
      correct: 1,
      answer_window_s: 20,
    });
  });

  it('arma trivia_update con el trivia_id y los campos de trivia_schedule', () => {
    const frame = JSON.parse(
      buildTriviaUpdate('r1', 't1', { atMs: 70_000, question: ' ¿Otra? ', options: ['A', ' B '], correct: 0, answerWindowS: 30 }, 'e4'),
    );
    expect(frame).toEqual({
      type: 'trivia_update',
      event_id: 'e4',
      room_id: 'r1',
      trivia_id: 't1',
      at_ms: 70_000,
      question: '¿Otra?',
      options: ['A', 'B'],
      correct: 0,
      answer_window_s: 30,
    });
  });

  it('arma trivia_delete, trivia_list y trivia_answer', () => {
    expect(JSON.parse(buildTriviaDelete('r1', 't1', 'e'))).toEqual({ type: 'trivia_delete', event_id: 'e', room_id: 'r1', trivia_id: 't1' });
    expect(JSON.parse(buildTriviaList('r1', 'e'))).toEqual({ type: 'trivia_list', event_id: 'e', room_id: 'r1' });
    expect(JSON.parse(buildTriviaAnswer('r1', 't1', 2, 'e'))).toEqual({
      type: 'trivia_answer',
      event_id: 'e',
      room_id: 'r1',
      trivia_id: 't1',
      option: 2,
    });
  });

  it.each([
    [{ question: '', options: ['a', 'b'], correct: 0 }, /pregunta/],
    [{ question: 'x'.repeat(141), options: ['a', 'b'], correct: 0 }, /140/],
    [{ question: 'q', options: ['a'], correct: 0 }, /entre 2 y 4/],
    [{ question: 'q', options: ['a', ''], correct: 0 }, /Completa/],
    [{ question: 'q', options: ['a', 'x'.repeat(61)], correct: 0 }, /60/],
    [{ question: 'q', options: ['a', 'A'], correct: 0 }, /distintas/],
    [{ question: 'q', options: ['a', 'b'], correct: 2 }, /correcta/],
    [{ question: 'q', options: ['a', 'b'], correct: 0, atMs: -1 }, /momento/],
    [{ question: 'q', options: ['a', 'b'], correct: 0, answerWindowS: 5 }, /10 y 60/],
    [{ question: 'q', options: ['a', 'b'], correct: 0, atMs: 24 * 3_600_000 + 1 }, /momento/],
  ])('valida el borrador %#', (draft, expected) => {
    expect(validateTriviaDraft({ atMs: 0, answerWindowS: 20, ...draft })).toMatch(expected);
  });

  it('un borrador válido devuelve null', () => {
    expect(validateTriviaDraft({ atMs: 0, question: 'q', options: ['a', 'b'], correct: 1, answerWindowS: 20 })).toBeNull();
  });

  it('parseMmSs entiende mm:ss y segundos sueltos', () => {
    expect(parseMmSs('01:05')).toBe(65_000);
    expect(parseMmSs('125:00')).toBe(7_500_000);
    expect(parseMmSs('42')).toBe(42_000);
    expect(parseMmSs(' 1:5 ')).toBeNull();
    expect(parseMmSs('1:60')).toBeNull();
    expect(parseMmSs('abc')).toBeNull();
  });
});
