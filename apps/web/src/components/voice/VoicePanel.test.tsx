import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { VoicePanel, type VoicePanelProps } from './VoicePanel';

const me = { peer_id: 'p-me', user_id: 'u-host', nick: 'Host', role: 'host', muted: false, host_muted: false };
const ana = { peer_id: 'p-ana', user_id: 'guest:ana', nick: 'Ana', role: 'participant', muted: false, host_muted: false };
const luis = { peer_id: 'p-luis', user_id: 'guest:luis', nick: 'Luis', role: 'participant', muted: true, host_muted: false };

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

describe('VoicePanel', () => {
  it('fuera de la voz muestra "Unirse a la voz"', async () => {
    const v = voice();
    render(<VoicePanel voice={v} speaking={new Set()} />);
    await userEvent.click(screen.getByRole('button', { name: /unirse a la voz/i }));
    expect(v.join).toHaveBeenCalled();
    expect(screen.queryByRole('list', { name: /en la voz/i })).not.toBeInTheDocument();
  });

  it('mientras conecta deshabilita el botón', () => {
    render(<VoicePanel voice={voice({ status: 'joining' })} speaking={new Set()} />);
    expect(screen.getByRole('button', { name: /conectando/i })).toBeDisabled();
    expect(screen.getByRole('status')).toHaveTextContent(/conectando a la voz/i);
  });

  it('en la voz lista a los miembros, con quién habla y quién está silenciado', () => {
    render(
      <VoicePanel
        voice={voice({ status: 'connected', self: me, peers: [ana, luis], connection: { 'p-ana': 'connecting' } })}
        speaking={new Set(['p-ana'])}
      />,
    );
    expect(screen.getByRole('status')).toHaveTextContent('3 en la voz');
    const items = within(screen.getByRole('list', { name: /en la voz/i })).getAllByRole('listitem');
    expect(items.map((li) => li.getAttribute('data-speaking'))).toEqual(['false', 'true', 'false']);
    expect(items[0]).toHaveTextContent('Host (tú)');
    expect(items[1]).toHaveTextContent(/hablando/);
    expect(items[1]).toHaveTextContent(/conectando/);
    expect(within(items[2]).getByRole('img', { name: /micrófono silenciado/i })).toBeInTheDocument();
  });

  it('silenciarse y salir', async () => {
    const v = voice({ status: 'connected', self: me });
    const { rerender } = render(<VoicePanel voice={v} speaking={new Set()} />);
    await userEvent.click(screen.getByRole('button', { name: 'Silenciar' }));
    expect(v.toggleMute).toHaveBeenCalled();
    await userEvent.click(screen.getByRole('button', { name: /salir de la voz/i }));
    expect(v.leave).toHaveBeenCalled();

    rerender(<VoicePanel voice={{ ...v, muted: true }} speaking={new Set()} />);
    expect(screen.getByRole('button', { name: /activar micrófono/i })).toHaveAttribute('aria-pressed', 'true');
  });

  it('el host silencia y permite hablar; un participante no ve esos botones', async () => {
    const v = voice({ status: 'connected', self: me, peers: [ana, { ...luis, host_muted: true }] });
    const { rerender } = render(<VoicePanel voice={v} speaking={new Set()} />);
    await userEvent.click(screen.getByRole('button', { name: 'Silenciar a Ana' }));
    expect(v.setHostMute).toHaveBeenCalledWith('guest:ana', true);
    await userEvent.click(screen.getByRole('button', { name: 'Permitir hablar a Luis' }));
    expect(v.setHostMute).toHaveBeenCalledWith('guest:luis', false);
    expect(screen.getByText('Silenciado por el host')).toBeInTheDocument();

    rerender(<VoicePanel voice={{ ...v, self: { ...ana, peer_id: 'p-x' } }} speaking={new Set()} />);
    expect(screen.queryByRole('button', { name: /silenciar a/i })).not.toBeInTheDocument();
  });

  it('muestra al propio usuario silenciado por el host', () => {
    render(
      <VoicePanel voice={voice({ status: 'connected', self: me, muted: true, hostMuted: true })} speaking={new Set()} />,
    );
    const items = within(screen.getByRole('list', { name: /en la voz/i })).getAllByRole('listitem');
    expect(items[0]).toHaveTextContent('Silenciado por el host');
    expect(screen.getByRole('button', { name: /activar micrófono/i })).toHaveAttribute('title', 'El host te silenció');
  });

  // HU-VOZ-04 AC1: quien escucha apaga el audio de un silenciado por el host.
  it('reproduce el audio remoto y lo apaga si el host lo silenció', () => {
    const stream = {} as MediaStream;
    const v = voice({ status: 'connected', self: me, peers: [ana], remoteStreams: { 'p-ana': stream } });
    const { rerender } = render(<VoicePanel voice={v} speaking={new Set()} />);
    const audio = screen.getByTestId('voice-audio') as HTMLAudioElement;
    expect(audio.srcObject).toBe(stream);
    expect(audio.muted).toBe(false);
    rerender(<VoicePanel voice={{ ...v, peers: [{ ...ana, host_muted: true }] }} speaking={new Set()} />);
    expect(audio.muted).toBe(true);
  });

  it('avisos con botón para cerrarlos', async () => {
    const v = voice({ notice: 'La voz está llena.', status: 'ended' });
    render(<VoicePanel voice={v} speaking={new Set()} />);
    expect(screen.getByRole('alert')).toHaveTextContent('La voz está llena.');
    await userEvent.click(screen.getByRole('button', { name: /cerrar aviso/i }));
    expect(v.dismissNotice).toHaveBeenCalled();
  });

  it('reconectando mantiene los controles', () => {
    render(<VoicePanel voice={voice({ status: 'reconnecting', self: me })} speaking={new Set()} />);
    expect(screen.getByRole('status')).toHaveTextContent(/reconectando/i);
    expect(screen.getByRole('button', { name: /salir de la voz/i })).toBeInTheDocument();
  });
});
