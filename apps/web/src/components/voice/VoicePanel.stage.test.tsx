/** Voz en modo escenario (salas live, ADR 0019). */
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { VoicePanel, type VoicePanelProps } from './VoicePanel';

const me = { peer_id: 'p-me', user_id: 'u-host', nick: 'Host', role: 'host', muted: false, host_muted: false };
const ana = { peer_id: 'p-ana', user_id: 'guest:ana', nick: 'Ana', role: 'participant', muted: false, host_muted: false };

function voice(extra: Partial<VoicePanelProps['voice']> = {}): VoicePanelProps['voice'] {
  return {
    status: 'idle',
    notice: null,
    self: null,
    peers: [],
    remoteStreams: {},
    connection: {},
    muted: false,
    hostMuted: false,
    join: vi.fn(async () => {}),
    leave: vi.fn(),
    toggleMute: vi.fn(),
    setHostMute: vi.fn(),
    dismissNotice: vi.fn(),
    ...extra,
  };
}

describe('VoicePanel — escenario', () => {
  it('en modo escenario explica quién habla y ofrece subir al escenario', () => {
    render(<VoicePanel voice={voice()} speaking={new Set()} stage />);
    expect(screen.getByRole('heading', { name: /escenario/i })).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent(/quienes él invite/);
    expect(screen.getByRole('button', { name: /subir al escenario/i })).toBeEnabled();
  });

  it('con 4009 muestra "Pedir subir al escenario" desactivado y permite reintentar', async () => {
    const v = voice({ status: 'ended', notOnStage: true });
    render(<VoicePanel voice={v} speaking={new Set()} stage />);
    const ask = screen.getByRole('button', { name: 'Pedir subir al escenario' });
    expect(ask).toBeDisabled();
    expect(ask).toHaveAccessibleDescription(/no estás en el escenario/i);
    await userEvent.click(screen.getByRole('button', { name: /volver a intentar/i }));
    expect(v.join).toHaveBeenCalled();
  });

  it('el host baja a alguien del escenario', async () => {
    const onRemove = vi.fn();
    render(
      <VoicePanel
        voice={voice({ status: 'connected', self: me, peers: [ana] })}
        speaking={new Set()}
        stage
        onRemoveFromStage={onRemove}
      />,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Bajar del escenario a Ana' }));
    expect(onRemove).toHaveBeenCalledWith('guest:ana', 'Ana');
  });
});
