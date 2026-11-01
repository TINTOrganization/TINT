import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { VoiceMesh, type MeshDeps } from './voiceMesh';
import type { SignalData } from './voiceProtocol';
import { FakePeerConnection, FakeStream, FakeTrack, flushAsync } from '../test/fakeWebRtc';

const ICE = [{ urls: ['stun:s'] }, { urls: 'turn:t', username: 'u', credential: 'c' }];

let signals: Array<{ to: string; data: SignalData }>;
let streams: Array<{ peerId: string; stream: unknown }>;
let states: Array<{ peerId: string; state: string }>;

function deps(extra: Partial<MeshDeps> = {}): MeshDeps {
  return {
    createPeerConnection: (config) => new FakePeerConnection(config) as unknown as RTCPeerConnection,
    sendSignal: (to, data) => signals.push({ to, data }),
    onRemoteStream: (peerId, stream) => streams.push({ peerId, stream }),
    onConnectionState: (peerId, state) => states.push({ peerId, state }),
    ...extra,
  };
}

function pc(i = FakePeerConnection.instances.length - 1) {
  return FakePeerConnection.instances[i];
}

const track = new FakeTrack() as unknown as MediaStreamTrack;

beforeEach(() => {
  FakePeerConnection.instances = [];
  signals = [];
  streams = [];
  states = [];
});

afterEach(() => vi.useRealTimers());

describe('VoiceMesh — quien llega ofrece (HU-VOZ-01 AC1)', () => {
  it('connectTo crea la conexión con los ICE servers y envía la oferta', async () => {
    const mesh = new VoiceMesh('me', ICE, track, deps());
    mesh.connectTo('p1');
    await flushAsync();
    expect(pc().config.iceServers).toEqual(ICE);
    expect(pc().transceivers[0].direction).toBe('sendrecv');
    expect(pc().transceivers[0].sender.track).toBe(track);
    expect(signals).toEqual([{ to: 'p1', data: { description: { type: 'offer', sdp: 'offer-0' } } }]);
    expect(mesh.peerIds()).toEqual(['p1']);
  });

  it('el que ya estaba responde a la oferta enviando su audio', async () => {
    const mesh = new VoiceMesh('me', ICE, track, deps());
    await mesh.handleSignal('p1', { description: { type: 'offer', sdp: 'o' } });
    const t = pc().transceivers[0];
    expect(t.direction).toBe('sendrecv');
    expect(t.sender.track).toBe(track);
    expect(signals).toEqual([{ to: 'p1', data: { description: { type: 'answer', sdp: 'answer-sendrecv' } } }]);
  });

  it('reenvía candidatos en ambos sentidos', async () => {
    const mesh = new VoiceMesh('me', ICE, track, deps());
    mesh.connectTo('p1');
    await flushAsync();
    pc().emitCandidate({ toJSON: () => ({ candidate: 'c1', sdpMid: '0' }) });
    pc().emitCandidate(null);
    expect(signals.slice(1)).toEqual([
      { to: 'p1', data: { candidate: { candidate: 'c1', sdpMid: '0' } } },
      { to: 'p1', data: { candidate: null } },
    ]);
    await mesh.handleSignal('p1', { description: { type: 'answer', sdp: 'a' } });
    await mesh.handleSignal('p1', { candidate: { candidate: 'r1' } });
    expect(pc().candidates).toEqual([{ candidate: 'r1' }]);
  });

  it('entrega el audio remoto', () => {
    const mesh = new VoiceMesh('me', ICE, track, deps());
    mesh.connectTo('p1');
    const stream = new FakeStream();
    pc().emitTrack(stream);
    expect(streams).toEqual([{ peerId: 'p1', stream }]);
  });
});

describe('VoiceMesh — silenciarse (HU-VOZ-02)', () => {
  it('setSending(false) quita la pista (no se envía audio) y true la devuelve', async () => {
    const mesh = new VoiceMesh('me', ICE, track, deps());
    mesh.connectTo('p1');
    await mesh.handleSignal('p2', { description: { type: 'offer', sdp: 'o' } });
    await mesh.setSending(false);
    for (const c of FakePeerConnection.instances) expect(c.transceivers[0].sender.track).toBeNull();
    await mesh.setSending(true);
    for (const c of FakePeerConnection.instances) expect(c.transceivers[0].sender.track).toBe(track);
  });

  it('las conexiones nuevas respetan el silencio', async () => {
    const mesh = new VoiceMesh('me', ICE, track, deps());
    await mesh.setSending(false);
    mesh.connectTo('p1');
    expect(pc().transceivers[0].sender.track).toBeNull();
    await mesh.handleSignal('p2', { description: { type: 'offer', sdp: 'o' } });
    expect(pc().transceivers[0].sender.track).toBeNull();
    expect(pc().transceivers[0].direction).toBe('sendrecv');
  });
});

describe('VoiceMesh — perfect negotiation', () => {
  it('el impolite ignora una oferta que choca con la suya', async () => {
    // 'z' > 'a': con el criterio selfId < peerId, 'z' es impolite frente a 'a'.
    const mesh = new VoiceMesh('z', ICE, track, deps());
    mesh.connectTo('a');
    await flushAsync();
    await mesh.handleSignal('a', { description: { type: 'offer', sdp: 'choque' } });
    expect(pc().remoteDescription).toBeNull();
    // Los candidatos de la oferta ignorada no rompen nada.
    await expect(mesh.handleSignal('a', { candidate: { candidate: 'x' } })).resolves.toBeUndefined();
  });

  it('el polite acepta la oferta ajena y responde', async () => {
    const mesh = new VoiceMesh('a', ICE, track, deps());
    mesh.connectTo('z');
    await flushAsync();
    await mesh.handleSignal('z', { description: { type: 'offer', sdp: 'choque' } });
    expect(pc().remoteDescription).toEqual({ type: 'offer', sdp: 'choque' });
    expect(signals.at(-1)?.data).toEqual({ description: { type: 'answer', sdp: 'answer-sendrecv' } });
  });

  it('un candidato que falla fuera de un choque se reporta', async () => {
    const mesh = new VoiceMesh('me', ICE, track, deps());
    await expect(mesh.handleSignal('p1', { candidate: { candidate: 'x' } })).rejects.toThrow();
  });
});

describe('VoiceMesh — redes (HU-VOZ-05 AC3)', () => {
  it('reinicia ICE cuando la conexión falla', async () => {
    const mesh = new VoiceMesh('me', ICE, track, deps());
    mesh.connectTo('p1');
    await flushAsync();
    pc().setConnectionState('failed');
    expect(pc().restarts).toBe(1);
    expect(states).toEqual([{ peerId: 'p1', state: 'failed' }]);
    await flushAsync();
    expect(signals.at(-1)?.data).toEqual({ description: { type: 'offer', sdp: 'offer-1' } });
  });

  it('espera un poco antes de reiniciar si solo se desconectó', () => {
    vi.useFakeTimers();
    const mesh = new VoiceMesh('me', ICE, track, deps({ disconnectGraceMs: 3000 }));
    mesh.connectTo('p1');
    pc().setConnectionState('disconnected');
    vi.advanceTimersByTime(2999);
    expect(pc().restarts).toBe(0);
    vi.advanceTimersByTime(1);
    expect(pc().restarts).toBe(1);

    pc().setConnectionState('disconnected');
    pc().setConnectionState('connected');
    vi.advanceTimersByTime(5000);
    expect(pc().restarts).toBe(1) ;
  });

  it('restartIce reinicia todas (cambio de red)', () => {
    const mesh = new VoiceMesh('me', ICE, track, deps());
    mesh.connectTo('p1');
    mesh.connectTo('p2');
    mesh.restartIce();
    expect(FakePeerConnection.instances.map((c) => c.restarts)).toEqual([1, 1]);
  });
});

describe('VoiceMesh — salidas (HU-VOZ-01 AC3)', () => {
  it('remove cierra la conexión de ese peer', () => {
    vi.useFakeTimers();
    const mesh = new VoiceMesh('me', ICE, track, deps());
    mesh.connectTo('p1');
    pc().setConnectionState('disconnected');
    mesh.remove('p1');
    expect(pc().closed).toBe(true);
    expect(mesh.peerIds()).toEqual([]);
    vi.advanceTimersByTime(10_000);
    expect(pc().restarts).toBe(0);
    mesh.remove('nadie');
  });

  it('close cierra todo e ignora señales tardías', async () => {
    const mesh = new VoiceMesh('me', ICE, track, deps());
    mesh.connectTo('p1');
    mesh.connectTo('p1'); // idempotente
    mesh.close();
    expect(FakePeerConnection.instances).toHaveLength(1);
    expect(pc().closed).toBe(true);
    await mesh.handleSignal('p2', { description: { type: 'offer', sdp: 'o' } });
    mesh.connectTo('p3');
    expect(FakePeerConnection.instances).toHaveLength(1);
  });
});

describe('VoiceMesh — energía recibida (quién habla)', () => {
  it('lee totalAudioEnergy y totalSamplesDuration del inbound-rtp de audio de cada peer', async () => {
    const mesh = new VoiceMesh('me', ICE, track, deps());
    mesh.connectTo('p1');
    mesh.connectTo('p2');
    FakePeerConnection.instances[0].stats = [
      { type: 'inbound-rtp', kind: 'audio', totalAudioEnergy: 0.5, totalSamplesDuration: 3 },
      { type: 'outbound-rtp', kind: 'audio', totalAudioEnergy: 9, totalSamplesDuration: 9 },
    ];
    FakePeerConnection.instances[1].stats = [{ type: 'transport' }];
    expect(await mesh.energySamples()).toEqual({ 'p1': { energy: 0.5, duration: 3 } });
  });

  it('una conexión que falla al dar stats no rompe a las demás', async () => {
    const mesh = new VoiceMesh('me', ICE, track, deps());
    mesh.connectTo('p1');
    mesh.connectTo('p2');
    FakePeerConnection.instances[0].getStats = async () => {
      throw new Error('cerrada');
    };
    FakePeerConnection.instances[1].stats = [{ type: 'inbound-rtp', kind: 'audio', totalAudioEnergy: 1, totalSamplesDuration: 2 }];
    expect(await mesh.energySamples()).toEqual({ 'p2': { energy: 1, duration: 2 } });
  });
});
