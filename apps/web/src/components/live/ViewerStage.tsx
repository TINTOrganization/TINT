import type { ReactNode } from 'react';
import type { LiveError, LiveStatus } from '../../hooks/useLiveStream';
import { SCENE_LABELS, type SceneName } from '../../lib/streamProtocol';
import { Button } from '../ui/Button';
import { LiveVideo } from './LiveVideo';

export interface ViewerStageProps {
  status: LiveStatus;
  stream: MediaStream | null;
  scene: SceneName | null;
  error: LiveError | null;
  onRetry: () => void;
  /** Capas encima del vídeo (reacciones, trivia). */
  children?: ReactNode;
}

const OVERLAY_TEXT: Partial<Record<LiveStatus, { title: string; body: string }>> = {
  idle: { title: 'Conectando con la transmisión…', body: 'En un momento verás al host.' },
  connecting: { title: 'Conectando con la transmisión…', body: 'En un momento verás al host.' },
  waiting: { title: 'El host aún no empieza', body: 'La transmisión aparecerá aquí en cuanto empiece. Mientras, puedes chatear.' },
  reconnecting: {
    title: 'Se perdió la señal',
    body: 'Estamos esperando a que vuelva la transmisión. No cierres la página.',
  },
};

/** Vídeo del viewer con el estado de la transmisión encima (waiting / reconnecting / error). */
export function ViewerStage({ status, stream, scene, error, onRetry, children }: ViewerStageProps) {
  const overlay = status === 'live' ? null : OVERLAY_TEXT[status];
  return (
    <div className="relative bg-black">
      <LiveVideo stream={stream} label="Transmisión en vivo" />
      {children}
      {overlay && (
        <div
          role="status"
          aria-live="polite"
          className="absolute inset-0 grid place-items-center bg-tint-bg/75 p-6 text-center backdrop-blur-sm"
        >
          <div>
            <p className="text-lg font-semibold tracking-tight text-white">{overlay.title}</p>
            <p className="mt-1 max-w-[42ch] text-sm leading-relaxed text-tint-muted">{overlay.body}</p>
          </div>
        </div>
      )}
      {status === 'error' && (
        <div role="alert" className="absolute inset-0 grid place-items-center bg-tint-bg/85 p-6 text-center">
          <div>
            <p className="text-lg font-semibold tracking-tight text-white">No pudimos mostrar la transmisión</p>
            <p className="mt-1 max-w-[42ch] text-sm leading-relaxed text-tint-muted">
              {error?.message ?? 'Intenta de nuevo en un momento.'}
            </p>
            <Button className="mt-4" size="sm" onClick={onRetry}>
              Reintentar
            </Button>
          </div>
        </div>
      )}
      {status === 'live' && scene && scene !== 'live' && <span className="sr-only">Escena: {SCENE_LABELS[scene]}</span>}
    </div>
  );
}
