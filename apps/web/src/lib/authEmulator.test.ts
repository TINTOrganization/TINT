import { describe, it, expect, vi } from 'vitest';
import type { Auth } from 'firebase/auth';
import { connectToAuthEmulator, resolveAuthEmulatorUrl } from './authEmulator';

describe('resolveAuthEmulatorUrl', () => {
  it('sin valor (o en blanco) no hay emulador', () => {
    expect(resolveAuthEmulatorUrl(undefined)).toBeNull();
    expect(resolveAuthEmulatorUrl('')).toBeNull();
    expect(resolveAuthEmulatorUrl('   ')).toBeNull();
  });

  it('acepta un origen http(s) y quita la barra final', () => {
    expect(resolveAuthEmulatorUrl('http://localhost:9099')).toBe('http://localhost:9099');
    expect(resolveAuthEmulatorUrl(' http://127.0.0.1:9099/ ')).toBe('http://127.0.0.1:9099');
    expect(resolveAuthEmulatorUrl('https://emu.local')).toBe('https://emu.local');
  });

  it('rechaza esquemas que no son http(s) y URLs inválidas', () => {
    expect(resolveAuthEmulatorUrl('localhost:9099')).toBeNull();
    expect(resolveAuthEmulatorUrl('javascript:alert(1)')).toBeNull();
    expect(resolveAuthEmulatorUrl('ftp://localhost:9099')).toBeNull();
    expect(resolveAuthEmulatorUrl('no es una url')).toBeNull();
  });
});

describe('connectToAuthEmulator', () => {
  const auth = {} as Auth;

  it('conecta el SDK al emulador sin el banner de advertencia', () => {
    const connect = vi.fn();
    expect(connectToAuthEmulator(auth, 'http://localhost:9099/', connect)).toBe(true);
    expect(connect).toHaveBeenCalledWith(auth, 'http://localhost:9099', { disableWarnings: true });
  });

  it('sin URL válida no toca el SDK (Firebase real)', () => {
    const connect = vi.fn();
    expect(connectToAuthEmulator(auth, undefined, connect)).toBe(false);
    expect(connectToAuthEmulator(auth, 'localhost:9099', connect)).toBe(false);
    expect(connect).not.toHaveBeenCalled();
  });
});
