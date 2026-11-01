import type { EnergySample } from './speaking';
import type { SignalData, VoiceIceServer } from './voiceProtocol';

export interface MeshDeps {
  createPeerConnection: (config: RTCConfiguration) => RTCPeerConnection;
  sendSignal: (to: string, data: SignalData) => void;
  onRemoteStream: (peerId: string, stream: MediaStream) => void;
  onConnectionState?: (peerId: string, state: RTCPeerConnectionState) => void;
  /** Espera antes de reiniciar ICE en `disconnected` (suele recuperarse solo). */
  disconnectGraceMs?: number;
}

/** Espera por defecto antes de reiniciar ICE en una conexión `disconnected`. */
export const DISCONNECT_GRACE_MS = 3000;

interface PeerLink {
  pc: RTCPeerConnection;
  polite: boolean;
  makingOffer: boolean;
  ignoreOffer: boolean;
  graceTimer: ReturnType<typeof setTimeout> | null;
}

/**
 * Malla WebRTC de la voz: una `RTCPeerConnection` por cada otro miembro.
 *
 * - **Quien llega ofrece** (`connectTo`); los que ya estaban crean la conexión al recibir la
 *   oferta. Para renegociar (reinicio de ICE) se usa *perfect negotiation*: ante ofertas
 *   cruzadas cede el `polite` (el de `peer_id` menor), el otro ignora la ajena.
 * - **Silenciarse** quita la pista del emisor (`replaceTrack(null)`): no se envía audio, ni
 *   siquiera silencio (HU-VOZ-02 AC1).
 * - **Redes:** `failed` reinicia ICE al momento; `disconnected` tras una espera. El
 *   navegador prueba la ruta directa antes que el relay TURN (HU-VOZ-05 AC2).
 */
export class VoiceMesh {
  private readonly links = new Map<string, PeerLink>();
  private sending = true;
  private closed = false;

  constructor(
    private readonly selfId: string,
    private readonly iceServers: VoiceIceServer[],
    private readonly track: MediaStreamTrack | null,
    private readonly deps: MeshDeps,
  ) {}

  /** Inicia la conexión con un peer que ya estaba en la voz (este cliente ofrece). */
  connectTo(peerId: string) {
    if (this.closed || this.links.has(peerId)) return;
    const link = this.createLink(peerId);
    link.pc.addTransceiver(this.outgoingTrack() ?? 'audio', { direction: 'sendrecv' });
  }

  async handleSignal(from: string, data: SignalData): Promise<void> {
    if (this.closed) return;
    const link = this.links.get(from) ?? this.createLink(from);
    const { pc } = link;

    if ('description' in data) {
      const description = data.description;
      const collision = description.type === 'offer' && (link.makingOffer || pc.signalingState !== 'stable');
      link.ignoreOffer = !link.polite && collision;
      if (link.ignoreOffer) return;
      await pc.setRemoteDescription(description);
      if (description.type !== 'offer') return;
      await this.prepareAnswer(pc);
      await pc.setLocalDescription();
      this.sendDescription(from, pc);
      return;
    }

    if (!data.candidate) return; // fin de candidatos
    try {
      await pc.addIceCandidate(data.candidate);
    } catch (err) {
      // Candidatos de una oferta que se ignoró a propósito: es normal que fallen.
      if (!link.ignoreOffer) throw err;
    }
  }

  /** Envía o deja de enviar el micrófono en todas las conexiones. */
  async setSending(on: boolean): Promise<void> {
    this.sending = on;
    const track = this.outgoingTrack();
    await Promise.all(
      [...this.links.values()].flatMap(({ pc }) =>
        pc.getTransceivers().map((t) => t.sender.replaceTrack(track)),
      ),
    );
  }

  /** Energía de audio recibida de cada peer (para saber quién habla). */
  async energySamples(): Promise<Record<string, EnergySample>> {
    const out: Record<string, EnergySample> = {};
    await Promise.all(
      [...this.links].map(async ([peerId, { pc }]) => {
        try {
          const report = await pc.getStats();
          report.forEach((s: { type?: string; kind?: string; totalAudioEnergy?: number; totalSamplesDuration?: number }) => {
            if (s.type !== 'inbound-rtp' || s.kind !== 'audio') return;
            out[peerId] = { energy: s.totalAudioEnergy ?? 0, duration: s.totalSamplesDuration ?? 0 };
          });
        } catch {
          // Conexión cerrándose: ese peer simplemente no cuenta en esta lectura.
        }
      }),
    );
    return out;
  }

  /** Reinicia ICE en todas las conexiones (cambio de red). */
  restartIce() {
    for (const { pc } of this.links.values()) pc.restartIce();
  }

  remove(peerId: string) {
    const link = this.links.get(peerId);
    if (!link) return;
    if (link.graceTimer) clearTimeout(link.graceTimer);
    link.pc.close();
    this.links.delete(peerId);
  }

  close() {
    this.closed = true;
    for (const peerId of [...this.links.keys()]) this.remove(peerId);
  }

  peerIds(): string[] {
    return [...this.links.keys()];
  }

  private outgoingTrack(): MediaStreamTrack | null {
    return this.sending ? this.track : null;
  }

  private createLink(peerId: string): PeerLink {
    const pc = this.deps.createPeerConnection({ iceServers: this.iceServers });
    const link: PeerLink = { pc, polite: this.selfId < peerId, makingOffer: false, ignoreOffer: false, graceTimer: null };
    this.links.set(peerId, link);

    pc.onnegotiationneeded = async () => {
      try {
        link.makingOffer = true;
        await pc.setLocalDescription();
        this.sendDescription(peerId, pc);
      } finally {
        link.makingOffer = false;
      }
    };
    pc.onicecandidate = ({ candidate }) => {
      this.deps.sendSignal(peerId, { candidate: candidate ? candidate.toJSON() : null });
    };
    pc.ontrack = (ev) => {
      this.deps.onRemoteStream(peerId, ev.streams[0] ?? new MediaStream([ev.track]));
    };
    pc.onconnectionstatechange = () => {
      const state = pc.connectionState;
      this.deps.onConnectionState?.(peerId, state);
      if (link.graceTimer) {
        clearTimeout(link.graceTimer);
        link.graceTimer = null;
      }
      if (state === 'failed') {
        pc.restartIce();
      } else if (state === 'disconnected') {
        link.graceTimer = setTimeout(() => {
          link.graceTimer = null;
          if (pc.connectionState === 'disconnected') pc.restartIce();
        }, this.deps.disconnectGraceMs ?? DISCONNECT_GRACE_MS);
      }
    };
    return link;
  }

  /** Al responder, la conexión también envía (si no está silenciado). */
  private async prepareAnswer(pc: RTCPeerConnection) {
    const transceiver = pc.getTransceivers().find((t) => t.receiver.track.kind === 'audio');
    if (!transceiver) return;
    transceiver.direction = 'sendrecv';
    await transceiver.sender.replaceTrack(this.outgoingTrack());
  }

  private sendDescription(peerId: string, pc: RTCPeerConnection) {
    const local = pc.localDescription;
    if (!local) return;
    this.deps.sendSignal(peerId, { description: { type: local.type, sdp: local.sdp } });
  }
}
