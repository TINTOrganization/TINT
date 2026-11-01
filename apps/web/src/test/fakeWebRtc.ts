/**
 * Dobles mínimos de WebRTC y getUserMedia para jsdom (que no los trae). Imitan solo lo que
 * usan `VoiceMesh` y `useVoiceChannel`: transceivers, descripciones, candidatos y estados.
 */

export class FakeTrack {
  kind = 'audio';
  enabled = true;
  stopped = false;
  stop() {
    this.stopped = true;
  }
}

export class FakeStream {
  tracks: FakeTrack[];
  constructor(tracks: FakeTrack[] = [new FakeTrack()]) {
    this.tracks = tracks;
  }
  getTracks() {
    return this.tracks;
  }
  getAudioTracks() {
    return this.tracks;
  }
}

export class FakeSender {
  track: unknown = null;
  replaced: unknown[] = [];
  async replaceTrack(track: unknown) {
    this.track = track;
    this.replaced.push(track);
  }
}

export class FakeTransceiver {
  direction: RTCRtpTransceiverDirection;
  sender = new FakeSender();
  receiver = { track: { kind: 'audio' } };
  constructor(direction: RTCRtpTransceiverDirection) {
    this.direction = direction;
  }
}

type Handler<T = void> = ((ev: T) => void) | null;

export class FakePeerConnection {
  static instances: FakePeerConnection[] = [];

  config: RTCConfiguration;
  signalingState: RTCSignalingState = 'stable';
  connectionState: RTCPeerConnectionState = 'new';
  localDescription: { type: RTCSdpType; sdp: string } | null = null;
  remoteDescription: RTCSessionDescriptionInit | null = null;
  transceivers: FakeTransceiver[] = [];
  candidates: unknown[] = [];
  restarts = 0;
  closed = false;
  /** Informes que devuelve getStats(). */
  stats: Array<Record<string, unknown>> = [];
  onnegotiationneeded: Handler = null;
  onicecandidate: Handler<{ candidate: unknown }> = null;
  ontrack: Handler<{ track: unknown; streams: unknown[] }> = null;
  onconnectionstatechange: Handler = null;

  constructor(config: RTCConfiguration) {
    this.config = config;
    FakePeerConnection.instances.push(this);
  }

  addTransceiver(trackOrKind: unknown, init?: RTCRtpTransceiverInit) {
    const t = new FakeTransceiver(init?.direction ?? 'sendrecv');
    if (typeof trackOrKind !== 'string') t.sender.track = trackOrKind;
    this.transceivers.push(t);
    queueMicrotask(() => this.onnegotiationneeded?.());
    return t;
  }

  getTransceivers() {
    return this.transceivers;
  }

  async setLocalDescription() {
    if (this.signalingState === 'have-remote-offer') {
      this.localDescription = { type: 'answer', sdp: `answer-${this.transceivers[0]?.direction}` };
      this.signalingState = 'stable';
    } else {
      this.localDescription = { type: 'offer', sdp: `offer-${this.restarts}` };
      this.signalingState = 'have-local-offer';
    }
  }

  async setRemoteDescription(desc: RTCSessionDescriptionInit) {
    this.remoteDescription = desc;
    if (desc.type === 'offer') {
      this.signalingState = 'have-remote-offer';
      if (this.transceivers.length === 0) this.transceivers.push(new FakeTransceiver('recvonly'));
    } else {
      this.signalingState = 'stable';
    }
  }

  async addIceCandidate(candidate: unknown) {
    if (!this.remoteDescription) throw new Error('sin descripción remota');
    this.candidates.push(candidate);
  }

  async getStats() {
    return { forEach: (fn: (s: Record<string, unknown>) => void) => this.stats.forEach(fn) };
  }

  restartIce() {
    this.restarts += 1;
    queueMicrotask(() => this.onnegotiationneeded?.());
  }

  close() {
    this.closed = true;
  }

  // --- Ayudas de prueba ---
  setConnectionState(state: RTCPeerConnectionState) {
    this.connectionState = state;
    this.onconnectionstatechange?.();
  }
  emitTrack(stream: FakeStream) {
    this.ontrack?.({ track: stream.tracks[0], streams: [stream] });
  }
  emitCandidate(candidate: unknown) {
    this.onicecandidate?.({ candidate });
  }
}

/** Deja correr las promesas y microtareas pendientes. */
export async function flushAsync(times = 5) {
  for (let i = 0; i < times; i += 1) await Promise.resolve();
}
