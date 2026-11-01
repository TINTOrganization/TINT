import { vi, beforeEach, afterEach, describe, it, expect } from 'vitest';
import {
  apiFetch,
  ApiError,
  loginRedirectPath,
  setHostSessionExpiredHandler,
  setHostTokenProvider,
} from './api';

const mockedFetch = vi.fn();
vi.stubGlobal('fetch', mockedFetch);

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
});

describe('apiFetch', () => {
  it('retorna el json si la respuesta es ok', async () => {
    mockedFetch.mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ a: 1 }) });
    await expect(apiFetch('/x')).resolves.toEqual({ a: 1 });
  });

  it('una respuesta 204 sin cuerpo devuelve null (p. ej. DELETE) sin intentar leer JSON', async () => {
    const json = vi.fn(() => Promise.reject(new SyntaxError('Unexpected end of JSON input')));
    mockedFetch.mockResolvedValueOnce({ ok: true, status: 204, json });
    await expect(apiFetch('/x', { method: 'DELETE' })).resolves.toBeNull();
    expect(json).not.toHaveBeenCalled();
  });

  it('el ApiError conserva el cuerpo de la respuesta (p. ej. maxUploadBytes del 413)', async () => {
    mockedFetch.mockResolvedValueOnce({
      ok: false,
      status: 413,
      json: () => Promise.resolve({ error: 'File too large', maxUploadBytes: 2_147_483_648 }),
    });
    const err = (await apiFetch('/x').catch((e: unknown) => e)) as ApiError;
    expect(err.status).toBe(413);
    expect(err.body).toEqual({ error: 'File too large', maxUploadBytes: 2_147_483_648 });
  });

  it('lanza ApiError con status y mensaje del backend si la respuesta falla', async () => {
    mockedFetch.mockResolvedValueOnce({
      ok: false,
      status: 401,
      json: () => Promise.resolve({ error: 'Unauthorized' }),
    });
    const err = await apiFetch('/x').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(401);
    expect((err as ApiError).message).toBe('Unauthorized');
  });

  it('envía el token de host en Authorization', async () => {
    localStorage.setItem('tint_token', 'tok-1');
    mockedFetch.mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({}) });
    await apiFetch('/rooms', { method: 'POST', body: JSON.stringify({}) });
    const [, opts] = mockedFetch.mock.calls[0] as [unknown, { headers: Headers }];
    expect(opts.headers.get('Authorization')).toBe('Bearer tok-1');
    expect(opts.headers.get('Content-Type')).toBe('application/json');
  });

  it('envía el guest token si no hay token de host', async () => {
    localStorage.setItem('tint_guest_token', 'guest-1');
    mockedFetch.mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({}) });
    await apiFetch('/rooms');
    const [, opts] = mockedFetch.mock.calls[0] as [unknown, { headers: Headers }];
    expect(opts.headers.get('Authorization')).toBe('Bearer guest-1');
  });

  it('auth "guest" fuerza el guest token aunque exista token de host', async () => {
    localStorage.setItem('tint_token', 'host-1');
    localStorage.setItem('tint_guest_token', 'guest-1');
    mockedFetch.mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({}) });
    await apiFetch('/rooms/r1/playback', { method: 'GET' }, 'guest');
    const [, opts] = mockedFetch.mock.calls[0] as [unknown, { headers: Headers }];
    expect(opts.headers.get('Authorization')).toBe('Bearer guest-1');
  });

  it('auth "host" usa solo el token de host', async () => {
    localStorage.setItem('tint_guest_token', 'guest-1');
    mockedFetch.mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({}) });
    await apiFetch('/rooms/r1/guests', {}, 'host');
    const [, opts] = mockedFetch.mock.calls[0] as [unknown, { headers: Headers }];
    expect(opts.headers.has('Authorization')).toBe(false);
  });
});

describe('apiFetch — sesión de host (token de Firebase)', () => {
  const ok = (body: unknown = {}) => ({ ok: true, status: 200, json: () => Promise.resolve(body) });
  const unauthorized = () => ({ ok: false, status: 401, json: () => Promise.resolve({ error: 'Unauthorized' }) });
  const authOf = (call: number) =>
    (mockedFetch.mock.calls[call] as [unknown, { headers: Headers }])[1].headers.get('Authorization');

  afterEach(() => {
    setHostTokenProvider(null);
    setHostSessionExpiredHandler(null);
    window.history.replaceState(null, '', '/');
  });

  it('pide al proveedor un token vigente y lo guarda antes de la petición', async () => {
    localStorage.setItem('tint_token', 'viejo');
    const provider = vi.fn().mockResolvedValue('fresco');
    setHostTokenProvider(provider);
    mockedFetch.mockResolvedValueOnce(ok());
    await apiFetch('/rooms');
    expect(provider).toHaveBeenCalledWith(false);
    expect(authOf(0)).toBe('Bearer fresco');
    expect(localStorage.getItem('tint_token')).toBe('fresco');
  });

  it('si el proveedor falla o no hay usuario, usa el token guardado', async () => {
    localStorage.setItem('tint_token', 'guardado');
    setHostTokenProvider(vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce(null));
    mockedFetch.mockResolvedValue(ok());
    await apiFetch('/rooms');
    await apiFetch('/rooms');
    expect(authOf(0)).toBe('Bearer guardado');
    expect(authOf(1)).toBe('Bearer guardado');
  });

  it('no consulta al proveedor sin sesión de host (p. ej. tras cerrar sesión)', async () => {
    const provider = vi.fn().mockResolvedValue('revivido');
    setHostTokenProvider(provider);
    mockedFetch.mockResolvedValueOnce(ok());
    await apiFetch('/rooms');
    expect(provider).not.toHaveBeenCalled();
    expect(localStorage.getItem('tint_token')).toBeNull();
  });

  it('ante un 401 fuerza el refresco y reintenta una vez con el token nuevo', async () => {
    localStorage.setItem('tint_token', 'vencido');
    const provider = vi.fn(async (force: boolean) => (force ? 'renovado' : 'vencido'));
    setHostTokenProvider(provider);
    const expired = vi.fn();
    setHostSessionExpiredHandler(expired);
    mockedFetch.mockResolvedValueOnce(unauthorized()).mockResolvedValueOnce(ok({ a: 1 }));
    await expect(apiFetch('/rooms')).resolves.toEqual({ a: 1 });
    expect(provider).toHaveBeenLastCalledWith(true);
    expect(authOf(1)).toBe('Bearer renovado');
    expect(localStorage.getItem('tint_token')).toBe('renovado');
    expect(expired).not.toHaveBeenCalled();
  });

  it('si sigue en 401 tras refrescar, borra la sesión de host y avisa', async () => {
    localStorage.setItem('tint_token', 'vencido');
    setHostTokenProvider(vi.fn(async (force: boolean) => (force ? 'renovado' : 'vencido')));
    const expired = vi.fn();
    setHostSessionExpiredHandler(expired);
    mockedFetch.mockResolvedValue(unauthorized());
    const err = await apiFetch('/rooms').catch((e: unknown) => e);
    expect((err as ApiError).status).toBe(401);
    expect(localStorage.getItem('tint_token')).toBeNull();
    expect(expired).toHaveBeenCalledTimes(1);
  });

  it('sin proveedor, un 401 del host también cierra la sesión sin reintentar', async () => {
    localStorage.setItem('tint_token', 'vencido');
    const expired = vi.fn();
    setHostSessionExpiredHandler(expired);
    mockedFetch.mockResolvedValueOnce(unauthorized());
    await expect(apiFetch('/rooms')).rejects.toBeInstanceOf(ApiError);
    expect(mockedFetch).toHaveBeenCalledTimes(1);
    expect(expired).toHaveBeenCalledTimes(1);
  });

  it('un 401 con credencial de invitado no toca la sesión de host', async () => {
    localStorage.setItem('tint_token', 'host');
    localStorage.setItem('tint_guest_token', 'guest');
    const expired = vi.fn();
    setHostSessionExpiredHandler(expired);
    mockedFetch.mockResolvedValueOnce(unauthorized());
    await expect(apiFetch('/rooms/r1/playback', {}, 'guest')).rejects.toBeInstanceOf(ApiError);
    expect(localStorage.getItem('tint_token')).toBe('host');
    expect(expired).not.toHaveBeenCalled();
  });

  it('por defecto lleva a /login?next=<ruta actual> sin recargar la página', async () => {
    window.history.replaceState(null, '', '/watch/r1?x=1');
    const popstate = vi.fn();
    window.addEventListener('popstate', popstate);
    localStorage.setItem('tint_token', 'vencido');
    mockedFetch.mockResolvedValueOnce(unauthorized());
    await apiFetch('/rooms').catch(() => null);
    window.removeEventListener('popstate', popstate);
    expect(window.location.pathname).toBe('/login');
    expect(new URLSearchParams(window.location.search).get('next')).toBe('/watch/r1?x=1');
    expect(popstate).toHaveBeenCalled();
  });

  it('no redirige si ya está en /login (p. ej. verificación fallida)', async () => {
    window.history.replaceState(null, '', '/login?next=%2Fdashboard');
    localStorage.setItem('tint_token', 'vencido');
    mockedFetch.mockResolvedValueOnce(unauthorized());
    await apiFetch('/auth/verify').catch(() => null);
    expect(window.location.search).toBe('?next=%2Fdashboard');
  });
});

describe('loginRedirectPath', () => {
  it('codifica la ruta de retorno', () => {
    expect(loginRedirectPath('/watch/r1', '?a=b')).toBe('/login?next=%2Fwatch%2Fr1%3Fa%3Db');
  });
});
