import { beforeEach, describe, expect, it, vi } from 'vitest';
import { apiFetch, ApiError } from './api';
import {
  assignVideo,
  assignVideoErrorMessage,
  formatDuration,
  listVideos,
  mergeLibrary,
  videoStatusLabel,
  videoTitle,
  type LibraryVideo,
} from './videos';

vi.mock('./api', async (orig) => ({
  ...(await orig<typeof import('./api')>()),
  apiFetch: vi.fn(),
}));
const mockedApiFetch = vi.mocked(apiFetch);

beforeEach(() => mockedApiFetch.mockReset());

describe('biblioteca de vídeos', () => {
  it('listVideos pide GET /videos con el token de host y tolera respuestas sin lista', async () => {
    const v = { id: 'v1', title: 'Peli', durationMs: 1000, status: 'ready', createdAt: 'x', previewUrl: 'https://p' };
    mockedApiFetch.mockResolvedValueOnce({ videos: [v] }).mockResolvedValueOnce({});
    await expect(listVideos()).resolves.toEqual([v]);
    await expect(listVideos()).resolves.toEqual([]);
    expect(mockedApiFetch).toHaveBeenCalledWith('/videos', { method: 'GET' }, 'host');
  });

  it('assignVideo usa PUT /rooms/:id/media {videoId}', async () => {
    mockedApiFetch.mockResolvedValue({ mediaId: 'v1', mediaKey: 'v1/source.mp4' });
    await expect(assignVideo('r 1', 'v1')).resolves.toEqual({ mediaId: 'v1', mediaKey: 'v1/source.mp4' });
    expect(mockedApiFetch).toHaveBeenCalledWith(
      '/rooms/r%201/media',
      { method: 'PUT', body: JSON.stringify({ videoId: 'v1' }) },
      'host',
    );
  });

  it.each([
    [new ApiError(404, 'x'), /ya no está disponible/],
    [new ApiError(403, 'x'), /permiso/],
    [new ApiError(410, 'x'), /cerrada/],
    [new ApiError(500, 'x'), /No se pudo poner el vídeo/],
    [new TypeError('x'), /No se pudo poner el vídeo/],
  ])('mensaje simple al asignar %#', (err, expected) => {
    expect(assignVideoErrorMessage(err)).toMatch(expected);
  });

  it.each([
    [null, ''],
    [0, ''],
    [45_000, '45 s'],
    [65_000, '1 min 05 s'],
    [5_400_000, '1 h 30 min'],
    [3_600_000, '1 h'],
  ])('formatDuration(%s) = %s', (ms, expected) => {
    expect(formatDuration(ms)).toBe(expected);
  });

  it('estado y título en palabras simples', () => {
    expect(videoStatusLabel('ready')).toBe('Listo');
    expect(videoStatusLabel('processing')).toBe('Preparando…');
    expect(videoStatusLabel('pending')).toBe('Preparando…');
    expect(videoTitle({ title: '  Mi peli ' })).toBe('Mi peli');
    expect(videoTitle({ title: null })).toBe('Vídeo sin nombre');
    expect(videoTitle({ title: '   ' })).toBe('Vídeo sin nombre');
  });
});

describe('mergeLibrary (refresco de la biblioteca sin recargar las miniaturas)', () => {
  const video = (over: Partial<LibraryVideo> = {}): LibraryVideo => ({
    id: 'v1',
    title: 'Peli',
    durationMs: 1000,
    status: 'processing',
    createdAt: '2026-10-01T10:00:00Z',
    previewUrl: 'https://cdn/v1/original.mp4?sig=A',
    ...over,
  });

  it('sin lista previa devuelve la nueva', () => {
    const next = [video()];
    expect(mergeLibrary(null, next)).toBe(next);
  });

  it('si solo cambió la firma de la miniatura devuelve la lista anterior (misma referencia: no se vuelve a pintar)', () => {
    const prev = [video(), video({ id: 'v2', previewUrl: 'https://cdn/v2.mp4?sig=A' })];
    const next = [video({ previewUrl: 'https://cdn/v1/original.mp4?sig=B' }), video({ id: 'v2', previewUrl: 'https://cdn/v2.mp4?sig=B' })];
    expect(mergeLibrary(prev, next)).toBe(prev);
  });

  it('conserva la miniatura de cada vídeo mientras su estado no cambia, aunque cambie otro dato', () => {
    const prev = [video(), video({ id: 'v2', status: 'ready', previewUrl: 'https://cdn/v2.mp4?sig=A' })];
    const next = [
      video({ title: 'Peli renombrada', previewUrl: 'https://cdn/v1/original.mp4?sig=B' }),
      video({ id: 'v2', status: 'ready', previewUrl: 'https://cdn/v2.mp4?sig=B' }),
    ];
    const merged = mergeLibrary(prev, next);
    expect(merged).not.toBe(prev);
    expect(merged[0]).toMatchObject({ title: 'Peli renombrada', previewUrl: 'https://cdn/v1/original.mp4?sig=A' });
    expect(merged[1].previewUrl).toBe('https://cdn/v2.mp4?sig=A');
  });

  it('al cambiar de estado (processing → ready) adopta la miniatura nueva, la 360p', () => {
    const prev = [video()];
    const next = [video({ status: 'ready', durationMs: 5000, previewUrl: 'https://cdn/v1/360p.mp4?sig=B' })];
    expect(mergeLibrary(prev, next)).toEqual(next);
  });

  it('un vídeo nuevo, uno que desaparece o un cambio de orden se reflejan', () => {
    const a = video();
    const b = video({ id: 'v2', previewUrl: null });
    expect(mergeLibrary([a], [b, a]).map((v) => v.id)).toEqual(['v2', 'v1']);
    expect(mergeLibrary([a, b], [a]).map((v) => v.id)).toEqual(['v1']);
    expect(mergeLibrary([a, b], [b, a]).map((v) => v.id)).toEqual(['v2', 'v1']);
  });

  it('si no había miniatura o ahora no la hay, se usa la nueva', () => {
    const prev = [video({ previewUrl: null })];
    expect(mergeLibrary(prev, [video({ previewUrl: 'https://cdn/x?sig=B' })])[0].previewUrl).toBe('https://cdn/x?sig=B');
    expect(mergeLibrary([video()], [video({ previewUrl: null })])[0].previewUrl).toBeNull();
  });
});

