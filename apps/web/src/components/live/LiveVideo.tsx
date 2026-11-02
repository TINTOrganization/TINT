import { useEffect, useRef, useState } from 'react';
import { Button } from '../ui/Button';

export interface LiveVideoProps {
  stream: MediaStream | null;
  /** Vista previa del host: siempre sin sonido (no se escucha a sí mismo). */
  preview?: boolean;
  label: string;
  className?: string;
}

/**
 * `<video>` de un MediaStream en vivo. Si el navegador bloquea el autoplay con sonido, arranca
 * sin sonido y ofrece "Activar sonido" (un gesto del usuario desbloquea el audio).
 */
export function LiveVideo({ stream, preview = false, label, className = '' }: LiveVideoProps) {
  const ref = useRef<HTMLVideoElement>(null);
  const [needsGesture, setNeedsGesture] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (el.srcObject !== stream) el.srcObject = stream;
    if (!stream) return;
    el.muted = preview;
    const started = el.play();
    started?.catch((err: { name?: string }) => {
      if (preview || err?.name !== 'NotAllowedError') return;
      // Autoplay con sonido bloqueado: se reproduce en silencio hasta un gesto.
      el.muted = true;
      setNeedsGesture(true);
      void el.play()?.catch(() => {});
    });
  }, [stream, preview]);

  const unmute = () => {
    const el = ref.current;
    if (!el) return;
    el.muted = false;
    void el.play()?.catch(() => {});
    setNeedsGesture(false);
  };

  return (
    <div className="relative">
      <video
        ref={ref}
        aria-label={label}
        autoPlay
        playsInline
        muted={preview}
        className={`aspect-video w-full bg-black object-contain ${className}`}
      />
      {needsGesture && !preview && (
        <div className="absolute bottom-3 left-3">
          <Button size="sm" onClick={unmute}>
            Activar sonido
          </Button>
        </div>
      )}
    </div>
  );
}
