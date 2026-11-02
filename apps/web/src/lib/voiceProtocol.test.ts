import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildHostMute,
  buildLeave,
  buildSelfMute,
  buildSignal,
  buildVoiceUrl,
  canModerate,
  parseVoiceMessage,
  resolveVoiceWsUrl,
  VOICE_CLOSE,
  voiceCloseNotice,
  voiceErrorMessage,
} from './voiceProtocol';

const peer = { peer_id: 'p1', user_id: 'guest:ana', nick: 'Ana', role: 'participant', muted: false, host_muted: false };

afterEach(() => vi.unstubAllEnvs());

describe('voiceProtocol — URL', () => {
  it('usa VITE_VOICE_WS_URL o el puerto 8085 por defecto', () => {
    vi.stubEnv('VITE_VOICE_WS_URL', '');
    expect(resolveVoiceWsUrl()).toBe('ws://localhost:8085/ws/voice');
    vi.stubEnv('VITE_VOICE_WS_URL', 'wss://voz.test/ws/voice');
    expect(resolveVoiceWsUrl()).toBe('wss://voz.test/ws/voice');
    expect(resolveVoiceWsUrl('ws://x/ws/voice')).toBe('ws://x/ws/voice');
  });

  it('codifica room_id y token en la query', () => {
    expect(buildVoiceUrl('ws://h/ws/voice', 'sala 1', 'a.b+c')).toBe(
      'ws://h/ws/voice?room_id=sala+1&token=a.b%2Bc',
    );
  });
});

describe('voiceProtocol — mensajes del cliente', () => {
  it('signal, self_mute, host_mute y leave llevan event_id y occurred_at', () => {
    for (const raw of [
      buildSignal('p2', { candidate: null }),
      buildSelfMute(true),
      buildHostMute('guest:ana', false),
      buildLeave(),
    ]) {
      const msg = JSON.parse(raw);
      expect(typeof msg.event_id).toBe('string');
      expect(msg.event_id.length).toBeGreaterThan(0);
      expect(msg.event_id.length).toBeLessThanOrEqual(64);
      expect(Number.isInteger(msg.occurred_at)).toBe(true);
    }
    expect(JSON.parse(buildSignal('p2', { candidate: null }))).toMatchObject({ type: 'signal', to: 'p2', data: { candidate: null } });
    expect(JSON.parse(buildSelfMute(true))).toMatchObject({ type: 'self_mute', muted: true });
    expect(JSON.parse(buildHostMute('u', false))).toMatchObject({ type: 'host_mute', user_id: 'u', muted: false });
    expect(JSON.parse(buildLeave())).toMatchObject({ type: 'leave' });
  });
});

describe('parseVoiceMessage', () => {
  it('voice_state normaliza peers e ice_servers', () => {
    const msg = parseVoiceMessage(
      JSON.stringify({
        type: 'voice_state',
        room_id: 'r1',
        self: { ...peer, peer_id: 'me' },
        peers: [peer, { peer_id: 'x' }, 'basura'],
        ice_servers: [{ urls: ['stun:s'] }, { urls: 'turn:t', username: 'u', credential: 'c' }, { nada: 1 }],
        max_members: 8,
      }),
    );
    expect(msg?.type).toBe('voice_state');
    if (msg?.type !== 'voice_state') return;
    expect(msg.self.peer_id).toBe('me');
    expect(msg.peers).toEqual([peer]);
    expect(msg.ice_servers).toEqual([{ urls: ['stun:s'] }, { urls: 'turn:t', username: 'u', credential: 'c' }]);
    expect(msg.max_members).toBe(8);
  });

  it('flags de silencio ausentes valen false', () => {
    const msg = parseVoiceMessage(
      JSON.stringify({ type: 'peer_joined', peer: { peer_id: 'p', user_id: 'u', nick: 'N', role: 'host' } }),
    );
    expect(msg).toEqual({ type: 'peer_joined', peer: { peer_id: 'p', user_id: 'u', nick: 'N', role: 'host', muted: false, host_muted: false } });
  });

  it('peer_left, signal, peer_muted y error', () => {
    expect(parseVoiceMessage('{"type":"peer_left","peer_id":"p"}')).toEqual({ type: 'peer_left', peer_id: 'p' });
    expect(parseVoiceMessage('{"type":"signal","from":"p","data":{"candidate":null}}')).toEqual({
      type: 'signal',
      from: 'p',
      data: { candidate: null },
    });
    expect(
      parseVoiceMessage('{"type":"peer_muted","peer_id":"p","user_id":"u","muted":true,"host_muted":true}'),
    ).toEqual({ type: 'peer_muted', peer_id: 'p', user_id: 'u', muted: true, host_muted: true });
    expect(parseVoiceMessage('{"type":"error","code":"HOST_MUTED","event_id_ref":"e"}')).toEqual({
      type: 'error',
      code: 'HOST_MUTED',
      event_id_ref: 'e',
    });
  });

  it('descarta lo inválido', () => {
    for (const text of [
      'no json',
      '[]',
      '{"type":"desconocido"}',
      '{"type":"voice_state","self":{}}',
      '{"type":"peer_joined"}',
      '{"type":"peer_left"}',
      '{"type":"signal","from":"p"}',
      '{"type":"signal","from":"p","data":[]}',
      '{"type":"peer_muted","peer_id":"p"}',
      '{"type":"error"}',
    ])
      expect(parseVoiceMessage(text)).toBeNull();
  });
});

describe('textos para la persona', () => {
  it('errores conocidos y genérico', () => {
    expect(voiceErrorMessage('HOST_MUTED')).toMatch(/host te silenció/i);
    expect(voiceErrorMessage('VOICE_FULL')).toMatch(/llena/i);
    expect(voiceErrorMessage('FORBIDDEN')).toMatch(/host/i);
    expect(voiceErrorMessage('UNAVAILABLE')).toMatch(/intenta/i);
    expect(voiceErrorMessage('RARO')).toMatch(/algo salió mal/i);
  });

  it('cierres terminales', () => {
    expect(voiceCloseNotice(VOICE_CLOSE.REVOKED, false)).toMatch(/acceso/i);
    expect(voiceCloseNotice(VOICE_CLOSE.FULL, false)).toMatch(/llena/i);
    expect(voiceCloseNotice(VOICE_CLOSE.EXPIRED, false)).toMatch(/caducó/i);
    expect(voiceCloseNotice(VOICE_CLOSE.EXPIRED, true)).toBeNull(); // el host pide otro ticket
    expect(voiceCloseNotice(1006, false)).toBeNull();
  });

  it('modera host y cohost', () => {
    expect(canModerate('host')).toBe(true);
    expect(canModerate('cohost')).toBe(true);
    expect(canModerate('participant')).toBe(false);
  });
});
