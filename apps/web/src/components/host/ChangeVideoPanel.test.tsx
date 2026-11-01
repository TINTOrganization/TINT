import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { apiFetch, ApiError } from '../../lib/api';
import { MockXhr } from '../../test/mockXhr';
import { ChangeVideoPanel } from './ChangeVideoPanel';

vi.mock('../../lib/api', async (orig) => ({
  ...(await orig<typeof import('../../lib/api')>()),
  apiFetch: vi.fn(),
}));
const mockedApiFetch = vi.mocked(apiFetch);

const GIB2 = 2 * 1024 ** 3;
const video = new File(['0123456789'], 'peli.mp4', { type: 'video/mp4' });
const cancelCalls = () => mockedApiFetch.mock.calls.filter(([, init]) => (init as RequestInit | undefined)?.method === 'DELETE');

const ticket = {
  videoId: 'v-1',
  uploadUrl: 'https://minio/tint/v-1/source.mp4?X-Amz-Signature=s',
  storageKey: 'v-1/source.mp4',
  expiresAt: '2099-01-01T00:00:00Z',
  headers: { 'Content-Type': 'video/mp4' },
};

const library = [
  { id: 'v-old', title: 'Noche de terror', durationMs: 5_400_000, status: 'ready', createdAt: '2026-10-01T10:00:00Z', previewUrl: 'https://cdn/v-old-360p.mp4?sig=1' },
  { id: 'v-new', title: null, durationMs: 65_000, status: 'processing', createdAt: '2026-10-10T10:00:00Z', previewUrl: null },
];

/** Simula identity-api: biblioteca, pedir subida, confirmarla y asignar; el resto falla. */
function routeUploads(
  overrides: {
    request?: () => Promise<unknown>;
    complete?: () => Promise<unknown>;
    videos?: () => Promise<unknown>;
    assign?: (init?: RequestInit) => Promise<unknown>;
    limits?: () => Promise<unknown>;
  } = {},
) {
  mockedApiFetch.mockImplementation(((path: string, init?: RequestInit) => {
    if (path === '/uploads/limits') return overrides.limits?.() ?? Promise.resolve({ maxUploadBytes: GIB2 });
    if (init?.method === 'DELETE' && path.includes('/media/uploads/')) return Promise.resolve(null);
    if (path === '/videos') return overrides.videos?.() ?? Promise.resolve({ videos: library });
    if (path.endsWith('/media') && init?.method === 'PUT') {
      return overrides.assign?.(init) ?? Promise.resolve({ mediaId: 'v-old', mediaKey: 'v-old/source.mp4' });
    }
    if (path.endsWith('/media/uploads')) return overrides.request?.() ?? Promise.resolve(ticket);
    if (path.endsWith('/complete')) {
      return overrides.complete?.() ?? Promise.resolve({ mediaId: 'v-1', mediaKey: 'v-1/source.mp4', status: 'pending' });
    }
    return Promise.reject(new Error(`ruta no simulada ${path}`));
  }) as typeof apiFetch);
}

beforeEach(() => {
  mockedApiFetch.mockReset();
  routeUploads();
  MockXhr.reset();
  vi.stubGlobal('XMLHttpRequest', MockXhr);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

async function openPanel() {
  await userEvent.click(screen.getByRole('button', { name: 'Cambiar vídeo' }));
  await userEvent.click(screen.getByRole('tab', { name: 'Subir nuevo' }));
  return screen.getByLabelText('Archivo de vídeo');
}

/** Elige un archivo, pulsa Subir y espera a que arranque el PUT a MinIO. */
async function startUpload(file: File = video) {
  await userEvent.upload(await openPanel(), file);
  await userEvent.click(screen.getByRole('button', { name: 'Subir' }));
  await waitFor(() => expect(MockXhr.instances).toHaveLength(1));
  return MockXhr.last();
}

describe('ChangeVideoPanel — subida', () => {
  it('se despliega con aria-expanded, enfoca la pestaña activa y se cierra con Escape', async () => {
    render(<ChangeVideoPanel roomId="r1" onMediaAssigned={() => true} />);
    const toggle = screen.getByRole('button', { name: 'Cambiar vídeo' });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await userEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByRole('tab', { name: 'Mis vídeos' })).toHaveFocus();
    await userEvent.click(screen.getByRole('tab', { name: 'Subir nuevo' }));
    const input = screen.getByLabelText('Archivo de vídeo');
    expect(input).toHaveAttribute('type', 'file');
    expect(input).toHaveAttribute('accept', 'video/*');
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(screen.queryByLabelText('Archivo de vídeo')).not.toBeInTheDocument();
    expect(toggle).toHaveFocus();
  });

  it('el botón Cerrar pliega el panel', async () => {
    render(<ChangeVideoPanel roomId="r1" onMediaAssigned={() => true} />);
    await openPanel();
    await userEvent.click(screen.getByRole('button', { name: 'Cerrar' }));
    expect(screen.queryByLabelText('Archivo de vídeo')).not.toBeInTheDocument();
  });

  it('sube a MinIO con progreso, confirma y avisa a la sala con el mediaId', async () => {
    routeUploads();
    const onMediaAssigned = vi.fn(() => true);
    render(<ChangeVideoPanel roomId="r 1" onMediaAssigned={onMediaAssigned} />);
    const input = await openPanel();
    expect(screen.getByRole('button', { name: 'Subir' })).toBeDisabled();
    await userEvent.upload(input, video);
    expect(screen.getByText(/peli\.mp4/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Subir' }));

    expect(mockedApiFetch).toHaveBeenCalledWith(
      '/rooms/r%201/media/uploads',
      { method: 'POST', body: JSON.stringify({ filename: 'peli.mp4', contentType: 'video/mp4', sizeBytes: 10 }) },
      'host',
    );
    await waitFor(() => expect(MockXhr.instances).toHaveLength(1));
    const xhr = MockXhr.last();
    expect(xhr.method).toBe('PUT');
    expect(xhr.url).toBe(ticket.uploadUrl);
    expect(xhr.headers).toEqual({ 'Content-Type': 'video/mp4' });
    expect(xhr.body).toBe(video);

    const bar = screen.getByRole('progressbar', { name: 'Progreso de subida' });
    expect(bar).toHaveAttribute('aria-valuenow', '0');
    act(() => xhr.progress(42, 100));
    expect(bar).toHaveAttribute('aria-valuenow', '42');
    expect(bar).toHaveAttribute('aria-valuemin', '0');
    expect(bar).toHaveAttribute('aria-valuemax', '100');
    expect(screen.getByText('Subiendo… 42 %')).toBeInTheDocument();
    expect(screen.getByLabelText('Archivo de vídeo')).toBeDisabled();

    act(() => xhr.respond(200));
    await waitFor(() => expect(onMediaAssigned).toHaveBeenCalledWith('v-1'));
    expect(mockedApiFetch).toHaveBeenCalledWith('/rooms/r%201/media/uploads/v-1/complete', { method: 'POST' }, 'host');
    expect(screen.getByRole('status')).toHaveTextContent('Vídeo cargado para todos');
    expect(screen.queryByRole('progressbar')).not.toBeInTheDocument();
  });

  it('muestra "Confirmando…" mientras identity-api registra la subida', async () => {
    let resolveComplete!: (v: unknown) => void;
    routeUploads({ complete: () => new Promise((r) => (resolveComplete = r)) });
    render(<ChangeVideoPanel roomId="r1" onMediaAssigned={() => true} />);
    const xhr = await startUpload();
    act(() => xhr.respond(200));
    expect(await screen.findByText(/Confirmando la subida/)).toBeInTheDocument();
    await act(async () => resolveComplete({ mediaId: 'v-1', mediaKey: 'k', status: 'pending' }));
    expect(screen.getByRole('status')).toHaveTextContent('Vídeo cargado para todos');
  });

  it('Cancelar aborta el PUT y permite volver a subir', async () => {
    routeUploads();
    render(<ChangeVideoPanel roomId="r1" onMediaAssigned={() => true} />);
    const xhr = await startUpload();
    await userEvent.click(screen.getByRole('button', { name: 'Cancelar subida' }));
    expect(xhr.aborted).toBe(true);
    expect(await screen.findByText('Subida cancelada.')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(mockedApiFetch).not.toHaveBeenCalledWith(expect.stringContaining('/complete'), expect.anything(), 'host');
    expect(screen.getByRole('button', { name: 'Subir' })).toBeEnabled();
  });

  it('aborta la subida en curso si el panel se desmonta', async () => {
    routeUploads();
    const { unmount } = render(<ChangeVideoPanel roomId="r1" onMediaAssigned={() => true} />);
    const xhr = await startUpload();
    unmount();
    expect(xhr.aborted).toBe(true);
  });

  it('rechaza archivos que no son vídeo sin llamar a identity-api', async () => {
    render(<ChangeVideoPanel roomId="r1" onMediaAssigned={() => true} />);
    const input = await openPanel();
    fireEvent.change(input, { target: { files: [new File(['x'], 'notas.txt', { type: 'text/plain' })] } });
    expect(screen.getByRole('alert')).toHaveTextContent(/no es un vídeo/i);
    expect(screen.getByRole('button', { name: 'Subir' })).toBeDisabled();
    expect(mockedApiFetch).not.toHaveBeenCalledWith(expect.stringContaining('/media/uploads'), expect.anything(), 'host');
  });

  it('413 → el archivo supera el tamaño máximo', async () => {
    routeUploads({ request: () => Promise.reject(new ApiError(413, 'File too large')) });
    render(<ChangeVideoPanel roomId="r1" onMediaAssigned={() => true} />);
    await userEvent.upload(await openPanel(), video);
    await userEvent.click(screen.getByRole('button', { name: 'Subir' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('El archivo supera el tamaño máximo');
    expect(MockXhr.instances).toHaveLength(0);
  });

  describe('límite de tamaño', () => {
    const big = () => new File([new Uint8Array(3 * 1024 ** 2)], 'grande.mp4', { type: 'video/mp4' });

    it('muestra el tamaño máximo (de identity-api) junto al selector', async () => {
      render(<ChangeVideoPanel roomId="r1" onMediaAssigned={() => true} />);
      await openPanel();
      expect(await screen.findByText(/Tamaño máximo: 2\.0 GB/)).toBeInTheDocument();
      expect(mockedApiFetch).toHaveBeenCalledWith('/uploads/limits', {}, 'host');
    });

    it('un archivo mayor que el límite se rechaza antes de subir, diciendo su tamaño y el máximo', async () => {
      routeUploads({ limits: () => Promise.resolve({ maxUploadBytes: 1024 ** 2 }) });
      render(<ChangeVideoPanel roomId="r1" onMediaAssigned={() => true} />);
      const input = await openPanel();
      await screen.findByText(/Tamaño máximo: 1\.0 MB/);
      await userEvent.upload(input, big());
      expect(screen.getByRole('alert')).toHaveTextContent('El archivo pesa 3.0 MB y el máximo es 1.0 MB.');
      expect(screen.getByRole('button', { name: 'Subir' })).toBeDisabled();
      expect(mockedApiFetch).not.toHaveBeenCalledWith(expect.stringContaining('/media/uploads'), expect.anything(), 'host');
    });

    it('si no se pudo obtener el límite no hay pre-chequeo ni texto: el servidor decide', async () => {
      routeUploads({ limits: () => Promise.reject(new ApiError(500, 'boom')) });
      render(<ChangeVideoPanel roomId="r1" onMediaAssigned={() => true} />);
      const input = await openPanel();
      await userEvent.upload(input, big());
      expect(screen.queryByText(/Tamaño máximo/)).not.toBeInTheDocument();
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Subir' })).toBeEnabled();
    });

    it('el 413 del servidor muestra el límite que trae en el cuerpo', async () => {
      routeUploads({
        limits: () => Promise.reject(new ApiError(500, 'boom')),
        request: () => Promise.reject(new ApiError(413, 'File too large', { maxUploadBytes: GIB2 })),
      });
      render(<ChangeVideoPanel roomId="r1" onMediaAssigned={() => true} />);
      await userEvent.upload(await openPanel(), video);
      await userEvent.click(screen.getByRole('button', { name: 'Subir' }));
      expect(await screen.findByRole('alert')).toHaveTextContent('El archivo supera el tamaño máximo permitido (2.0 GB).');
    });
  });

  describe('subida interrumpida: cancela la reserva para que el reintento empiece limpio', () => {
    it('un corte de red durante el PUT cancela la subida reservada', async () => {
      render(<ChangeVideoPanel roomId="r1" onMediaAssigned={() => true} />);
      const xhr = await startUpload();
      act(() => xhr.fail());
      expect(await screen.findByRole('alert')).toHaveTextContent(/Se perdió la conexión/);
      await waitFor(() => expect(mockedApiFetch).toHaveBeenCalledWith('/rooms/r1/media/uploads/v-1', { method: 'DELETE' }, 'host'));
    });

    it('Cancelar subida también cancela la reserva', async () => {
      render(<ChangeVideoPanel roomId="r1" onMediaAssigned={() => true} />);
      await startUpload();
      await userEvent.click(screen.getByRole('button', { name: 'Cancelar subida' }));
      await waitFor(() => expect(cancelCalls()).toHaveLength(1));
    });

    it('desmontar el panel en plena subida cancela la reserva', async () => {
      const { unmount } = render(<ChangeVideoPanel roomId="r1" onMediaAssigned={() => true} />);
      await startUpload();
      unmount();
      await waitFor(() => expect(cancelCalls()).toHaveLength(1));
    });

    it('si falla la confirmación también se cancela', async () => {
      routeUploads({ complete: () => Promise.reject(new ApiError(409, 'Upload missing')) });
      render(<ChangeVideoPanel roomId="r1" onMediaAssigned={() => true} />);
      const xhr = await startUpload();
      act(() => xhr.respond(200));
      await screen.findByRole('alert');
      await waitFor(() => expect(cancelCalls()).toHaveLength(1));
    });

    it('si falla la reserva (nada que cancelar) o la subida termina bien, no se cancela nada', async () => {
      routeUploads({ request: () => Promise.reject(new ApiError(413, 'File too large')) });
      const first = render(<ChangeVideoPanel roomId="r1" onMediaAssigned={() => true} />);
      await userEvent.upload(await openPanel(), video);
      await userEvent.click(screen.getByRole('button', { name: 'Subir' }));
      await screen.findByRole('alert');
      expect(cancelCalls()).toHaveLength(0);
      first.unmount();

      routeUploads();
      MockXhr.reset();
      render(<ChangeVideoPanel roomId="r1" onMediaAssigned={() => true} />);
      const xhr = await startUpload();
      act(() => xhr.respond(200));
      await waitFor(() => expect(mockedApiFetch).toHaveBeenCalledWith(expect.stringContaining('/complete'), { method: 'POST' }, 'host'));
      expect(cancelCalls()).toHaveLength(0);
    });
  });

  it('409 al confirmar → la subida no llegó; Subir reintenta todo el flujo', async () => {
    routeUploads({ complete: () => Promise.reject(new ApiError(409, 'Upload missing')) });
    const onMediaAssigned = vi.fn(() => true);
    render(<ChangeVideoPanel roomId="r1" onMediaAssigned={onMediaAssigned} />);
    const xhr = await startUpload();
    act(() => xhr.respond(200));
    expect(await screen.findByRole('alert')).toHaveTextContent('El vídeo no terminó de llegar; inténtalo de nuevo');
    expect(onMediaAssigned).not.toHaveBeenCalled();

    routeUploads();
    await userEvent.click(screen.getByRole('button', { name: 'Subir' }));
    await waitFor(() => expect(MockXhr.instances).toHaveLength(2));
    act(() => MockXhr.last().respond(200));
    await waitFor(() => expect(onMediaAssigned).toHaveBeenCalledWith('v-1'));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('un rechazo del PUT se explica sin jerga técnica', async () => {
    routeUploads();
    render(<ChangeVideoPanel roomId="r1" onMediaAssigned={() => true} />);
    const xhr = await startUpload();
    act(() => xhr.respond(403));
    expect(await screen.findByRole('alert')).toHaveTextContent(/permiso de subida pudo caducar/);
    expect(screen.getByRole('alert').textContent).not.toMatch(/HTTP|MinIO|403/);
  });

  it('si no se pudo enviar LOAD, avisa y permite reintentar el aviso', async () => {
    routeUploads();
    const onMediaAssigned = vi.fn(() => false);
    render(<ChangeVideoPanel roomId="r1" onMediaAssigned={onMediaAssigned} />);
    const xhr = await startUpload();
    act(() => xhr.respond(200));
    expect(await screen.findByRole('alert')).toHaveTextContent(/no pudimos avisar a la sala/i);
    const retry = screen.getByRole('button', { name: 'Avisar a la sala' });
    await userEvent.click(retry);
    expect(onMediaAssigned).toHaveBeenCalledTimes(2);
    expect(screen.getByRole('alert')).toBeInTheDocument();

    onMediaAssigned.mockReturnValue(true);
    await userEvent.click(retry);
    expect(onMediaAssigned).toHaveBeenLastCalledWith('v-1');
    expect(screen.getByRole('status')).toHaveTextContent('Vídeo cargado para todos');
    expect(screen.queryByRole('button', { name: 'Avisar a la sala' })).not.toBeInTheDocument();
  });
});

describe('ChangeVideoPanel — Mis vídeos', () => {
  async function openLibrary(props: Partial<Parameters<typeof ChangeVideoPanel>[0]> = {}) {
    render(<ChangeVideoPanel roomId="r 1" onMediaAssigned={() => true} {...props} />);
    await userEvent.click(screen.getByRole('button', { name: 'Cambiar vídeo' }));
    return screen.findByRole('list', { name: 'Mis vídeos' });
  }

  it('muestra la cuadrícula con miniatura, título, duración y estado en palabras simples', async () => {
    const grid = await openLibrary();
    expect(mockedApiFetch).toHaveBeenCalledWith('/videos', { method: 'GET' }, 'host');
    const cards = within(grid).getAllByRole('listitem');
    expect(cards).toHaveLength(2);
    expect(within(cards[0]).getByText('Noche de terror')).toBeInTheDocument();
    expect(within(cards[0]).getByText('1 h 30 min')).toBeInTheDocument();
    expect(within(cards[0]).getByText('Listo')).toBeInTheDocument();
    const thumb = cards[0].querySelector('video');
    expect(thumb).toHaveAttribute('src', 'https://cdn/v-old-360p.mp4?sig=1');
    expect(thumb).toHaveAttribute('preload', 'metadata');
    expect(thumb?.muted).toBe(true);
    expect(within(cards[1]).getByText('Vídeo sin nombre')).toBeInTheDocument();
    expect(within(cards[1]).getByText('Preparando…')).toBeInTheDocument();
    expect(cards[1].querySelector('video')).toBeNull();
    expect(screen.getByRole('tab', { name: 'Mis vídeos' })).toHaveAttribute('aria-selected', 'true');
  });

  it('busca por nombre y avisa si nada coincide', async () => {
    const grid = await openLibrary();
    await userEvent.type(screen.getByLabelText('Buscar por nombre'), 'terror');
    expect(within(grid).getAllByRole('listitem')).toHaveLength(1);
    await userEvent.clear(screen.getByLabelText('Buscar por nombre'));
    await userEvent.type(screen.getByLabelText('Buscar por nombre'), 'comedia');
    expect(screen.getByText('Ningún vídeo coincide con «comedia».')).toBeInTheDocument();
  });

  it('"Ver en la sala" asigna con PUT {videoId} y avisa a la sala', async () => {
    const onMediaAssigned = vi.fn(() => true);
    await openLibrary({ onMediaAssigned });
    await userEvent.click(screen.getByRole('button', { name: 'Ver «Noche de terror» en la sala' }));
    expect(mockedApiFetch).toHaveBeenCalledWith(
      '/rooms/r%201/media',
      { method: 'PUT', body: JSON.stringify({ videoId: 'v-old' }) },
      'host',
    );
    await waitFor(() => expect(onMediaAssigned).toHaveBeenCalledWith('v-old'));
    expect(screen.getByRole('status')).toHaveTextContent('Vídeo cargado para todos');
  });

  it('si el vídeo ya no está disponible lo dice con palabras simples', async () => {
    routeUploads({ assign: () => Promise.reject(new ApiError(404, 'Video not found')) });
    await openLibrary();
    await userEvent.click(screen.getByRole('button', { name: 'Ver «Noche de terror» en la sala' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Ese vídeo ya no está disponible.');
  });

  it('si no se pudo avisar a la sala ofrece reintentar', async () => {
    await openLibrary({ onMediaAssigned: () => false });
    await userEvent.click(screen.getByRole('button', { name: 'Ver «Noche de terror» en la sala' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/no pudimos avisar a la sala/i);
    expect(screen.getByRole('alert').textContent).not.toMatch(/Canal Sync|social-core|MinIO/);
    expect(screen.getByRole('button', { name: 'Avisar a la sala' })).toBeInTheDocument();
  });

  it('estado vacío amable que lleva a "Subir nuevo"', async () => {
    routeUploads({ videos: () => Promise.resolve({ videos: [] }) });
    render(<ChangeVideoPanel roomId="r1" onMediaAssigned={() => true} />);
    await userEvent.click(screen.getByRole('button', { name: 'Cambiar vídeo' }));
    expect(await screen.findByText(/Todavía no tienes vídeos/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Subir mi primer vídeo' }));
    expect(screen.getByRole('tab', { name: 'Subir nuevo' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByLabelText('Archivo de vídeo')).toBeInTheDocument();
  });

  it('error al cargar la biblioteca con reintento', async () => {
    let fail = true;
    routeUploads({
      videos: () => {
        const r = fail ? Promise.reject(new Error('x')) : Promise.resolve({ videos: library });
        fail = false;
        return r;
      },
    });
    render(<ChangeVideoPanel roomId="r1" onMediaAssigned={() => true} />);
    await userEvent.click(screen.getByRole('button', { name: 'Cambiar vídeo' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('No pudimos cargar tus vídeos.');
    await userEvent.click(screen.getByRole('button', { name: 'Reintentar' }));
    expect(await screen.findByRole('list', { name: 'Mis vídeos' })).toBeInTheDocument();
  });

  it('las pestañas se recorren con las flechas', async () => {
    await openLibrary();
    const mine = screen.getByRole('tab', { name: 'Mis vídeos' });
    fireEvent.keyDown(mine, { key: 'ArrowRight' });
    expect(screen.getByRole('tab', { name: 'Subir nuevo' })).toHaveFocus();
    expect(screen.getByRole('tab', { name: 'Subir nuevo' })).toHaveAttribute('aria-selected', 'true');
    fireEvent.keyDown(screen.getByRole('tab', { name: 'Subir nuevo' }), { key: 'ArrowLeft' });
    expect(mine).toHaveFocus();
  });

  it('tras subir un vídeo, la biblioteca se actualiza', async () => {
    render(<ChangeVideoPanel roomId="r1" onMediaAssigned={() => true} />);
    const xhr = await startUpload();
    act(() => xhr.respond(200));
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Vídeo cargado para todos'));
    expect(mockedApiFetch.mock.calls.filter(([p]) => p === '/videos').length).toBeGreaterThanOrEqual(2);
  });

  it('openRequest abre el panel en "Mis vídeos"', async () => {
    const { rerender } = render(<ChangeVideoPanel roomId="r1" onMediaAssigned={() => true} />);
    rerender(<ChangeVideoPanel roomId="r1" onMediaAssigned={() => true} openRequest={1} />);
    expect(await screen.findByRole('list', { name: 'Mis vídeos' })).toBeInTheDocument();
  });

  it('no queda texto técnico visible', async () => {
    await openLibrary();
    await userEvent.click(screen.getByRole('tab', { name: 'Subir nuevo' }));
    expect(document.body.textContent).not.toMatch(/MinIO|bucket|Canal Sync|social-core|ticket de sincron|HTTP/i);
  });
});
