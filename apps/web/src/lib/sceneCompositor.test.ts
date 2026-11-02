import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  canComposite,
  containRect,
  coverCrop,
  OUTPUT_HEIGHT,
  OUTPUT_WIDTH,
  pipRect,
  SceneCompositor,
  workerTicker,
} from './sceneCompositor';
import { FakeMediaStream, FakeMediaTrack } from '../test/fakeLiveStream';

class FakeVideo {
  videoWidth = 0;
  videoHeight = 0;
  readyState = 0;
  srcObject: unknown = null;
  muted = false;
  playsInline = false;
  play = vi.fn(async () => {});
  pause = vi.fn();
  ready(w: number, h: number) {
    this.videoWidth = w;
    this.videoHeight = h;
    this.readyState = 4;
  }
}

function fakeCtx() {
  const calls: Array<[string, unknown[]]> = [];
  const rec = (name: string) => (...args: unknown[]) => void calls.push([name, args]);
  return {
    calls,
    texts: () => calls.filter(([n]) => n === 'fillText').map(([, a]) => a[0]),
    images: () => calls.filter(([n]) => n === 'drawImage').map(([, a]) => a),
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 1,
    font: '',
    textAlign: '',
    textBaseline: '',
    fillRect: rec('fillRect'),
    fillText: rec('fillText'),
    drawImage: rec('drawImage'),
    save: rec('save'),
    restore: rec('restore'),
    clip: rec('clip'),
    stroke: rec('stroke'),
    beginPath: rec('beginPath'),
    moveTo: rec('moveTo'),
    arcTo: rec('arcTo'),
    closePath: rec('closePath'),
    createRadialGradient: () => ({ addColorStop: () => {} }),
  };
}

let ctx: ReturnType<typeof fakeCtx>;
let videos: FakeVideo[];
let outTrack: FakeMediaTrack;
let tick: () => void;
let stopTicker: ReturnType<typeof vi.fn>;

function make(extra: { getContext?: () => unknown } = {}) {
  const canvas = {
    width: 0,
    height: 0,
    getContext: extra.getContext ?? (() => ctx),
    captureStream: vi.fn(() => new FakeMediaStream([outTrack])),
  };
  return new SceneCompositor({
    title: 'Final del torneo',
    createCanvas: () => canvas as unknown as HTMLCanvasElement,
    createVideo: () => {
      const v = new FakeVideo();
      videos.push(v);
      return v as unknown as HTMLVideoElement;
    },
    ticker: (_fps, fn) => {
      tick = fn;
      return stopTicker;
    },
  });
}

beforeEach(() => {
  ctx = fakeCtx();
  videos = [];
  outTrack = new FakeMediaTrack('video', 'canvas');
  stopTicker = vi.fn();
  vi.stubGlobal('MediaStream', FakeMediaStream);
});
afterEach(() => vi.unstubAllGlobals());

describe('geometría', () => {
  it('containRect encaja sin recortar', () => {
    expect(containRect(1280, 1024, { x: 0, y: 0, w: 1920, h: 1080 })).toEqual({ x: 285, y: 0, w: 1350, h: 1080 });
    expect(containRect(0, 0, { x: 1, y: 2, w: 3, h: 4 })).toEqual({ x: 1, y: 2, w: 3, h: 4 });
  });

  it('coverCrop recorta al centro', () => {
    expect(coverCrop(640, 640, 16, 9)).toEqual({ x: 0, y: 140, w: 640, h: 360 });
    expect(coverCrop(1920, 800, 16, 9).y).toBe(0);
    expect(coverCrop(0, 0, 16, 9)).toEqual({ x: 0, y: 0, w: 0, h: 0 });
  });

  it('el PiP va abajo a la derecha dentro del lienzo', () => {
    const r = pipRect();
    expect(r.x + r.w).toBeLessThan(OUTPUT_WIDTH);
    expect(r.y + r.h).toBeLessThan(OUTPUT_HEIGHT);
    expect(r.w / r.h).toBeCloseTo(16 / 9, 1);
  });
});

describe('SceneCompositor', () => {
  it('captura el lienzo 1920×1080 como una pista de vídeo con contentHint motion', () => {
    const c = make();
    expect(c.canvas.width).toBe(1920);
    expect(c.canvas.height).toBe(1080);
    expect(c.track).toBe(outTrack);
    expect(outTrack.contentHint).toBe('motion');
  });

  it('sin pantalla dibuja la tarjeta "Volvemos enseguida"', () => {
    make();
    expect(ctx.texts()).toContain('Volvemos enseguida');
  });

  it('dibuja la pantalla y, con cámara, el PiP sin cambiar de pista', () => {
    const c = make();
    c.setScreen(new FakeMediaTrack('video') as unknown as MediaStreamTrack);
    videos[0].ready(1920, 1080);
    ctx.calls.length = 0;
    tick();
    expect(ctx.images()).toHaveLength(1);
    c.setCamera(new FakeMediaTrack('video') as unknown as MediaStreamTrack);
    videos[1].ready(640, 480);
    ctx.calls.length = 0;
    tick();
    expect(ctx.images()).toHaveLength(2);
    expect(ctx.calls.some(([n]) => n === 'clip')).toBe(true);
    c.setCamera(null);
    ctx.calls.length = 0;
    tick();
    expect(ctx.images()).toHaveLength(1);
    expect(videos[1].srcObject).toBeNull();
    expect(c.track).toBe(outTrack);
  });

  it('las escenas tapan la pantalla con su título y el de la sala', () => {
    const c = make();
    c.setScreen(new FakeMediaTrack('video') as unknown as MediaStreamTrack);
    videos[0].ready(1920, 1080);
    ctx.calls.length = 0;
    c.setScene('starting_soon');
    expect(c.currentScene).toBe('starting_soon');
    expect(ctx.texts()).toEqual(expect.arrayContaining(['Empezamos pronto', 'Final del torneo']));
    expect(ctx.images()).toHaveLength(0);
    c.setScene('brb');
    expect(ctx.texts()).toContain('Ya volvemos');
  });

  it('un play rechazado no rompe nada', () => {
    const c = make();
    videos[0].play.mockRejectedValueOnce(new Error('no'));
    c.setScreen(new FakeMediaTrack('video') as unknown as MediaStreamTrack);
    expect(videos[0].play).toHaveBeenCalled();
  });

  it('dispose detiene el reloj y la pista', () => {
    const c = make();
    c.dispose();
    expect(stopTicker).toHaveBeenCalled();
    expect(outTrack.stopped).toBe(true);
  });

  it('sin contexto 2D lanza un error', () => {
    expect(() => make({ getContext: () => null })).toThrow(/lienzo/);
  });
});

describe('workerTicker y canComposite', () => {
  it('sin Worker usa setInterval', () => {
    vi.useFakeTimers();
    vi.stubGlobal('Worker', undefined);
    const fn = vi.fn();
    const stop = workerTicker(10, fn);
    vi.advanceTimersByTime(250);
    expect(fn).toHaveBeenCalledTimes(2);
    stop();
    vi.advanceTimersByTime(500);
    expect(fn).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });

  it('con Worker programa el periodo en el worker', () => {
    const posted: unknown[] = [];
    const terminate = vi.fn();
    class W {
      onmessage: (() => void) | null = null;
      postMessage(v: unknown) {
        posted.push(v);
      }
      terminate = terminate;
    }
    vi.stubGlobal('Worker', W);
    const revoke = vi.fn();
    Object.assign(URL, { createObjectURL: () => 'blob:x', revokeObjectURL: revoke });
    const stop = workerTicker(30, () => {});
    expect(posted).toEqual([33]);
    stop();
    expect(terminate).toHaveBeenCalled();
    expect(revoke).toHaveBeenCalledWith('blob:x');
  });

  it('si el Worker falla vuelve a setInterval', () => {
    vi.useFakeTimers();
    vi.stubGlobal('Worker', class {
      constructor() {
        throw new Error('CSP');
      }
    });
    Object.assign(URL, { createObjectURL: () => 'blob:x' });
    const fn = vi.fn();
    const stop = workerTicker(10, fn);
    vi.advanceTimersByTime(100);
    expect(fn).toHaveBeenCalledTimes(1);
    stop();
    vi.useRealTimers();
  });

  it('canComposite depende de captureStream', () => {
    const proto = HTMLCanvasElement.prototype as { captureStream?: unknown };
    const original = proto.captureStream;
    delete proto.captureStream;
    expect(canComposite()).toBe(false);
    proto.captureStream = () => null;
    expect(canComposite()).toBe(true);
    if (original) proto.captureStream = original;
    else delete proto.captureStream;
  });
});
