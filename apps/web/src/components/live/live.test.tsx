import { act, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LiveVideo } from './LiveVideo';
import { AudioMixerPanel, METER_INTERVAL_MS } from './AudioMixerPanel';
import { HostStatsPanel } from './HostStatsPanel';
import { LiveStatusBadge, ViewerCount } from './LiveBadges';
import { StagePanel } from './StagePanel';

beforeEach(() => {
  Object.defineProperty(HTMLMediaElement.prototype, 'srcObject', { configurable: true, writable: true, value: null });
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

const stream = {} as MediaStream;

describe('LiveVideo', () => {
  it('asigna el stream y reproduce', async () => {
    const play = vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined);
    render(<LiveVideo stream={stream} label="Vídeo" />);
    expect((screen.getByLabelText('Vídeo') as HTMLVideoElement).srcObject).toBe(stream);
    expect(play).toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: 'Activar sonido' })).not.toBeInTheDocument();
  });

  it('con autoplay bloqueado arranca sin sonido y ofrece "Activar sonido"', async () => {
    const play = vi
      .spyOn(HTMLMediaElement.prototype, 'play')
      .mockRejectedValueOnce(new DOMException('no', 'NotAllowedError'))
      .mockResolvedValue(undefined);
    render(<LiveVideo stream={stream} label="Vídeo" />);
    const button = await screen.findByRole('button', { name: 'Activar sonido' });
    const video = screen.getByLabelText('Vídeo') as HTMLVideoElement;
    expect(video.muted).toBe(true);
    await userEvent.click(button);
    expect(video.muted).toBe(false);
    expect(play).toHaveBeenCalledTimes(3);
    expect(screen.queryByRole('button', { name: 'Activar sonido' })).not.toBeInTheDocument();
  });

  it('la vista previa siempre va sin sonido y no ofrece activarlo', async () => {
    vi.spyOn(HTMLMediaElement.prototype, 'play').mockRejectedValue(new DOMException('no', 'NotAllowedError'));
    render(<LiveVideo stream={stream} preview label="Vista" />);
    await act(async () => {});
    expect((screen.getByLabelText('Vista') as HTMLVideoElement).muted).toBe(true);
    expect(screen.queryByRole('button', { name: 'Activar sonido' })).not.toBeInTheDocument();
  });

  it('sin stream no reproduce', () => {
    const play = vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined);
    render(<LiveVideo stream={null} label="Vídeo" />);
    expect(play).not.toHaveBeenCalled();
  });
});

describe('AudioMixerPanel', () => {
  const mixer = {
    pc: { available: true, gain: 0.8, muted: false },
    mic: { available: true, gain: 1, muted: true },
    stage: { available: false, gain: 1, muted: false },
  };

  it('vúmetro, volumen y silencio por fuente', async () => {
    vi.useFakeTimers();
    const onGain = vi.fn();
    const onMute = vi.fn();
    render(
      <AudioMixerPanel
        mixer={mixer}
        levels={() => ({ pc: 0.25, mic: 0.5, stage: 0 })}
        onGain={onGain}
        onMute={onMute}
        onEnableMic={vi.fn()}
        systemAudioUnavailable
        echoHint
      />,
    );
    act(() => {
      vi.advanceTimersByTime(METER_INTERVAL_MS);
    });
    expect(screen.getByRole('meter', { name: 'Nivel de Audio del PC' })).toHaveAttribute('aria-valuenow', '70');
    // Silenciado: el vúmetro queda en 0.
    expect(screen.getByRole('meter', { name: 'Nivel de Micrófono' })).toHaveAttribute('aria-valuenow', '0');
    const slider = screen.getByRole('slider', { name: 'Volumen de Audio del PC' });
    expect(slider).toHaveAttribute('aria-valuetext', '80 %');
    fireEvent.change(slider, { target: { value: '150' } });
    expect(onGain).toHaveBeenCalledWith('pc', 1.5);
    act(() => {
      screen.getByRole('button', { name: 'Silenciar Micrófono' }).click();
    });
    expect(onMute).toHaveBeenCalledWith('mic', false);
    expect(screen.getByRole('button', { name: 'Silenciar Micrófono' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByText('Nadie en el escenario')).toBeInTheDocument();
    expect(screen.getByText(/Compartir audio/)).toBeInTheDocument();
    expect(screen.getByText(/auriculares/)).toBeInTheDocument();
  });

  it('niveles altos se pintan en ámbar o rojo', () => {
    vi.useFakeTimers();
    render(
      <AudioMixerPanel
        mixer={{ ...mixer, mic: { available: true, gain: 1, muted: false }, stage: { available: true, gain: 1, muted: false } }}
        levels={() => ({ pc: 1, mic: 0.3, stage: 0 })}
        onGain={vi.fn()}
        onMute={vi.fn()}
        onEnableMic={vi.fn()}
        systemAudioUnavailable={false}
        echoHint={false}
      />,
    );
    act(() => {
      vi.advanceTimersByTime(METER_INTERVAL_MS);
    });
    expect(screen.getByRole('meter', { name: 'Nivel de Audio del PC' })).toHaveAttribute('aria-valuenow', '100');
    expect(screen.getByRole('meter', { name: 'Nivel de Micrófono' })).toHaveAttribute('aria-valuenow', '77');
  });
});

describe('HostStatsPanel y badges', () => {
  it('sin estadísticas muestra el estado vacío', () => {
    render(<HostStatsPanel stats={null} viewerCount={null} />);
    expect(screen.getByText(/aparecen cuando el servidor recibe tu vídeo/)).toBeInTheDocument();
  });

  it('ordena las capas h, m, l y marca las inactivas', () => {
    render(
      <HostStatsPanel
        stats={{
          layers: [
            { rid: 'l', bitrate_bps: 250_000, active: true, viewers: 1 },
            { rid: 'h', bitrate_bps: 2_500_000, active: false, viewers: 0 },
          ],
          nacks: 3,
          plis: 1,
        }}
        viewerCount={1}
      />,
    );
    const rows = screen.getAllByRole('row').slice(1);
    expect(rows[0]).toHaveTextContent('Alta · 1080p · inactiva');
    expect(rows[1]).toHaveTextContent('Baja · 360p');
    expect(rows[1]).toHaveTextContent('250 kbps');
  });

  it('badges de estado y contador', () => {
    const { rerender } = render(<LiveStatusBadge status="reconnecting" />);
    expect(screen.getByText('Reconectando…')).toBeInTheDocument();
    rerender(<LiveStatusBadge status="error" />);
    expect(screen.getByText('Sin conexión')).toBeInTheDocument();
    rerender(<ViewerCount count={1} />);
    expect(screen.getByLabelText('1 espectador')).toBeInTheDocument();
    rerender(<ViewerCount count={null} />);
    expect(screen.queryByLabelText(/espectador/)).not.toBeInTheDocument();
  });
});

describe('StagePanel', () => {
  it('sin mensajes explica cómo invitar; ignora avisos y al propio host', () => {
    render(
      <StagePanel
        messages={[
          { type: 'notice', event_id: 'n', text: 'x' } as never,
          { type: 'chat_message', event_id: 'm', room_id: 'r', user_id: 'host', nick: 'Yo', text: 'x', occurred_at: '', received_at: '' },
        ]}
        selfId="host"
        onInvite={vi.fn()}
        onRemove={vi.fn()}
        onStage={new Set()}
      />,
    );
    expect(screen.getByText(/cuando alguien escriba/i)).toBeInTheDocument();
  });

  it('un error genérico muestra un mensaje por defecto', async () => {
    render(
      <StagePanel
        messages={[
          { type: 'chat_message', event_id: 'm', room_id: 'r', user_id: 'u1', nick: '', text: 'x', occurred_at: '', received_at: '' },
        ]}
        selfId={null}
        onInvite={() => Promise.reject('x')}
        onRemove={vi.fn()}
        onStage={new Set()}
      />,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Invitar al escenario a Sin nombre' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('No se pudo cambiar el escenario.');
  });
});
