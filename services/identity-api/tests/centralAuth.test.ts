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