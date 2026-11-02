/** Trivia "lanzar ahora" en salas live (dominio-transmision §6.1, social-core). */
import { act, renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { useSocialSocket } from './useSocialSocket';
import { buildTriviaLaunchNow } from '../lib/socialSocket';
import { MockWebSocket } from '../test/mockWebSocket';

describe('trivia_launch_now', () => {
  it('el builder lleva event_id, type y trivia_id', () => {
    expect(JSON.parse(buildTriviaLaunchNow('r1', 't1', 'e1'))).toEqual({
      type: 'trivia_launch_now',
      event_id: 'e1',
      room_id: 'r1',
      trivia_id: 't1',
    });
  });

  it('launchTriviaNow envía el frame con el socket abierto', () => {
    MockWebSocket.reset();
    localStorage.setItem('tint_guest_token', 'g');
    const { result } = renderHook(() =>
      useSocialSocket('r1', { role: 'guest', createSocket: (u) => new MockWebSocket(u) as unknown as WebSocket }),
    );
    expect(result.current.launchTriviaNow('t1')).toBe(false);
    act(() => MockWebSocket.last().open());
    act(() => {
      result.current.launchTriviaNow('t9');
    });
    expect(MockWebSocket.last().sentJson()).toEqual([
      expect.objectContaining({ type: 'trivia_launch_now', trivia_id: 't9', event_id: expect.any(String) }),
    ]);
  });
});
