import { v4 as uuidv4 } from 'uuid';
import { getRedisClient } from '../tokens/revocation.js';
import { logger } from '../../logging.js';

/**
 * Stream que consume Analítica (grupo `analytics-workers`). Contrato en
 * docs/contrato-eventos-analitica.md: campos planos de texto, sin datos personales.
 */
export const ANALYTICS_STREAM = 'analytics:events';
const MAXLEN = '100000';
const SOURCE = 'identity-api';

export type AnalyticsEventType = 'user_login' | 'room_created' | 'room_closed' | 'invitation_claimed';
export type AnalyticsFieldValue = string | number | boolean | null | undefined;

const COMMON_FIELDS = new Set(['event_id', 'type', 'source', 'occurred_at', 'received_at']);

function logFailure(type: string, err: unknown) {
  // Solo el tipo y el mensaje: nunca los campos del evento.
  logger.error(`analytics: no se pudo publicar ${type}`, {
    error: (err as Error)?.message ?? String(err),
  });
}

/**
 * `XADD analytics:events MAXLEN ~ 100000 * …` best-effort: la promesa nunca
 * rechaza (ni si el cliente lanza de forma síncrona), así que la ruta puede
 * llamarla con `void` después de responder sin riesgo de tumbar la petición.
 */
export function publishAnalyticsEvent(type: AnalyticsEventType, fields: Record<string, AnalyticsFieldValue>): Promise<void> {
  try {
    const now = new Date().toISOString();
    const args: string[] = ['event_id', uuidv4(), 'type', type, 'source', SOURCE, 'occurred_at', now, 'received_at', now];
    for (const [key, value] of Object.entries(fields)) {
      if (value === undefined || value === null || COMMON_FIELDS.has(key)) continue;
      args.push(key, String(value));
    }
    return Promise.resolve(getRedisClient().xadd(ANALYTICS_STREAM, 'MAXLEN', '~', MAXLEN, '*', ...args)).then(
      () => undefined,
      (err) => logFailure(type, err),
    );
  } catch (err) {
    logFailure(type, err);
    return Promise.resolve();
  }
}
