import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import jwt from 'jsonwebtoken';
import { generateKeyPairSync } from 'node:crypto';
import { requireAuthHost } from '../src/middlewares/auth.js';
import { centralTokenCheck } from '../src/middlewares/centralAuth.js';
import { isAuthEmulatorEnabled } from '../src/modules/auth/firebaseToken.js';
import { env } from '../src/config/env.js';

vi.mock('../src/modules/auth/jwks.js', () => ({ getSigningKey: vi.fn() }));
vi.mock('../src/modules/users/users.repo.js', () => ({ upsertByProvider: vi.fn() }));
vi.mock('../src/modules/tokens/revocation.js', () => ({ isTokenRevoked: vi.fn(async () => false) }));

import { getSigningKey } from '../src/modules/auth/jwks.js';
import { upsertByProvider } from '../src/modules/users/users.repo.js';

const DEMO = 'demo-tint';
const { publicKey, privateKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});

const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');

/** Token como los del Firebase Auth Emulator: `alg: none` y firma vacía. */
function unsignedToken(overrides: Record<string, unknown> = {}, signature = '', alg = 'none') {
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    iss: `https://securetoken.google.com/${env.FIREBASE_PROJECT_ID}`,
    aud: env.FIREBASE_PROJECT_ID,
    sub: 'emulator-uid-1',
    user_id: 'emulator-uid-1',
    email: 'host@example.com',
    name: 'Host Demo',
    iat: now,
    auth_time: now,
    exp: now + 3600,
    firebase: { sign_in_provider: 'google.com', identities: {} },
    ...overrides,
  };
  for (const [key, value] of Object.entries(payload)) {
    if (value === undefined) delete (payload as Record<string, unknown>)[key];
  }
  return `${b64({ alg, typ: 'JWT' })}.${b64(payload)}.${signature}`;
}

function rs256Token() {
  return jwt.sign(
    {
      sub: 'google-uid-1',
      aud: env.FIREBASE_PROJECT_ID,
      iss: `https://securetoken.google.com/${env.FIREBASE_PROJECT_ID}`,
    },
    privateKey,
    { algorithm: 'RS256', header: { kid: 'kid-1', alg: 'RS256' }, expiresIn: '1h' },
  );
}

const req = (token: string) => ({ headers: { authorization: `Bearer ${token}` } }) as any;
function res() {
  const r: any = {};
  r.status = vi.fn().mockReturnValue(r);
  r.json = vi.fn().mockReturnValue(r);
  r.set = vi.fn().mockReturnValue(r);
  r.end = vi.fn().mockReturnValue(r);
  return r;
}

const original = {
  host: env.FIREBASE_AUTH_EMULATOR_HOST,
  nodeEnv: env.NODE_ENV,
  project: env.FIREBASE_PROJECT_ID,
};

function enableEmulator() {
  env.FIREBASE_AUTH_EMULATOR_HOST = 'firebase-auth-emulator:9099';
  env.FIREBASE_PROJECT_ID = DEMO;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getSigningKey).mockResolvedValue(publicKey);
  vi.mocked(upsertByProvider).mockImplementation(async (input: any) => ({
    id: 'user-1',
    provider: 'firebase',
    providerSub: input.providerSub,
    email: input.email,
    displayName: input.displayName,
  }) as any);
});

afterEach(() => {
  env.FIREBASE_AUTH_EMULATOR_HOST = original.host;
  env.NODE_ENV = original.nodeEnv;
  env.FIREBASE_PROJECT_ID = original.project;
});

describe('isAuthEmulatorEnabled', () => {
  it('exige host del emulador, NODE_ENV distinto de production y proyecto demo-*', () => {
    const ok = { FIREBASE_AUTH_EMULATOR_HOST: 'x:9099', NODE_ENV: 'development' as const, FIREBASE_PROJECT_ID: DEMO };
    expect(isAuthEmulatorEnabled(ok)).toBe(true);
    expect(isAuthEmulatorEnabled({ ...ok, FIREBASE_AUTH_EMULATOR_HOST: undefined })).toBe(false);
    expect(isAuthEmulatorEnabled({ ...ok, NODE_ENV: 'production' })).toBe(false);
    expect(isAuthEmulatorEnabled({ ...ok, FIREBASE_PROJECT_ID: 'tint-login' })).toBe(false);
  });

  it('por defecto (sin FIREBASE_AUTH_EMULATOR_HOST) está desactivado', () => {
    expect(isAuthEmulatorEnabled()).toBe(false);
  });
});

describe('ID tokens sin firma (alg: none) FUERA del modo emulador', () => {
  it('requireAuthHost los rechaza con 401 aunque iss/aud/exp/sub sean válidos', async () => {
    const r = res();
    const next = vi.fn();
    await requireAuthHost(req(unsignedToken()), r, next);
    expect(r.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
    expect(upsertByProvider).not.toHaveBeenCalled();
  });

  it('se rechazan con proyecto demo-* si falta FIREBASE_AUTH_EMULATOR_HOST', async () => {
    env.FIREBASE_PROJECT_ID = DEMO;
    const r = res();
    await requireAuthHost(req(unsignedToken()), r, vi.fn());
    expect(r.status).toHaveBeenCalledWith(401);
  });

  it('se rechazan con NODE_ENV=production aunque el emulador esté configurado', async () => {
    enableEmulator();
    env.NODE_ENV = 'production';
    const r = res();
    await requireAuthHost(req(unsignedToken()), r, vi.fn());
    expect(r.status).toHaveBeenCalledWith(401);
    expect(upsertByProvider).not.toHaveBeenCalled();
  });

  it('el gateway (/internal/auth/check) los rechaza con 401 sin identidad', async () => {
    const r = res();
    await centralTokenCheck(req(unsignedToken()), r, vi.fn());
    expect(r.status).toHaveBeenCalledWith(401);
    expect(r.set).not.toHaveBeenCalled();
  });
});

describe('modo emulador activo', () => {
  beforeEach(enableEmulator);

  it('acepta el token del emulador y crea o recupera el usuario', async () => {
    const request = req(unsignedToken());
    const next = vi.fn();
    await requireAuthHost(request, res(), next);
    expect(next).toHaveBeenCalled();
    expect(upsertByProvider).toHaveBeenCalledWith(
      expect.objectContaining({ providerSub: 'emulator-uid-1', email: 'host@example.com', displayName: 'Host Demo' }),
    );
    expect(request.user).toMatchObject({ id: 'user-1', providerSub: 'emulator-uid-1' });
  });

  it('el gateway devuelve la identidad de host para el token del emulador', async () => {
    const r = res();
    await centralTokenCheck(req(unsignedToken()), r, vi.fn());
    expect(r.status).toHaveBeenCalledWith(204);
    expect(r.set).toHaveBeenCalledWith({ 'X-User-Id': 'user-1', 'X-User-Sub': 'emulator-uid-1', 'X-User-Role': 'host' });
  });

  it.each([
    ['iss de otro proyecto', { iss: 'https://securetoken.google.com/otro' }],
    ['aud de otro proyecto', { aud: 'otro' }],
    ['caducado', { exp: Math.floor(Date.now() / 1000) - 10 }],
    ['sin exp', { exp: undefined }],
    ['sin sub', { sub: undefined }],
    ['sub vacío', { sub: '' }],
  ])('401 si el token del emulador viene %s', async (_name, overrides) => {
    const r = res();
    const next = vi.fn();
    await requireAuthHost(req(unsignedToken(overrides)), r, next);
    expect(r.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  it('401 si un token alg: none trae una firma (no es del emulador)', async () => {
    const r = res();
    await requireAuthHost(req(unsignedToken({}, 'AAAA')), r, vi.fn());
    expect(r.status).toHaveBeenCalledWith(401);
  });

  it.each(['None', 'NONE'])('401 con la variante de mayúsculas alg: %s', async (alg) => {
    const r = res();
    await requireAuthHost(req(unsignedToken({}, '', alg)), r, vi.fn());
    expect(r.status).toHaveBeenCalledWith(401);
  });

  it('los ID tokens RS256 de Google siguen funcionando', async () => {
    const next = vi.fn();
    await requireAuthHost(req(rs256Token()), res(), next);
    expect(next).toHaveBeenCalled();
    expect(getSigningKey).toHaveBeenCalledWith('kid-1');
  });

  it('un token HS256 no se acepta como ID token de host', async () => {
    const token = jwt.sign({ sub: 'x', aud: DEMO, iss: `https://securetoken.google.com/${DEMO}` }, 'secret', {
      expiresIn: '1h',
      header: { kid: 'kid-1', alg: 'HS256' },
    });
    const r = res();
    await requireAuthHost(req(token), r, vi.fn());
    expect(r.status).toHaveBeenCalledWith(401);
  });
});
