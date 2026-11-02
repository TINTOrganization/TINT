import type { ReactNode } from 'react';
import type { LiveStream } from '../../hooks/useLiveStream';
import { SCENE_LABELS, SCENES, type SceneName } from '../../lib/streamProtocol';
import { Button } from '../ui/Button';
import { ErrorAlert } from '../ui/Primitives';
import { LiveVideo } from './LiveVideo';

export type HostStudioProps = {
  live: Pick<
    LiveStream,
    | 'status'
    | 'publishing'
    | 'error'
    | 'notice'
    | 'previewStream'
    | 'cameraOn'
    | 'screenSharing'
    | 'scene'
    | 'publish'
    | 'replaceScreen'
    | 'setCameraEnabled'
    | 'setScene'
    | 'dismissNotice'
  >;
  onEndEvent: () => void;
  ending: boolean;
  /** Capas sobre la vista previa (reacciones, trivia). */
  children?: ReactNode;
};

/**
 * Estudio del host: vista previa de lo que ve la audiencia, empezar a transmitir, cambiar de
 * pantalla, cámara en PiP, escenas y "Terminar evento".
 */
export function HostStudio({ live, onEndEvent, ending, children }: HostStudioProps) {
  const connecting = live.status === 'connecting';
  const scene: SceneName = live.scene ?? 'live';

  return (
    <div>
      <div className="relative bg-black">
        {live.previewStream ? (
          <LiveVideo stream={live.previewStream} preview label="Vista previa de la transmisión" />
        ) : (
          <div className="grid aspect-video place-items-center p-6 text-center">
            <div className="max-w-md">
              <p className="tint-eyebrow">Transmisión en vivo</p>
              <p className="mt-2 text-xl font-semibold tracking-tight text-white">Comparte tu pantalla con la sala</p>
              <p className="mt-2 text-sm leading-relaxed text-tint-muted">
                Elige una pantalla, ventana o pestaña. Para incluir el sonido, comparte una pestaña y marca «Compartir
                audio». La cámara es opcional y la puedes activar en vivo.
              </p>
              <Button className="mt-5" onClick={() => void live.publish()} disabled={connecting}>
                {connecting ? 'Conectando…' : 'Empezar a transmitir'}
              </Button>
            </div>
          </div>
        )}
        {children}
      </div>

      <div className="space-y-3 p-4">
        {live.error && <ErrorAlert message={live.error.message} />}
        {live.notice && (
          <div className="flex items-start gap-2">
            <p
              role="status"
              className="min-w-0 flex-1 rounded-xl border border-amber-300/20 bg-amber-300/10 px-3 py-2 text-[13px] leading-relaxed text-amber-100"
            >
              {live.notice}
            </p>
            <Button variant="quiet" size="sm" onClick={live.dismissNotice} aria-label="Cerrar aviso">
              ✕
            </Button>
          </div>
        )}

        {live.publishing && (
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="ghost" size="sm" onClick={() => void live.replaceScreen()}>
              {live.screenSharing ? 'Cambiar pantalla' : 'Volver a compartir'}
            </Button>
            <Button
              variant={live.cameraOn ? 'primary' : 'ghost'}
              size="sm"
              aria-pressed={live.cameraOn}
              onClick={() => void live.setCameraEnabled(!live.cameraOn)}
            >
              {live.cameraOn ? 'Cámara activada' : 'Activar cámara'}
            </Button>
            <div role="radiogroup" aria-label="Escena" className="flex flex-wrap gap-1 rounded-full bg-white/5 p-1">
              {SCENES.map((name) => (
                <button
                  key={name}
                  type="button"
                  role="radio"
                  aria-checked={scene === name}
                  onClick={() => live.setScene(name)}
                  className={`rounded-full px-3 py-1.5 text-[13px] transition focus:outline-none focus-visible:ring-2 focus-visible:ring-tint-accent ${
                    scene === name ? 'bg-tint-accent font-semibold text-tint-bg' : 'text-tint-muted hover:text-white'
                  }`}
                >
                  {SCENE_LABELS[name]}
                </button>
              ))}
            </div>
          </div>
        )}

        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-white/5 pt-3">
          <p className="text-[13px] leading-relaxed text-tint-muted">
            Al terminar, la transmisión, el chat y la voz se cierran para todos.
          </p>
          <Button variant="danger" size="sm" onClick={onEndEvent} disabled={ending}>
            {ending ? 'Terminando…' : 'Terminar evento'}
          </Button>
        </div>
      </div>
    </div>
  );
}
