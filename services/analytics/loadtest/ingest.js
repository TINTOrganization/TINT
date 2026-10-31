// ANA-TEST-01 — Prueba de carga de la ingesta de analítica con k6.
//
// Publica RATE eventos por segundo (por defecto 1.000) en `analytics:events` con
// XADD, igual que los productores reales (campos planos, MAXLEN ~ 100000), y al
// terminar espera a que el grupo `analytics-workers` quede al día (lag 0 y sin
// pendientes). Así mide las dos mitades del desacoplamiento:
//
//   - analytics_xadd_ms: lo que le cuesta publicar a un productor. Es lo único
//     que la telemetría le añade a un play, un mensaje o una reacción.
//   - analytics_drain_s: cuánto tarda el worker de Python en ponerse al día
//     cuando termina la ráfaga.
//
// Uso: k6 run services/analytics/loadtest/ingest.js
// Ver services/analytics/loadtest/README.md.

import redis from 'k6/experimental/redis';
import crypto from 'k6/crypto';
import { sleep } from 'k6';
import { Counter, Trend } from 'k6/metrics';

const REDIS_URL = __ENV.REDIS_URL || 'redis://localhost:6379';
const STREAM = __ENV.STREAM || 'analytics:events';
const GROUP = __ENV.GROUP || 'analytics-workers';
const RATE = parseInt(__ENV.RATE || '1000', 10);
const DURATION = __ENV.DURATION || '60s';
const ROOM_ID = __ENV.ROOM_ID || `loadtest-${Date.now()}`;
// Tope de espera a que el worker quede al día tras la ráfaga.
const DRAIN_TIMEOUT_S = parseInt(__ENV.DRAIN_TIMEOUT_S || '120', 10);
const MAX_VUS = parseInt(__ENV.MAX_VUS || '200', 10);

export const options = {
  scenarios: {
    ingest: {
      // Tasa de llegada constante: k6 lanza RATE iteraciones por segundo aunque
      // Redis responda más lento (si no alcanza, lo cuenta en dropped_iterations).
      executor: 'constant-arrival-rate',
      rate: RATE,
      timeUnit: '1s',
      duration: DURATION,
      preAllocatedVUs: Math.min(50, MAX_VUS),
      maxVUs: MAX_VUS,
    },
  },
  thresholds: {
    analytics_xadd_ms: ['p(95)<20', 'p(99)<50'],
    analytics_xadd_errors: ['count==0'],
    // La tasa pedida se sostiene: menos del 1 % de las iteraciones sin lanzar.
    dropped_iterations: [`count<${Math.ceil(RATE * durationSeconds(DURATION) * 0.01)}`],
    analytics_drain_s: [`max<${DRAIN_TIMEOUT_S}`],
    analytics_lag_after_drain: ['max==0'],
  },
  teardownTimeout: `${DRAIN_TIMEOUT_S + 30}s`,
};

const xaddMs = new Trend('analytics_xadd_ms', true);
const xaddErrors = new Counter('analytics_xadd_errors');
const published = new Counter('analytics_events_published');
const drainSeconds = new Trend('analytics_drain_s');
const lagAfterDrain = new Trend('analytics_lag_after_drain');

const client = new redis.Client(REDIS_URL);

const EMOJIS = ['👏', '😂', '🔥', '😮'];
const SOURCES = {
  drift_correction: 'sync-core',
  reaction: 'social-core',
  chat_message: 'social-core',
  presence: 'social-core',
};
// Mezcla parecida a la de una sala real: sobre todo correcciones de drift.
const MIX = [
  'drift_correction',
  'drift_correction',
  'drift_correction',
  'drift_correction',
  'reaction',
  'reaction',
  'reaction',
  'chat_message',
  'chat_message',
  'presence',
];

export default async function () {
  const type = MIX[Math.floor(Math.random() * MIX.length)];
  const args = ['MAXLEN', '~', '100000', '*', ...flatten(buildEvent(type))];
  const started = Date.now();
  try {
    await client.sendCommand('XADD', STREAM, ...args);
    xaddMs.add(Date.now() - started);
    published.add(1, { type });
  } catch (err) {
    xaddErrors.add(1);
  }
}

// teardown espera a que el worker consuma y confirme todo lo publicado.
export async function teardown() {
  const started = Date.now();
  let state = { lag: -1, pending: -1 };
  while ((Date.now() - started) / 1000 < DRAIN_TIMEOUT_S) {
    state = groupState(await client.sendCommand('XINFO', 'GROUPS', STREAM));
    if (state.lag === 0 && state.pending === 0) break;
    sleep(0.5);
  }
  const waited = (Date.now() - started) / 1000;
  const drained = state.lag === 0 && state.pending === 0;
  // Si no quedó al día, se registra el tope para que falle el umbral.
  drainSeconds.add(drained ? waited : DRAIN_TIMEOUT_S);
  lagAfterDrain.add(Math.max(state.lag, 0) + Math.max(state.pending, 0));
  console.log(
    `sala ${ROOM_ID}: lag=${state.lag} pendientes=${state.pending} tras ${waited.toFixed(1)} s` +
      (state.lag < 0 ? ` (¿existe el grupo ${GROUP}? ¿está arriba analytics?)` : ''),
  );
}

// Eventos válidos según docs/contrato-eventos-analitica.md (sin texto ni PII).
function buildEvent(type) {
  const now = new Date().toISOString();
  const event = {
    event_id: uuid(),
    type,
    source: SOURCES[type],
    room_id: ROOM_ID,
    occurred_at: now,
    received_at: now,
  };
  const positionMs = Math.floor(Math.random() * 5400000);
  if (type === 'drift_correction') {
    return {
      ...event,
      role: 'participant',
      drift_ms: 500 + Math.floor(Math.random() * 1500),
      rtt_ms: 10 + Math.floor(Math.random() * 90),
      position_ms: positionMs,
      strategy: Math.random() < 0.7 ? 'rate' : 'seek',
    };
  }
  const user = { ...event, user_id: `guest:${__VU}` };
  if (type === 'reaction') {
    return { ...user, emoji: EMOJIS[Math.floor(Math.random() * EMOJIS.length)], position_ms: positionMs };
  }
  if (type === 'chat_message') {
    return { ...user, message_length: 1 + Math.floor(Math.random() * 280) };
  }
  return { ...user, kind: 'joined', connected_users: 1 + Math.floor(Math.random() * 500) };
}

function flatten(event) {
  const args = [];
  for (const key of Object.keys(event)) args.push(key, String(event[key]));
  return args;
}

// XINFO GROUPS devuelve, por grupo, una lista plana [campo, valor, ...].
function groupState(groups) {
  for (const raw of groups || []) {
    const info = {};
    for (let i = 0; i + 1 < raw.length; i += 2) info[String(raw[i])] = raw[i + 1];
    if (String(info.name) === GROUP) {
      return { lag: Number(info.lag), pending: Number(info.pending) };
    }
  }
  return { lag: -1, pending: -1 };
}

function uuid() {
  const hex = crypto.hexEncode(crypto.randomBytes(16));
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20)}`;
}

function durationSeconds(text) {
  const match = /^(\d+)(ms|s|m|h)$/.exec(text);
  if (!match) throw new Error(`DURATION inválida: ${text}`);
  return (parseInt(match[1], 10) * { ms: 1, s: 1000, m: 60000, h: 3600000 }[match[2]]) / 1000;
}
