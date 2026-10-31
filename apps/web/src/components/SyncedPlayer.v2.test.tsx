import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { createRef } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SyncedPlayer, type SyncedPlayerProps } from './SyncedPlayer';
import type { SyncBroadcast, SyncSocketApi } from '../hooks/useSyncSocket';
import type { SyncSnapshot } from '../lib/syncProtocol';

const SRC = 'https://cdn.test/demo.mp4';

const pausedState: SyncSnapshot = {
  status: 'paused',
  position_ms: 20_000,
  updated_at_ms: 1_000,
  rate: 1,
  version: 2,
  server_time_ms: 1_000,
  media_id: 'm1',
  received_at_perf: 0,
};

function makeSync(over: Partial<SyncSocketApi> = {}): SyncSocketApi {
  return {
    connected: true,
    state: null,
    hostOnline: true,
    lastError: null,
    correction: null,
    canControl: true,
    rttMs: null,
    driftMs: null,
    revoked: false,
    expired: false,
    fatalError: null,
    reconnect: null,
    lastBroadcast: null,
    volume: 1,
    quality: 'auto',
    sendCommand: vi.fn(() => 'evt'),
    sendBuffering: vi.fn(() => true),
    ...over,
  };
}

function bc(over: Partial<SyncBroadcast>): SyncBroadcast {
  return { seq: 1, type: 'SEEK', position_ms: 0, rate: 1, media_id: 'm1', own: false, ...over };
}

function renderPlayer(props: Partial<SyncedPlayerProps> = {}) {
  const videoRef = createRef<HTMLVideoElement>();
  const sync = props.sync ?? makeSync();
  const all = { src: SRC, canControl: true, sync, videoRef, now: () => 0, ...props } as SyncedPlayerProps;
  const utils = render(<SyncedPlayer {...all} />);
  const rerenderWith = (over: Partial<SyncedPlayerProps>) => utils.rerender(<SyncedPlayer {...all} {...over} />);
  return { ...utils, videoRef, sync, rerenderWith };
}

function video(): HTMLVideoElement {
  return screen.getByLabelText('Vídeo de la sala') as HTMLVideoElement;
}

function withDuration(seconds: number) {
  Object.defineProperty(video(), 'duration', { configurable: true, value: seconds });
  fireEvent.durationChange(video());
}

beforeEach(() => {
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined);
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});
  vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: false, addListener: vi.fn(), removeListener: vi.fn() })));
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('SyncedPlayer — velocidad (F6)', () => {
  it('quien controla elige la velocidad y envía RATE', () => {
    const { sync } = renderPlayer({ sync: makeSync({ state: pausedState }) });
    const select = screen.getByRole('combobox', { name: 'Velocidad' });
    expect(select).toHaveValue('1');
    expect(select).toHaveAttribute('aria-keyshortcuts', '[ ]');
    expect(within(select).getAllByRole('option').map((o) => o.textContent)).toEqual(['0.5×', '0.75×', '1×', '1.25×', '1.5×', '2×']);
    video().currentTime = 20;
    fireEvent.change(select, { target: { value: '1.5' } });
    expect(sync.sendCommand).toHaveBeenCalledWith('RATE', 20_000, { rate: 1.5 });
  });

  it('una velocidad fuera de la lista también se muestra', () => {
    renderPlayer({ sync: makeSync({ state: { ...pausedState, rate: 3 } }) });
    expect(screen.getByRole('combobox', { name: 'Velocidad' })).toHaveValue('3');
  });

  it('el participante solo ve la velocidad si no es 1×', () => {
    const { rerenderWith } = renderPlayer({ canControl: false, sync: makeSync({ state: pausedState }) });
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument();
    expect(screen.queryByText('1×')).not.toBeInTheDocument();
    rerenderWith({ sync: makeSync({ state: { ...pausedState, rate: 1.5, version: 3 } }) });
    expect(screen.getByText('1.5×')).toHaveAttribute('aria-label', 'Velocidad 1.5×');
  });
});

describe('SyncedPlayer — atajos de teclado', () => {
  it('Espacio/K alterna según el estado maestro', () => {
    const { sync, rerenderWith } = renderPlayer({ sync: makeSync({ state: pausedState }) });
    fireEvent.keyDown(document.body, { key: 'k' });
    expect(sync.sendCommand).toHaveBeenLastCalledWith('PLAY', 20_000);
    rerenderWith({ sync: { ...sync, state: { ...pausedState, status: 'playing', version: 3 } } });
    fireEvent.keyDown(document.body, { key: ' ' });
    expect(sync.sendCommand).toHaveBeenLastCalledWith('PAUSE', expect.any(Number));
  });

  it('←/→ saltan 10 s acotando a la duración', () => {
    const { sync } = renderPlayer();
    withDuration(30);
    video().currentTime = 25;
    fireEvent.keyDown(document.body, { key: 'ArrowRight' });
    expect(sync.sendCommand).toHaveBeenLastCalledWith('SEEK', 30_000);
    video().currentTime = 5;
    fireEvent.keyDown(document.body, { key: 'j' });
    expect(sync.sendCommand).toHaveBeenLastCalledWith('SEEK', 0);
  });

  it('sin duración conocida no acota hacia adelante', () => {
    const { sync } = renderPlayer();
    video().currentTime = 5;
    fireEvent.keyDown(document.body, { key: 'l' });
    expect(sync.sendCommand).toHaveBeenLastCalledWith('SEEK', 15_000);
  });

  it('[ y ] cambian la velocidad un paso; en el extremo no envían', () => {
    const { sync, rerenderWith } = renderPlayer({ sync: makeSync({ state: pausedState }) });
    fireEvent.keyDown(document.body, { key: ']' });
    expect(sync.sendCommand).toHaveBeenLastCalledWith('RATE', 20_000, { rate: 1.25 });
    rerenderWith({ sync: { ...sync, state: { ...pausedState, rate: 0.5, version: 3 } } });
    vi.mocked(sync.sendCommand).mockClear();
    fireEvent.keyDown(document.body, { key: '[' });
    expect(sync.sendCommand).not.toHaveBeenCalled();
  });

  it('? muestra la ayuda de atajos', () => {
    renderPlayer();
    const toggle = screen.getByRole('button', { name: 'Atajos de teclado' });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    fireEvent.keyDown(document.body, { key: '?' });
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText('Retroceder 10 s')).toBeInTheDocument();
    fireEvent.click(toggle);
    expect(screen.queryByText('Retroceder 10 s')).not.toBeInTheDocument();
  });

  it('los botones anuncian sus atajos', () => {
    renderPlayer();
    expect(screen.getByRole('button', { name: 'Reproducir' })).toHaveAttribute('aria-keyshortcuts', 'Space k');
    expect(screen.getByRole('button', { name: 'Pausar' })).toHaveAttribute('aria-keyshortcuts', 'Space k');
    expect(screen.getByRole('button', { name: 'Retroceder 10 segundos' })).toHaveAttribute('aria-keyshortcuts', 'ArrowLeft j');
    expect(screen.getByRole('button', { name: 'Avanzar 10 segundos' })).toHaveAttribute('aria-keyshortcuts', 'ArrowRight l');
  });

  it('los botones ±10 s envían SEEK', () => {
    const { sync } = renderPlayer();
    video().currentTime = 12;
    fireEvent.click(screen.getByRole('button', { name: 'Avanzar 10 segundos' }));
    expect(sync.sendCommand).toHaveBeenLastCalledWith('SEEK', 22_000);
    fireEvent.click(screen.getByRole('button', { name: 'Retroceder 10 segundos' }));
    expect(sync.sendCommand).toHaveBeenLastCalledWith('SEEK', 2_000);
  });

  it('con láser, L lo alterna (no avanza) y la ayuda lo refleja', () => {
    const onToggleLaser = vi.fn();
    const { sync } = renderPlayer({ onToggleLaser });
    expect(screen.getByRole('button', { name: 'Avanzar 10 segundos' })).toHaveAttribute('aria-keyshortcuts', 'ArrowRight');
    fireEvent.keyDown(document.body, { key: 'l' });
    expect(onToggleLaser).toHaveBeenCalledTimes(1);
    expect(sync.sendCommand).not.toHaveBeenCalled();
    fireEvent.keyDown(document.body, { key: '?' });
    expect(screen.getByText('Activar o desactivar el puntero láser')).toBeInTheDocument();
    expect(screen.queryByText('→ / L')).not.toBeInTheDocument();
    expect(screen.getByText('→')).toBeInTheDocument();
  });

  it('sin control no hay atajos ni ayuda', () => {
    const { sync } = renderPlayer({ canControl: false });
    fireEvent.keyDown(document.body, { key: 'k' });
    expect(sync.sendCommand).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: 'Atajos de teclado' })).not.toBeInTheDocument();
  });
});

describe('SyncedPlayer — control delegado (F7)', () => {
  it('muestra el aviso de control temporal', () => {
    renderPlayer({ delegated: true });
    expect(screen.getByRole('status')).toHaveTextContent('El host no está: tienes el control temporal');
  });

  it('sin delegación no hay aviso', () => {
    renderPlayer();
    expect(screen.queryByText(/control temporal/)).not.toBeInTheDocument();
  });
});

describe('SyncedPlayer — barra de cine', () => {
  it('marca los saltos ajenos del host y los reinicia al cargar otro vídeo', () => {
    const { rerenderWith, sync } = renderPlayer();
    withDuration(100);
    rerenderWith({ sync: { ...sync, lastBroadcast: bc({ seq: 1, position_ms: 10_000 }) } });
    rerenderWith({ sync: { ...sync, lastBroadcast: bc({ seq: 2, position_ms: 20_000, own: true }) } });
    rerenderWith({ sync: { ...sync, lastBroadcast: bc({ seq: 3, type: 'PAUSE', position_ms: 30_000 }) } });
    expect(screen.getAllByTestId('seek-mark')).toHaveLength(1);
    for (let i = 4; i <= 10; i++) {
      rerenderWith({ sync: { ...sync, lastBroadcast: bc({ seq: i, position_ms: i * 1_000 }) } });
    }
    expect(screen.getAllByTestId('seek-mark')).toHaveLength(5);
    rerenderWith({ sync: { ...sync, lastBroadcast: bc({ seq: 11, type: 'LOAD', media_id: 'm2' }) } });
    expect(screen.queryAllByTestId('seek-mark')).toHaveLength(0);
  });

  it('dibuja los rangos en búfer del vídeo', () => {
    renderPlayer();
    withDuration(100);
    Object.defineProperty(video(), 'buffered', {
      configurable: true,
      value: { length: 1, start: () => 0, end: () => 40 },
    });
    fireEvent.progress(video());
    expect(screen.getByTestId('seek-buffered')).toHaveStyle({ width: '40%' });
  });
});

describe('SyncedPlayer — fundido al corregir', () => {
  it('seek de corrección activa un fundido breve', () => {
    vi.useFakeTimers();
    renderPlayer({
      sync: makeSync({ correction: { seq: 1, target_ms: 42_000, strategy: 'seek', drift_ms: 900, version: 1 } }),
    });
    expect(screen.getByTestId('sync-fade')).toHaveAttribute('data-active', 'true');
    act(() => vi.advanceTimersByTime(200));
    expect(screen.getByTestId('sync-fade')).toHaveAttribute('data-active', 'false');
  });

  it('un salto grande al aplicar estado también funde; uno pequeño no', () => {
    vi.useFakeTimers();
    const { rerenderWith, sync } = renderPlayer({ sync: makeSync({ state: pausedState }) });
    expect(screen.getByTestId('sync-fade')).toHaveAttribute('data-active', 'true');
    act(() => vi.advanceTimersByTime(200));
    rerenderWith({ sync: { ...sync, state: { ...pausedState, position_ms: 21_000, version: 3 } } });
    expect(screen.getByTestId('sync-fade')).toHaveAttribute('data-active', 'false');
  });

  it('con prefers-reduced-motion no hay fundido', () => {
    vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: true, addListener: vi.fn(), removeListener: vi.fn() })));
    renderPlayer({
      sync: makeSync({ correction: { seq: 1, target_ms: 42_000, strategy: 'seek', drift_ms: 900, version: 1 } }),
    });
    expect(screen.getByTestId('sync-fade')).toHaveAttribute('data-active', 'false');
  });
});

describe('SyncedPlayer — cambio de src', () => {
  it('al refrescar la URL conserva la posición sin estado maestro', () => {
    const { rerenderWith } = renderPlayer();
    video().currentTime = 42;
    fireEvent.timeUpdate(video());
    rerenderWith({ src: 'https://cdn.test/demo.mp4?sig=2' });
    video().currentTime = 0;
    fireEvent.loadedMetadata(video());
    expect(video().currentTime).toBe(42);
  });

  it('con estado maestro aplica la posición esperada al cargar los metadatos', () => {
    const { rerenderWith } = renderPlayer({ sync: makeSync({ state: pausedState }) });
    rerenderWith({ src: 'https://cdn.test/otro.mp4' });
    video().currentTime = 0;
    fireEvent.loadedMetadata(video());
    expect(video().currentTime).toBe(20);
  });

  it.each([
    [2, true],
    [4, true],
    [3, false],
    [1, false],
  ])('un error del vídeo con código %i avisa (onMediaError): %s', (code, expected) => {
    const onMediaError = vi.fn();
    renderPlayer({ onMediaError });
    Object.defineProperty(video(), 'error', { configurable: true, value: { code } });
    fireEvent.error(video());
    expect(onMediaError).toHaveBeenCalledTimes(expected ? 1 : 0);
  });

  it('un error sin onMediaError ni MediaError no rompe', () => {
    renderPlayer();
    fireEvent.error(video());
    expect(video()).toBeInTheDocument();
  });

  it('permite personalizar el mensaje sin vídeo', () => {
    renderPlayer({ src: undefined, emptyMessage: 'Cargando vídeo…' });
    expect(screen.getByText('Cargando vídeo…')).toBeInTheDocument();
  });
});
