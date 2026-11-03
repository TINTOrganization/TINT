import { useEffect, useRef, useState } from 'react';
import {
  createSpeakingTracker,
  energyLevel,
  rmsLevel,
  SPEAKING_SAMPLE_MS,
  type EnergySample,
} from '../lib/speaking';

interface UseSpeakingOptions {
  /** Inyectable para pruebas; null = sin Web Audio (no se mide el micrófono propio). */
  createAudioContext?: () => AudioContext | null;
  /** Energía acumulada recibida de cada peer (`VoiceMesh.energySamples`). */
  sampleRemote?: () => Promise<Record<string, EnergySample>>;
}

interface Tap {
  stream: MediaStream;
  source: MediaStreamAudioSourceNode;
  analyser: AnalyserNode;
  buffer: Uint8Array;
}

function defaultAudioContext(): AudioContext | null {
  const Ctor =
    typeof window === 'undefined'
      ? undefined
      : window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  return Ctor ? new Ctor() : null;
}

function sameSet(a: Set<string>, b: Set<string>) {
  return a.size === b.size && [...a].every((x) => b.has(x));
}

/**
 * Quién habla (HU-VOZ-03). Cada `SPEAKING_SAMPLE_MS` mide los `streams` locales con un
 * `AnalyserNode` y a los demás con `sampleRemote` (energía de WebRTC), y devuelve los ids
 * que están hablando. El estado solo cambia cuando cambia el conjunto.
 */
export function useSpeaking(streams: Record<string, MediaStream>, opts: UseSpeakingOptions = {}): Set<string> {
  const [speaking, setSpeaking] = useState<Set<string>>(() => new Set());
  const createRef = useRef(opts.createAudioContext ?? defaultAudioContext);
  const sampleRef = useRef(opts.sampleRemote);
  sampleRef.current = opts.sampleRemote;
  const rt = useRef({
    ctx: undefined as AudioContext | null | undefined,
    taps: new Map<string, Tap>(),
    remotePrev: new Map<string, EnergySample>(),
    sampling: false,
    tracker: createSpeakingTracker(),
    interval: null as ReturnType<typeof setInterval> | null,
  }).current;
  const hasRemote = !!opts.sampleRemote;

  useEffect(() => {
    // Suelta los streams que ya no están (o cambiaron).
    for (const [id, tap] of rt.taps) {
      if (streams[id] === tap.stream) continue;
      tap.source.disconnect();
      rt.taps.delete(id);
      rt.tracker.remove(id);
    }
    const ids = Object.keys(streams);
    if (ids.length > 0 && rt.ctx === undefined) {
      rt.ctx = createRef.current();
      if (rt.ctx?.state === 'suspended') void rt.ctx.resume();
    }
    const ctx = rt.ctx;
    if (ctx) {
      for (const id of ids) {
        if (rt.taps.has(id)) continue;
        const source = ctx.createMediaStreamSource(streams[id]);
        const analyser = ctx.createAnalyser();
        analyser.fftSize = 512;
        source.connect(analyser);
        rt.taps.set(id, { stream: streams[id], source, analyser, buffer: new Uint8Array(analyser.fftSize) });
      }
    }

    const publish = () => {
      const next = rt.tracker.speaking();
      setSpeaking((prev) => (sameSet(prev, next) ? prev : next));
    };

    if (!hasRemote) {
      for (const id of rt.remotePrev.keys()) rt.tracker.remove(id);
      rt.remotePrev.clear();
    }
    if (rt.taps.size === 0 && !hasRemote) {
      if (rt.interval) clearInterval(rt.interval);
      rt.interval = null;
      publish();
      return;
    }
    if (rt.interval) return;
    rt.interval = setInterval(() => {
      const now = Date.now();
      for (const [id, tap] of rt.taps) {
        tap.analyser.getByteTimeDomainData(tap.buffer);
        rt.tracker.update(id, rmsLevel(tap.buffer), now);
      }
      publish();
      const sample = sampleRef.current;
      if (!sample || rt.sampling) return;
      rt.sampling = true;
      sample()
        .then((samples) => {
          const at = Date.now();
          for (const [id, cur] of Object.entries(samples)) {
            rt.tracker.update(id, energyLevel(rt.remotePrev.get(id), cur), at);
            rt.remotePrev.set(id, cur);
          }
          for (const id of [...rt.remotePrev.keys()]) {
            if (id in samples) continue;
            rt.remotePrev.delete(id);
            rt.tracker.remove(id);
          }
          publish();
        })
        .catch(() => {
          // Sin stats en esta vuelta (conexiones cerrándose): se reintenta en la siguiente.
        })
        .finally(() => {
          rt.sampling = false;
        });
    }, SPEAKING_SAMPLE_MS);
  }, [streams, hasRemote, rt]);

  useEffect(
    () => () => {
      if (rt.interval) clearInterval(rt.interval);
      for (const tap of rt.taps.values()) tap.source.disconnect();
      rt.taps.clear();
      void rt.ctx?.close();
    },
    [rt],
  );

  return speaking;
}
