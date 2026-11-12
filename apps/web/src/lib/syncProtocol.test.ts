import {
  backoffDelay,
  buildBuffering,
  buildCommand,
  buildSyncCheck,
  buildSyncUrl,
  estimateServerNow,
  expectedPosition,
  parseServerMessage,
  stepRate,
  toServerMessage,
  CLOSE_EXPIRED,
  CLOSE_REVOKED,
  RATE_OPTIONS,
  type SyncState,
} from './syncProtocol';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const base: SyncState = {
  status: 'playing',
  position_ms: 10_000,
  updated_at_ms: 1_000,
  rate: 1,
  version: 3,
  server_time_ms: 1_500,
};

describe('expectedPosition', () => {
  it('avanza la posición según el tiempo del servidor cuando reproduce', () => {
    expect(expectedPosition(base, 3_000)).toBe(12_000);
  });

  it('respeta la tasa de reproducción', () => {
    expect(expectedPosition({ ...base, rate: 2 }, 2_000)).toBe(12_000);
  });

  it('no avanza si está en pausa', () => {
    expect(expectedPosition({ ...base, status: 'paused' }, 9_999)).toBe(10_000);
  });

  it('no retrocede si el reloj estimado es anterior al ancla', () => {
    expect(expectedPosition(base, 500)).toBe(10_000);
  });
});

describe('estimateServerNow', () => {
  it('suma el tiempo local transcurrido desde la recepción', () => {
    expect(estimateServerNow({ ...base, received_at_perf: 100 }, 350)).toBe(1_750);
  });
});

describe('buildCommand', () => {
  it('construye un comando plano con uuid y fecha ISO', () => {
    const cmd = buildCommand('SEEK', 'r1', 1234.6, new Date('2026-01-01T00:00:00.000Z'));
    expect(cmd).toEqual({
      event_id: expect.stringMatching(UUID_RE),
      type: 'SEEK',
      room_id: 'r1',
      position_ms: 1235,
      occurred_at: '2026-01-01T00:00:00.000Z',
    });
  });

  it('RATE incluye rate y LOAD incluye media_id', () => {
    const now = new Date('2026-01-01T00:00:00.000Z');
    expect(buildCommand('RATE', 'r1', 10, now, { rate: 1.5 })).toMatchObject({ type: 'RATE', rate: 1.5 });
    const load = buildCommand('LOAD', 'r1', 0, now, { media_id: 'm-9' });
    expect(load).toMatchObject({ type: 'LOAD', media_id: 'm-9', position_ms: 0 });
    expect(load).not.toHaveProperty('rate');
  });

  it('genera event_id distintos', () => {
    expect(buildCommand('PLAY', 'r', 0).event_id).not.toBe(buildCommand('PLAY', 'r', 0).event_id);
  });
});

describe('buildSyncCheck', () => {
  it('incluye la version del estado aplicado si se conoce', () => {
    const msg = buildSyncCheck('r1', 1_000, 5_000, new Date('2026-01-01T00:00:01.000Z'), 7);
    expect(msg.version).toBe(7);
    expect(JSON.parse(JSON.stringify(msg))).toHaveProperty('version', 7);
  });

  it('sin version conocida (antes del primer STATE) no envía la clave', () => {
    expect(buildSyncCheck('r1', 1_000, 5_000)).not.toHaveProperty('version');
  });

  it('incluye echo_server_ts y la posición redondeada', () => {
    const msg = buildSyncCheck('r1', 999.4, 5_000, new Date('2026-01-01T00:00:01.000Z'));
    expect(msg).toEqual({
      event_id: expect.stringMatching(UUID_RE),
      type: 'SYNC_CHECK',
      room_id: 'r1',
      position_ms: 999,
      occurred_at: '2026-01-01T00:00:01.000Z',
      echo_server_ts: 5_000,
    });
  });
});

describe('buildSyncUrl', () => {
  it('codifica room_id y token en la query', () => {
    expect(buildSyncUrl('ws://h/ws/sync', 'r 1', 'a.b&c')).toBe(
      'ws://h/ws/sync?room_id=r%201&token=a.b%26c',
    );
  });
});

describe('backoffDelay', () => {
  it.each([
    [0, 500],
    [1, 1_000],
    [2, 2_000],
    [4, 8_000],
    [5, 10_000],
    [20, 10_000],
  ])('intento %i → %i ms', (attempt, ms) => {
    expect(backoffDelay(attempt)).toBe(ms);
  });
});

describe('parseServerMessage', () => {
  it('parsea un mensaje con type conocido', () => {
    expect(parseServerMessage('{"type":"HEARTBEAT","server_time_ms":5}')).toEqual({
      type: 'HEARTBEAT',
      server_time_ms: 5,
    });
  });

  it.each(['no-json', '42', 'null', '{"type":"DESCONOCIDO"}', '{"sin":"type"}'])(
    'devuelve null para %s',
    (raw) => {
      expect(parseServerMessage(raw)).toBeNull();
    },
  );
});

describe('protocolo v2', () => {
  it.each(['RATE', 'LOAD', 'CONTROL'])('acepta el tipo %s', (type) => {
    expect(parseServerMessage(JSON.stringify({ type }))).toEqual({ type });
  });

  it('toServerMessage valida objetos ya decodificados (MessagePack)', () => {
    expect(toServerMessage({ type: 'CONTROL', can_control: true })).toEqual({ type: 'CONTROL', can_control: true });
    expect(toServerMessage({ type: 'NOPE' })).toBeNull();
    expect(toServerMessage(null)).toBeNull();
    expect(toServerMessage('STATE')).toBeNull();
  });

  it('expone el código de cierre por revocación y las velocidades', () => {
    expect(CLOSE_REVOKED).toBe(4001);
    expect(CLOSE_EXPIRED).toBe(4003);
    expect(RATE_OPTIONS).toEqual([0.5, 0.75, 1, 1.25, 1.5, 2]);
  });

  it.each([
    [1, 1, 1.25],
    [1, -1, 0.75],
    [2, 1, 2],
    [0.5, -1, 0.5],
    [1.1, 1, 1.25],
    [3, -1, 1.5],
  ])('stepRate(%f, %i) → %f', (rate, dir, out) => {
    expect(stepRate(rate, dir as 1 | -1)).toBe(out);
  });
});

describe('buildBuffering', () => {
  it('construye el mensaje BUFFERING del contrato con enteros', () => {
    const msg = buildBuffering('r1', 12_345.6, 850.4, new Date('2026-10-11T04:29:49.368Z'));
    expect(msg).toEqual({
      event_id: expect.stringMatching(UUID_RE),
      type: 'BUFFERING',
      room_id: 'r1',
      position_ms: 12_346,
      duration_ms: 850,
      occurred_at: '2026-10-11T04:29:49.368Z',
    });
  });

  it('nunca envía posiciones negativas', () => {
    expect(buildBuffering('r1', -5, 200).position_ms).toBe(0);
  });
});
