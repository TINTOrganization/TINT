import { describe, expect, it, vi } from 'vitest';
import jwt from 'jsonwebtoken';
import { centralTokenCheck } from '../src/middlewares/centralAuth.js';
import { env } from '../src/config/env.js';

vi.mock('../src/modules/tokens/revocation.js', () => ({
  isTokenRevoked: vi.fn(async () => false),
}));

function mockResponse() {
  const response: any = {};
  response.status = vi.fn().mockReturnValue(response);
  response.json = vi.fn().mockReturnValue(response);
  response.set = vi.fn().mockReturnValue(response);
  response.end = vi.fn().mockReturnValue(response);
  return response;
}

function requestWithToken(token: string) {
  return { headers: { authorization: `Bearer ${token}` } } as any;
}

describe('centralTokenCheck', () => {
  it('returns the verified identity for a valid gateway token', async () => {
    const token = jwt.sign(
      { sub: 'guest:1', role: 'participant', room_id: 'room-1', nick: 'Ada', jti: 'jti-1' },
      env.JWT_SECRET,
      { issuer: env.JWT_ISSUER, audience: env.JWT_AUDIENCE, expiresIn: '5m' },
    );
    const response = mockResponse();

    await centralTokenCheck(requestWithToken(token), response, vi.fn());

    expect(response.status).toHaveBeenCalledWith(204);
    expect(response.set).toHaveBeenCalledWith({
      'X-User-Id': 'guest:1',
      'X-User-Sub': 'guest:1',
      'X-User-Role': 'participant',
      'X-User-Room-Id': 'room-1',
      'X-User-Nick': 'Ada',
    });
  });

  it('rejects an expired token with 401', async () => {
    const token = jwt.sign({ sub: 'guest:1' }, env.JWT_SECRET, {
      issuer: env.JWT_ISSUER,
      audience: env.JWT_AUDIENCE,
      expiresIn: -1,
    });
    const response = mockResponse();

    await centralTokenCheck(requestWithToken(token), response, vi.fn());

    expect(response.status).toHaveBeenCalledWith(401);
    expect(response.json).toHaveBeenCalledWith({ error: 'Invalid token' });
  });
});
// WebSocket por el gateway: el navegador no puede mandar Authorization en el handshake, así que la
// web pone el token en `?token=` y Caddy (forward_auth) lo reenvía en X-Forwarded-Uri.
function wsRequest(uri: string, extra: Record<string, string> = {}) {
  return { headers: { 'x-forwarded-uri': uri, ...extra } } as any;
}

function roomToken(claims: Record<string, unknown> = {}, expiresIn: string | number = '5m', secret = env.JWT_SECRET) {
  return jwt.sign(
    { sub: 'guest:1', role: 'participant', room_id: 'room-1', nick: 'Ada', jti: 'jti-1', ...claims },
    secret,
    { issuer: env.JWT_ISSUER, audience: env.JWT_AUDIENCE, expiresIn: expiresIn as any },
  );
}

describe('centralTokenCheck · WebSocket handshakes', () => {
  it('accepts the room token from the ?token= query of a /ws/* upgrade', async () => {
    const response = mockResponse();
    await centralTokenCheck(wsRequest(`/ws/sync?room_id=room-1&token=${roomToken()}`), response, vi.fn());
    expect(response.status).toHaveBeenCalledWith(204);
    expect(response.set).toHaveBeenCalledWith(expect.objectContaining({ 'X-User-Room-Id': 'room-1', 'X-User-Role': 'participant' }));
  });

  it('lets an expired but genuine token through so the service can close with 4003', async () => {
    const response = mockResponse();
    await centralTokenCheck(wsRequest(`/ws/social?token=${roomToken({}, -1)}`), response, vi.fn());
    expect(response.status).toHaveBeenCalledWith(204);
  });

  it('lets a revoked token through so the service can close with 4001', async () => {
    const { isTokenRevoked } = await import('../src/modules/tokens/revocation.js');
    vi.mocked(isTokenRevoked).mockResolvedValueOnce(true);
    const response = mockResponse();
    await centralTokenCheck(wsRequest(`/ws/voice?token=${roomToken()}`), response, vi.fn());
    expect(response.status).toHaveBeenCalledWith(204);
  });

  it('rejects a /ws/* token with a forged signature', async () => {
    const response = mockResponse();
    await centralTokenCheck(wsRequest(`/ws/sync?token=${roomToken({}, '5m', 'not-the-secret')}`), response, vi.fn());
    expect(response.status).toHaveBeenCalledWith(401);
  });

  it('rejects an unsigned (alg none) token on /ws/*', async () => {
    const forged = `${Buffer.from('{"alg":"none","typ":"JWT"}').toString('base64url')}.${Buffer.from('{"sub":"x"}').toString('base64url')}.`;
    const response = mockResponse();
    await centralTokenCheck(wsRequest(`/ws/sync?token=${forged}`), response, vi.fn());
    expect(response.status).toHaveBeenCalledWith(401);
  });

  it('rejects a /ws/* handshake without token', async () => {
    const response = mockResponse();
    await centralTokenCheck(wsRequest('/ws/sync?room_id=room-1'), response, vi.fn());
    expect(response.status).toHaveBeenCalledWith(401);
  });

  it('ignores ?token= outside /ws/* (REST must use Authorization)', async () => {
    const response = mockResponse();
    await centralTokenCheck(wsRequest(`/api/v1/rooms?token=${roomToken()}`), response, vi.fn());
    expect(response.status).toHaveBeenCalledWith(401);
  });

  it('still rejects an expired Bearer token on REST', async () => {
    const response = mockResponse();
    await centralTokenCheck(
      wsRequest('/api/v1/rooms/room-1/playback', { authorization: `Bearer ${roomToken({}, -1)}` }),
      response,
      vi.fn(),
    );
    expect(response.status).toHaveBeenCalledWith(401);
  });
});
