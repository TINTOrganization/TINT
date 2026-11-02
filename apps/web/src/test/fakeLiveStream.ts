/**
 * Dobles de prueba para la transmisión en vivo (WHIP/WHEP + WebAudio), que jsdom no trae:
 * pistas y streams de captura, PeerConnection con DataChannel y oferta, AudioContext mínimo
 * y respuestas HTTP de stream-core. Solo imitan lo que usan `useLiveStream` y `AudioMixer`.
 */

type Listener = (ev: unknown) => void;

let trackSeq = 0;

export class FakeMediaTrack {
  readonly id: string;
  readonly kind: 'audio' | 'video';
  readonly label: string;
  enabled = true;
  readyState: 'live' | 'ended' = 'live';
  stopped = false;
  /** Restricciones aplicadas con applyConstraints (en orden). */
  constraints: MediaTrackConstraints[] = [];
  contentHint = '';
  onended: Listener | null = null;
  private listeners = new Map<string, Set<Listener>>();

  constructor(kind: 'audio' | 'video', label: string = kind) {
    trackSeq += 1;
    this.id = `${kind}-${trackSeq}`;
    this.kind = kind;
    this.label = label;
  }

  stop() {
    this.stopped = true;
    this.readyState = 'ended';
  }

  async applyConstraints(c: MediaTrackConstraints = {}) {
    this.constraints.push(c);
  }

  getSettings() {
    return {};
  }

  getConstraints() {
    return this.constraints[this.constraints.length - 1] ?? {};
  }

  clone() {
    return new FakeMediaTrack(this.kind, this.label);
  }

  addEventListener(type: string, fn: Listener) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type)?.add(fn);
  }

  removeEventListener(type: string, fn: Listener) {
    this.listeners.get(type)?.delete(fn);
  }

  /** Simula "Dejar de compartir" del navegador. */
  end() {
    this.readyState = 'ended';
    this.onended?.({});
    this.listeners.get('ended')?.forEach((fn) => fn({}));
  }
}

export class FakeMediaStream {
  readonly id = `stream-${(trackSeq += 1)}`;
  tracks: FakeMediaTrack[];
  constructor(tracks: FakeMediaTrack[] = []) {
    this.tracks = [...tracks];
  }
  getTracks() {
    return [...this.tracks];
  }
  getAudioTracks() {
    return this.tracks.filter((t) => t.kind === 'audio');
  }
  getVideoTracks() {
    return this.tracks.filter((t) => t.kind === 'video');
  }
  addTrack(t: FakeMediaTrack) {
    this.tracks.push(t);
  }
  removeTrack(t: FakeMediaTrack) {
    this.tracks = this.tracks.filter((x) => x !== t);
  }
}

export class FakeDataChannel {
  readonly label: string;
  readonly init: RTCDataChannelInit | undefined;
  readyState: RTCDataChannelState = 'open';
  sent: string[] = [];
  onmessage: Listener | null = null;
  onopen: Listener | null = null;
  onclose: Listener | null = null;
  private listeners = new Map<string, Set<Listener>>();

  constructor(label: string, init?: RTCDataChannelInit) {
    this.label = label;
    this.init = init;
  }
  get id() {
    return this.init?.id ?? null;
  }
  get negotiated() {
    return this.init?.negotiated ?? false;
  }
  send(data: string) {
    this.sent.push(data);
  }
  close() {
    this.readyState = 'closed';
  }
  addEventListener(type: string, fn: Listener) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type)?.add(fn);
  }
  removeEventListener(type: string, fn: Listener) {
    this.listeners.get(type)?.delete(fn);
  }
  /** Simula un mensaje del servidor (los objetos se serializan a JSON). */
  emit(payload: unknown) {
    const data = typeof payload === 'string' ? payload : JSON.stringify(payload);
    const ev = { data };
    this.onmessage?.(ev);
    this.listeners.get('message')?.forEach((fn) => fn(ev));
  }
}

export interface FakeStreamTransceiver {
  kind: 'audio' | 'video';
  direction: RTCRtpTransceiverDirection;
  init: RTCRtpTransceiverInit | undefined;
  codecPreferences: unknown[] | null;
  setCodecPreferences: (codecs: unknown[]) => void;
  sender: {
    track: FakeMediaTrack | null;
    replaceTrack: (t: FakeMediaTrack | null) => Promise<void>;
    getParameters: () => { encodings: RTCRtpEncodingParameters[] };
    setParameters: (p: unknown) => Promise<void>;
  };
  receiver: { track: FakeMediaTrack };
}

let pcSeq = 0;

export class FakeStreamPeerConnection {
  static instances: FakeStreamPeerConnection[] = [];

  readonly seq: number;
  config: RTCConfiguration | undefined;
  /** Orden de las llamadas relevantes (p. ej. createDataChannel antes de createOffer). */
  calls: string[] = [];
  transceivers: FakeStreamTransceiver[] = [];
  channels: FakeDataChannel[] = [];
  localDescription: RTCSessionDescriptionInit | null = null;
  remoteDescription: RTCSessionDescriptionInit | null = null;
  iceGatheringState: RTCIceGatheringState = 'complete';
  connectionState: RTCPeerConnectionState = 'new';
  iceConnectionState: RTCIceConnectionState = 'new';
  signalingState: RTCSignalingState = 'stable';
  closed = false;
  onicecandidate: Listener | null = null;
  ontrack: Listener | null = null;
  onconnectionstatechange: Listener | null = null;
  oniceconnectionstatechange: Listener | null = null;
  onicegatheringstatechange: Listener | null = null;
  onnegotiationneeded: Listener | null = null;
  private listeners = new Map<string, Set<Listener>>();

  constructor(config?: RTCConfiguration) {
    pcSeq += 1;
    this.seq = pcSeq;
    this.config = config;
    FakeStreamPeerConnection.instances.push(this);
  }

  static reset() {
    FakeStreamPeerConnection.instances = [];
  }

  addTransceiver(trackOrKind: FakeMediaTrack | 'audio' | 'video', init?: RTCRtpTransceiverInit) {
    this.calls.push('addTransceiver');
    const track = typeof trackOrKind === 'string' ? null : trackOrKind;
    const kind = typeof trackOrKind === 'string' ? trackOrKind : trackOrKind.kind;
    const t: FakeStreamTransceiver = {
      kind,
      direction: init?.direction ?? 'sendrecv',
      init,
      codecPreferences: null,
      setCodecPreferences(codecs) {
        this.codecPreferences = codecs;
      },
      sender: {
        track,
        async replaceTrack(next) {
          this.track = next;
        },
        getParameters: () => ({ encodings: (init?.sendEncodings ?? []) as RTCRtpEncodingParameters[] }),
        async setParameters() {},
      },
      receiver: { track: new FakeMediaTrack(kind) },
    };
    this.transceivers.push(t);
    return t;
  }

  addTrack(track: FakeMediaTrack) {
    this.calls.push('addTrack');
    const t = this.addTransceiver(track, { direction: 'sendrecv' });
    this.calls.pop();
    return t.sender;
  }

  getTransceivers() {
    return this.transceivers;
  }

  getSenders() {
    return this.transceivers.map((t) => t.sender);
  }

  getReceivers() {
    return this.transceivers.map((t) => t.receiver);
  }

  createDataChannel(label: string, init?: RTCDataChannelInit) {
    this.calls.push('createDataChannel');
    const dc = new FakeDataChannel(label, init);
    this.channels.push(dc);
    return dc;
  }

  /** SDP único por PeerConnection para identificar a qué POST pertenece. */
  get offerSdp() {
    return `v=0\r\no=- ${this.seq} 2 IN IP4 127.0.0.1\r\ns=offer-${this.seq}\r\n`;
  }

  async createOffer() {
    this.calls.push('createOffer');
    return { type: 'offer' as const, sdp: this.offerSdp };
  }

  async setLocalDescription(desc?: RTCSessionDescriptionInit) {
    this.calls.push('setLocalDescription');
    this.localDescription = desc ?? { type: 'offer', sdp: this.offerSdp };
    this.signalingState = 'have-local-offer';
  }

  async setRemoteDescription(desc: RTCSessionDescriptionInit) {
    this.calls.push('setRemoteDescription');
    this.remoteDescription = desc;
    this.signalingState = 'stable';
  }

  async addIceCandidate() {}

  getConfiguration() {
    return this.config ?? {};
  }

  setConfiguration(c: RTCConfiguration) {
    this.config = c;
  }

  async getStats() {
    return new Map();
  }

  restartIce() {}

  close() {
    this.closed = true;
    this.connectionState = 'closed';
  }

  addEventListener(type: string, fn: Listener) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type)?.add(fn);
  }

  removeEventListener(type: string, fn: Listener) {
    this.listeners.get(type)?.delete(fn);
  }

  // --- Ayudas de prueba ---
  /** DataChannel `stream-events` creado por el cliente. */
  get eventsChannel() {
    return this.channels.find((c) => c.label === 'stream-events') ?? null;
  }

  /** ¿Envía una pista de este tipo? */
  sends(kind: 'audio' | 'video') {
    return this.transceivers.some(
      (t) => t.kind === kind && t.sender.track !== null && (t.direction === 'sendonly' || t.direction === 'sendrecv'),
    );
  }

  emitTrack(track: FakeMediaTrack, stream = new FakeMediaStream([track])) {
    const ev = { track, streams: [stream], receiver: { track } };
    this.ontrack?.(ev);
    this.listeners.get('track')?.forEach((fn) => fn(ev));
  }

  setConnectionState(state: RTCPeerConnectionState) {
    this.connectionState = state;
    this.onconnectionstatechange?.({});
    this.listeners.get('connectionstatechange')?.forEach((fn) => fn({}));
  }
}

// --- WebAudio mínimo ---

export class FakeAudioParam {
  value: number;
  constructor(value = 1) {
    this.value = value;
  }
  setValueAtTime(v: number) {
    this.value = v;
    return this;
  }
  setTargetAtTime(v: number) {
    this.value = v;
    return this;
  }
  linearRampToValueAtTime(v: number) {
    this.value = v;
    return this;
  }
  exponentialRampToValueAtTime(v: number) {
    this.value = v;
    return this;
  }
  cancelScheduledValues() {
    return this;
  }
}

export class FakeAudioNode {
  readonly type: string;
  connections: FakeAudioNode[] = [];
  disconnected = false;
  channelCount = 2;
  constructor(type: string) {
    this.type = type;
  }
  connect<T extends FakeAudioNode>(dest: T): T {
    this.connections.push(dest);
    return dest;
  }
  disconnect(dest?: FakeAudioNode) {
    if (dest) this.connections = this.connections.filter((n) => n !== dest);
    else {
      this.connections = [];
      this.disconnected = true;
    }
  }
}

export class FakeGainNode extends FakeAudioNode {
  gain = new FakeAudioParam(1);
  constructor() {
    super('gain');
  }
}

export class FakeSourceNode extends FakeAudioNode {
  /** Stream o pista de la que sale el audio. */
  readonly input: FakeMediaStream | FakeMediaTrack;
  constructor(input: FakeMediaStream | FakeMediaTrack) {
    super('source');
    this.input = input;
  }
  get tracks(): FakeMediaTrack[] {
    return this.input instanceof FakeMediaStream ? this.input.getAudioTracks() : [this.input];
  }
}

export class FakeAnalyserNode extends FakeAudioNode {
  fftSize = 2048;
  frequencyBinCount = 1024;
  constructor() {
    super('analyser');
  }
  getFloatTimeDomainData(arr: Float32Array) {
    arr.fill(0);
  }
  getByteTimeDomainData(arr: Uint8Array) {
    arr.fill(128);
  }
  getByteFrequencyData(arr: Uint8Array) {
    arr.fill(0);
  }
}

export class FakeDestinationNode extends FakeAudioNode {
  stream: FakeMediaStream;
  constructor() {
    super('destination');
    this.stream = new FakeMediaStream([new FakeMediaTrack('audio', 'mix')]);
  }
}

export class FakeAudioContext {
  static instances: FakeAudioContext[] = [];
  state: AudioContextState = 'running';
  currentTime = 0;
  sampleRate = 48_000;
  sources: FakeSourceNode[] = [];
  gains: FakeGainNode[] = [];
  analysers: FakeAnalyserNode[] = [];
  destinations: FakeDestinationNode[] = [];
  destination = new FakeAudioNode('speakers');
  closed = false;

  constructor() {
    FakeAudioContext.instances.push(this);
  }

  static reset() {
    FakeAudioContext.instances = [];
  }

  createMediaStreamSource(stream: FakeMediaStream) {
    const n = new FakeSourceNode(stream);
    this.sources.push(n);
    return n;
  }
  createMediaStreamTrackSource(track: FakeMediaTrack) {
    const n = new FakeSourceNode(track);
    this.sources.push(n);
    return n;
  }
  createGain() {
    const n = new FakeGainNode();
    this.gains.push(n);
    return n;
  }
  createAnalyser() {
    const n = new FakeAnalyserNode();
    this.analysers.push(n);
    return n;
  }
  createMediaStreamDestination() {
    const n = new FakeDestinationNode();
    this.destinations.push(n);
    return n;
  }
  async resume() {
    this.state = 'running';
  }
  async close() {
    this.closed = true;
    this.state = 'closed';
  }

  // --- Ayudas de prueba ---
  /** Nodo fuente creado para esa pista (directo o dentro de un stream). */
  sourceFor(track: FakeMediaTrack) {
    return this.sources.find((s) => s.tracks.includes(track)) ?? null;
  }
  /** Ganancia propia de la fuente: el primer GainNode conectado a su nodo fuente. */
  gainFor(track: FakeMediaTrack) {
    const src = this.sourceFor(track);
    if (!src) return null;
    const visited = new Set<FakeAudioNode>();
    const queue: FakeAudioNode[] = [...src.connections];
    while (queue.length) {
      const n = queue.shift() as FakeAudioNode;
      if (visited.has(n)) continue;
      visited.add(n);
      if (n instanceof FakeGainNode) return n;
      queue.push(...n.connections);
    }
    return null;
  }
  /** ¿Llega la fuente a algún MediaStreamDestination (la mezcla que se transmite)? */
  reachesOutput(track: FakeMediaTrack) {
    const src = this.sourceFor(track);
    if (!src) return false;
    const visited = new Set<FakeAudioNode>();
    const queue: FakeAudioNode[] = [...src.connections];
    while (queue.length) {
      const n = queue.shift() as FakeAudioNode;
      if (n instanceof FakeDestinationNode) return true;
      if (visited.has(n)) continue;
      visited.add(n);
      queue.push(...n.connections);
    }
    return false;
  }
}

// --- HTTP de stream-core ---

export interface FakeResponseInit {
  status: number;
  body?: string;
  json?: unknown;
  headers?: Record<string, string>;
}

/** Respuesta mínima compatible con lo que lee un cliente WHIP/WHEP. */
export function fakeResponse({ status, body, json, headers = {} }: FakeResponseInit) {
  const text = body ?? (json !== undefined ? JSON.stringify(json) : '');
  return {
    status,
    ok: status >= 200 && status < 300,
    statusText: String(status),
    headers: new Headers(headers),
    text: async () => text,
    json: async () => (json !== undefined ? json : JSON.parse(text)),
  } as unknown as Response;
}

/** 201 de WHIP/WHEP con SDP de respuesta y Location de la sesión. */
export function sdpCreated(sessionId: string, answer = `v=0\r\ns=answer-${sessionId}\r\n`) {
  return fakeResponse({
    status: 201,
    body: answer,
    headers: {
      'Content-Type': 'application/sdp',
      Location: `/api/v1/stream/sessions/${sessionId}`,
      Link: '<turn:turn.test:3478?transport=udp>; rel="ice-server"; username="u"; credential="p"',
    },
  });
}

/** Error JSON `{error, message}` de stream-core. */
export function streamError(status: number, error: string, message = error) {
  return fakeResponse({ status, json: { error, message }, headers: { 'Content-Type': 'application/json' } });
}

/** Normaliza los headers de un RequestInit (objeto, array o Headers). */
export function headersOf(init: RequestInit | undefined) {
  return new Headers(init?.headers);
}

export async function flushLive(times = 10) {
  for (let i = 0; i < times; i += 1) await Promise.resolve();
}
