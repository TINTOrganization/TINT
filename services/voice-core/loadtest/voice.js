// Carga de la señalización de voz (voice-core /ws/voice) con k6.
//
//   k6 run -e BASE_URL=ws://localhost:8085 -e JWT_SECRET=… -e VUS=50 -e DURATION=20s \
//     services/voice-core/loadtest/voice.js
//
// Cada VU es un participante: firma su propio token (HS256, igual que identity-api), entra a
// una sala de ROOM_SIZE personas, manda una "oferta" a cada peer y luego una señal por
// segundo a un peer al azar, y sale tras SESSION_S segundos para volver a entrar (rotación:
// peer_joined/peer_left). En cada iteración también prueba un token falso (401 antes del
// upgrade). Mide el tiempo hasta voice_state y el de reenvío de signal entre clientes.
import ws from 'k6/ws';
import crypto from 'k6/crypto';
import encoding from 'k6/encoding';
import { check } from 'k6';
import { Counter, Rate, Trend } from 'k6/metrics';

const BASE_URL = __ENV.BASE_URL || 'ws://localhost:8085';
const SECRET = __ENV.JWT_SECRET || 'dev-secret-change-in-prod';
const ROOM_ID = __ENV.ROOM_ID || `load-${Date.now()}`;
const ROOM_SIZE = Number(__ENV.ROOM_SIZE || 5);
const SESSION_S = Number(__ENV.SESSION_S || 6);

export const options = {
  vus: Number(__ENV.VUS || 50),
  duration: __ENV.DURATION || '20s',
  thresholds: {
    voice_join_ms: ['p(95)<300'],
    voice_signal_relay_ms: ['p(95)<100'],
    voice_join_ok: ['rate>0.99'],
    voice_auth_rejected: ['rate==1'],
    voice_errors: ['count==0'],
    checks: ['rate>0.99'],
  },
};

const joinMs = new Trend('voice_join_ms', true);
const relayMs = new Trend('voice_signal_relay_ms', true);
const joinOk = new Rate('voice_join_ok');
const authRejected = new Rate('voice_auth_rejected');
const errors = new Counter('voice_errors');
const signalsRelayed = new Counter('voice_signals_relayed');

function b64url(text) {
  return encoding.b64encode(text, 'rawurl');
}

function token(sub, room, secret = SECRET) {
  const now = Math.floor(Date.now() / 1000);
  const head = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = b64url(
    JSON.stringify({
      sub,
      room_id: room,
      role: 'participant',
      nick: sub,
      jti: `${sub}-${now}-${Math.random().toString(36).slice(2)}`,
      iss: __ENV.JWT_ISSUER || 'tint-identity',
      aud: __ENV.JWT_AUDIENCE || 'tint:room',
      exp: now + 3600,
    }),
  );
  const sig = crypto.hmac('sha256', secret, `${head}.${body}`, 'binary');
  return `${head}.${body}.${encoding.b64encode(sig, 'rawurl')}`;
}

let seq = 0;
function msg(type, fields) {
  seq += 1;
  return JSON.stringify({ type, event_id: `vu${__VU}-${seq}`, occurred_at: Date.now(), ...fields });
}

export default function () {
  const room = `${ROOM_ID}-${Math.floor((__VU - 1) / ROOM_SIZE)}`;
  const url = (tok) => `${BASE_URL}/ws/voice?room_id=${encodeURIComponent(room)}&token=${tok}`;

  // Autorización: un token mal firmado se rechaza antes del upgrade.
  const bad = ws.connect(url(token(`vu-${__VU}`, room, 'otro-secreto')), {}, () => {});
  authRejected.add(bad && bad.status === 401);

  const started = Date.now();
  let joined = false;
  const res = ws.connect(url(token(`vu-${__VU}`, room)), {}, (socket) => {
    let peers = [];
    socket.on('message', (text) => {
      const m = JSON.parse(text);
      if (m.type === 'voice_state') {
        joined = true;
        joinMs.add(Date.now() - started);
        peers = m.peers.map((p) => p.peer_id);
        // Quien llega ofrece a cada uno de los que ya estaban.
        for (const p of peers) socket.send(msg('signal', { to: p, data: { description: { type: 'offer', sdp: 'x' }, t: Date.now() } }));
      } else if (m.type === 'peer_joined') {
        peers.push(m.peer.peer_id);
      } else if (m.type === 'peer_left') {
        peers = peers.filter((p) => p !== m.peer_id);
      } else if (m.type === 'signal') {
        if (typeof m.data.t === 'number') {
          relayMs.add(Date.now() - m.data.t);
          signalsRelayed.add(1);
        }
        check(m, { 'signal trae from del servidor': (s) => typeof s.from === 'string' && s.from.length > 0 });
      } else if (m.type === 'error' && m.code !== 'PEER_NOT_FOUND') {
        // PEER_NOT_FOUND es normal en la rotación (el peer acaba de salir).
        errors.add(1);
        console.warn(`error ${m.code}`);
      }
    });
    socket.setInterval(() => {
      if (peers.length === 0) return;
      const to = peers[Math.floor(Math.random() * peers.length)];
      socket.send(msg('signal', { to, data: { candidate: { candidate: 'probe' }, t: Date.now() } }));
    }, 1000);
    socket.setTimeout(() => socket.send(msg('self_mute', { muted: true })), 1500);
    socket.setTimeout(() => {
      socket.send(msg('leave', {}));
      socket.close();
    }, SESSION_S * 1000);
  });
  joinOk.add(joined);
  check(res, { 'upgrade 101': (r) => r && r.status === 101 });
}
