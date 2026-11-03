import jwt from 'jsonwebtoken';
import { getSigningKey } from './jwks.js';
import { DEMO_PROJECT_PREFIX, env, type Env } from '../../config/env.js';

/**
 * Modo Firebase Auth Emulator (ADR 0024): solo si FIREBASE_AUTH_EMULATOR_HOST tiene valor,
 * NODE_ENV no es `production` y el proyecto es de demostración (`demo-*`). `parseEnv` ya impide
 * arrancar en otro caso; esta comprobación se repite en cada petición (defensa en profundidad).
 */
export function isAuthEmulatorEnabled(config: Pick<Env, 'FIREBASE_AUTH_EMULATOR_HOST' | 'NODE_ENV' | 'FIREBASE_PROJECT_ID'> = env): boolean {
  return (
    Boolean(config.FIREBASE_AUTH_EMULATOR_HOST) &&
    config.NODE_ENV !== 'production' &&
    config.FIREBASE_PROJECT_ID.startsWith(DEMO_PROJECT_PREFIX)
  );
}

/**
 * Verifica un ID token de Firebase y devuelve sus claims.
 * - RS256 con `kid`: firma contra el JWKS de Google (siempre, también en modo emulador).
 * - `alg: none` (sin firma): solo en modo emulador; fuera de él se rechaza siempre.
 * En ambos casos exige `iss`, `aud` (del FIREBASE_PROJECT_ID), `exp` vigente y `sub`.
 * Lanza un error ante cualquier fallo: el llamador responde 401.
 */
export async function verifyFirebaseIdToken(token: string): Promise<jwt.JwtPayload> {
  const decoded = jwt.decode(token, { complete: true });
  const alg = decoded?.header?.alg;
  const claims = {
    issuer: `https://securetoken.google.com/${env.FIREBASE_PROJECT_ID}`,
    audience: env.FIREBASE_PROJECT_ID,
  };
  let payload: string | jwt.JwtPayload;
  if (alg === 'none') {
    if (!isAuthEmulatorEnabled()) {
      throw new Error('token sin firma fuera del modo emulador');
    }
    // jsonwebtoken exige que la parte de la firma venga vacía con `none`.
    payload = jwt.verify(token, undefined as unknown as jwt.Secret, { ...claims, algorithms: ['none'] });
  } else {
    const kid = decoded?.header?.kid;
    if (!kid) {
      throw new Error('token sin kid');
    }
    const key = await getSigningKey(kid);
    payload = jwt.verify(token, key, { ...claims, algorithms: ['RS256'] });
  }
  if (typeof payload === 'string' || typeof payload.exp !== 'number') {
    throw new Error('token sin exp');
  }
  if (typeof payload.sub !== 'string' || payload.sub.length === 0) {
    throw new Error('token sin sub');
  }
  return payload;
}
