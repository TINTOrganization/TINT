import type { SceneName } from './streamProtocol';

/**
 * Compositor de escenas del host (docs/dominio-transmision.md §2): dibuja en un canvas de
 * 1920×1080 la pantalla compartida, la cámara opcional en PiP y las escenas "Empezamos pronto"
 * / "Ya volvemos", y entrega una sola pista de vídeo (`canvas.captureStream`). Cambiar de escena
 * o activar la cámara solo cambia lo que se dibuja: no hay que renegociar el WHIP.
 *
 * El reloj de dibujo corre en un Worker: un `requestAnimationFrame` o un `setInterval` de la
 * página se congelan o se ralentizan a 1 Hz cuando el host cambia a la pestaña que comparte.
 */

export const OUTPUT_WIDTH = 1920;
export const OUTPUT_HEIGHT = 1080;
export const OUTPUT_FPS = 30;

export const SCENE_TITLES: Record<Exclude<SceneName, 'live'>, string> = {
  starting_soon: 'Empezamos pronto',
  brb: 'Ya volvemos',
};

const ACCENT = '#ff6b1a';
const BG = '#0b0b0f';
const FONT = 'Outfit, system-ui, sans-serif';

/** Reloj de dibujo: llama a `tick` ~fps veces por segundo; devuelve cómo detenerlo. */
export type Ticker = (fps: number, tick: () => void) => () => void;

const WORKER_SRC = 'let t=null;onmessage=(e)=>{clearInterval(t);if(e.data>0)t=setInterval(()=>postMessage(0),e.data)}';

/** Ticker en un Worker (no se ralentiza en segundo plano); sin Worker, `setInterval`. */
export const workerTicker: Ticker = (fps, tick) => {
  const period = Math.round(1000 / fps);
  if (typeof Worker !== 'undefined' && typeof URL.createObjectURL === 'function') {
    try {
      const url = URL.createObjectURL(new Blob([WORKER_SRC], { type: 'text/javascript' }));
      const worker = new Worker(url);
      worker.onmessage = () => tick();
      worker.postMessage(period);
      return () => {
        worker.terminate();
        URL.revokeObjectURL(url);
      };
    } catch {
      // CSP sin blob: o Worker no disponible: se sigue con el temporizador de la página.
    }
  }
  const id = setInterval(tick, period);
  return () => clearInterval(id);
};

/** ¿Puede este navegador componer en un canvas y capturarlo como pista? */
export function canComposite(): boolean {
  return (
    typeof HTMLCanvasElement !== 'undefined' &&
    typeof (HTMLCanvasElement.prototype as { captureStream?: unknown }).captureStream === 'function'
  );
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Encaja `src` dentro de `box` sin recortar (bandas negras). */
export function containRect(srcW: number, srcH: number, box: Rect): Rect {
  if (srcW <= 0 || srcH <= 0) return box;
  const scale = Math.min(box.w / srcW, box.h / srcH);
  const w = srcW * scale;
  const h = srcH * scale;
  return { x: box.x + (box.w - w) / 2, y: box.y + (box.h - h) / 2, w, h };
}

/** Recorte de `src` que cubre la proporción de `box` (para la cámara en PiP). */
export function coverCrop(srcW: number, srcH: number, boxW: number, boxH: number): Rect {
  if (srcW <= 0 || srcH <= 0) return { x: 0, y: 0, w: srcW, h: srcH };
  const target = boxW / boxH;
  if (srcW / srcH > target) {
    const w = srcH * target;
    return { x: (srcW - w) / 2, y: 0, w, h: srcH };
  }
  const h = srcW / target;
  return { x: 0, y: (srcH - h) / 2, w: srcW, h };
}

/** Rectángulo de la cámara en PiP: abajo a la derecha, 22 % del ancho, 16:9. */
export function pipRect(width = OUTPUT_WIDTH, height = OUTPUT_HEIGHT): Rect {
  const w = Math.round(width * 0.22);
  const h = Math.round((w * 9) / 16);
  const margin = Math.round(width * 0.02);
  return { x: width - w - margin, y: height - h - margin, w, h };
}

type VideoLike = Pick<HTMLVideoElement, 'videoWidth' | 'videoHeight' | 'readyState' | 'srcObject' | 'muted' | 'playsInline' | 'play' | 'pause'>;

export interface CompositorOptions {
  /** Título de la sala para las escenas. */
  title?: string;
  createCanvas?: () => HTMLCanvasElement;
  createVideo?: () => VideoLike;
  ticker?: Ticker;
  fps?: number;
}

export class SceneCompositor {
  readonly canvas: HTMLCanvasElement;
  readonly stream: MediaStream;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly screen: VideoLike;
  private readonly camera: VideoLike;
  private hasScreen = false;
  private hasCamera = false;
  private scene: SceneName = 'live';
  private readonly title: string;
  private stopTicker: () => void;

  constructor(opts: CompositorOptions = {}) {
    const createVideo = opts.createVideo ?? (() => document.createElement('video'));
    this.canvas = (opts.createCanvas ?? (() => document.createElement('canvas')))();
    this.canvas.width = OUTPUT_WIDTH;
    this.canvas.height = OUTPUT_HEIGHT;
    const ctx = this.canvas.getContext('2d');
    if (!ctx) throw new Error('No se pudo crear el lienzo de la transmisión.');
    this.ctx = ctx;
    this.title = opts.title ?? '';
    this.screen = createVideo();
    this.camera = createVideo();
    for (const v of [this.screen, this.camera]) {
      v.muted = true;
      v.playsInline = true;
    }
    const fps = opts.fps ?? OUTPUT_FPS;
    this.stream = this.canvas.captureStream(fps);
    const track = this.stream.getVideoTracks()[0];
    if (track) track.contentHint = 'motion';
    this.draw();
    this.stopTicker = (opts.ticker ?? workerTicker)(fps, () => this.draw());
  }

  get track(): MediaStreamTrack | null {
    return this.stream.getVideoTracks()[0] ?? null;
  }

  get currentScene(): SceneName {
    return this.scene;
  }

  setScreen(track: MediaStreamTrack | null): void {
    this.hasScreen = this.attach(this.screen, track);
  }

  setCamera(track: MediaStreamTrack | null): void {
    this.hasCamera = this.attach(this.camera, track);
  }

  setScene(name: SceneName): void {
    this.scene = name;
    this.draw();
  }

  dispose(): void {
    this.stopTicker();
    this.stopTicker = () => {};
    this.attach(this.screen, null);
    this.attach(this.camera, null);
    this.stream.getTracks().forEach((t) => t.stop());
  }

  /** Dibuja un fotograma (público para pruebas y para el primer frame). */
  draw(): void {
    const { ctx } = this;
    ctx.fillStyle = BG;
    ctx.fillRect(0, 0, OUTPUT_WIDTH, OUTPUT_HEIGHT);
    if (this.scene !== 'live') {
      this.drawCard(SCENE_TITLES[this.scene]);
      return;
    }
    if (!this.hasScreen || !ready(this.screen)) {
      this.drawCard('Volvemos enseguida');
      return;
    }
    const r = containRect(this.screen.videoWidth, this.screen.videoHeight, {
      x: 0,
      y: 0,
      w: OUTPUT_WIDTH,
      h: OUTPUT_HEIGHT,
    });
    ctx.drawImage(this.screen as HTMLVideoElement, r.x, r.y, r.w, r.h);
    if (this.hasCamera && ready(this.camera)) this.drawPip();
  }

  private drawPip() {
    const { ctx } = this;
    const box = pipRect();
    const crop = coverCrop(this.camera.videoWidth, this.camera.videoHeight, box.w, box.h);
    ctx.save();
    roundRect(ctx, box, 18);
    ctx.clip();
    ctx.drawImage(this.camera as HTMLVideoElement, crop.x, crop.y, crop.w, crop.h, box.x, box.y, box.w, box.h);
    ctx.restore();
    ctx.lineWidth = 3;
    ctx.strokeStyle = 'rgba(255,255,255,0.35)';
    roundRect(ctx, box, 18);
    ctx.stroke();
  }

  private drawCard(heading: string) {
    const { ctx } = this;
    const glow = ctx.createRadialGradient(
      OUTPUT_WIDTH / 2,
      OUTPUT_HEIGHT * 0.55,
      0,
      OUTPUT_WIDTH / 2,
      OUTPUT_HEIGHT * 0.55,
      OUTPUT_WIDTH * 0.6,
    );
    glow.addColorStop(0, 'rgba(255,107,26,0.30)');
    glow.addColorStop(1, 'rgba(11,11,15,0)');
    ctx.fillStyle = glow;
    ctx.fillRect(0, 0, OUTPUT_WIDTH, OUTPUT_HEIGHT);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = ACCENT;
    ctx.font = `600 34px ${FONT}`;
    ctx.fillText('TINT · EN VIVO', OUTPUT_WIDTH / 2, OUTPUT_HEIGHT * 0.36);
    ctx.fillStyle = '#ffffff';
    ctx.font = `700 120px ${FONT}`;
    ctx.fillText(heading, OUTPUT_WIDTH / 2, OUTPUT_HEIGHT * 0.5);
    if (this.title) {
      ctx.fillStyle = 'rgba(255,255,255,0.7)';
      ctx.font = `500 44px ${FONT}`;
      ctx.fillText(this.title, OUTPUT_WIDTH / 2, OUTPUT_HEIGHT * 0.62, OUTPUT_WIDTH * 0.8);
    }
  }

  private attach(video: VideoLike, track: MediaStreamTrack | null): boolean {
    if (!track) {
      video.pause();
      video.srcObject = null;
      return false;
    }
    video.srcObject = new MediaStream([track]);
    video.play().catch(() => {
      // Un elemento silenciado fuera del DOM puede reproducirse sin gesto; si no, se reintenta al dibujar.
    });
    return true;
  }
}

function ready(v: VideoLike): boolean {
  return v.readyState >= 2 && v.videoWidth > 0 && v.videoHeight > 0;
}

function roundRect(ctx: CanvasRenderingContext2D, r: Rect, radius: number) {
  ctx.beginPath();
  ctx.moveTo(r.x + radius, r.y);
  ctx.arcTo(r.x + r.w, r.y, r.x + r.w, r.y + r.h, radius);
  ctx.arcTo(r.x + r.w, r.y + r.h, r.x, r.y + r.h, radius);
  ctx.arcTo(r.x, r.y + r.h, r.x, r.y, radius);
  ctx.arcTo(r.x, r.y, r.x + r.w, r.y, radius);
  ctx.closePath();
}
