import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useSpeaking } from './useSpeaking';
import { SPEAKING_HOLD_MS, SPEAKING_SAMPLE_MS } from '../lib/speaking';

/** Nivel simulado (amplitud 0..127 alrededor de 128) por stream. */
const amplitude = new Map<unknown, number>();

class FakeAudioContext {
  static instances: FakeAudioContext[] = [];
  state = 'running';
  closed = false;
  disconnected = 0;
  constructor() {
    FakeAudioContext.instances.push(this);
  }
  createMediaStreamSource(stream: unknown) {
    return {
      connect: (analyser: { stream?: unknown }) => {
        analyser.stream = stream;
      },
      disconnect: () => {
        this.disconnected += 1;
      },
    };
  }
  createAnalyser() {
    const analyser = {
      fftSize: 0,
      stream: undefined as unknown,
      getByteTimeDomainData(buf: Uint8Array) {
        const a = amplitude.get(analyser.stream) ?? 0;
        for (let i = 0; i < buf.length; i += 1) buf[i] = i % 2 === 0 ? 128 + a : 128 - a;
      },
    };
    return analyser;
  }
  resume() {
    return Promise.resolve();
  }
  close() {
    this.closed = true;
    return Promise.resolve();
  }
}

const create = () => new FakeAudioContext() as unknown as AudioContext;
const s1 = {} as MediaStream;
const s2 = {} as MediaStream;

beforeEach(() => {
  vi.useFakeTimers();
  FakeAudioContext.instances = [];
  amplitude.clear();
});
afterEach(() => vi.useRealTimers());

describe('useSpeaking (HU-VOZ-03)', () => {
  it('sin streams no crea AudioContext', () => {
    const { result } = renderHook(() => useSpeaking({}, { createAudioContext: create }));
    expect(result.current.size).toBe(0);
    expect(FakeAudioContext.instances).toHaveLength(0);
  });

  it('resalta a quien habla y lo apaga tras el silencio', () => {
    amplitude.set(s1, 60);
    const { result } = renderHook(() => useSpeaking({ a: s1, b: s2 }, { createAudioContext: create }));
    act(() => {
      vi.advanceTimersByTime(SPEAKING_SAMPLE_MS);
    });
    expect([...result.current]).toEqual(['a']);

    amplitude.set(s1, 0);
    amplitude.set(s2, 60);
    act(() => {
      vi.advanceTimersByTime(SPEAKING_SAMPLE_MS);
    });
    expect(result.current).toEqual(new Set(['a', 'b'])); // a sigue durante la retención
    act(() => {
      vi.advanceTimersByTime(SPEAKING_HOLD_MS + SPEAKING_SAMPLE_MS);
    });
    expect(result.current).toEqual(new Set(['b']));
  });

  it('suelta los streams que ya no están y cierra el contexto al desmontar', () => {
    amplitude.set(s1, 60);
    const { result, rerender, unmount } = renderHook(
      ({ streams }) => useSpeaking(streams, { createAudioContext: create }),
      { initialProps: { streams: { a: s1 } as Record<string, MediaStream> } },
    );
    act(() => {
      vi.advanceTimersByTime(SPEAKING_SAMPLE_MS);
    });
    expect(result.current.has('a')).toBe(true);
    rerender({ streams: {} });
    act(() => {
      vi.advanceTimersByTime(SPEAKING_SAMPLE_MS);
    });
    expect(result.current.size).toBe(0);
    expect(FakeAudioContext.instances[0].disconnected).toBe(1);
    unmount();
    expect(FakeAudioContext.instances[0].closed).toBe(true);
  });

  it('sin Web Audio no resalta a nadie', () => {
    const { result } = renderHook(() => useSpeaking({ a: s1 }, { createAudioContext: () => null }));
    act(() => {
      vi.advanceTimersByTime(SPEAKING_SAMPLE_MS * 3);
    });
    expect(result.current.size).toBe(0);
  });
});

describe('useSpeaking — los demás, por energía de getStats', () => {
  it('resalta a quien sube la energía recibida y lo olvida cuando deja de aparecer', async () => {
    let energy = 0;
    let samples: Record<string, { energy: number; duration: number }> = {};
    let t = 0;
    const sampleRemote = vi.fn(async () => {
      t += SPEAKING_SAMPLE_MS / 1000;
      return Object.fromEntries(Object.keys(samples).map((id) => [id, { energy, duration: t }]));
    });
    samples = { r: { energy: 0, duration: 0 } };
    const { result, rerender } = renderHook(
      ({ sampler }) => useSpeaking({}, { createAudioContext: create, sampleRemote: sampler }),
      { initialProps: { sampler: sampleRemote as typeof sampleRemote | undefined } },
    );
    expect(FakeAudioContext.instances).toHaveLength(0); // sin pista local no hace falta Web Audio
    await act(async () => {
      await vi.advanceTimersByTimeAsync(SPEAKING_SAMPLE_MS);
    });
    expect(result.current.size).toBe(0); // la primera lectura solo fija la base
    energy = 0.04; // 0,04 en 0,15 s → nivel ≈ 0,52
    await act(async () => {
      await vi.advanceTimersByTimeAsync(SPEAKING_SAMPLE_MS);
    });
    expect([...result.current]).toEqual(['r']);

    samples = {};
    await act(async () => {
      await vi.advanceTimersByTimeAsync(SPEAKING_SAMPLE_MS);
    });
    expect(result.current.size).toBe(0);

    // Sin muestreador ni streams se detiene el intervalo.
    rerender({ sampler: undefined });
    const calls = sampleRemote.mock.calls.length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(SPEAKING_SAMPLE_MS * 5);
    });
    expect(sampleRemote.mock.calls.length).toBe(calls);
  });

  it('un muestreo que falla no rompe nada', async () => {
    const sampleRemote = vi.fn(async () => {
      throw new Error('sin stats');
    });
    const { result } = renderHook(() => useSpeaking({}, { sampleRemote }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(SPEAKING_SAMPLE_MS * 2);
    });
    expect(result.current.size).toBe(0);
    expect(sampleRemote).toHaveBeenCalled();
  });
});
