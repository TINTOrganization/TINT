import { describe, expect, it } from 'vitest';
import { formatClockTime, formatDuration, formatNumber, heatLevel, HEAT_LEVELS, niceTicks } from './chartScale';

describe('niceTicks', () => {
  it('redondea el máximo a 1, 2 o 5 × 10^k y reparte ticks limpios desde 0', () => {
    expect(niceTicks(7)).toEqual([0, 2, 4, 6, 8]);
    expect(niceTicks(10)).toEqual([0, 5, 10]);
    expect(niceTicks(37)).toEqual([0, 10, 20, 30, 40]);
    expect(niceTicks(1_200)).toEqual([0, 500, 1_000, 1_500]);
    expect(niceTicks(3)).toEqual([0, 1, 2, 3]);
  });

  it('con máximo 0 o negativo devuelve [0, 1]', () => {
    expect(niceTicks(0)).toEqual([0, 1]);
    expect(niceTicks(-4)).toEqual([0, 1]);
  });

  it('nunca usa pasos fraccionarios para conteos', () => {
    expect(niceTicks(1)).toEqual([0, 1]);
    expect(niceTicks(2)).toEqual([0, 1, 2]);
  });
});

describe('formatNumber', () => {
  it('compacta desde 1.000 y limita decimales', () => {
    expect(formatNumber(0)).toBe('0');
    expect(formatNumber(12.345)).toBe('12,3');
    expect(formatNumber(999)).toBe('999');
    // Intl separa con espacio duro (U+00A0).
    expect(formatNumber(1_500).replace(/\s/g, ' ')).toBe('1,5 mil');
    expect(formatNumber(2.5, 2)).toBe('2,5');
  });
});

describe('formatClockTime', () => {
  it('muestra la hora local HH:MM de un ISO', () => {
    const iso = new Date(2026, 9, 11, 9, 5).toISOString();
    expect(formatClockTime(iso)).toBe('09:05');
  });

  it('devuelve el texto original si no es una fecha', () => {
    expect(formatClockTime('ayer')).toBe('ayer');
  });
});

describe('heatLevel', () => {
  it('0 para celdas vacías y 1..N proporcional al máximo', () => {
    expect(heatLevel(0, 10)).toBe(0);
    expect(heatLevel(1, 10)).toBe(1);
    expect(heatLevel(5, 10)).toBe(2);
    expect(heatLevel(7, 10)).toBe(3);
    expect(heatLevel(10, 10)).toBe(HEAT_LEVELS);
    expect(heatLevel(3, 0)).toBe(0);
  });
});

describe('formatDuration', () => {
  it('elige ms, segundos o minutos según la magnitud', () => {
    expect(formatDuration(0)).toBe('0 ms');
    expect(formatDuration(639.6)).toBe('640 ms');
    expect(formatDuration(2_904)).toBe('2,9 s');
    expect(formatDuration(1_529_943)).toBe('25,5 min');
  });
});
