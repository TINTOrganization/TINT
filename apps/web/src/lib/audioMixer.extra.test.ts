import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AudioMixer, MAX_GAIN } from './audioMixer';
import { FakeAnalyserNode, FakeAudioContext, FakeMediaStream, FakeMediaTrack } from '../test/fakeLiveStream';

const ctx = () => FakeAudioContext.instances[FakeAudioContext.instances.length - 1];
const stream = (...t: FakeMediaTrack[]) => new FakeMediaStream(t) as unknown as MediaStream;

beforeEach(() => {
  FakeAudioContext.reset();
  vi.stubGlobal('AudioContext', FakeAudioContext);
  vi.stubGlobal('MediaStream', FakeMediaStream);
});
afterEach(() => vi.unstubAllGlobals());

describe('AudioMixer — extras', () => {
  it('sin Web Audio lanza un error claro', () => {
    vi.stubGlobal('AudioContext', undefined);
    expect(() => new AudioMixer()).toThrow(/Web Audio/);
  });

  it('el escenario con varias voces conecta cada pista a la misma ganancia', () => {
    const mixer = new AudioMixer();
    const a = new FakeMediaTrack('audio');
    const b = new FakeMediaTrack('audio');
    mixer.addSource('stage', stream(a, b));
    expect(ctx().gainFor(a)).toBe(ctx().gainFor(b));
    expect(ctx().reachesOutput(b)).toBe(true);
  });

  it('reemplazar o quitar una fuente desconecta la anterior', () => {
    const mixer = new AudioMixer();
    const first = new FakeMediaTrack('audio');
    const second = new FakeMediaTrack('audio');
    mixer.addSource('mic', stream(first));
    mixer.addSource('mic', stream(second));
    expect(ctx().reachesOutput(first)).toBe(false);
    expect(ctx().reachesOutput(second)).toBe(true);
    expect(mixer.hasSource('mic')).toBe(true);
    mixer.removeSource('mic');
    expect(mixer.hasSource('mic')).toBe(false);
    mixer.removeSource('mic');
  });

  it('la ganancia se limita a MAX_GAIN y se conserva para una fuente que aún no existe', () => {
    const mixer = new AudioMixer();
    mixer.setGain('mic', 5);
    expect(mixer.getGain('mic')).toBe(MAX_GAIN);
    mixer.setMuted('stage', true);
    expect(mixer.isMuted('stage')).toBe(true);
    const t = new FakeMediaTrack('audio');
    mixer.addSource('mic', stream(t));
    expect(ctx().gainFor(t)?.gain.value).toBe(MAX_GAIN);
  });

  it('level devuelve el RMS de la fuente (0 sin fuente)', () => {
    const mixer = new AudioMixer();
    expect(mixer.level('pc')).toBe(0);
    mixer.addSource('mic', stream(new FakeMediaTrack('audio')));
    const analyser = ctx().analysers[0] as FakeAnalyserNode;
    analyser.getFloatTimeDomainData = (arr: Float32Array) => arr.fill(0.5);
    expect(mixer.level('mic')).toBeCloseTo(0.5);
  });

  it('el audio del PC con pista limpia el aviso', () => {
    const mixer = new AudioMixer();
    mixer.addSource('pc', stream());
    expect(mixer.systemAudioUnavailable).toBe(true);
    mixer.addSource('pc', stream(new FakeMediaTrack('audio')));
    expect(mixer.systemAudioUnavailable).toBe(false);
    expect(mixer.systemAudioMessage).toBeNull();
  });

  it('resume reanuda un contexto suspendido', async () => {
    const mixer = new AudioMixer();
    ctx().state = 'suspended';
    await mixer.resume();
    expect(ctx().state).toBe('running');
    await mixer.resume();
  });
});
