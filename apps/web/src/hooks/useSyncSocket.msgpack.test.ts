import { decode, encode } from '@msgpack/msgpack';
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MockWebSocket } from '../test/mockWebSocket';
import { useSyncSocket, type UseSyncSocketOptions } from './useSyncSocket';

vi.mock('../lib/api', () => ({ apiFetch: vi.fn() }));

const WS = 'ws://test/ws/sync';
const state = {
  type: 'STATE',
  status: 'paused',
  position_ms: 4_000,
  updated_at_ms: 1_767_225_600_000,
  rate: 1,
  version: 3,
  server_time_ms: 1_767_225_600_100,
  media_id: 'm-1',
  can_control: true,
  occurred_at: '2026-01-01T00:00:00.000Z',
  received_at: '2026-01-01T00:00:00.050Z',
};

function toBuffer(value: unknown): ArrayBuffer {
  const bytes = encode(value);
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

function setup(opts: Partial<UseSyncSocketOptions> = {}) {
  return renderHook(() => useSyncSocket({ roomId: 'r1', role: 'guest', url: WS, ...opts }));
}

beforeEach(() => {
  MockWebSocket.reset();
  vi.stubGlobal('WebSocket', MockWebSocket);
  localStorage.clear();
  localStorage.setItem('tint_guest_token', 'g');
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('useSyncSocket — MessagePack (O6)', () => {
  it('por defecto usa JSON sin subprotocolo', () => {
    vi.stubEnv('VITE_SYNC_ENCODING', '');
    setup();
    expect(MockWebSocket.last().protocols).toBeUndefined();
  });

  it('VITE_SYNC_ENCODING=msgpack pide el subprotocolo y binaryType arraybuffer', () => {
    vi.stubEnv('VITE_SYNC_ENCODING', 'msgpack');
    setup();
    const ws = MockWebSocket.last();
    expect(ws.protocols).toEqual(['tint.sync.msgpack']);
    expect(ws.binaryType).toBe('arraybuffer');
  });

  it('con el subprotocolo aceptado decodifica y codifica en binario', () => {
    const { result } = setup({ encoding: 'msgpack', getPositionMs: () => 4_100 });
    const ws = MockWebSocket.last();
    act(() => ws.open('tint.sync.msgpack'));
    act(() => ws.receiveBinary(toBuffer(state)));
    expect(result.current.state).toMatchObject({ position_ms: 4_000, media_id: 'm-1', version: 3 });
    expect(result.current.canControl).toBe(true);

    act(() => ws.receiveBinary(toBuffer({ type: 'HEARTBEAT', server_time_ms: 1_767_225_601_000, rtt_ms: 20 })));
    act(() => {
      result.current.sendCommand('RATE', 4_100, { rate: 1.25 });
    });
    expect(ws.sent).toHaveLength(2);
    const [check, cmd] = ws.sent.map((f) => {
      expect(f).toBeInstanceOf(Uint8Array);
      return decode(f as Uint8Array) as Record<string, unknown>;
    });
    expect(check).toMatchObject({ type: 'SYNC_CHECK', echo_server_ts: 1_767_225_601_000, position_ms: 4_100, version: 3 });
    expect(typeof check.occurred_at).toBe('string');
    expect(cmd).toMatchObject({ type: 'RATE', rate: 1.25, room_id: 'r1' });
    expect(cmd).not.toHaveProperty('media_id');
  });

  it('si el servidor no acepta el subprotocolo sigue en JSON', () => {
    const { result } = setup({ encoding: 'msgpack' });
    const ws = MockWebSocket.last();
    act(() => ws.open(''));
    act(() => ws.receive(state));
    expect(result.current.state?.media_id).toBe('m-1');
    act(() => ws.receive({ type: 'HEARTBEAT', server_time_ms: 5 }));
    expect(ws.sentJson()[0]).toMatchObject({ type: 'SYNC_CHECK', echo_server_ts: 5 });
  });

  it('ignora frames binarios corruptos', () => {
    const { result } = setup({ encoding: 'msgpack' });
    const ws = MockWebSocket.last();
    act(() => ws.open('tint.sync.msgpack'));
    act(() => ws.receiveBinary(new Uint8Array([0xc1]).buffer));
    expect(result.current.state).toBeNull();
  });
});
