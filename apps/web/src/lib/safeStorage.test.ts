import { afterEach, describe, expect, it, vi } from 'vitest';
import { readStored, writeStored } from './safeStorage';

describe('safeStorage', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
  });

  it('lee y escribe en localStorage', () => {
    expect(readStored('k')).toBeNull();
    writeStored('k', 'v');
    expect(readStored('k')).toBe('v');
  });

  it('no falla si el almacenamiento lanza (modo privado, datos bloqueados)', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    expect(readStored('k')).toBeNull();
    expect(() => writeStored('k', 'v')).not.toThrow();
  });

  it('maneja entornos SSR donde localStorage no está definido', () => {
    const original = globalThis.localStorage;
    // @ts-expect-error simulación de SSR
    delete globalThis.localStorage;
    try {
      expect(readStored('test')).toBeNull();
      expect(() => writeStored('test', 'val')).not.toThrow();
    } finally {
      globalThis.localStorage = original;
    }
  });
});
