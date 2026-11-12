import { connectAuthEmulator, type Auth } from 'firebase/auth';

/**
 * URL del Firebase Auth Emulator (solo desarrollo, ADR 0024) a partir de
 * `VITE_FIREBASE_AUTH_EMULATOR_URL`. Sin valor o con un valor que no sea un origen
 * http(s) devuelve `null`: la web usa Firebase real.
 */
export function resolveAuthEmulatorUrl(raw: string | undefined): string | null {
  const value = raw?.trim();
  if (!value) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  return url.origin;
}

/** Conecta el SDK de Auth al emulador si hay URL válida. Devuelve si lo hizo. */
export function connectToAuthEmulator(
  auth: Auth,
  raw: string | undefined,
  connect: typeof connectAuthEmulator = connectAuthEmulator,
): boolean {
  const url = resolveAuthEmulatorUrl(raw);
  if (!url) return false;
  connect(auth, url, { disableWarnings: true });
  return true;
}
