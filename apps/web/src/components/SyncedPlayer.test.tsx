import { act, fireEvent, render, screen } from '@testing-library/react';
import { createRef, Profiler } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SyncedPlayer, type SyncedPlayerProps } from './SyncedPlayer';
import type { SyncSocketApi } from '../hooks/useSyncSocket';
import type { SyncSnapshot } from '../lib/syncProtocol';

const SRC = 'https://cdn.test/demo.mp4';

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

const playingState: SyncSnapshot = {
  status: 'playing',
  position_ms: 10_000,
  updated_at_ms: 1_000,
  rate: 1,
  version: 2,
  server_time_ms: 1_000,
  media_id: '',
  received_at_perf: 0,
};

let playSpy: ReturnType<typeof vi.spyOn>;
let pauseSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  playSpy = vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined);
  pauseSpy = vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function renderPlayer(props: Partial<SyncedPlayerProps> = {}) {
  const videoRef = createRef<HTMLVideoElement>();
  const sync = props.sync ?? makeSync();
  const utils = render(
    <SyncedPlayer src={SRC} canControl sync={sync} videoRef={videoRef} now={() => 0} {...props} />,
  );
  return { ...utils, videoRef, sync };
}

function video(): HTMLVideoElement {
  return screen.getByLabelText('Vídeo de la sala') as HTMLVideoElement;
}

describe('SyncedPlayer — render', () => {
  it('renderiza el vídeo sin controles nativos', () => {
    const { videoRef } = renderPlayer();
    expect(video()).toHaveAttribute('src', SRC);
    expect(video()).not.toHaveAttribute('controls');
    expect(videoRef.current).toBe(video());
  });

  it('muestra un mensaje si no hay vídeo configurado', () => {
    renderPlayer({ src: undefined });
    expect(screen.getByText('Sin video configurado')).toBeInTheDocument();
    expect(screen.queryByLabelText('Vídeo de la sala')).not.toBeInTheDocument();
  });

  it('muestra "Host desconectado" cuando el host se cae', () => {
    renderPlayer({ sync: makeSync({ hostOnline: false }) });
    expect(screen.getByText('Host desconectado')).toBeInTheDocument();
  });

  it('no muestra el badge si el host está en línea', () => {
    renderPlayer();
    expect(screen.queryByText('Host desconectado')).not.toBeInTheDocument();
  });

  it('muestra errores del servidor', () => {
    renderPlayer({ sync: makeSync({ lastError: 'FORBIDDEN' }) });
    expect(screen.getByRole('alert')).toHaveTextContent(/permiso/i);
  });

  it.each([
    ['RATE_LIMITED', /demasiados/i],
    ['INVALID', /inválido/i],
    ['INTERNAL', /servidor/i],
    ['TICKET', /ticket/i],
    ['NO_TOKEN', /sesión/i],
  ])('mensaje para %s', (code, re) => {
    renderPlayer({ sync: makeSync({ lastError: code }) });
    expect(screen.getByRole('alert')).toHaveTextContent(re);
  });
});

describe('SyncedPlayer — controles', () => {
  it('host envía PLAY y PAUSE con la posición actual', () => {
    const { sync } = renderPlayer();
    video().currentTime = 3.2;
    fireEvent.click(screen.getByRole('button', { name: 'Reproducir' }));
    expect(sync.sendCommand).toHaveBeenCalledWith('PLAY', 3_200);
    fireEvent.click(screen.getByRole('button', { name: 'Pausar' }));
    expect(sync.sendCommand).toHaveBeenCalledWith('PAUSE', 3_200);
    // El cliente no es autoritativo: espera al broadcast para reproducir.
    expect(playSpy).not.toHaveBeenCalled();
  });

  it('host busca con la barra de progreso al soltar', () => {
    const { sync } = renderPlayer();
    Object.defineProperty(video(), 'duration', { configurable: true, value: 60 });
    fireEvent.loadedMetadata(video());
    const slider = screen.getByRole('slider', { name: 'Buscar posición' });
    expect(slider).toHaveAttribute('aria-valuemax', '60000');
    fireEvent.keyDown(slider, { key: 'End' });
    expect(sync.sendCommand).not.toHaveBeenCalled();
    fireEvent.keyUp(slider, { key: 'End' });
    expect(sync.sendCommand).toHaveBeenCalledWith('SEEK', 60_000);
  });

  it('soltar sin arrastrar no envía SEEK', () => {
    const { sync } = renderPlayer();
    fireEvent.pointerUp(screen.getByRole('slider', { name: 'Buscar posición' }));
    expect(sync.sendCommand).not.toHaveBeenCalled();
  });

  it('participante ve controles deshabilitados y progreso de solo lectura', () => {
    const { sync } = renderPlayer({ canControl: false });
    const play = screen.getByRole('button', { name: 'Reproducir' });
    expect(play).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Pausar' })).toBeDisabled();
    expect(screen.queryByRole('slider')).not.toBeInTheDocument();
    expect(screen.getByRole('progressbar', { name: 'Progreso' })).toBeInTheDocument();
    fireEvent.click(play);
    expect(sync.sendCommand).not.toHaveBeenCalled();
  });

  it('actualiza el progreso con timeupdate', () => {
    renderPlayer({ canControl: false });
    Object.defineProperty(video(), 'duration', { configurable: true, value: 100 });
    video().currentTime = 25;
    fireEvent.timeUpdate(video());
    expect(screen.getByRole('progressbar', { name: 'Progreso' })).toHaveAttribute('aria-valuenow', '25');
    expect(screen.getByText('0:25 / 1:40')).toBeInTheDocument();
  });

  it('deshabilita los controles del host si no hay conexión', () => {
    renderPlayer({ sync: makeSync({ connected: false }) });
    expect(screen.getByRole('button', { name: 'Reproducir' })).toBeDisabled();
  });
});

describe('SyncedPlayer — aplicar estado', () => {
  it('posiciona y reproduce según el estado maestro', () => {
    renderPlayer({
      sync: makeSync({ state: { ...playingState, received_at_perf: 0 } }),
      now: () => 500,
    });
    expect(video().currentTime).toBeCloseTo(10.5);
    expect(playSpy).toHaveBeenCalled();
  });

  it('pausa cuando el estado está en pausa', () => {
    renderPlayer({ sync: makeSync({ state: { ...playingState, status: 'paused' } }) });
    expect(video().currentTime).toBe(10);
    expect(pauseSpy).toHaveBeenCalled();
    expect(playSpy).not.toHaveBeenCalled();
  });

  it('si el navegador bloquea autoplay ofrece unirse', async () => {
    playSpy.mockRejectedValueOnce(new DOMException('blocked', 'NotAllowedError'));
    renderPlayer({ sync: makeSync({ state: playingState }) });
    const join = await screen.findByRole('button', { name: 'Unirse a la reproducción' });
    playSpy.mockResolvedValueOnce(undefined);
    await act(async () => {
      fireEvent.click(join);
    });
    expect(playSpy).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole('button', { name: 'Unirse a la reproducción' })).not.toBeInTheDocument();
  });

  it('si unirse también falla mantiene el botón', async () => {
    playSpy.mockRejectedValue(new DOMException('blocked', 'NotAllowedError'));
    renderPlayer({ sync: makeSync({ state: playingState }) });
    const join = await screen.findByRole('button', { name: 'Unirse a la reproducción' });
    await act(async () => {
      fireEvent.click(join);
    });
    expect(screen.getByRole('button', { name: 'Unirse a la reproducción' })).toBeInTheDocument();
  });

  it('si la sala se pausa, retira el botón de unirse', async () => {
    playSpy.mockRejectedValueOnce(new DOMException('blocked', 'NotAllowedError'));
    const { rerender, videoRef } = renderPlayer({ sync: makeSync({ state: playingState }) });
    await screen.findByRole('button', { name: 'Unirse a la reproducción' });
    rerender(
      <SyncedPlayer
        src={SRC}
        canControl
        sync={makeSync({ state: { ...playingState, status: 'paused', version: 3 } })}
        videoRef={videoRef}
        now={() => 0}
      />,
    );
    expect(screen.queryByRole('button', { name: 'Unirse a la reproducción' })).not.toBeInTheDocument();
  });

  it('unirse re-aplica el estado maestro: salta a la posición actual y reproduce', async () => {
    playSpy.mockRejectedValueOnce(new DOMException('blocked', 'NotAllowedError'));
    let t = 0;
    renderPlayer({ sync: makeSync({ state: playingState }), now: () => t });
    const join = await screen.findByRole('button', { name: 'Unirse a la reproducción' });
    // El usuario tarda 5 s en pulsar: debe entrar en el segundo actual, no en el de antes.
    t = 5_000;
    await act(async () => {
      fireEvent.click(join);
    });
    expect(video().currentTime).toBeCloseTo(15);
    expect(playSpy).toHaveBeenCalledTimes(2);
  });
  it('un play() interrumpido (AbortError, p. ej. PLAY → PAUSE) no pide un gesto', async () => {
    playSpy.mockRejectedValueOnce(new DOMException('interrupted', 'AbortError'));
    renderPlayer({ sync: makeSync({ state: playingState }) });
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.queryByRole('button', { name: 'Unirse a la reproducción' })).not.toBeInTheDocument();
  });

  it('otros errores de play() (sin nombre) tampoco piden un gesto', async () => {
    playSpy.mockRejectedValueOnce(new Error('boom'));
    renderPlayer({ sync: makeSync({ state: playingState }) });
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.queryByRole('button', { name: 'Unirse a la reproducción' })).not.toBeInTheDocument();
  });

  it('tolera play() sin promesa (navegadores antiguos)', () => {
    playSpy.mockReturnValue(undefined as unknown as Promise<void>);
    renderPlayer({ sync: makeSync({ state: playingState }) });
    expect(screen.queryByRole('button', { name: 'Unirse a la reproducción' })).not.toBeInTheDocument();
  });
});

describe('SyncedPlayer — tolerancia al aplicar estado (sin saltos innecesarios)', () => {
  function rerenderState(
    rerender: (ui: React.ReactElement) => void,
    videoRef: React.RefObject<HTMLVideoElement>,
    state: SyncSnapshot,
  ) {
    rerender(<SyncedPlayer src={SRC} canControl sync={makeSync({ state })} videoRef={videoRef} now={() => 0} />);
  }

  it('un broadcast que no mueve el ancla (VOLUME/QUALITY) no reposiciona si la deriva es < 250 ms', () => {
    const { rerender, videoRef } = renderPlayer({ sync: makeSync({ state: playingState }) });
    expect(video().currentTime).toBe(10);
    video().currentTime = 10.2;
    rerenderState(rerender, videoRef, { ...playingState, version: 3, volume: 0.4 });
    expect(video().currentTime).toBe(10.2);
  });

  it('reproduciendo, una deriva > 250 ms sí reposiciona', () => {
    const { rerender, videoRef } = renderPlayer({ sync: makeSync({ state: playingState }) });
    video().currentTime = 10.3;
    rerenderState(rerender, videoRef, { ...playingState, version: 3 });
    expect(video().currentTime).toBe(10);
  });

  it('en pausa la tolerancia es de 50 ms', () => {
    const paused = { ...playingState, status: 'paused' as const };
    const { rerender, videoRef } = renderPlayer({ sync: makeSync({ state: paused }) });
    video().currentTime = 10.04;
    rerenderState(rerender, videoRef, { ...paused, version: 3 });
    expect(video().currentTime).toBe(10.04);
    video().currentTime = 10.08;
    rerenderState(rerender, videoRef, { ...paused, version: 4 });
    expect(video().currentTime).toBe(10);
  });

  it('dentro de la tolerancia igual aplica la velocidad y el play/pausa', () => {
    const { rerender, videoRef } = renderPlayer({ sync: makeSync({ state: playingState }) });
    video().currentTime = 10.1;
    pauseSpy.mockClear();
    rerenderState(rerender, videoRef, { ...playingState, version: 3, rate: 1.5 });
    expect(video().playbackRate).toBe(1.5);
    expect(video().currentTime).toBe(10.1);
    rerenderState(rerender, videoRef, { ...playingState, version: 4, status: 'paused', position_ms: 10_100 });
    expect(pauseSpy).toHaveBeenCalled();
    expect(video().currentTime).toBe(10.1);
  });
});

describe('SyncedPlayer — correcciones', () => {
  it('seek reposiciona el vídeo', () => {
    renderPlayer({
      sync: makeSync({
        correction: { seq: 1, target_ms: 42_000, strategy: 'seek', drift_ms: 900, version: 1 },
      }),
    });
    expect(video().currentTime).toBe(42);
  });

  it('rate acelera y restaura al alcanzar la posición esperada', () => {
    vi.useFakeTimers();
    let perf = 0;
    renderPlayer({
      sync: makeSync({
        state: playingState,
        correction: { seq: 1, target_ms: 10_000, strategy: 'rate', drift_ms: -300, version: 2 },
      }),
      now: () => perf,
    });
    expect(video().playbackRate).toBe(1.05);
    // Sigue atrasado: mantiene la corrección.
    video().currentTime = 9;
    perf = 250;
    act(() => vi.advanceTimersByTime(250));
    expect(video().playbackRate).toBe(1.05);
    // Alcanza la posición esperada (10_000 + 500 ms) → restaura.
    perf = 500;
    video().currentTime = 10.45;
    fireEvent.timeUpdate(video());
    expect(video().playbackRate).toBe(1);
  });

  it('rate restaura tras 5 s como máximo', () => {
    vi.useFakeTimers();
    let perf = 0;
    renderPlayer({
      sync: makeSync({
        correction: { seq: 1, target_ms: 0, strategy: 'rate', drift_ms: 300, version: 1 },
      }),
      now: () => perf,
    });
    expect(video().playbackRate).toBe(0.95);
    perf = 4_000;
    act(() => vi.advanceTimersByTime(4_000));
    expect(video().playbackRate).toBe(0.95);
    perf = 5_000;
    act(() => vi.advanceTimersByTime(1_000));
    expect(video().playbackRate).toBe(1);
  });

  it('a 2× la corrección de velocidad es relativa (2.1) y restaura a la velocidad de la sala', () => {
    vi.useFakeTimers();
    let perf = 0;
    renderPlayer({
      sync: makeSync({
        state: { ...playingState, rate: 2 },
        correction: { seq: 1, target_ms: 10_000, strategy: 'rate', drift_ms: -300, version: 2 },
      }),
      now: () => perf,
    });
    expect(video().playbackRate).toBeCloseTo(2.1);
    perf = 5_000;
    act(() => vi.advanceTimersByTime(5_000));
    expect(video().playbackRate).toBe(2);
  });

  it('usa la velocidad de sala que trae la corrección si la hay', () => {
    renderPlayer({
      sync: makeSync({
        state: playingState,
        correction: { seq: 1, target_ms: 10_000, strategy: 'rate', drift_ms: 300, version: 2, rate: 1.5 },
      }),
    });
    expect(video().playbackRate).toBeCloseTo(1.425);
  });

  it('no aplica un seek de corrección mientras el vídeo hace buffering', () => {
    const { rerender, videoRef } = renderPlayer();
    Object.defineProperty(video(), 'readyState', { configurable: true, value: 2 });
    Object.defineProperty(video(), 'paused', { configurable: true, value: false });
    video().currentTime = 5;
    rerender(
      <SyncedPlayer
        src={SRC}
        canControl
        videoRef={videoRef}
        now={() => 0}
        sync={makeSync({ correction: { seq: 1, target_ms: 42_000, strategy: 'seek', drift_ms: -900, version: 1 } })}
      />,
    );
    expect(video().currentTime).toBe(5);
    expect(screen.getByTestId('sync-fade')).toHaveAttribute('data-active', 'false');
  });

  it('no aplica un seek de corrección con el autoplay bloqueado', async () => {
    playSpy.mockRejectedValueOnce(new DOMException('blocked', 'NotAllowedError'));
    const { rerender, videoRef } = renderPlayer({ sync: makeSync({ state: playingState }) });
    await screen.findByRole('button', { name: 'Unirse a la reproducción' });
    video().currentTime = 10;
    rerender(
      <SyncedPlayer
        src={SRC}
        canControl
        videoRef={videoRef}
        now={() => 0}
        sync={makeSync({
          state: playingState,
          correction: { seq: 1, target_ms: 42_000, strategy: 'seek', drift_ms: -900, version: 2 },
        })}
      />,
    );
    expect(video().currentTime).toBe(10);
  });

  it('no re-posiciona cerca del final un vídeo que ya terminó', () => {
    const { rerender, videoRef } = renderPlayer();
    Object.defineProperty(video(), 'duration', { configurable: true, value: 60 });
    Object.defineProperty(video(), 'ended', { configurable: true, value: true });
    video().currentTime = 60;
    rerender(
      <SyncedPlayer
        src={SRC}
        canControl
        videoRef={videoRef}
        now={() => 0}
        sync={makeSync({ correction: { seq: 1, target_ms: 61_000, strategy: 'seek', drift_ms: -900, version: 1 } })}
      />,
    );
    expect(video().currentTime).toBe(60);
  });

  it('un nuevo estado cancela la corrección de velocidad', () => {
    vi.useFakeTimers();
    const correction = { seq: 1, target_ms: 0, strategy: 'rate' as const, drift_ms: 300, version: 1 };
    const { rerender, videoRef } = renderPlayer({ sync: makeSync({ correction }) });
    expect(video().playbackRate).toBe(0.95);
    rerender(
      <SyncedPlayer
        src={SRC}
        canControl
        videoRef={videoRef}
        now={() => 0}
        sync={makeSync({ correction, state: { ...playingState, status: 'paused', version: 3 } })}
      />,
    );
    expect(video().playbackRate).toBe(1);
  });
});

describe('SyncedPlayer — rendimiento del progreso', () => {
  function renderCounted() {
    const videoRef = createRef<HTMLVideoElement>();
    const commits = { count: 0 };
    render(
      <Profiler id="player" onRender={() => (commits.count += 1)}>
        <SyncedPlayer src={SRC} canControl={false} sync={makeSync()} videoRef={videoRef} now={() => 0} />
      </Profiler>,
    );
    Object.defineProperty(video(), 'duration', { configurable: true, value: 100 });
    fireEvent.durationChange(video());
    return commits;
  }

  it('es un componente memo (los mensajes del chat no lo re-renderizan)', () => {
    expect((SyncedPlayer as unknown as { $$typeof: symbol }).$$typeof).toBe(Symbol.for('react.memo'));
  });

  it('timeupdate solo re-renderiza si la posición avanzó ≥ 250 ms', () => {
    const commits = renderCounted();
    video().currentTime = 10;
    fireEvent.timeUpdate(video());
    const base = commits.count;
    video().currentTime = 10.1;
    fireEvent.timeUpdate(video());
    video().currentTime = 10.2;
    fireEvent.timeUpdate(video());
    expect(commits.count).toBe(base);
    video().currentTime = 10.3;
    fireEvent.timeUpdate(video());
    expect(commits.count).toBe(base + 1);
  });

  it('un seek actualiza la posición aunque el salto sea pequeño', () => {
    const commits = renderCounted();
    video().currentTime = 10;
    fireEvent.timeUpdate(video());
    const base = commits.count;
    video().currentTime = 10.1;
    fireEvent.seeked(video());
    expect(commits.count).toBe(base + 1);
  });

  it('progress y durationchange sin cambios no re-renderizan', () => {
    const commits = renderCounted();
    Object.defineProperty(video(), 'buffered', {
      configurable: true,
      value: { length: 1, start: () => 0, end: () => 40 },
    });
    fireEvent.progress(video());
    const base = commits.count;
    fireEvent.progress(video());
    fireEvent.durationChange(video());
    expect(commits.count).toBe(base);
  });
});

describe('SyncedPlayer — BUFFERING (stalls)', () => {
  function renderWithClock() {
    let t = 0;
    const sync = makeSync();
    renderPlayer({ sync, now: () => t });
    return { sync, advance: (ms: number) => (t += ms) };
  }

  it('reporta el stall waiting → playing con la posición actual del vídeo', () => {
    const { sync, advance } = renderWithClock();
    fireEvent.waiting(video());
    advance(850);
    video().currentTime = 12.3456;
    fireEvent.playing(video());
    expect(sync.sendBuffering).toHaveBeenCalledWith(12_346, 850);
  });

  it('no reporta stalls triviales', () => {
    const { sync, advance } = renderWithClock();
    fireEvent.waiting(video());
    advance(40);
    fireEvent.playing(video());
    expect(sync.sendBuffering).not.toHaveBeenCalled();
  });

  it('no reporta la espera causada por un seek', () => {
    const { sync, advance } = renderWithClock();
    fireEvent.seeking(video());
    fireEvent.waiting(video());
    advance(900);
    fireEvent.seeked(video());
    fireEvent.playing(video());
    expect(sync.sendBuffering).not.toHaveBeenCalled();
  });

  it('olvida el stall en curso si el vídeo se vacía (cambio de fuente)', () => {
    const { sync, advance } = renderWithClock();
    fireEvent.waiting(video());
    advance(900);
    fireEvent.emptied(video());
    fireEvent.playing(video());
    expect(sync.sendBuffering).not.toHaveBeenCalled();
  });
});
