import { describe, it, expect, vi, afterEach } from 'vitest';
import { logger } from '../src/logging.js';
import { setRedisClient } from '../src/modules/tokens/revocation.js';
import { ANALYTICS_STREAM, publishAnalyticsEvent } from '../src/modules/analytics/analytics.events.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const ISO_MS_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

/** Convierte los pares planos de XADD (después de `*`) en un objeto. */
function fieldsOf(call: unknown[]) {
  const star = call.indexOf('*');
  const pairs = call.slice(star + 1) as string[];
  const out: Record<string, string> = {};
  for (let i = 0; i < pairs.length; i += 2) out[pairs[i]] = pairs[i + 1];
  return out;
}

afterEach(() => {
  setRedisClient(null);
  vi.restoreAllMocks();
});

describe('analytics.events', () => {
  it('XADD analytics:events MAXLEN ~ 100000 * con los campos comunes y propios', async () => {
    const xadd = vi.fn().mockResolvedValue('1-0');
    setRedisClient({ xadd } as any);
    await publishAnalyticsEvent('room_created', { room_id: 'room-1', user_id: 'sub-1' });
    expect(ANALYTICS_STREAM).toBe('analytics:events');
    expect(xadd).toHaveBeenCalledTimes(1);
    const call = xadd.mock.calls[0];
    expect(call.slice(0, 5)).toEqual(['analytics:events', 'MAXLEN', '~', '100000', '*']);
    const fields = fieldsOf(call);
    expect(fields).toMatchObject({ type: 'room_created', source: 'identity-api', room_id: 'room-1', user_id: 'sub-1' });
    expect(fields.event_id).toMatch(UUID_RE);
    expect(fields.occurred_at).toMatch(ISO_MS_RE);
    expect(fields.received_at).toMatch(ISO_MS_RE);
    // Campos planos: todo valor es texto.
    for (const value of call.slice(5)) expect(typeof value).toBe('string');
  });

  it('cada evento lleva un event_id distinto', async () => {
    const xadd = vi.fn().mockResolvedValue('1-0');
    setRedisClient({ xadd } as any);
    await publishAnalyticsEvent('user_login', { method: 'google', user_id: 'a' });
    await publishAnalyticsEvent('user_login', { method: 'google', user_id: 'a' });
    expect(fieldsOf(xadd.mock.calls[0]).event_id).not.toBe(fieldsOf(xadd.mock.calls[1]).event_id);
  });

  it('omite campos undefined o null y convierte números y booleanos a texto', async () => {
    const xadd = vi.fn().mockResolvedValue('1-0');
    setRedisClient({ xadd } as any);
    await publishAnalyticsEvent('user_login', { method: 'google', room_id: undefined, user_id: null, n: 3, ok: true });
    const fields = fieldsOf(xadd.mock.calls[0]);
    expect(fields).not.toHaveProperty('room_id');
    expect(fields).not.toHaveProperty('user_id');
    expect(fields.n).toBe('3');
    expect(fields.ok).toBe('true');
  });

  it('los campos comunes no se pueden sobrescribir', async () => {
    const xadd = vi.fn().mockResolvedValue('1-0');
    setRedisClient({ xadd } as any);
    await publishAnalyticsEvent('room_created', { source: 'otro', type: 'x', event_id: 'e' });
    const call = xadd.mock.calls[0];
    const fields = fieldsOf(call);
    expect(fields.source).toBe('identity-api');
    expect(fields.type).toBe('room_created');
    expect(fields.event_id).toMatch(UUID_RE);
    expect(call.filter((v: unknown) => v === 'source')).toHaveLength(1);
  });

  it('best-effort: si XADD rechaza, no propaga el error y lo registra sin datos del evento', async () => {
    const log = vi.spyOn(logger, 'error').mockImplementation(() => {});
    setRedisClient({ xadd: vi.fn().mockRejectedValue(new Error('redis down')) } as any);
    await expect(publishAnalyticsEvent('room_created', { room_id: 'r', user_id: 'secret-sub' })).resolves.toBeUndefined();
    expect(log).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(log.mock.calls)).not.toContain('secret-sub');
  });

  it('best-effort: si XADD lanza de forma síncrona, tampoco propaga', async () => {
    const log = vi.spyOn(logger, 'error').mockImplementation(() => {});
    setRedisClient({
      xadd: vi.fn(() => {
        throw new Error('boom');
      }),
    } as any);
    await expect(publishAnalyticsEvent('room_created', { room_id: 'r' })).resolves.toBeUndefined();
    expect(log).toHaveBeenCalledTimes(1);
  });
});
