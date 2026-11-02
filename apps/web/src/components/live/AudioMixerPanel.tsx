import { useEffect, useState } from 'react';
import { MAX_GAIN, type MixerSourceId } from '../../lib/audioMixer';
import type { MixerView } from '../../hooks/useLiveStream';
import { Button } from '../ui/Button';

const SOURCE_LABELS: Record<MixerSourceId, string> = {
  pc: 'Audio del PC',
  mic: 'Micrófono',
  stage: 'Escenario',
};

const UNAVAILABLE_TEXT: Record<MixerSourceId, string> = {
  pc: 'No llegó audio del PC',
  mic: 'Micrófono apagado',
  stage: 'Nadie en el escenario',
};

/** Frecuencia de los vúmetros: ~15 Hz basta para el ojo y no re-renderiza la sala. */
export const METER_INTERVAL_MS = 66;

export interface AudioMixerPanelProps {
  mixer: MixerView;
  levels: () => Record<MixerSourceId, number>;
  onGain: (id: MixerSourceId, value: number) => void;
  onMute: (id: MixerSourceId, muted: boolean) => void;
  onEnableMic: () => void;
  systemAudioUnavailable: boolean;
  /** El navegador no puede silenciar la reproducción local de la pestaña compartida. */
  echoHint: boolean;
}

function Meter({ label, value }: { label: string; value: number }) {
  // Escala perceptual: el RMS de la voz ronda 0,05–0,3.
  const pct = Math.round(Math.min(1, Math.sqrt(value) * 1.4) * 100);
  return (
    <div
      role="meter"
      aria-label={`Nivel de ${label}`}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={pct}
      className="h-1.5 w-full overflow-hidden rounded-full bg-white/10"
    >
      <div
        className={`h-full rounded-full transition-[width] duration-75 motion-reduce:transition-none ${
          pct > 90 ? 'bg-red-400' : pct > 70 ? 'bg-amber-300' : 'bg-emerald-400'
        }`}
        style={{ width: `${pct}%` }}
      />
    </div>
  );
}

/** Mezclador del host (HU-LIVE-01b AC2): ganancia, silencio y vúmetro por fuente. */
export function AudioMixerPanel({
  mixer,
  levels,
  onGain,
  onMute,
  onEnableMic,
  systemAudioUnavailable,
  echoHint,
}: AudioMixerPanelProps) {
  const [values, setValues] = useState<Record<MixerSourceId, number>>({ pc: 0, mic: 0, stage: 0 });
  useEffect(() => {
    const id = setInterval(() => setValues(levels()), METER_INTERVAL_MS);
    return () => clearInterval(id);
  }, [levels]);

  return (
    <section aria-labelledby="mixer-title">
      <h2 id="mixer-title" className="text-[15px] font-semibold text-white">
        Mezclador de audio
      </h2>
      <p className="mt-1 text-[13px] leading-relaxed">Todo se mezcla en un solo audio estéreo para la audiencia.</p>
      <ul className="mt-4 space-y-4">
        {(Object.keys(SOURCE_LABELS) as MixerSourceId[]).map((id) => {
          const src = mixer[id];
          const label = SOURCE_LABELS[id];
          const pct = Math.round(src.gain * 100);
          return (
            <li key={id} className="space-y-2">
              <div className="flex items-center justify-between gap-3">
                <span className="text-sm text-white">{label}</span>
                {src.available ? (
                  <Button
                    variant={src.muted ? 'danger' : 'quiet'}
                    size="sm"
                    aria-pressed={src.muted}
                    aria-label={`Silenciar ${label}`}
                    onClick={() => onMute(id, !src.muted)}
                  >
                    {src.muted ? 'Silenciado' : 'Silenciar'}
                  </Button>
                ) : id === 'mic' ? (
                  <Button variant="ghost" size="sm" onClick={onEnableMic}>
                    Activar micrófono
                  </Button>
                ) : (
                  <span className="text-[12px] text-tint-muted">{UNAVAILABLE_TEXT[id]}</span>
                )}
              </div>
              {src.available && (
                <>
                  <Meter label={label} value={src.muted ? 0 : values[id]} />
                  <input
                    type="range"
                    min={0}
                    max={MAX_GAIN * 100}
                    step={5}
                    value={pct}
                    aria-label={`Volumen de ${label}`}
                    aria-valuetext={`${pct} %`}
                    onChange={(e) => onGain(id, Number(e.target.value) / 100)}
                    className="w-full accent-tint-accent"
                  />
                </>
              )}
            </li>
          );
        })}
      </ul>
      {systemAudioUnavailable && (
        <p className="mt-4 rounded-xl border border-amber-300/20 bg-amber-300/10 px-3 py-2 text-[13px] leading-relaxed text-amber-100">
          Tu navegador no compartió el audio del PC. Para incluirlo, usa «Cambiar pantalla», elige una pestaña de
          Chrome o Edge y marca «Compartir audio».
        </p>
      )}
      {echoHint && (
        <p className="mt-3 text-[12px] leading-relaxed text-tint-muted">
          Usa auriculares: este navegador no puede evitar que tu micrófono capte el sonido del PC.
        </p>
      )}
    </section>
  );
}
