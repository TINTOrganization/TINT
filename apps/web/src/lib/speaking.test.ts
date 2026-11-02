import { describe, expect, it } from 'vitest';
import { createSpeakingTracker, energyLevel, rmsLevel, SPEAKING_HOLD_MS } from './speaking';

describe('rmsLevel', () => {
  it('silencio (128) es 0 y la señal máxima se acerca a 1', () => {
    expect(rmsLevel(new Uint8Array([128, 128, 128, 128]))).toBe(0);
    expect(rmsLevel(new Uint8Array([0, 255, 0, 255]))).toBeGreaterThan(0.98);
    expect(rmsLevel(new Uint8Array([]))).toBe(0);
  });
});

describe('createSpeakingTracker', () => {
  // HU-VOZ-03 AC1: resalta a quien habla.
  it('se enciende al superar el umbral', () => {
    const t = createSpeakingTracker();
    expect(t.update('a', 0.01, 0)).toBe(false);
    expect(t.update('a', 0.2, 100)).toBe(true);
    expect(t.speaking()).toEqual(new Set(['a']));
  });

  // HU-VOZ-03 AC2: se apaga en silencio, sin parpadear entre sílabas.
  it('se apaga tras SPEAKING_HOLD_MS de silencio', () => {
    const t = createSpeakingTracker();
    t.update('a', 0.2, 0);
    expect(t.update('a', 0.0, 100)).toBe(true);
    expect(t.update('a', 0.0, SPEAKING_HOLD_MS - 1)).toBe(true);
    expect(t.update('a', 0.0, SPEAKING_HOLD_MS + 1)).toBe(false);
  });

  it('histéresis: un nivel intermedio mantiene pero no enciende', () => {
    const t = createSpeakingTracker({ onLevel: 0.1, offLevel: 0.04 });
    expect(t.update('a', 0.06, 0)).toBe(false);
    t.update('a', 0.2, 10);
    expect(t.update('a', 0.06, 2000)).toBe(true);
  });

  // HU-VOZ-03 AC3: varias personas a la vez.
  it('lleva a varios por separado y olvida a quien sale', () => {
    const t = createSpeakingTracker();
    t.update('a', 0.2, 0);
    t.update('b', 0.3, 0);
    t.update('c', 0.0, 0);
    expect(t.speaking()).toEqual(new Set(['a', 'b']));
    t.remove('a');
    expect(t.speaking()).toEqual(new Set(['b']));
  });
});

describe('energyLevel (nivel de los demás desde getStats)', () => {
  it('es la raíz de la energía media del intervalo', () => {
    // 0,25 de energía en 1 s → potencia media 0,25 → nivel 0,5.
    expect(energyLevel({ energy: 1, duration: 10 }, { energy: 1.25, duration: 11 })).toBeCloseTo(0.5);
  });

  it('sin muestra previa, sin tiempo transcurrido o con contadores reiniciados da 0', () => {
    expect(energyLevel(undefined, { energy: 1, duration: 1 })).toBe(0);
    expect(energyLevel({ energy: 1, duration: 1 }, { energy: 1, duration: 1 })).toBe(0);
    expect(energyLevel({ energy: 5, duration: 9 }, { energy: 0.1, duration: 0.5 })).toBe(0);
  });
});
