import {
  applyCorrection,
  computeDrift,
  correctionAction,
  DRIFT_THRESHOLD_MS,
  RATE_AHEAD,
  RATE_BEHIND,
  RATE_MAX_DURATION_MS,
  shouldResync,
  shouldRestoreRate,
  shouldSkipSeekCorrection,
} from './drift';

describe('correctionAction', () => {
  it('seek → posiciona en target_ms en segundos', () => {
    expect(correctionAction({ target_ms: 12_500, strategy: 'seek', drift_ms: 900 })).toEqual({
      kind: 'seek',
      seconds: 12.5,
    });
  });

  it('rate con drift negativo (atrasado) → acelera', () => {
    expect(correctionAction({ target_ms: 0, strategy: 'rate', drift_ms: -200 })).toEqual({
      kind: 'rate',
      playbackRate: RATE_BEHIND,
    });
    expect(RATE_BEHIND).toBe(1.05);
  });

  it('rate con drift positivo (adelantado) → frena', () => {
    expect(correctionAction({ target_ms: 0, strategy: 'rate', drift_ms: 200 })).toEqual({
      kind: 'rate',
      playbackRate: RATE_AHEAD,
    });
    expect(RATE_AHEAD).toBe(0.95);
  });

  it('rate con drift cero → velocidad normal', () => {
    expect(correctionAction({ target_ms: 0, strategy: 'rate', drift_ms: 0 })).toEqual({
      kind: 'rate',
      playbackRate: 1,
    });
  });
});

describe('correctionAction relativa a la velocidad de la sala', () => {
  it('a 2× acelera a 2.1 y frena a 1.9 (no a 1.05/0.95 absolutos)', () => {
    expect(correctionAction({ target_ms: 0, strategy: 'rate', drift_ms: -300 }, 2)).toEqual({
      kind: 'rate',
      playbackRate: 2 * RATE_BEHIND,
    });
    expect(correctionAction({ target_ms: 0, strategy: 'rate', drift_ms: 300 }, 2)).toEqual({
      kind: 'rate',
      playbackRate: 2 * RATE_AHEAD,
    });
  });

  it('sin deriva vuelve a la velocidad de la sala', () => {
    expect(correctionAction({ target_ms: 0, strategy: 'rate', drift_ms: 0 }, 0.5)).toEqual({
      kind: 'rate',
      playbackRate: 0.5,
    });
  });

  it('una velocidad de sala inválida cae a 1×', () => {
    expect(correctionAction({ target_ms: 0, strategy: 'rate', drift_ms: -300 }, Number.NaN)).toEqual({
      kind: 'rate',
      playbackRate: RATE_BEHIND,
    });
    expect(correctionAction({ target_ms: 0, strategy: 'rate', drift_ms: -300 }, 0)).toEqual({
      kind: 'rate',
      playbackRate: RATE_BEHIND,
    });
  });
});

describe('shouldSkipSeekCorrection', () => {
  const base = { readyState: 4, paused: false, ended: false, duration: 600, currentTime: 10 };

  it('aplica el seek en condiciones normales', () => {
    expect(shouldSkipSeekCorrection(base, 20_000, false)).toBe(false);
  });

  it('lo omite mientras el vídeo reproduce sin datos suficientes (buffering)', () => {
    expect(shouldSkipSeekCorrection({ ...base, readyState: 2 }, 20_000, false)).toBe(true);
    // En pausa no hay buffering que interrumpir: se alinea.
    expect(shouldSkipSeekCorrection({ ...base, readyState: 2, paused: true }, 20_000, false)).toBe(false);
  });

  it('lo omite si el autoplay está bloqueado (se espera el gesto)', () => {
    expect(shouldSkipSeekCorrection({ ...base, paused: true }, 20_000, true)).toBe(true);
  });

  it('lo omite si el vídeo terminó y el objetivo está en o tras el final', () => {
    expect(shouldSkipSeekCorrection({ ...base, ended: true, currentTime: 600 }, 600_500, false)).toBe(true);
    expect(shouldSkipSeekCorrection({ ...base, ended: true, currentTime: 600 }, 30_000, false)).toBe(false);
    expect(shouldSkipSeekCorrection({ ...base, ended: true, duration: Number.NaN }, 600_500, false)).toBe(false);
  });

  it('lo omite si el vídeo ya está en el objetivo (p. ej. tras reconciliar el estado)', () => {
    expect(shouldSkipSeekCorrection({ ...base, currentTime: 20.1 }, 20_000, false)).toBe(true);
  });
});

describe('applyCorrection', () => {
  it('rate relativo a la sala', () => {
    const video = { currentTime: 5, playbackRate: 1.5 };
    applyCorrection(video, { target_ms: 0, strategy: 'rate', drift_ms: 400 }, 1.5);
    expect(video.playbackRate).toBeCloseTo(1.425);
  });

  it('aplica seek sobre el elemento de vídeo', () => {
    const video = { currentTime: 0, playbackRate: 1 };
    const action = applyCorrection(video, { target_ms: 3_000, strategy: 'seek', drift_ms: 700 });
    expect(action.kind).toBe('seek');
    expect(video.currentTime).toBe(3);
    expect(video.playbackRate).toBe(1);
  });

  it('aplica rate sobre el elemento de vídeo', () => {
    const video = { currentTime: 5, playbackRate: 1 };
    applyCorrection(video, { target_ms: 0, strategy: 'rate', drift_ms: -150 });
    expect(video.playbackRate).toBe(1.05);
    expect(video.currentTime).toBe(5);
  });
});

describe('shouldRestoreRate', () => {
  it('restaura cuando el desfase baja de 100 ms', () => {
    expect(shouldRestoreRate(10_050, 10_000, 1_000)).toBe(true);
    expect(shouldRestoreRate(9_901, 10_000, 1_000)).toBe(true);
  });

  it('mantiene la corrección si sigue desfasado', () => {
    expect(shouldRestoreRate(10_200, 10_000, 1_000)).toBe(false);
  });

  it('restaura siempre tras el tiempo máximo', () => {
    expect(shouldRestoreRate(20_000, 10_000, RATE_MAX_DURATION_MS)).toBe(true);
  });

  it('sin posición esperada solo restaura por tiempo', () => {
    expect(shouldRestoreRate(10_000, null, 1_000)).toBe(false);
    expect(shouldRestoreRate(10_000, null, RATE_MAX_DURATION_MS + 1)).toBe(true);
  });
});

describe('computeDrift', () => {
  it('compensa el tiempo transcurrido cuando está reproduciendo', () => {
    expect(computeDrift(10_300, 10_000, 1_000, 1_200, true)).toBe(100);
  });

  it('ignora el tiempo transcurrido cuando está en pausa', () => {
    expect(computeDrift(10_300, 10_000, 1_000, 1_200, false)).toBe(300);
  });

  it('no usa tiempo negativo si el reloj local va atrasado', () => {
    expect(computeDrift(10_000, 10_000, 2_000, 1_000, true)).toBe(0);
  });
});

describe('shouldResync', () => {
  it.each([
    [0, false],
    [DRIFT_THRESHOLD_MS, false],
    [DRIFT_THRESHOLD_MS + 1, true],
    [-(DRIFT_THRESHOLD_MS + 1), true],
  ])('drift %i ms → %s', (drift, expected) => {
    expect(shouldResync(drift)).toBe(expected);
  });
});
