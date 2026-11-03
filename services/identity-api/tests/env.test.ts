import { describe, it, expect } from 'vitest';
import { parseEnv } from '../src/config/env.js';

const base = { FIREBASE_PROJECT_ID: 'demo-tint' };

describe('parseEnv: modo Firebase Auth Emulator (ADR 0024)', () => {
  it('sin FIREBASE_AUTH_EMULATOR_HOST el modo emulador queda desactivado', () => {
    expect(parseEnv({ ...base }).FIREBASE_AUTH_EMULATOR_HOST).toBeUndefined();
  });

  it('una cadena vacía cuenta como desactivado (también en producción)', () => {
    const env = parseEnv({ ...base, NODE_ENV: 'production', FIREBASE_AUTH_EMULATOR_HOST: '' });
    expect(env.FIREBASE_AUTH_EMULATOR_HOST).toBeUndefined();
  });

  it('acepta el emulador en desarrollo con un proyecto demo-*', () => {
    const env = parseEnv({
      ...base,
      NODE_ENV: 'development',
      FIREBASE_AUTH_EMULATOR_HOST: 'firebase-auth-emulator:9099',
    });
    expect(env.FIREBASE_AUTH_EMULATOR_HOST).toBe('firebase-auth-emulator:9099');
  });

  it('se niega a arrancar con el emulador y NODE_ENV=production', () => {
    expect(() =>
      parseEnv({ ...base, NODE_ENV: 'production', FIREBASE_AUTH_EMULATOR_HOST: 'localhost:9099' }),
    ).toThrow(/NODE_ENV=production/);
  });

  it('se niega a arrancar con el emulador y un proyecto real (sin prefijo demo-)', () => {
    expect(() =>
      parseEnv({
        FIREBASE_PROJECT_ID: 'tint-login',
        NODE_ENV: 'development',
        FIREBASE_AUTH_EMULATOR_HOST: 'localhost:9099',
      }),
    ).toThrow(/demo-/);
  });

  it('producción sin emulador arranca normalmente', () => {
    expect(parseEnv({ FIREBASE_PROJECT_ID: 'tint-login', NODE_ENV: 'production' }).NODE_ENV).toBe('production');
  });
});
