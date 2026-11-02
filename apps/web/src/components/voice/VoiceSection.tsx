import { useCallback, useEffect, useMemo, useRef } from 'react';
import { Card } from '../ui/Primitives';
import { VoicePanel } from './VoicePanel';
import { useSpeaking } from '../../hooks/useSpeaking';
import { useVoiceChannel, type UseVoiceChannelOptions } from '../../hooks/useVoiceChannel';

/**
 * Canal de voz montado en la sala: conecta `useVoiceChannel` (voice-core + WebRTC) con la
 * detección de quién habla y el panel. Si voice-core no está, solo falla esta tarjeta:
 * el chat y la sincronía siguen (HU-VOZ-06 AC1).
 */
export interface VoiceSectionProps extends UseVoiceChannelOptions {
  roomId: string;
  /** Sala `live`: voz en modo escenario (ADR 0019). */
  stage?: boolean;
  /** Host en modo escenario: bajar a alguien del escenario. */
  onRemoveFromStage?: (userId: string, nick: string) => void;
  /** Cierre 4010 / 410 Disabled: el evento terminó (la sala muestra el aviso de fin). */
  onRoomDisabled?: () => void;
  /** Audio recibido de quienes están en la voz (el host lo mezcla en la transmisión). */
  onRemoteStreams?: (streams: MediaStream[]) => void;
}

export function VoiceSection({
  roomId,
  stage,
  onRemoveFromStage,
  onRoomDisabled,
  onRemoteStreams,
  ...opts
}: VoiceSectionProps) {
  const voice = useVoiceChannel(roomId, opts);
  const { status, self, localStream, muted, hostMuted, peers, sampleEnergy, roomDisabled, remoteStreams } = voice;

  const onRoomDisabledRef = useRef(onRoomDisabled);
  onRoomDisabledRef.current = onRoomDisabled;
  useEffect(() => {
    if (roomDisabled) onRoomDisabledRef.current?.();
  }, [roomDisabled]);
  const onRemoteStreamsRef = useRef(onRemoteStreams);
  onRemoteStreamsRef.current = onRemoteStreams;
  useEffect(() => {
    onRemoteStreamsRef.current?.(Object.values(remoteStreams));
  }, [remoteStreams]);

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
      <VoicePanel voice={voice} speaking={speaking} stage={stage} onRemoveFromStage={onRemoveFromStage} />
    </Card>
  );
}
