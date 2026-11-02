import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { inviteToStage, removeFromStage, resolveVoiceApiUrl, StageError, stageErrorMessage } from './voiceStage';

let fetchMock: ReturnType<typeof vi.fn>;
const ticket = async () => 'host-ticket';

beforeEach(() => {
  fetchMock = vi.fn(async () => new Response(null, { status: 204 }));
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('voiceStage', () => {
  it('la base sale de VITE_VOICE_API_URL o del WebSocket de voz', () => {
    vi.stubEnv('VITE_VOICE_API_URL', 'https://gw.test/');
    expect(resolveVoiceApiUrl()).toBe('https://gw.test');
    vi.stubEnv('VITE_VOICE_API_URL', '');
    vi.stubEnv('VITE_VOICE_WS_URL', 'wss://gw.test/ws/voice');
    expect(resolveVoiceApiUrl()).toBe('https://gw.test');
    vi.stubEnv('VITE_VOICE_WS_URL', 'ws://localhost:8085/ws/voice');
    expect(resolveVoiceApiUrl()).toBe('http://localhost:8085');
    vi.stubEnv('VITE_VOICE_WS_URL', 'no es url');
    expect(resolveVoiceApiUrl()).toBe('http://localhost:8085');
  });

  it('invita con PUT y retira con DELETE usando el sync-ticket', async () => {
    await inviteToStage('r1', 'guest:ana', { baseUrl: 'https://v', fetchHostTicket: ticket });
    await removeFromStage('r1', 'guest:ana', { baseUrl: 'https://v', fetchHostTicket: ticket });
    expect(fetchMock.mock.calls).toEqual([
      ['https://v/api/v1/voice/rooms/r1/stage/guest%3Aana', { method: 'PUT', headers: { Authorization: 'Bearer host-ticket' } }],
      ['https://v/api/v1/voice/rooms/r1/stage/guest%3Aana', { method: 'DELETE', headers: { Authorization: 'Bearer host-ticket' } }],
    ]);
  });

  it('403 y 503 son StageError con mensajes claros; la red es status 0', async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 403 }));
    await expect(inviteToStage('r1', 'u', { fetchHostTicket: ticket })).rejects.toMatchObject({ status: 403 });
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 503 }));
    await expect(inviteToStage('r1', 'u', { fetchHostTicket: ticket })).rejects.toBeInstanceOf(StageError);
    fetchMock.mockRejectedValueOnce(new TypeError('red'));
    await expect(removeFromStage('r1', 'u', { fetchHostTicket: ticket })).rejects.toMatchObject({ status: 0 });
    expect(stageErrorMessage(403)).toMatch(/solo el host/i);
    expect(stageErrorMessage(503)).toMatch(/intenta de nuevo/i);
  });
});
