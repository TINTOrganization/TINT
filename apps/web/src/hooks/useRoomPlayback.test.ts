import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { apiFetch } from '../lib/api';
import {
  PLAYBACK_PROCESSING_POLL_MS,
  PLAYBACK_RECOVER_COOLDOWN_MS,
  useRoomPlayback,
  type UseRoomPlaybackOptions,
} from './useRoomPlayback';

vi.mock('../lib/api', () => ({ apiFetch: vi.fn() }));
const mockedApiFetch = vi.mocked(apiFetch);

const NOW = new Date('2026-01-01T00:00:00.000Z').getTime();
const iso = (ms: number) => new Date(ms).toISOString();

function playback(mediaId: string | null, url: string | null, expiresInMs = 15 * 60_000) {
  return { mediaId, url, expiresAt: url ? iso(Date.now() + expiresInMs) : null };
}

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

interface Props {
  roomId: string;
  mediaId: string | undefined;
  opts?: UseRoomPlaybackOptions;
}

function setup(initial: Props) {
  return renderHook((p: Props) => useRoomPlayback(p.roomId, p.mediaId, p.opts), { initialProps: initial });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  mockedApiFetch.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('useRoomPlayback', () => {
  it('pide la URL firmada al montar con el token del rol', async () => {
    mockedApiFetch.mockResolvedValue(playback('m1', 'https://minio/m1?sig=1'));
    const { result } = setup({ roomId: 'r 1', mediaId: undefined, opts: { role: 'guest' } });
    expect(result.current.loading).toBe(true);
    await flush();
    expect(mockedApiFetch).toHaveBeenCalledWith('/rooms/r%201/playback', { method: 'GET' }, 'guest');
    expect(result.current).toMatchObject({
      url: 'https://minio/m1?sig=1',
      mediaId: 'm1',
      loading: false,
      error: null,
    });
  });

  it('el host usa su token por defecto', async () => {
    mockedApiFetch.mockResolvedValue(playback(null, null));
    const { result } = setup({ roomId: 'r1', mediaId: undefined });
    await flush();
    expect(mockedApiFetch).toHaveBeenCalledWith('/rooms/r1/playback', { method: 'GET' }, 'host');
    expect(result.current).toMatchObject({ url: null, mediaId: null, expiresAt: null, loading: false });
  });

  it('tolera respuestas sin campos (identity-api antigua)', async () => {
    mockedApiFetch.mockResolvedValue({});
    const { result } = setup({ roomId: 'r1', mediaId: undefined });
    await flush();
    expect(result.current).toMatchObject({ url: null, mediaId: null });
  });

  it('vuelve a pedir solo cuando cambia el media_id del estado sync', async () => {
    mockedApiFetch.mockResolvedValue(playback('m1', 'https://minio/m1'));
    const { result, rerender } = setup({ roomId: 'r1', mediaId: undefined });
    await flush();
    rerender({ roomId: 'r1', mediaId: 'm1' });
    await flush();
    expect(mockedApiFetch).toHaveBeenCalledTimes(1);

    mockedApiFetch.mockResolvedValue(playback('m2', 'https://minio/m2'));
    rerender({ roomId: 'r1', mediaId: 'm2' });
    await flush();
    expect(mockedApiFetch).toHaveBeenCalledTimes(2);
    expect(result.current.url).toBe('https://minio/m2');

    rerender({ roomId: 'r1', mediaId: undefined });
    await flush();
    expect(mockedApiFetch).toHaveBeenCalledTimes(2);
  });

  it('"" (sala sin vídeo) equivale a mediaId null', async () => {
    mockedApiFetch.mockResolvedValue(playback(null, null));
    const { rerender } = setup({ roomId: 'r1', mediaId: undefined });
    await flush();
    rerender({ roomId: 'r1', mediaId: '' });
    await flush();
    expect(mockedApiFetch).toHaveBeenCalledTimes(1);
  });

  it('descarta respuestas viejas si el vídeo cambió en vuelo', async () => {
    let resolveFirst!: (v: unknown) => void;
    mockedApiFetch
      .mockReturnValueOnce(new Promise((r) => (resolveFirst = r)))
      .mockResolvedValueOnce(playback('m2', 'https://minio/m2'));
    const { result, rerender } = setup({ roomId: 'r1', mediaId: undefined });
    rerender({ roomId: 'r1', mediaId: 'm2' });
    await flush();
    resolveFirst(playback('m1', 'https://minio/m1'));
    await flush();
    expect(result.current.url).toBe('https://minio/m2');
  });

  it('refresca la URL un minuto antes de que expire sin cambiar el src en reproducción', async () => {
    mockedApiFetch.mockResolvedValue(playback('m1', 'https://minio/m1?sig=1', 5 * 60_000));
    const { result } = setup({ roomId: 'r1', mediaId: 'm1' });
    await flush();
    mockedApiFetch.mockResolvedValue(playback('m1', 'https://minio/m1?sig=2', 5 * 60_000));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(4 * 60_000 - 1);
    });
    expect(mockedApiFetch).toHaveBeenCalledTimes(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(mockedApiFetch).toHaveBeenCalledTimes(2);
    // Cambiar el src recargaría el vídeo (fotograma negro): se guarda la URL nueva aparte.
    expect(result.current.url).toBe('https://minio/m1?sig=1');
    expect(result.current.loading).toBe(false);
  });

  it('recover() adopta la URL refrescada sin volver a pedirla', async () => {
    mockedApiFetch.mockResolvedValue({
      ...playback('m1', 'https://minio/m1?sig=1', 5 * 60_000),
      qualities: [{ id: '720p', label: '720p', url: 'https://minio/m1/720p?sig=1' }],
    });
    const { result } = setup({ roomId: 'r1', mediaId: 'm1' });
    await flush();
    mockedApiFetch.mockResolvedValue({
      ...playback('m1', 'https://minio/m1?sig=2', 5 * 60_000),
      qualities: [{ id: '720p', label: '720p', url: 'https://minio/m1/720p?sig=2' }],
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(4 * 60_000);
    });
    act(() => result.current.recover());
    await flush();
    expect(mockedApiFetch).toHaveBeenCalledTimes(2);
    expect(result.current.url).toBe('https://minio/m1?sig=2');
    expect(result.current.qualities).toEqual([
      { id: '720p', label: '720p', url: 'https://minio/m1/720p?sig=2' },
      { id: 'source', label: 'Original', url: 'https://minio/m1?sig=2' },
    ]);
  });

  it('el siguiente refresco se programa con la caducidad de la URL refrescada', async () => {
    mockedApiFetch.mockResolvedValue(playback('m1', 'https://minio/m1?sig=1', 5 * 60_000));
    setup({ roomId: 'r1', mediaId: 'm1' });
    await flush();
    mockedApiFetch.mockResolvedValue(playback('m1', 'https://minio/m1?sig=2', 10 * 60_000));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(4 * 60_000);
    });
    expect(mockedApiFetch).toHaveBeenCalledTimes(2);
    // La URL refrescada caduca a los 10 min (absolutos): siguiente refresco a los 9 min.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5 * 60_000 - 1);
    });
    expect(mockedApiFetch).toHaveBeenCalledTimes(2);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(mockedApiFetch).toHaveBeenCalledTimes(3);
  });

  it('recover() sin URL refrescada la pide y la adopta; no repite antes del enfriamiento', async () => {
    mockedApiFetch.mockResolvedValue(playback('m1', 'https://minio/m1?sig=1', 60 * 60_000));
    const { result } = setup({ roomId: 'r1', mediaId: 'm1' });
    await flush();
    mockedApiFetch.mockResolvedValue(playback('m1', 'https://minio/m1?sig=2', 60 * 60_000));
    act(() => result.current.recover());
    await flush();
    expect(mockedApiFetch).toHaveBeenCalledTimes(2);
    expect(result.current.url).toBe('https://minio/m1?sig=2');
    // Un archivo dañado fallaría siempre: no se entra en un bucle de peticiones.
    act(() => result.current.recover());
    await flush();
    expect(mockedApiFetch).toHaveBeenCalledTimes(2);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(PLAYBACK_RECOVER_COOLDOWN_MS);
    });
    act(() => result.current.recover());
    await flush();
    expect(mockedApiFetch).toHaveBeenCalledTimes(3);
  });

  it('adoptFresh() sin URL refrescada no hace nada', async () => {
    mockedApiFetch.mockResolvedValue(playback('m1', 'https://minio/m1?sig=1'));
    const { result } = setup({ roomId: 'r1', mediaId: 'm1' });
    await flush();
    act(() => result.current.adoptFresh());
    await flush();
    expect(mockedApiFetch).toHaveBeenCalledTimes(1);
    expect(result.current.url).toBe('https://minio/m1?sig=1');
  });

  it('si el refresco trae otro vídeo lo adopta entero', async () => {
    mockedApiFetch.mockResolvedValue(playback('m1', 'https://minio/m1?sig=1', 2 * 60_000));
    const { result } = setup({ roomId: 'r1', mediaId: undefined });
    await flush();
    mockedApiFetch.mockResolvedValue(playback('m2', 'https://minio/m2?sig=1'));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(result.current).toMatchObject({ mediaId: 'm2', url: 'https://minio/m2?sig=1' });
  });

  it('al pasar a ready, recover() adopta las URLs publicadas por el worker', async () => {
    mockedApiFetch
      .mockResolvedValueOnce({ ...playback('m1', 'https://minio/incoming/m1/original.mp4?sig=1'), status: 'processing' })
      .mockResolvedValueOnce({ ...playback('m1', 'https://minio/m1/source.mp4?sig=1'), status: 'ready', ambilightUrl: 'https://a' });
    const { result } = setup({ roomId: 'r1', mediaId: 'm1' });
    await flush();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(PLAYBACK_PROCESSING_POLL_MS);
    });
    expect(result.current.url).toBe('https://minio/incoming/m1/original.mp4?sig=1');
    act(() => result.current.recover());
    await flush();
    expect(mockedApiFetch).toHaveBeenCalledTimes(2);
    expect(result.current).toMatchObject({ url: 'https://minio/m1/source.mp4?sig=1', status: 'ready', ambilightUrl: 'https://a' });
  });

  it('espera un mínimo antes de refrescar URLs casi vencidas', async () => {
    mockedApiFetch.mockResolvedValue(playback('m1', 'https://minio/m1', 10_000));
    setup({ roomId: 'r1', mediaId: 'm1' });
    await flush();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(4_999);
    });
    expect(mockedApiFetch).toHaveBeenCalledTimes(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(mockedApiFetch).toHaveBeenCalledTimes(2);
  });

  it('ignora expiresAt inválido', async () => {
    mockedApiFetch.mockResolvedValue({ mediaId: 'm1', url: 'u', expiresAt: 'no-es-fecha' });
    setup({ roomId: 'r1', mediaId: 'm1' });
    await flush();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60 * 60_000);
    });
    expect(mockedApiFetch).toHaveBeenCalledTimes(1);
  });

  it('expone el error y conserva la última URL válida', async () => {
    mockedApiFetch.mockResolvedValueOnce(playback('m1', 'https://minio/m1', 2 * 60_000));
    mockedApiFetch.mockRejectedValueOnce(new Error('500'));
    const { result } = setup({ roomId: 'r1', mediaId: 'm1' });
    await flush();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(result.current.error).toMatch(/no se pudo cargar/i);
    expect(result.current.loading).toBe(false);
    expect(result.current.url).toBe('https://minio/m1');
  });

  it('limpia el temporizador al desmontar', async () => {
    mockedApiFetch.mockResolvedValue(playback('m1', 'https://minio/m1', 2 * 60_000));
    const { unmount } = setup({ roomId: 'r1', mediaId: 'm1' });
    await flush();
    unmount();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10 * 60_000);
    });
    expect(mockedApiFetch).toHaveBeenCalledTimes(1);
  });

  it('enabled=false no pide nada', async () => {
    const { result } = setup({ roomId: 'r1', mediaId: 'm1', opts: { enabled: false } });
    await flush();
    expect(mockedApiFetch).not.toHaveBeenCalled();
    expect(result.current.loading).toBe(false);
  });

  it('expone status y ambilightUrl (null si identity-api no los envía)', async () => {
    mockedApiFetch.mockResolvedValueOnce(playback('m1', 'u'));
    const { result } = setup({ roomId: 'r1', mediaId: 'm1' });
    expect(result.current).toMatchObject({ status: null, ambilightUrl: null });
    await flush();
    expect(result.current).toMatchObject({ status: null, ambilightUrl: null });
  });

  it('normaliza status desconocidos a null', async () => {
    mockedApiFetch.mockResolvedValueOnce({ ...playback('m1', 'u'), status: 'raro' });
    const { result } = setup({ roomId: 'r1', mediaId: 'm1' });
    await flush();
    expect(result.current.status).toBeNull();
  });

  it('con vídeo ready expone la URL de ambilight y no re-consulta', async () => {
    mockedApiFetch.mockResolvedValue({ ...playback('m1', 'u'), status: 'ready', ambilightUrl: 'https://minio/m1/ambilight.json' });
    const { result } = setup({ roomId: 'r1', mediaId: 'm1' });
    await flush();
    expect(result.current).toMatchObject({ status: 'ready', ambilightUrl: 'https://minio/m1/ambilight.json' });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(PLAYBACK_PROCESSING_POLL_MS * 3);
    });
    expect(mockedApiFetch).toHaveBeenCalledTimes(1);
  });

  it('mientras se procesa re-consulta cada ~5 s sin cambiar la URL del vídeo', async () => {
    mockedApiFetch
      .mockResolvedValueOnce({ ...playback('m1', 'https://minio/m1?sig=1'), status: 'pending', ambilightUrl: null })
      .mockResolvedValueOnce({ ...playback('m1', 'https://minio/m1?sig=2'), status: 'processing', ambilightUrl: null })
      .mockResolvedValueOnce({ ...playback('m1', 'https://minio/m1?sig=3'), status: 'ready', ambilightUrl: 'https://a' });
    const { result } = setup({ roomId: 'r1', mediaId: 'm1' });
    await flush();
    expect(result.current).toMatchObject({ status: 'pending', url: 'https://minio/m1?sig=1' });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(PLAYBACK_PROCESSING_POLL_MS - 1);
    });
    expect(mockedApiFetch).toHaveBeenCalledTimes(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(mockedApiFetch).toHaveBeenCalledTimes(2);
    expect(result.current).toMatchObject({ status: 'processing', url: 'https://minio/m1?sig=1', loading: false });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(PLAYBACK_PROCESSING_POLL_MS);
    });
    expect(result.current).toMatchObject({ status: 'ready', ambilightUrl: 'https://a', url: 'https://minio/m1?sig=1' });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(PLAYBACK_PROCESSING_POLL_MS * 3);
    });
    expect(mockedApiFetch).toHaveBeenCalledTimes(3);
  });

  it('si el procesamiento termina en failed deja de servir la URL del original', async () => {
    mockedApiFetch
      .mockResolvedValueOnce({ ...playback('m1', 'https://minio/incoming?sig=1'), status: 'processing', ambilightUrl: null })
      .mockResolvedValueOnce({ mediaId: 'm1', url: null, expiresAt: null, status: 'failed', ambilightUrl: null });
    const { result } = setup({ roomId: 'r1', mediaId: 'm1' });
    await flush();
    expect(result.current.url).toBe('https://minio/incoming?sig=1');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(PLAYBACK_PROCESSING_POLL_MS);
    });
    expect(result.current).toMatchObject({ status: 'failed', url: null, expiresAt: null });
  });

  it('deja de re-consultar al llegar a failed', async () => {
    mockedApiFetch
      .mockResolvedValueOnce({ ...playback('m1', 'u'), status: 'processing' })
      .mockResolvedValue({ ...playback('m1', 'u'), status: 'failed' });
    const { result } = setup({ roomId: 'r1', mediaId: 'm1' });
    await flush();
    for (let i = 0; i < 4; i += 1) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(PLAYBACK_PROCESSING_POLL_MS);
      });
    }
    expect(result.current.status).toBe('failed');
    expect(mockedApiFetch).toHaveBeenCalledTimes(2);
  });

  it('respeta un máximo de re-consultas', async () => {
    mockedApiFetch.mockResolvedValue({ ...playback('m1', 'u', 60 * 60_000), status: 'processing' });
    setup({ roomId: 'r1', mediaId: 'm1', opts: { processingPollMs: 1_000, maxProcessingPolls: 3 } });
    await flush();
    for (let i = 0; i < 6; i += 1) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1_000);
      });
    }
    expect(mockedApiFetch).toHaveBeenCalledTimes(4);
  });

  it('un fallo al re-consultar no muestra error y sigue intentando', async () => {
    mockedApiFetch
      .mockResolvedValueOnce({ ...playback('m1', 'u'), status: 'processing' })
      .mockRejectedValueOnce(new Error('503'))
      .mockResolvedValueOnce({ ...playback('m1', 'u'), status: 'ready' });
    const { result } = setup({ roomId: 'r1', mediaId: 'm1' });
    await flush();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(PLAYBACK_PROCESSING_POLL_MS);
    });
    expect(result.current.error).toBeNull();
    expect(result.current.status).toBe('processing');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(PLAYBACK_PROCESSING_POLL_MS);
    });
    expect(result.current.status).toBe('ready');
  });

  it('si al re-consultar la sala ya tiene otro vídeo, lo adopta entero', async () => {
    mockedApiFetch
      .mockResolvedValueOnce({ ...playback('m1', 'https://minio/m1'), status: 'processing' })
      .mockResolvedValueOnce({ ...playback('m2', 'https://minio/m2'), status: 'ready' });
    const { result } = setup({ roomId: 'r1', mediaId: undefined });
    await flush();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(PLAYBACK_PROCESSING_POLL_MS);
    });
    expect(result.current).toMatchObject({ mediaId: 'm2', url: 'https://minio/m2', status: 'ready' });
  });

  it('una carga completa invalida la re-consulta en vuelo', async () => {
    let resolvePoll!: (v: unknown) => void;
    mockedApiFetch
      .mockResolvedValueOnce({ ...playback('m1', 'https://minio/m1'), status: 'processing' })
      .mockReturnValueOnce(new Promise((r) => (resolvePoll = r)))
      .mockResolvedValueOnce({ ...playback('m2', 'https://minio/m2'), status: 'pending' });
    const { result, rerender } = setup({ roomId: 'r1', mediaId: 'm1' });
    await flush();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(PLAYBACK_PROCESSING_POLL_MS);
    });
    rerender({ roomId: 'r1', mediaId: 'm2' });
    await flush();
    resolvePoll({ ...playback('m1', 'https://minio/m1'), status: 'ready' });
    await flush();
    expect(result.current).toMatchObject({ mediaId: 'm2', status: 'pending' });
  });

  it('limpia la re-consulta al desmontar', async () => {
    mockedApiFetch.mockResolvedValue({ ...playback('m1', 'u'), status: 'pending' });
    const { unmount } = setup({ roomId: 'r1', mediaId: 'm1' });
    await flush();
    unmount();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(PLAYBACK_PROCESSING_POLL_MS * 5);
    });
    expect(mockedApiFetch).toHaveBeenCalledTimes(1);
  });
});

describe('useRoomPlayback — invitación no válida', () => {
  const httpError = (status: number) => Object.assign(new Error(`API error ${status}`), { status });

  it.each([401, 403])('un %i con guest token borra el token y marca la invitación como no válida', async (status) => {
    localStorage.setItem('tint_guest_token', 'g');
    mockedApiFetch.mockRejectedValueOnce(httpError(status));
    const { result } = setup({ roomId: 'r1', mediaId: undefined, opts: { role: 'guest' } });
    await flush();
    expect(result.current.revoked).toBe(true);
    expect(localStorage.getItem('tint_guest_token')).toBeNull();
  });

  it('el host con 403 no toca el guest token ni se marca como revocado', async () => {
    localStorage.setItem('tint_guest_token', 'g');
    mockedApiFetch.mockRejectedValueOnce(httpError(403));
    const { result } = setup({ roomId: 'r1', mediaId: undefined, opts: { role: 'host' } });
    await flush();
    expect(result.current.revoked).toBe(false);
    expect(result.current.error).toMatch(/no se pudo cargar/i);
    expect(localStorage.getItem('tint_guest_token')).toBe('g');
  });

  it('otros errores del invitado (p. ej. 500) solo muestran el error', async () => {
    localStorage.setItem('tint_guest_token', 'g');
    mockedApiFetch.mockRejectedValueOnce(httpError(500));
    const { result } = setup({ roomId: 'r1', mediaId: undefined, opts: { role: 'guest' } });
    await flush();
    expect(result.current.revoked).toBe(false);
    expect(localStorage.getItem('tint_guest_token')).toBe('g');
  });
});

describe('useRoomPlayback — calidades', () => {
  const q720 = { id: '720p', label: '720p', url: 'https://minio/m1/720p.mp4?sig=1' };

  it('servidor antiguo sin qualities → solo el original', async () => {
    mockedApiFetch.mockResolvedValue(playback('m1', 'https://minio/m1?sig=1'));
    const { result } = setup({ roomId: 'r1', mediaId: undefined });
    await flush();
    expect(result.current.qualities).toEqual([{ id: 'source', label: 'Original', url: 'https://minio/m1?sig=1' }]);
  });

  it('expone las calidades que envía identity-api', async () => {
    const qualities = [{ id: 'source', label: 'Original', url: 'https://minio/m1?sig=1' }, q720];
    mockedApiFetch.mockResolvedValue({ ...playback('m1', 'https://minio/m1?sig=1'), qualities });
    const { result } = setup({ roomId: 'r1', mediaId: undefined });
    await flush();
    expect(result.current.qualities).toEqual(qualities);
  });

  it('sin vídeo no hay calidades', async () => {
    mockedApiFetch.mockResolvedValue(playback(null, null));
    const { result } = setup({ roomId: 'r1', mediaId: undefined });
    expect(result.current.qualities).toEqual([]);
    await flush();
    expect(result.current.qualities).toEqual([]);
  });

  it('al re-consultar adopta las nuevas calidades sin cambiar la URL del original', async () => {
    mockedApiFetch
      .mockResolvedValueOnce({ ...playback('m1', 'https://minio/m1?sig=1'), status: 'processing' })
      .mockResolvedValueOnce({
        ...playback('m1', 'https://minio/m1?sig=2'),
        status: 'ready',
        qualities: [{ id: 'source', label: 'Original', url: 'https://minio/m1?sig=2' }, q720],
      });
    const { result } = setup({ roomId: 'r1', mediaId: 'm1' });
    await flush();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(PLAYBACK_PROCESSING_POLL_MS);
    });
    expect(result.current.url).toBe('https://minio/m1?sig=1');
    expect(result.current.qualities).toEqual([{ id: 'source', label: 'Original', url: 'https://minio/m1?sig=1' }, q720]);
  });

  it('si el procesamiento falla se vacían las calidades', async () => {
    mockedApiFetch
      .mockResolvedValueOnce({ ...playback('m1', 'u'), status: 'processing' })
      .mockResolvedValueOnce({ mediaId: 'm1', url: null, expiresAt: null, status: 'failed' });
    const { result } = setup({ roomId: 'r1', mediaId: 'm1' });
    await flush();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(PLAYBACK_PROCESSING_POLL_MS);
    });
    expect(result.current.qualities).toEqual([]);
  });
});
