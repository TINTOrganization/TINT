/**
 * Mezclador de audio del host (HU-LIVE-01b, docs/dominio-transmision.md): junta el audio del PC
 * (sistema o pestaña), el micrófono y el escenario (voces invitadas) en una sola pista que viaja
 * por el WHIP de audio (Opus estéreo a 128 kbps). Cada fuente tiene su ganancia, su silencio y
 * su vúmetro. El audio del PC va sin AEC, NS ni AGC (es música o el sonido de un juego).
 *
 * Grafo: fuente(s) → ganancia de la fuente → analizador (vúmetro)
 *                                           ↘ MediaStreamDestination (salida estéreo)
 */

export type MixerSourceId = 'pc' | 'mic' | 'stage';

export const MIXER_SOURCES: readonly MixerSourceId[] = ['pc', 'mic', 'stage'];

/** Restricciones del audio del PC: sin procesamiento de voz (AC3). */
export const PC_AUDIO_CONSTRAINTS: MediaTrackConstraints = {
  echoCancellation: false,
  noiseSuppression: false,
  autoGainControl: false,
  channelCount: 2,
};

export const SYSTEM_AUDIO_UNAVAILABLE_MESSAGE =
  'Tu navegador o sistema no compartió el audio del PC. La transmisión sigue con el micrófono; ' +
  'para incluir el sonido, comparte una pestaña de Chrome o Edge y marca "Compartir audio".';

/** Ganancia máxima aceptada (200 %). */
export const MAX_GAIN = 2;

interface SourceChain {
  nodes: AudioNode[];
  gain: GainNode;
  analyser: AnalyserNode;
  buffer: Float32Array;
  tracks: MediaStreamTrack[];
}

type AudioContextCtor = new () => AudioContext;

export class AudioMixer {
  readonly output: MediaStream;
  systemAudioUnavailable = false;
  systemAudioMessage: string | null = null;

  private readonly ctx: AudioContext;
  private readonly destination: MediaStreamAudioDestinationNode;
  private readonly chains = new Map<MixerSourceId, SourceChain>();
  private readonly gains: Record<MixerSourceId, number> = { pc: 1, mic: 1, stage: 1 };
  private readonly muted: Record<MixerSourceId, boolean> = { pc: false, mic: false, stage: false };

  constructor() {
    const Ctor = (globalThis as { AudioContext?: AudioContextCtor }).AudioContext;
    if (!Ctor) throw new Error('Este navegador no permite mezclar audio (Web Audio).');
    this.ctx = new Ctor();
    this.destination = this.ctx.createMediaStreamDestination();
    // Estéreo de punta a punta (la música del PC no se colapsa a mono).
    this.destination.channelCount = 2;
    this.output = this.destination.stream;
  }

  /** Conecta (o reemplaza) una fuente con las pistas de audio de `stream`. */
  addSource(id: MixerSourceId, stream: MediaStream): void {
    this.removeSource(id);
    const tracks = stream.getAudioTracks();
    if (id === 'pc') {
      this.systemAudioUnavailable = tracks.length === 0;
      this.systemAudioMessage = this.systemAudioUnavailable ? SYSTEM_AUDIO_UNAVAILABLE_MESSAGE : null;
      for (const track of tracks) {
        // Sin AEC/NS/AGC; si el navegador no lo permite, se sigue con lo que entregue.
        track.applyConstraints(PC_AUDIO_CONSTRAINTS).catch(() => {});
      }
    }
    if (tracks.length === 0) return;
    const gain = this.ctx.createGain();
    const analyser = this.ctx.createAnalyser();
    analyser.fftSize = 1024;
    // Una fuente por pista: createMediaStreamSource solo usa la primera pista de un stream.
    const nodes = tracks.map((track) => {
      const node = this.ctx.createMediaStreamSource(new MediaStream([track]));
      node.connect(gain);
      return node as AudioNode;
    });
    gain.connect(analyser);
    gain.connect(this.destination);
    this.chains.set(id, {
      nodes,
      gain,
      analyser,
      buffer: new Float32Array(analyser.fftSize),
      tracks,
    });
    this.apply(id);
  }

  removeSource(id: MixerSourceId): void {
    const chain = this.chains.get(id);
    if (!chain) return;
    for (const n of chain.nodes) n.disconnect();
    chain.gain.disconnect();
    chain.analyser.disconnect();
    this.chains.delete(id);
  }

  hasSource(id: MixerSourceId): boolean {
    return this.chains.has(id);
  }

  /** Ganancia lineal 0..MAX_GAIN; valores negativos o no numéricos se ignoran. */
  setGain(id: MixerSourceId, value: number): void {
    if (!Number.isFinite(value) || value < 0) return;
    this.gains[id] = Math.min(value, MAX_GAIN);
    this.apply(id);
  }

  getGain(id: MixerSourceId): number {
    return this.gains[id];
  }

  setMuted(id: MixerSourceId, muted: boolean): void {
    this.muted[id] = muted;
    this.apply(id);
  }

  isMuted(id: MixerSourceId): boolean {
    return this.muted[id];
  }

  /** Nivel RMS (0..1) de la fuente después de su ganancia, para el vúmetro. */
  level(id: MixerSourceId): number {
    const chain = this.chains.get(id);
    if (!chain) return 0;
    chain.analyser.getFloatTimeDomainData(chain.buffer);
    let sum = 0;
    for (const v of chain.buffer) sum += v * v;
    return Math.min(1, Math.sqrt(sum / chain.buffer.length));
  }

  /** El navegador suspende el AudioContext sin un gesto: se reanuda al publicar. */
  async resume(): Promise<void> {
    if (this.ctx.state === 'suspended') await this.ctx.resume();
  }

  dispose(): void {
    for (const id of [...this.chains.keys()]) this.removeSource(id);
    this.destination.disconnect();
    void this.ctx.close().catch(() => {});
  }

  private apply(id: MixerSourceId) {
    const chain = this.chains.get(id);
    if (!chain) return;
    chain.gain.gain.value = this.muted[id] ? 0 : this.gains[id];
  }
}
