import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, apiFetch } from './api';
import { chatHistoryErrorMessage, ChatHistoryError, fetchChatHistory, hostHistoryTicket, resolveSocialApiUrl } from './chatHistory';

vi.mock('./api', async (orig) => ({ ...(await orig<typeof import('./api')>()), apiFetch: vi.fn() }));
const mockedApi = vi.mocked(apiFetch);

const msg = (id: string, extra: Record<string, unknown> = {}) => ({
  type: 'chat_message',
  event_id: id,
  room_id: 'r1',
  user_id: 'guest:ana',
  nick: 'Ana',
  text: `hola ${id}`,
  occurred_at: '2026-11-01T18:00:00.000Z',
  received_at: '2026-11-01T18:00:00.000Z',
  ...extra,
});

let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  mockedApi.mockReset();
  fetchMock = vi.fn(async () => new Response(JSON.stringify({ room_id: 'r1', messages: [msg('a')] }), { status: 200 }));
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('resolveSocialApiUrl', () => {
  it('usa el origen del WebSocket social (mismo origen que /ws/social)', () => {
    vi.stubEnv('VITE_SOCIAL_WS_URL', 'wss://gw.test/ws/social');
    expect(resolveSocialApiUrl()).toBe('https://gw.test');
    vi.stubEnv('VITE_SOCIAL_WS_URL', 'ws://localhost:8082/ws/social');
    expect(resolveSocialApiUrl()).toBe('http://localhost:8082');
    vi.stubEnv('VITE_SOCIAL_WS_URL', '');
    expect(resolveSocialApiUrl()).toBe('http://localhost:8082');
    expect(resolveSocialApiUrl('https://x/')).toBe('https://x');
  });
});

describe('fetchChatHistory', () => {
  it('pide el sync-ticket del host y lee GET /api/v1/social/rooms/{id}/chat', async () => {
    mockedApi.mockResolvedValueOnce({ token: 'ticket' });
    const messages = await fetchChatHistory('r 1', { baseUrl: 'https://gw' });
    expect(mockedApi).toHaveBeenCalledWith('/rooms/r%201/sync-ticket', { method: 'POST' });
    expect(fetchMock).toHaveBeenCalledWith('https://gw/api/v1/social/rooms/r%201/chat', {
      headers: { Authorization: 'Bearer ticket' },
    });
    expect(messages.map((m) => m.event_id)).toEqual(['a']);
  });

  it('respaldo: si el sync-ticket da 410 Disabled usa el analytics-ticket', async () => {
    mockedApi
      .mockRejectedValueOnce(new ApiError(410, 'Disabled', { error: 'Disabled' }))
      .mockResolvedValueOnce({ token: 'analytics' });
    await expect(hostHistoryTicket('r1')).resolves.toBe('analytics');
    expect(mockedApi).toHaveBeenLastCalledWith('/rooms/r1/analytics-ticket', { method: 'POST' });
    mockedApi.mockRejectedValueOnce(new ApiError(403, 'Forbidden'));
    await expect(hostHistoryTicket('r1')).rejects.toBeInstanceOf(ApiError);
  });

  it('descarta lo que no es un chat_message válido y conserva el spoiler', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          messages: [msg('a', { spoiler: true }), { type: 'notice' }, msg('b', { text: 3 }), msg('c', { nick: null }), 'x'],
        }),
      ),
    );
    const messages = await fetchChatHistory('r1', { fetchTicket: async () => 't' });
    expect(messages.map((m) => [m.event_id, m.spoiler ?? false, m.nick])).toEqual([
      ['a', true, 'Ana'],
      ['c', false, ''],
    ]);
  });

  it('sin cuerpo o sin lista devuelve []', async () => {
    fetchMock.mockResolvedValueOnce(new Response('no json'));
    await expect(fetchChatHistory('r1', { fetchTicket: async () => 't' })).resolves.toEqual([]);
  });

  it.each([
    [401, /caducó/],
    [403, /solo el host/i],
    [503, /no está disponible/],
  ])('HTTP %i → ChatHistoryError con mensaje claro', async (status, text) => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status }));
    const err = await fetchChatHistory('r1', { fetchTicket: async () => 't' }).catch((e) => e);
    expect(err).toBeInstanceOf(ChatHistoryError);
    expect(err.status).toBe(status);
    expect(err.message).toMatch(text);
  });

  it('errores de red y del ticket', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('red'));
    await expect(fetchChatHistory('r1', { fetchTicket: async () => 't' })).rejects.toMatchObject({ status: 0 });
    await expect(
      fetchChatHistory('r1', { fetchTicket: () => Promise.reject(new ApiError(404, 'Not found')) }),
    ).rejects.toMatchObject({ status: 404, message: 'Esta sala ya no existe.' });
    await expect(fetchChatHistory('r1', { fetchTicket: () => Promise.reject(new Error('x')) })).rejects.toMatchObject({
      status: 0,
    });
    expect(chatHistoryErrorMessage(0)).toMatch(/conexión/);
  });
});
