import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Auth, User } from 'firebase/auth';
import { onIdTokenChanged } from 'firebase/auth';
import { startHostSession, syncAuthCookie } from './authSession';
import { apiFetch, setHostTokenProvider } from './api';

vi.mock('firebase/auth', () => ({ onIdTokenChanged: vi.fn() }));

const mockedOnIdTokenChanged = vi.mocked(onIdTokenChanged);
const mockedFetch = vi.fn();
vi.stubGlobal('fetch', mockedFetch);

type Listener = (user: User | null) => void;

function fakeUser(token: string): User {
  return { getIdToken: vi.fn().mockResolvedValue(token) } as unknown as User;
}

function fakeAuth(user: User | null): Auth {
  return { currentUser: user, authStateReady: vi.fn().mockResolvedValue(undefined) } as unknown as Auth;
}

function captureListener(): Listener {
  return mockedOnIdTokenChanged.mock.calls[0][1] as Listener;
}

const flush = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  mockedOnIdTokenChanged.mockReturnValue(vi.fn());
});

afterEach(() => setHostTokenProvider(null));

describe('startHostSession', () => {
  it('mantiene fresco tint_token cuando Firebase renueva el ID token', async () => {
    localStorage.setItem('tint_token', 'viejo');
    startHostSession(fakeAuth(null));
    captureListener()(fakeUser('nuevo'));
    await flush();
    expect(localStorage.getItem('tint_token')).toBe('nuevo');
  });

  it('no revive la sesión si el usuario cerró sesión en TINT', async () => {
    startHostSession(fakeAuth(null));
    captureListener()(fakeUser('nuevo'));
    await flush();
    expect(localStorage.getItem('tint_token')).toBeNull();
  });

  it('ignora el evento sin usuario y los fallos al leer el token', async () => {
    localStorage.setItem('tint_token', 'viejo');
    startHostSession(fakeAuth(null));
    captureListener()(null);
    captureListener()({ getIdToken: vi.fn().mockRejectedValue(new Error('offline')) } as unknown as User);
    await flush();
    expect(localStorage.getItem('tint_token')).toBe('viejo');
  });

  it('las peticiones de host usan el token del usuario actual de Firebase', async () => {
    localStorage.setItem('tint_token', 'viejo');
    const user = fakeUser('vigente');
    const auth = fakeAuth(user);
    startHostSession(auth);
    mockedFetch.mockResolvedValueOnce({ ok: true, status: 200, json: () => Promise.resolve({}) });
    await apiFetch('/rooms');
    expect(auth.authStateReady).toHaveBeenCalled();
    expect(user.getIdToken).toHaveBeenCalledWith(false);
    const [, opts] = mockedFetch.mock.calls[0] as [unknown, { headers: Headers }];
    expect(opts.headers.get('Authorization')).toBe('Bearer vigente');
  });

  it('sin usuario de Firebase, sigue con el token guardado', async () => {
    localStorage.setItem('tint_token', 'guardado');
    startHostSession(fakeAuth(null));
    mockedFetch.mockResolvedValueOnce({ ok: true, status: 200, json: () => Promise.resolve({}) });
    await apiFetch('/rooms');
    const [, opts] = mockedFetch.mock.calls[0] as [unknown, { headers: Headers }];
    expect(opts.headers.get('Authorization')).toBe('Bearer guardado');
  });

  it('la función devuelta deja de escuchar y retira el proveedor', async () => {
    const unsubscribe = vi.fn();
    mockedOnIdTokenChanged.mockReturnValue(unsubscribe);
    localStorage.setItem('tint_token', 'guardado');
    const user = fakeUser('vigente');
    const stop = startHostSession(fakeAuth(user));
    stop();
    expect(unsubscribe).toHaveBeenCalled();
    mockedFetch.mockResolvedValueOnce({ ok: true, status: 200, json: () => Promise.resolve({}) });
    await apiFetch('/rooms');
    expect(user.getIdToken).not.toHaveBeenCalled();
  });
});

describe('syncAuthCookie', () => {
  it('establece y borra la cookie tint_token para navegación SSR', () => {
    syncAuthCookie('tok-abc');
    expect(document.cookie).toContain('tint_token=tok-abc');

    syncAuthCookie(null);
    expect(document.cookie).not.toContain('tint_token=tok-abc');
  });
});
