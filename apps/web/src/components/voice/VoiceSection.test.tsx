import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { VoiceSection } from './VoiceSection';
import { MockWebSocket } from '../../test/mockWebSocket';
import { FakePeerConnection, FakeStream, flushAsync } from '../../test/fakeWebRtc';

const me = { peer_id: 'p-me', user_id: 'guest:me', nick: 'Yo', role: 'participant', muted: false, host_muted: false };
const host = { peer_id: 'p-host', user_id: 'u-host', nick: 'Host', role: 'host', muted: false, host_muted: false };

beforeEach(() => {
  MockWebSocket.reset();
  FakePeerConnection.instances = [];
  localStorage.setItem('tint_guest_token', 'g');
});

describe('VoiceSection', () => {
  it('une el hook, la malla y el panel: entrar, ver al host y oírlo', async () => {
    render(
      <VoiceSection
        roomId="r1"
        role="guest"
        baseUrl="ws://voz/ws/voice"
        createSocket={(url) => new MockWebSocket(url) as unknown as WebSocket}
        getUserMedia={async () => new FakeStream() as unknown as MediaStream}
        createPeerConnection={(c) => new FakePeerConnection(c) as unknown as RTCPeerConnection}
      />,
    );
    expect(MockWebSocket.instances).toHaveLength(0);
    await userEvent.click(screen.getByRole('button', { name: /unirse a la voz/i }));
    const ws = MockWebSocket.last();
    await act(async () => {
      ws.open();
      ws.receive({ type: 'voice_state', room_id: 'r1', self: me, peers: [host], ice_servers: [], max_members: 8 });
      await flushAsync();
    });
    const list = screen.getByRole('list', { name: /en la voz/i });
    expect(within(list).getAllByRole('listitem').map((li) => li.textContent)).toEqual([
      expect.stringContaining('Yo (tú)'),
      expect.stringContaining('Host'),
    ]);
    act(() => FakePeerConnection.instances[0].emitTrack(new FakeStream()));
    expect(screen.getByTestId('voice-audio')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Silenciar' }));
    expect(screen.getByRole('button', { name: /activar micrófono/i })).toBeInTheDocument();
  });

  it('sin voice-core la sala sigue: solo se muestra el aviso de reconexión', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    render(
      <VoiceSection
        roomId="r1"
        role="guest"
        createSocket={(url) => new MockWebSocket(url) as unknown as WebSocket}
        getUserMedia={async () => new FakeStream() as unknown as MediaStream}
      />,
    );
    await userEvent.click(screen.getByRole('button', { name: /unirse a la voz/i }));
    act(() => MockWebSocket.last().close(1006));
    expect(screen.getByRole('status')).toHaveTextContent(/reconectando/i);
    vi.useRealTimers();
  });
});

describe('VoiceSection — qué se mide para resaltar', () => {
  it('mide el micrófono propio mientras envía y a los demás por energía, salvo silenciados por el host', async () => {
    const calls: Array<{ local: string[]; sample?: () => Promise<Record<string, unknown>> }> = [];
    const speakingModule = await import('../../hooks/useSpeaking');
    const spy = vi.spyOn(speakingModule, 'useSpeaking').mockImplementation((streams, opts) => {
      calls.push({ local: Object.keys(streams), sample: opts?.sampleRemote });
      return new Set();
    });
    render(
      <VoiceSection
        roomId="r1"
        role="guest"
        createSocket={(url) => new MockWebSocket(url) as unknown as WebSocket}
        getUserMedia={async () => new FakeStream() as unknown as MediaStream}
        createPeerConnection={(c) => new FakePeerConnection(c) as unknown as RTCPeerConnection}
      />,
    );
    expect(calls.at(-1)?.sample).toBeUndefined(); // fuera de la voz no se muestrea nada
    await userEvent.click(screen.getByRole('button', { name: /unirse a la voz/i }));
    const ws = MockWebSocket.last();
    const ana = { ...host, peer_id: 'p-ana', user_id: 'guest:ana', nick: 'Ana', role: 'participant' };
    await act(async () => {
      ws.open();
      ws.receive({ type: 'voice_state', room_id: 'r1', self: me, peers: [host, ana], ice_servers: [], max_members: 8 });
      await flushAsync();
    });
    expect(calls.at(-1)?.local).toEqual(['p-me']);
    for (const pc of FakePeerConnection.instances)
      pc.stats = [{ type: 'inbound-rtp', kind: 'audio', totalAudioEnergy: 1, totalSamplesDuration: 1 }];
    expect(Object.keys((await calls.at(-1)!.sample!()) ?? {}).sort()).toEqual(['p-ana', 'p-host']);

    // HU-VOZ-04: a quien silenció el host no se le resalta.
    act(() => ws.receive({ type: 'peer_muted', peer_id: 'p-ana', user_id: 'guest:ana', muted: true, host_muted: true }));
    expect(Object.keys((await calls.at(-1)!.sample!()) ?? {})).toEqual(['p-host']);

    // Con el micrófono silenciado no se mide la voz propia.
    await userEvent.click(screen.getByRole('button', { name: 'Silenciar' }));
    expect(calls.at(-1)?.local).toEqual([]);
    spy.mockRestore();
  });
});
