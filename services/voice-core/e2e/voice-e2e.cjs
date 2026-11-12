// E2E de la voz con dos Chromium reales (micrófono falso: un tono) contra la web y voice-core.
// Lo lanza run.sh dentro de minlag/mermaid-cli (trae Chromium y Puppeteer).
//
//   node voice-e2e.cjs [normal|relay]
//
// Variables: WEB_URL (http://localhost:5173), VOICE_HTTP (http://localhost:8085), JWT_SECRET,
// JWT_ISSUER, JWT_AUDIENCE. En modo relay se fuerza iceTransportPolicy 'relay' (solo TURN).
const puppeteer = require(process.env.PUPPETEER_PATH || '/home/mermaidcli/node_modules/puppeteer');
const crypto = require('crypto');

const mode = process.argv[2] === 'relay' ? 'relay' : 'normal';
const relay = mode === 'relay';
const WEB = process.env.WEB_URL || 'http://localhost:5173';
const VOICE_HTTP = process.env.VOICE_HTTP || 'http://localhost:8085';
const ROOM = `e2e-voz-${Date.now()}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const b64url = (buf) => Buffer.from(buf).toString('base64url');
function token(nick, role = 'participant') {
  const now = Math.floor(Date.now() / 1000);
  const claims = {
    sub: `e2e-${nick.toLowerCase()}-${crypto.randomUUID().slice(0, 8)}`,
    room_id: ROOM,
    role,
    nick,
    jti: crypto.randomUUID(),
    iss: process.env.JWT_ISSUER || 'tint-identity',
    aud: process.env.JWT_AUDIENCE || 'tint:room',
    exp: now + 3600,
  };
  const head = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = b64url(JSON.stringify(claims));
  const sig = crypto
    .createHmac('sha256', process.env.JWT_SECRET || 'dev-secret-change-in-prod')
    .update(`${head}.${body}`)
    .digest();
  return { token: `${head}.${body}.${b64url(sig)}`, sub: claims.sub };
}

// Guarda las RTCPeerConnection de la página (y fuerza relay si se pide).
const spy = `(() => {
  const Orig = window.RTCPeerConnection;
  window.__pcs = [];
  window.RTCPeerConnection = function (config) {
    const pc = new Orig(${relay} ? { ...config, iceTransportPolicy: 'relay' } : config);
    window.__pcs.push(pc);
    return pc;
  };
  window.RTCPeerConnection.prototype = Orig.prototype;
  // Sockets de voz abiertos, para simular que se cae la red de la señalización.
  const OrigWs = window.WebSocket;
  window.__voiceSockets = [];
  window.WebSocket = function (url, protocols) {
    const ws = new OrigWs(url, protocols);
    if (String(url).includes('/ws/voice')) window.__voiceSockets.push(ws);
    return ws;
  };
  window.WebSocket.prototype = OrigWs.prototype;
  Object.assign(window.WebSocket, { CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 });
})();`;

/** Bytes de audio recibidos/enviados y par ICE elegido de la conexión activa. */
async function stats(page) {
  return page.evaluate(async () => {
    const pc = window.__pcs.find((c) => c.connectionState !== 'closed');
    if (!pc) return null;
    const byId = {};
    let inbound = 0;
    let outbound = 0;
    let pairId = null;
    (await pc.getStats()).forEach((s) => {
      byId[s.id] = s;
      if (s.type === 'inbound-rtp' && s.kind === 'audio') inbound += s.bytesReceived || 0;
      if (s.type === 'outbound-rtp' && s.kind === 'audio') outbound += s.bytesSent || 0;
      if (s.type === 'transport' && s.selectedCandidatePairId) pairId = s.selectedCandidatePairId;
    });
    const pair = pairId && byId[pairId];
    const local = pair && byId[pair.localCandidateId];
    const remote = pair && byId[pair.remoteCandidateId];
    return {
      state: pc.connectionState,
      inbound,
      outbound,
      policy: pc.getConfiguration().iceTransportPolicy,
      route: local && remote ? `${local.candidateType} -> ${remote.candidateType}` : null,
      viaTurn: local?.candidateType === 'relay' || remote?.candidateType === 'relay',
    };
  });
}

/** Diferencia de bytes en una ventana de 2 s. */
async function delta(page, key) {
  const a = await stats(page);
  await sleep(2000);
  const b = await stats(page);
  return (b?.[key] ?? 0) - (a?.[key] ?? 0);
}

async function person(browser, nick, tok) {
  const ctx = await browser.createBrowserContext();
  const page = await ctx.newPage();
  page.on('dialog', (d) => d.accept());
  await page.evaluateOnNewDocument(spy);
  await page.evaluateOnNewDocument((t) => localStorage.setItem('tint_guest_token', t), tok);
  await page.goto(`${WEB}/watch/${ROOM}`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  const join = await page
    .waitForSelector('xpath/.//button[contains(., "Unirse a la voz")]', { timeout: 20000 })
    .catch(() => null);
  if (!join) throw new Error(`${nick}: no aparece "Unirse a la voz"`);
  await join.click();
  return page;
}

const status = (page) => page.$eval('#voice-title + p', (el) => el.textContent.trim()).catch(() => '');
const rows = (page) =>
  page.$$eval('ul[aria-label="En la voz"] li', (lis) =>
    lis.map((li) => ({ text: li.textContent.replace(/\s+/g, ' ').trim(), speaking: li.dataset.speaking })),
  );
const button = async (page, xpath) => (await page.$$(`xpath/.//button[${xpath}]`))[0];

let failures = 0;
function check(ok, label) {
  console.log(`${ok ? '✔' : '✘'} ${label}`);
  if (!ok) failures += 1;
}

async function waitFor(fn, ms = 10000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (await fn()) return true;
    await sleep(100);
  }
  return false;
}

(async () => {
  const browser = await puppeteer.launch({
    headless: 'new',
    executablePath: process.env.CHROME_PATH || '/usr/bin/chromium-browser',
    args: [
      '--no-sandbox',
      '--use-fake-ui-for-media-stream',
      '--use-fake-device-for-media-stream',
      '--autoplay-policy=no-user-gesture-required',
    ],
  });
  const ana = token('Ana');
  const luis = token('Luis');
  const host = token('Host', 'host');
  try {
    console.log(`== voz E2E · ${relay ? 'solo TURN (relay)' : 'ruta libre'} · sala ${ROOM}`);
    const pa = await person(browser, 'Ana', ana.token);
    await waitFor(async () => (await status(pa)) === '1 en la voz');
    const pl = await person(browser, 'Luis', luis.token);

    // HU-VOZ-01 AC1: entran, se conectan y se oyen.
    check(
      await waitFor(async () => (await status(pa)) === '2 en la voz' && (await status(pl)) === '2 en la voz'),
      'los dos se ven en la voz',
    );
    check(await waitFor(async () => (await stats(pl))?.state === 'connected', 15000), 'RTCPeerConnection conectada');
    const heard = await delta(pl, 'inbound');
    check(heard > 1000, `Luis recibe audio de Ana (+${heard} bytes en 2 s)`);
    const route = await stats(pl);
    if (relay) check(route?.viaTurn && route?.policy === 'relay', `la ruta pasa por TURN (${route?.route})`);
    else check(!route?.viaTurn, `con ruta directa disponible no se usa TURN (${route?.route})`); // HU-VOZ-05 AC2

    // HU-VOZ-03: quien habla aparece resaltado (el tono es intermitente).
    check(
      await waitFor(async () => (await rows(pl)).some((r) => r.text.startsWith('A') && r.speaking === 'true')),
      'Luis ve a Ana resaltada mientras suena el tono',
    );

    // HU-VOZ-02: silenciada no se transmite audio; al activar vuelve; los demás ven el icono.
    await (await button(pa, 'normalize-space(.)="Silenciar"')).click();
    await sleep(1500);
    const mutedBytes = await delta(pl, 'inbound');
    check(mutedBytes < 200, `sin audio mientras Ana está silenciada (+${mutedBytes} bytes)`);
    check(!!(await pl.$('ul[aria-label="En la voz"] [aria-label="Micrófono silenciado"]')), 'Luis ve el icono de silenciado');
    await (await button(pa, 'contains(., "Activar micrófono")')).click();
    await sleep(1500);
    const back = await delta(pl, 'inbound');
    check(back > 1000, `el audio vuelve al activar (+${back} bytes)`);

    // HU-VOZ-04: el host silencia a Luis por la API REST.
    const muteUrl = `${VOICE_HTTP}/api/v1/voice/rooms/${ROOM}/mutes/${encodeURIComponent(luis.sub)}`;
    const forbidden = await fetch(muteUrl, { method: 'PUT', headers: { Authorization: `Bearer ${ana.token}` } });
    check(forbidden.status === 403, `una participante que intenta silenciar recibe ${forbidden.status}`);
    const put = await fetch(muteUrl, { method: 'PUT', headers: { Authorization: `Bearer ${host.token}` } });
    check(put.status === 204, `el host silencia a Luis (${put.status})`);
    check(
      await waitFor(async () => (await rows(pl)).some((r) => r.text.includes('(tú)') && r.text.includes('Silenciado por el host'))),
      'Luis se ve silenciado por el host',
    );
    await sleep(1000);
    const luisSends = await delta(pl, 'outbound');
    check(luisSends < 200, `Luis no envía audio (+${luisSends} bytes)`);
    check(await pa.$eval('audio', (a) => a.muted), 'el audio de Luis está mudo en el navegador de Ana');
    await (await button(pl, 'contains(., "Activar micrófono")')).click();
    const alert = await pl
      .waitForSelector('[role="alert"]', { timeout: 3000 })
      .then((el) => el.evaluate((n) => n.textContent))
      .catch(() => '');
    check(/host te silenció/i.test(alert), `Luis no puede activarse ("${alert}")`);
    const del = await fetch(muteUrl, { method: 'DELETE', headers: { Authorization: `Bearer ${host.token}` } });
    check(del.status === 204, `el host le permite hablar (${del.status})`);
    await waitFor(async () => !!(await button(pl, 'contains(., "Activar micrófono")')) && !(await pa.$eval('audio', (a) => a.muted)));
    await (await button(pl, 'contains(., "Activar micrófono")')).click();
    await sleep(1500);
    const luisBack = await delta(pl, 'outbound');
    check(luisBack > 1000, `con permiso del host Luis vuelve a enviar (+${luisBack} bytes)`);
    check(!(await pa.$eval('audio', (a) => a.muted)), 'y Ana vuelve a oírlo');

    // HU-VOZ-05 AC3: se cae la señalización de Luis → reconecta solo y el audio vuelve.
    await pl.evaluate(() => window.__voiceSockets.filter((w) => w.readyState === 1).forEach((w) => w.close(4999)));
    check(
      await waitFor(async () => /reconectando/i.test(await status(pl)), 3000),
      'Luis ve "Reconectando la voz…" al caerse la señalización',
    );
    check(
      await waitFor(async () => (await status(pl)) === '2 en la voz' && (await status(pa)) === '2 en la voz', 15000),
      'Luis vuelve a la voz sin hacer nada',
    );
    const t0 = Date.now();
    const reconnected = await waitFor(async () => (await stats(pl))?.state === 'connected', 30000);
    const states = await pl.evaluate(() => window.__pcs.map((c) => c.connectionState + '/' + c.iceConnectionState + '/' + c.iceGatheringState));
    check(reconnected, `nueva RTCPeerConnection conectada (${Date.now() - t0} ms; ${states.join(' ')})`);
    const again = await delta(pl, 'inbound');
    check(again > 1000, `tras reconectar Luis vuelve a oír a Ana (+${again} bytes)`);

    // HU-VOZ-01 AC3: al salir, el otro deja de tenerla.
    await (await button(pa, 'contains(., "Salir de la voz")')).click();
    check(await waitFor(async () => (await status(pl)) === '1 en la voz'), 'al salir Ana, Luis queda solo');
  } catch (err) {
    console.log('✘ error:', err.message);
    failures += 1;
  } finally {
    await browser.close();
  }
  console.log(failures === 0 ? `== ${mode}: todo en verde` : `== ${mode}: ${failures} fallo(s)`);
  process.exit(failures === 0 ? 0 : 1);
})();
