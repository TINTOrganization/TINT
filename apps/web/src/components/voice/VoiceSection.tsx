import { useCallback, useMemo, useRef } from 'react';
import { Card } from '../ui/Primitives';
import { VoicePanel } from './VoicePanel';
import { useSpeaking } from '../../hooks/useSpeaking';
import { useVoiceChannel, type UseVoiceChannelOptions } from '../../hooks/useVoiceChannel';

/**
 * Canal de voz montado en la sala: conecta `useVoiceChannel` (voice-core + WebRTC) con la
 * detección de quién habla y el panel. Si voice-core no está, solo falla esta tarjeta:
 * el chat y la sincronía siguen (HU-VOZ-06 AC1).
 */
export function VoiceSection({ roomId, ...opts }: { roomId: string } & UseVoiceChannelOptions) {
  const voice = useVoiceChannel(roomId, opts);
  const { status, self, localStream, muted, hostMuted, peers, sampleEnergy } = voice;

  // La voz propia se mide (Web Audio) solo mientras se envía.
  const local = useMemo(
    () => (self && localStream && !muted && !hostMuted ? { [self.peer_id]: localStream } : {}),
    [self, localStream, muted, hostMuted],
  );
  // La de los demás, por la energía que recibe WebRTC; a quien silenció el host no se le resalta.
  const peersRef = useRef(peers);
  peersRef.current = peers;
  const sampleRemote = useCallback(async () => {
    const samples = await sampleEnergy();
    const silenced = new Set(peersRef.current.filter((p) => p.host_muted).map((p) => p.peer_id));
    return Object.fromEntries(Object.entries(samples).filter(([id]) => !silenced.has(id)));
  }, [sampleEnergy]);
  const speaking = useSpeaking(local, { sampleRemote: status === 'connected' ? sampleRemote : undefined });

  return (
    <Card className="mt-4 p-5">
      <VoicePanel voice={voice} speaking={speaking} />
    </Card>
  );
}
