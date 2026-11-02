// E2E de la transmisión en vivo con Chromium real (docs/dominio-transmision.md §7–§9).
// Lo lanza run.sh dentro de minlag/mermaid-cli (trae Chromium y Puppeteer).
//
//   node stream-e2e.cjs [normal|relay]
//
// Host y viewers usan la web real (`/live/:id` y el hook useLiveStream). Lo único que se sustituye
// es la fuente de la pantalla: `getDisplayMedia` devuelve un canvas que dibuja `Date.now()` como un
// código de bloques blanco/negro (y su complemento, para descartar lecturas corruptas) más un tono
// como "audio del PC". El compositor, el simulcast, los dos WHIP, el DataChannel y el WHEP son los
// de producción. identity-api lo reemplaza un stub HTTP (sala `live`, sync-ticket firmado).
//
// Casos (§9 S1, HU-LIVE-02/03/05): S1 simulcast, TTFF, glass-to-glass, audio, relay y gracia.
const puppeteer = require(process.env.PUPPETEER_PATH || '/home/mermaidcli/node_modules/puppeteer');
const crypto = require('crypto');
const http = require('http');

const mode = process.argv[2] === 'relay' ? 'relay' : 'normal';
const relay = mode === 'relay';
const WEB = process.env.WEB_URL || 'http://localhost:15173';
const STREAM_HTTP = process.env.STREAM_HTTP || 'http://127.0.0.1:18086';
const STUB_PORT = Number(process.env.STUB_PORT || 18081);
const GRACE_S = Number(process.env.GRACE_S || 10);
const INTERNAL = process.env.INTERNAL_API_SECRET || 'dev-internal-secret-change-in-prod';
const ROOM = `e2e-live-${mode}-${Date.now()}`;
const TTFF_ROUNDS = Number(process.env.TTFF_ROUNDS || 5); // recargas por viewer
const G2G_MS = Number(process.env.G2G_MS || 15000);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- Tokens ---------------------------------------------------------------------------------
const b64url = (buf) => Buffer.from(buf).toString('base64url');
function sign(claims) {
  const head = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = b64url(JSON.stringify(claims));
  const sig = crypto
    .createHmac('sha256', process.env.JWT_SECRET || 'dev-secret-change-in-prod')
    .update(`${head}.${body}`)
    .digest();
  return `${head}.${body}.${b64url(sig)}`;
}
function token(nick, role = 'participant') {
  const now = Math.floor(Date.now() / 1000);
  return sign({
    sub: `e2e-${nick.toLowerCase()}-${crypto.randomUUID().slice(0, 8)}`,
    room_id: ROOM,
    role,
    nick,
    jti: crypto.randomUUID(),
    iss: process.env.JWT_ISSUER || 'tint-identity',
    aud: process.env.JWT_AUDIENCE || 'tint:room',
    exp: now + 3600,
  });
}
const hostTicket = token('Host', 'host');
// Sesión de host de la web (`tint_token`): solo se decodifica para mostrar; el stub no la valida.
const hostSession = `${b64url('{"alg":"none"}')}.${b64url(JSON.stringify({ sub: 'e2e-host', name: 'Host E2E' }))}.x`;

// --- Stub de identity-api --------------------------------------------------------------------
const disableCalls = [];
const stub = http.createServer((req, res) => {
  const send = (code, body) => {
    res.writeHead(code, {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Authorization, Content-Type',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    });
    res.end(JSON.stringify(body));
  };
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    const path = req.url.split('?')[0];
    if (req.method === 'OPTIONS') return send(204, {});
    let m;
    if ((m = /^\/api\/v1\/internal\/rooms\/([^/]+)\/disable$/.exec(path)) && req.method === 'POST') {
      disableCalls.push({ room: decodeURIComponent(m[1]), token: req.headers['x-internal-token'], body, at: Date.now() });
      return send(200, { ok: true });
    }
    if ((m = /^\/api\/v1\/rooms\/([^/]+)$/.exec(path)) && req.method === 'GET')
      return send(200, { room: { id: m[1], kind: 'live', status: 'active', title: 'E2E en vivo' } });
    if (/^\/api\/v1\/rooms\/[^/]+\/invitations$/.test(path)) return send(200, { invitations: [] });
    if (/^\/api\/v1\/rooms\/[^/]+\/sync-ticket$/.test(path) && req.method === 'POST')
      return send(200, { token: hostTicket });
    return send(404, { error: 'NOT_FOUND' });
  });
});

// --- Código inyectado en las páginas ---------------------------------------------------------
// Registra las RTCPeerConnection, los mensajes de sus DataChannel y el TTFF de cada WHEP.
const spy = `(() => {
  const Orig = window.RTCPeerConnection;
  window.__pcs = []; window.__events = []; window.__ttff = [];
  window.RTCPeerConnection = function (config) {
    const pc = new Orig(${relay} ? { ...config, iceTransportPolicy: 'relay' } : config);
    window.__pcs.push(pc);
    const createDc = pc.createDataChannel.bind(pc);
    pc.createDataChannel = (label, init) => {
      const dc = createDc(label, init);
      dc.addEventListener('message', (e) => {
        try { window.__events.push({ at: Date.now(), ...JSON.parse(e.data) }); } catch {}
      });
      return dc;
    };
    return pc;
  };
  window.RTCPeerConnection.prototype = Orig.prototype;
  Object.setPrototypeOf(window.RTCPeerConnection, Orig);
  const origFetch = window.fetch.bind(window);
  window.fetch = (input, init) => {
    const url = String(input && input.url ? input.url : input);
    const post = init && init.method === 'POST';
    if (post && /\\/whip\\?kind=video$/.test(url)) window.__whipAt = Date.now();
    if (post && /\\/whep$/.test(url)) {
      // TTFF: del POST WHEP al primer frame decodificado (framesDecoded > 0).
      const pc = window.__pcs[window.__pcs.length - 1];
      const t0 = performance.now();
      // Fases: PeerConnection connected, primer byte de vídeo y primer frame decodificado.
      const phase = { connected: -1, bytes: -1 };
      const id = setInterval(async () => {
        const dt = performance.now() - t0;
        if (dt > 15000) { clearInterval(id); window.__ttff.push({ ms: -1, ...phase }); return; }
        if (!pc || pc.connectionState === 'closed') return;
        if (phase.connected < 0 && pc.connectionState === 'connected') phase.connected = Math.round(dt);
        let frames = 0;
        let bytes = 0;
        (await pc.getStats()).forEach((s) => {
          if (s.type === 'inbound-rtp' && s.kind === 'video') { frames = s.framesDecoded || 0; bytes = s.bytesReceived || 0; }
        });
        if (phase.bytes < 0 && bytes > 0) phase.bytes = Math.round(dt);
        if (frames > 0) { clearInterval(id); window.__ttff.push({ ms: performance.now() - t0, at: Date.now() - (performance.now() - t0), ...phase }); }
      }, 20);
    }
    return origFetch(input, init);
  };
})();`;

// Geometría del código de barras (en el canvas de 1280×720 del host).
const BC = { W: 1280, H: 720, COLS: 14, ROWS: 3, CELL: 80, X0: 80, Y0: 40, GAP: 40, BITS: 42 };

// Host: la "pantalla" es un canvas con Date.now() en binario + un tono como audio del sistema.
const fakeScreen = `(() => {
  const BC = ${JSON.stringify(BC)};
  navigator.mediaDevices.getDisplayMedia = async () => {
    const c = document.createElement('canvas');
    c.width = BC.W; c.height = BC.H;
    const ctx = c.getContext('2d');
    let x = 0;
    const draw = () => {
      const t = Date.now();
      ctx.fillStyle = '#808080';
      ctx.fillRect(0, 0, BC.W, BC.H);
      for (let i = 0; i < BC.BITS; i++) {
        const bit = Math.floor(t / 2 ** i) % 2;
        const x0 = BC.X0 + (i % BC.COLS) * BC.CELL;
        const y0 = BC.Y0 + Math.floor(i / BC.COLS) * BC.CELL;
        ctx.fillStyle = bit ? '#fff' : '#000';
        ctx.fillRect(x0, y0, BC.CELL, BC.CELL);
        ctx.fillStyle = bit ? '#000' : '#fff';
        ctx.fillRect(x0, y0 + BC.ROWS * BC.CELL + BC.GAP, BC.CELL, BC.CELL);
      }
      // Algo de movimiento abajo para que el codificador no vea una imagen casi estática.
      x = (x + 12) % BC.W;
      ctx.fillStyle = '#c33';
      ctx.fillRect(x, 620, 160, 80);
    };
    draw();
    setInterval(draw, 1000 / 60);
    const video = c.captureStream(30).getVideoTracks()[0];
    const ac = new AudioContext();
    const osc = ac.createOscillator();
    osc.frequency.value = 440;
    const dst = ac.createMediaStreamDestination();
    osc.connect(dst);
    osc.start();
    return new MediaStream([video, dst.stream.getAudioTracks()[0]]);
  };
})();`;

// Viewer: lee el código de cada frame del <video> (requestVideoFrameCallback) y calcula la latencia.
function startDecoder(BC) {
  window.__g2g = [];
  const v = document.querySelector('video[aria-label="Transmisión en vivo"]');
  if (!v) return false;
  const c = document.createElement('canvas');
  c.width = 640;
  c.height = 360;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  const k = c.width / BC.W;
  const onFrame = () => {
    const now = Date.now();
    if (v.videoWidth) {
      ctx.drawImage(v, 0, 0, c.width, c.height);
      const d = ctx.getImageData(0, 0, c.width, c.height).data;
      // Luminancia media de un parche de 5×5 en el centro de la celda (tolera bordes y artefactos).
      const lum = (x, y) => {
        let sum = 0;
        for (let dy = -2; dy <= 2; dy++)
          for (let dx = -2; dx <= 2; dx++) {
            const o = ((Math.round(y * k) + dy) * c.width + Math.round(x * k) + dx) * 4;
            sum += (d[o] + d[o + 1] + d[o + 2]) / 3;
          }
        return sum / 25;
      };
      let t = 0;
      let ok = true;
      for (let i = 0; i < BC.BITS && ok; i++) {
        const cx = BC.X0 + (i % BC.COLS) * BC.CELL + BC.CELL / 2;
        const cy = BC.Y0 + Math.floor(i / BC.COLS) * BC.CELL + BC.CELL / 2;
        const a = lum(cx, cy);
        const b = lum(cx, cy + BC.ROWS * BC.CELL + BC.GAP);
        if (Math.abs(a - b) < 60) ok = false; // bit y complemento deben ser opuestos y nítidos
        else if (a > b) t += 2 ** i;
      }
      if (ok) {
        const dt = now - t;
        if (dt > -20 && dt < 10000) window.__g2g.push({ dt, w: v.videoWidth });
      }
    }
    v.requestVideoFrameCallback(onFrame);
  };
  v.requestVideoFrameCallback(onFrame);
  return true;
}

// --- Utilidades ------------------------------------------------------------------------------
let failures = 0;
const results = { mode, room: ROOM };
function check(ok, label) {
  console.log(`${ok ? '✔' : '✘'} ${label}`);
  if (!ok) failures += 1;
  return ok;
}
async function waitFor(fn, ms = 10000, step = 100) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (await fn()) return true;
    await sleep(step);
  }
  return false;
}
function pct(xs, p) {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1))];
}

/** Resumen de getStats de todas las PeerConnection abiertas de la página. */
const pageStats = (page) =>
  page.evaluate(async () => {
    const out = { outbound: {}, video: null, audio: null, routes: [], states: [] };
    for (const pc of window.__pcs) {
      if (pc.connectionState === 'closed') continue;
      out.states.push(pc.connectionState);
      const byId = {};
      let pairId = null;
      const stats = await pc.getStats();
      stats.forEach((s) => (byId[s.id] = s));
      stats.forEach((s) => {
        if (s.type === 'outbound-rtp' && s.kind === 'video')
          out.outbound[s.rid || '?'] = {
            bytes: s.bytesSent,
            header: s.headerBytesSent, // en Chrome incluye el padding
            packets: s.packetsSent,
            rtx: s.retransmittedBytesSent,
            targetBps: s.targetBitrate,
            frames: s.framesEncoded,
            w: s.frameWidth,
            h: s.frameHeight,
            fps: s.framesPerSecond,
            active: s.active,
            limit: s.qualityLimitationReason,
          };
        if (s.type === 'outbound-rtp' && s.kind === 'audio') out.audioOut = { bytes: s.bytesSent };
        if (s.type === 'inbound-rtp' && s.kind === 'video')
          out.video = { frames: s.framesDecoded, bytes: s.bytesReceived, w: s.frameWidth, h: s.frameHeight };
        if (s.type === 'inbound-rtp' && s.kind === 'audio')
          out.audio = {
            bytes: s.bytesReceived,
            codec: byId[s.codecId]?.mimeType,
            channels: byId[s.codecId]?.channels,
            fmtp: byId[s.codecId]?.sdpFmtpLine,
          };
        if (s.type === 'transport' && s.selectedCandidatePairId) pairId = s.selectedCandidatePairId;
      });
      const pair = pairId && byId[pairId];
      const local = pair && byId[pair.localCandidateId];
      const remote = pair && byId[pair.remoteCandidateId];
      if (local && remote) out.routes.push(`${local.candidateType}->${remote.candidateType}`);
      if (pair && pair.availableIncomingBitrate) out.rembBps = pair.availableIncomingBitrate;
      if (pair && pair.availableOutgoingBitrate) out.bweOutBps = pair.availableOutgoingBitrate;
    }
    return out;
  });

const events = (page, type) => page.evaluate((t) => window.__events.filter((e) => e.type === t), type);

async function openPage(browser, storage, name) {
  const ctx = await browser.createBrowserContext();
  const page = await ctx.newPage();
  page.on('dialog', (d) => d.accept());
  page.on('pageerror', (e) => console.log(`  [${name}] pageerror: ${e.message}`));
  await page.evaluateOnNewDocument(spy);
  await page.evaluateOnNewDocument((kv) => {
    for (const [k, v] of Object.entries(kv)) localStorage.setItem(k, v);
  }, storage);
  return page;
}

async function openViewer(browser, name) {
  const page = await openPage(browser, { tint_guest_token: token(name) }, name);
  await page.goto(`${WEB}/live/${ROOM}`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  return page;
}

/** Espera el TTFF de la última conexión WHEP de la página (ms, o -1 si no llegó en 15 s). */
async function ttffOf(page) {
  await waitFor(() => page.evaluate(() => window.__ttff.length > 0), 20000);
  return page.evaluate(() => window.__ttff[window.__ttff.length - 1] ?? { ms: -1 });
}

(async () => {
  await new Promise((r) => stub.listen(STUB_PORT, '0.0.0.0', r));
  const browser = await puppeteer.launch({
    headless: 'new',
    executablePath: process.env.CHROME_PATH || '/usr/bin/chromium-browser',
    args: [
      '--no-sandbox',
      '--use-fake-ui-for-media-stream',
      '--use-fake-device-for-media-stream',
      '--autoplay-policy=no-user-gesture-required',
      '--disable-background-timer-throttling',
      '--disable-renderer-backgrounding',
      '--disable-backgrounding-occluded-windows',
    ],
  });
  try {
    console.log(`== stream E2E · ${relay ? 'solo TURN (relay)' : 'ruta libre'} · sala ${ROOM}`);
    const start = await fetch(`${STREAM_HTTP}/internal/events/start/${ROOM}`, { method: 'POST' });
    if (!check(start.status === 200, `sala habilitada en stream-core (${start.status})`)) throw new Error('sin sala');

    // --- Host: la web real, "Empezar a transmitir" ---
    const host = await openPage(browser, { tint_token: hostSession }, 'host');
    await host.evaluateOnNewDocument(fakeScreen);
    await host.goto(`${WEB}/live/${ROOM}`, { waitUntil: 'domcontentloaded', timeout: 60000 });
    const startBtn = await host
      .waitForSelector('xpath/.//button[contains(., "Empezar a transmitir")]', { timeout: 20000 })
      .catch(() => null);
    if (!check(!!startBtn, 'el host ve "Empezar a transmitir"')) throw new Error('sin botón');
    await startBtn.click();

    // --- 1. S1 simulcast: 3 outbound-rtp en Chrome y 3 capas aprendidas por el SFU en < 10 s ---
    let s1 = null;
    let hs = null;
    const s1ok = await waitFor(async () => {
      s1 = await pageStats(host);
      hs = (await events(host, 'host_stats')).pop();
      const rids = ['l', 'm', 'h'];
      const chrome = rids.every((r) => s1.outbound[r]?.frames > 0 && s1.outbound[r]?.active !== false);
      const sfu = hs && rids.every((r) => hs.layers.some((l) => l.rid === r && l.active && l.bitrate_bps > 0));
      return chrome && sfu;
    }, 15000, 250);
    const s1ms = (await host.evaluate(() => Date.now() - window.__whipAt)) || -1;
    results.s1 = { ms: s1ok ? s1ms : null, chrome: s1?.outbound, sfu: hs?.layers };
    console.log(`  Chrome outbound-rtp: ${JSON.stringify(s1?.outbound)}`);
    console.log(`  SFU host_stats.layers: ${JSON.stringify(hs?.layers)}`);
    check(s1ok && s1ms < 10000, `S1: Chrome publica 3 rid y el SFU aprende las 3 capas activas (${s1ok ? s1ms + ' ms' : 'no'} desde el WHIP; < 10 s)`);
    const hostBefore = await pageStats(host);
    await sleep(2000);
    const hostAfter = await pageStats(host);
    const kbps = Object.fromEntries(
      Object.keys(hostAfter.outbound).map((r) => [r, Math.round(((hostAfter.outbound[r].bytes - (hostBefore.outbound[r]?.bytes || 0)) * 8) / 2000)]),
    );
    results.s1.kbps = kbps;
    console.log(`  subida por capa (kbps, 2 s): ${JSON.stringify(kbps)} · audio ${Math.round(((hostAfter.audioOut?.bytes || 0) - (hostBefore.audioOut?.bytes || 0)) * 8 / 2000)} kbps`);
    console.log(`  rutas del host: ${hostAfter.routes.join(', ')}`);
    const steady = (await events(host, 'host_stats')).pop();
    results.s1.sfuSteady = steady?.layers;
    console.log(`  SFU host_stats (régimen): ${JSON.stringify(steady?.layers)} · nacks ${steady?.nacks} · plis ${steady?.plis}`);

    // Host: cuándo recibe cada PLI y codifica cada keyframe de cada capa (Date.now()).
    await host.evaluate(() => {
      window.__kf = [];
      const last = {};
      setInterval(async () => {
        const pc = window.__pcs.find((c) => c.connectionState !== 'closed');
        if (!pc) return;
        (await pc.getStats()).forEach((s) => {
          if (s.type !== 'outbound-rtp' || s.kind !== 'video') return;
          const prev = last[s.rid] || { pli: 0, kf: 0 };
          if (s.pliCount > prev.pli) window.__kf.push({ at: Date.now(), rid: s.rid, ev: 'pli' });
          if (s.keyFramesEncoded > prev.kf) window.__kf.push({ at: Date.now(), rid: s.rid, ev: 'kf' });
          last[s.rid] = { pli: s.pliCount, kf: s.keyFramesEncoded };
        });
      }, 20);
    });

    // --- Viewers ---
    const viewers = [await openViewer(browser, 'Ana'), await openViewer(browser, 'Luis')];

    // --- 2. TTFF: del POST WHEP al primer frame, TTFF_ROUNDS conexiones por viewer ---
    const ttffs = [];
    for (let round = 0; round < TTFF_ROUNDS; round++) {
      for (const v of viewers) {
        if (round > 0) await v.reload({ waitUntil: 'domcontentloaded' });
        ttffs.push(await ttffOf(v));
      }
    }
    console.log(`  fases (ms desde el POST WHEP: connected / primer byte de vídeo / primer frame): ${ttffs.map((t) => `${t.connected}/${t.bytes}/${Math.round(t.ms)}`).join(' · ')}`);
    if (process.env.DIAG) {
      const kf = await host.evaluate(() => window.__kf);
      for (const t of ttffs) {
        const near = kf.filter((k) => k.at >= t.at - 200 && k.at <= t.at + t.ms + 200).map((k) => `${k.rid}:${k.ev}@${k.at - t.at}`);
        console.log(`  [diag] WHEP→frame ${Math.round(t.ms)} ms; host: ${near.join(' ')}`);
      }
    }
    const ttffMs = ttffs.map((t) => t.ms);
    const okTtff = ttffMs.filter((t) => t >= 0);
    results.ttff = { samples: ttffMs.map(Math.round), p50: Math.round(pct(okTtff, 50)), p95: Math.round(pct(okTtff, 95)), max: Math.round(Math.max(...okTtff)) };
    console.log(`  TTFF (ms): ${results.ttff.samples.join(', ')}`);
    check(okTtff.length === ttffMs.length && ttffMs.every((t) => t < 5000), `TTFF < 5 s en las ${ttffMs.length} conexiones (máx ${results.ttff.max} ms)`);
    check(results.ttff.p95 < 2000, `TTFF p95 ${results.ttff.p95} ms < 2 s (p50 ${results.ttff.p50} ms; HU-LIVE-02 AC1)`);

    // --- 3. Glass-to-glass ---
    for (const v of viewers) {
      const ok = await waitFor(() => v.evaluate(startDecoder, BC), 10000);
      check(ok, 'el viewer muestra el <video> de la transmisión');
    }
    // Mientras tanto: capa que recibe el primer viewer (ancho) y su estimación de bajada (REMB).
    const layerLog = [];
    for (let t = 0; t < G2G_MS; t += 1000) {
      const st = await pageStats(viewers[0]);
      layerLog.push(`${st.video?.w ?? '?'}px/${st.rembBps ? Math.round(st.rembBps / 1000) + 'k' : '—'}`);
      await sleep(1000);
    }
    console.log(`  viewer 1 cada 1 s (ancho recibido / availableIncomingBitrate): ${layerLog.join(' ')}`);
    results.layers = layerLog;
    const g2g = (await Promise.all(viewers.map((v) => v.evaluate(() => window.__g2g)))).flat();
    const dts = g2g.map((s) => s.dt);
    const widths = [...new Set(g2g.map((s) => s.w))];
    results.g2g = { n: dts.length, p50: pct(dts, 50), p95: pct(dts, 95), max: Math.max(...dts), widths };
    console.log(`  glass-to-glass: ${dts.length} muestras · p50 ${results.g2g.p50} ms · p95 ${results.g2g.p95} ms · máx ${results.g2g.max} ms · anchos recibidos ${widths.join('/')}`);
    check(dts.length >= 30, `≥ 30 muestras de glass-to-glass (${dts.length})`);
    check(results.g2g.p95 < 500, `glass-to-glass p95 ${results.g2g.p95} ms < 500 ms`);

    // --- 4. Audio Opus ---
    for (const [i, v] of viewers.entries()) {
      const a = await pageStats(v);
      await sleep(2000);
      const b = await pageStats(v);
      const bytes = (b.audio?.bytes || 0) - (a.audio?.bytes || 0);
      results[`audio${i}`] = { bytes2s: bytes, codec: b.audio?.codec, channels: b.audio?.channels, fmtp: b.audio?.fmtp };
      check(bytes > 0 && /opus/i.test(b.audio?.codec || ''), `viewer ${i + 1} recibe audio ${b.audio?.codec} (+${bytes} bytes en 2 s; fmtp ${b.audio?.fmtp})`);
    }

    // --- 5. Rutas (relay: todas por TURN y llega vídeo) ---
    const vstats = await Promise.all(viewers.map(pageStats));
    const routes = [...hostAfter.routes, ...vstats.flatMap((s) => s.routes)];
    results.routes = routes;
    if (relay) {
      check(routes.length >= 4 && routes.every((r) => r.startsWith('relay')), `relay: todos los pares elegidos son relay (${routes.join(', ')})`);
      check(vstats.every((s) => s.video?.frames > 0), `relay: llega vídeo a los viewers (${vstats.map((s) => s.video?.frames).join('/')} frames)`);
    } else {
      check(routes.every((r) => !r.includes('relay')), `ruta libre sin TURN (${routes.join(', ')})`);
    }

    // Subida del host en régimen (HU-LIVE-02 AC2), tras ~40 s transmitiendo: Chrome y lo que ve el SFU.
    const late0 = await pageStats(host);
    await sleep(2000);
    const late1 = await pageStats(host);
    const lateKbps = Object.fromEntries(
      Object.keys(late1.outbound).map((r) => [r, Math.round(((late1.outbound[r].bytes - (late0.outbound[r]?.bytes || 0)) * 8) / 2000)]),
    );
    const lateHeaderKbps = Object.fromEntries(
      Object.keys(late1.outbound).map((r) => [r, Math.round(((late1.outbound[r].header - (late0.outbound[r]?.header || 0)) * 8) / 2000)]),
    );
    const rate = (field, scale) =>
      Object.fromEntries(
        Object.keys(late1.outbound).map((r) => [r, Math.round((((late1.outbound[r][field] || 0) - (late0.outbound[r]?.[field] || 0)) * scale) / 2000)]),
      );
    const latePps = rate('packets', 1000);
    const lateRtxKbps = rate('rtx', 8);
    const lateTargetKbps = Object.fromEntries(Object.keys(late1.outbound).map((r) => [r, Math.round((late1.outbound[r].targetBps || 0) / 1000)]));
    console.log(`  host en régimen: cabeceras + padding por capa (kbps) ${JSON.stringify(lateHeaderKbps)} · paquetes/s ${JSON.stringify(latePps)} · retransmitido (kbps) ${JSON.stringify(lateRtxKbps)} · targetBitrate (kbps) ${JSON.stringify(lateTargetKbps)}`);
    const lateHs = (await events(host, 'host_stats')).pop();
    results.hostLate = { kbps: lateKbps, headerKbps: lateHeaderKbps, pps: latePps, rtxKbps: lateRtxKbps, targetKbps: lateTargetKbps, bweOutKbps: Math.round((late1.bweOutBps || 0) / 1000), sfu: lateHs?.layers, limit: late1.outbound.h?.limit };
    console.log(`  host en régimen: Chrome por capa (kbps) ${JSON.stringify(lateKbps)} · BWE de salida ${results.hostLate.bweOutKbps} kbps · limitación ${late1.outbound.h?.limit}`);
    console.log(`  SFU host_stats en régimen: ${(lateHs?.layers || []).map((l) => `${l.rid} ${Math.round(l.bitrate_bps / 1000)}k (${l.viewers} viewers)`).join(' · ')}`);

    // --- 6. Gracia y fin: se cierra la pestaña del host ---
    const closedAt = Date.now();
    await host.close({ runBeforeUnload: true });
    const reconnecting = await waitFor(
      async () => (await Promise.all(viewers.map((v) => events(v, 'stream_state')))).every((evs) => evs.some((e) => e.state === 'reconnecting' && e.at >= closedAt)),
      15000,
    );
    const rec = (await events(viewers[0], 'stream_state')).find((e) => e.state === 'reconnecting' && e.at >= closedAt);
    check(reconnecting, `los viewers reciben stream_state reconnecting (${rec ? rec.at - closedAt + ' ms' : '—'}; grace_deadline_ms ${rec?.grace_deadline_ms ? 'presente' : 'ausente'})`);
    const ended = await waitFor(
      async () => (await Promise.all(viewers.map((v) => events(v, 'stream_state')))).every((evs) => evs.some((e) => e.state === 'ended')),
      (GRACE_S + 15) * 1000,
      200,
    );
    const end = (await events(viewers[0], 'stream_state')).find((e) => e.state === 'ended');
    results.grace = { reconnectingMs: rec ? rec.at - closedAt : null, endedMs: end ? end.at - closedAt : null, reason: end?.reason };
    check(ended && end?.reason === 'grace_expired', `stream_state ended con reason "${end?.reason}" a los ${end ? end.at - closedAt : '—'} ms (gracia ${GRACE_S} s)`);
    const call = disableCalls.find((c) => c.room === ROOM);
    check(!!call && call.token === INTERNAL, `stream-core llamó a POST /api/v1/internal/rooms/{id}/disable con X-Internal-Token (${call ? 'sí' : 'no'})`);
    const notice = await viewers[0]
      .waitForFunction((t) => document.body.innerText.includes(t), { timeout: 5000 }, 'El evento terminó y la sala fue deshabilitada')
      .then(() => true)
      .catch(() => false);
    check(notice, 'el viewer ve "El evento terminó y la sala fue deshabilitada"');
  } catch (err) {
    console.log('✘ error:', err.message);
    failures += 1;
  } finally {
    await browser.close();
    stub.close();
  }
  console.log(`RESULT ${JSON.stringify(results)}`);
  console.log(failures === 0 ? `== ${mode}: todo en verde` : `== ${mode}: ${failures} fallo(s)`);
  process.exit(failures === 0 ? 0 : 1);
})();
