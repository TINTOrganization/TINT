/**
 * Pruebas rojas del mezclador de audio del host (HU-LIVE-01b AC2–AC4, docs/dominio-transmision.md).
 *
 * Contrato que especifican (el módulo aún no existe):
 *   const mixer = new AudioMixer();              // usa el AudioContext global
 *   mixer.addSource('pc' | 'mic' | 'stage', stream): void
 *   mixer.setGain(id, 0..n); mixer.setMuted(id, boolean)
 *   mixer.output: MediaStream                    // una pista: la mezcla que va al WHIP de audio
 *   mixer.systemAudioUnavailable: boolean; mixer.systemAudioMessage: string | null
 *   mixer.dispose(): void
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AudioMixer } from './audioMixer';
import { FakeAudioContext, FakeMediaStream, FakeMediaTrack } from '../test/fakeLiveStream';

const NO_PROCESSING = { echoCancellation: false, noiseSuppression: false, autoGainControl: false };

let pc: FakeMediaTrack;
let mic: FakeMediaTrack;
let stage: FakeMediaTrack;

function ctx() {
  return FakeAudioContext.instances[FakeAudioContext.instances.length - 1];
}

function mixerWithAll() {
  const mixer = new AudioMixer();
  mixer.addSource('pc', new FakeMediaStream([new FakeMediaTrack('video'), pc]) as unknown as MediaStream);
  mixer.addSource('mic', new FakeMediaStream([mic]) as unknown as MediaStream);
  mixer.addSource('stage', new FakeMediaStream([stage]) as unknown as MediaStream);
  return mixer;
}

beforeEach(() => {
  FakeAudioContext.reset();
  vi.stubGlobal('AudioContext', FakeAudioContext);
  vi.stubGlobal('MediaStream', FakeMediaStream);
  pc = new FakeMediaTrack('audio', 'system');
  mic = new FakeMediaTrack('audio', 'mic');
  stage = new FakeMediaTrack('audio', 'stage');
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('AudioMixer — fuentes y salida (AC2)', () => {
  it('mezcla PC, micrófono y escenario en una sola pista de salida', () => {
    const mixer = mixerWithAll();
    for (const t of [pc, mic, stage]) expect(ctx().reachesOutput(t)).toBe(true);
    expect(mixer.output.getAudioTracks()).toHaveLength(1);
    expect(mixer.output.getAudioTracks()[0]).toBe(ctx().destinations[0].stream.getAudioTracks()[0]);
  });

  it('cada fuente tiene su propia ganancia', () => {
    const mixer = mixerWithAll();
    mixer.setGain('pc', 0.4);
    mixer.setGain('mic', 1.5);
    expect(ctx().gainFor(pc)?.gain.value).toBeCloseTo(0.4);
    expect(ctx().gainFor(mic)?.gain.value).toBeCloseTo(1.5);
    expect(ctx().gainFor(stage)?.gain.value).toBeCloseTo(1);
    expect(new Set([ctx().gainFor(pc), ctx().gainFor(mic), ctx().gainFor(stage)]).size).toBe(3);
  });

  it('silenciar una fuente no afecta a las demás y al reactivarla vuelve su ganancia', () => {
    const mixer = mixerWithAll();
    mixer.setGain('mic', 0.7);
    mixer.setMuted('mic', true);
    expect(ctx().gainFor(mic)?.gain.value).toBe(0);
    expect(ctx().gainFor(pc)?.gain.value).toBeCloseTo(1);
    // Cambiar la ganancia mientras está en silencio no la hace sonar.
    mixer.setGain('mic', 0.9);
    expect(ctx().gainFor(mic)?.gain.value).toBe(0);
    mixer.setMuted('mic', false);
    expect(ctx().gainFor(mic)?.gain.value).toBeCloseTo(0.9);
  });

  it('una ganancia negativa o no numérica no se aplica', () => {
    const mixer = mixerWithAll();
    mixer.setGain('pc', 0.5);
    mixer.setGain('pc', -1);
    mixer.setGain('pc', Number.NaN);
    expect(ctx().gainFor(pc)?.gain.value).toBeCloseTo(0.5);
  });
});

describe('AudioMixer — audio del PC (AC3, AC4)', () => {
  it('el audio del PC va sin cancelación de eco, supresión de ruido ni AGC', () => {
    mixerWithAll();
    expect(pc.constraints).toContainEqual(expect.objectContaining(NO_PROCESSING));
    // El micrófono conserva el procesamiento de voz.
    expect(mic.constraints).not.toContainEqual(expect.objectContaining(NO_PROCESSING));
  });

  it('si la captura no trae pista de audio, marca systemAudioUnavailable con un aviso claro', () => {
    const mixer = new AudioMixer();
    expect(mixer.systemAudioUnavailable).toBe(false);
    expect(mixer.systemAudioMessage).toBeNull();
    mixer.addSource('pc', new FakeMediaStream([new FakeMediaTrack('video')]) as unknown as MediaStream);
    expect(mixer.systemAudioUnavailable).toBe(true);
    expect(mixer.systemAudioMessage).toMatch(/audio/i);
    expect(mixer.systemAudioMessage).toMatch(/micrófono/i);
  });

  it('sin audio del PC la mezcla sigue con el micrófono', () => {
    const mixer = new AudioMixer();
    mixer.addSource('pc', new FakeMediaStream([new FakeMediaTrack('video')]) as unknown as MediaStream);
    mixer.addSource('mic', new FakeMediaStream([mic]) as unknown as MediaStream);
    expect(ctx().reachesOutput(mic)).toBe(true);
    expect(mixer.output.getAudioTracks()).toHaveLength(1);
  });
});

describe('AudioMixer — ciclo de vida', () => {
  it('dispose desconecta las fuentes y cierra el AudioContext', () => {
    const mixer = mixerWithAll();
    mixer.dispose();
    expect(ctx().closed).toBe(true);
    expect(ctx().sources.every((s) => s.disconnected)).toBe(true);
  });
});
