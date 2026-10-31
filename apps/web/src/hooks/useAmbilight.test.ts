import { act, renderHook, waitFor } from '@testing-library/react';
import type { RefObject } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AMBILIGHT_SAMPLE_MS, useAmbilight } from './useAmbilight';

const FRAMES = [
  { t_ms: 0, top: '#000000', right: '#000000', bottom: '#000000', left: '#000000' },
  { t_ms: 1000, top: '#ffffff', right: '#ff0000', bottom: '#00ff00', left: '#0000ff' },
];

describe('useAmbilight', () => {
  let video: { currentTime: number };
  let videoRef: RefObject<HTMLVideoElement>;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    // Solo los intervalos: waitFor sigue usando los temporizadores reales.
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    video = { currentTime: 0 };
    videoRef = { current: video as unknown as HTMLVideoElement };
    fetchMock = vi.fn(() => Promise.resolve({ ok: true, json: () => Promise.resolve(FRAMES) }));
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  /** Siguiente muestreo (~4 Hz). */
  const runFrame = () => {
    act(() => vi.advanceTimersByTime(AMBILIGHT_SAMPLE_MS));
  };
  /** La paleta ya se descargó y hay un muestreo programado. */
  const sampling = () => vi.getTimerCount() > 0;

  it('sin URL no descarga ni da color', () => {
    const { result } = renderHook(() => useAmbilight(null, videoRef));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.current).toBeNull();
  });

  it('descarga la paleta y sigue el tiempo del vídeo interpolando', async () => {
    const { result } = renderHook(() => useAmbilight('https://blob/m1/ambilight.json?sig=1', videoRef));
    expect(fetchMock).toHaveBeenCalledWith('https://blob/m1/ambilight.json?sig=1', expect.objectContaining({ signal: expect.anything() }));
    await waitFor(() => expect(sampling()).toBe(true));
    // El primer color llega al instante, sin esperar al primer intervalo.
    expect(result.current).toEqual({ top: '#000000', right: '#000000', bottom: '#000000', left: '#000000' });
    video.currentTime = 0.5;
    runFrame();
    expect(result.current?.top).toBe('#808080');
  });

  it('muestrea a ~4 Hz (no en cada fotograma): la transición CSS de 700 ms suaviza', async () => {
    expect(AMBILIGHT_SAMPLE_MS).toBe(250);
    const { result } = renderHook(() => useAmbilight('https://blob/m1/ambilight.json', videoRef));
    await waitFor(() => expect(sampling()).toBe(true));
    video.currentTime = 0.5;
    act(() => vi.advanceTimersByTime(AMBILIGHT_SAMPLE_MS - 1));
    expect(result.current?.top).toBe('#000000');
    act(() => vi.advanceTimersByTime(1));
    expect(result.current?.top).toBe('#808080');
  });

  it('solo re-renderiza cuando cambia el color', async () => {
    let renders = 0;
    renderHook(() => {
      renders += 1;
      return useAmbilight('https://blob/m1/ambilight.json', videoRef);
    });
    await waitFor(() => expect(sampling()).toBe(true));
    runFrame();
    const after = renders;
    runFrame();
    runFrame();
    expect(renders).toBe(after);
  });

  it('sin interpolar salta de frame en frame', async () => {
    const { result } = renderHook(() => useAmbilight('https://blob/a.json', videoRef, { interpolate: false }));
    await waitFor(() => expect(sampling()).toBe(true));
    video.currentTime = 0.9;
    runFrame();
    expect(result.current?.top).toBe('#000000');
  });

  it('una URL refirmada del mismo vídeo no vuelve a descargar', async () => {
    const { rerender } = renderHook(({ url }) => useAmbilight(url, videoRef), {
      initialProps: { url: 'https://blob/m1/ambilight.json?sig=1' },
    });
    await waitFor(() => expect(sampling()).toBe(true));
    rerender({ url: 'https://blob/m1/ambilight.json?sig=2' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    rerender({ url: 'https://blob/m2/ambilight.json?sig=1' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
  });

  it('desactivado no da color ni anima', async () => {
    const { result, rerender } = renderHook(({ enabled }) => useAmbilight('https://blob/a.json', videoRef, { enabled }), {
      initialProps: { enabled: true },
    });
    await waitFor(() => expect(sampling()).toBe(true));
    runFrame();
    expect(result.current).not.toBeNull();
    rerender({ enabled: false });
    expect(result.current).toBeNull();
    expect(sampling()).toBe(false);
  });

  it('si la descarga falla no hay brillo', async () => {
    fetchMock.mockImplementation(() => Promise.resolve({ ok: false, json: () => Promise.resolve([]) }));
    const { result } = renderHook(() => useAmbilight('https://blob/a.json', videoRef));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(sampling()).toBe(false);
    expect(result.current).toBeNull();
  });

  it('sin vídeo montado espera sin fallar', async () => {
    const empty: RefObject<HTMLVideoElement> = { current: null };
    const { result } = renderHook(() => useAmbilight('https://blob/a.json', empty));
    await waitFor(() => expect(sampling()).toBe(true));
    runFrame();
    expect(result.current).toBeNull();
    expect(sampling()).toBe(true);
  });

  it('desmontar a mitad de la descarga la aborta', () => {
    const { unmount } = renderHook(() => useAmbilight('https://blob/a.json', videoRef));
    const signal = (fetchMock.mock.calls[0] as unknown as [string, { signal: AbortSignal }])[1].signal;
    unmount();
    expect(signal.aborted).toBe(true);
  });
});
