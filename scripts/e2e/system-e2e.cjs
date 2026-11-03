// E2E del sistema completo con Chromium real, por la entrada única del gateway (https://localhost).
// Lo lanza run.sh dentro de minlag/mermaid-cli (trae Chromium y Puppeteer).
//
//   node system-e2e.cjs watch   login (Firebase Auth Emulator) → sala watch → subida de vídeo
//                               (MinIO + media-worker) → invitada por link → reproducción
//                               sincronizada → chat, reacción, encuesta y trivia → KPIs
//   node system-e2e.cjs live    login → sala live → transmisión (WHIP/WHEP por el SFU) →
//                               invitada la ve → chat, encuesta, trivia "lanzar ahora" →
//                               voz en escenario → "Terminar evento" → aviso de fin a la invitada
//
// Variables: BASE (https://localhost), VIDEO (clip mp4), OUT (carpeta de capturas, opcional).
const puppeteer = require(process.env.PUPPETEER_PATH || '/home/mermaidcli/node_modules/puppeteer');

const MODE = process.argv[2] === 'live' ? 'live' : 'watch';
const BASE = process.env.BASE || 'https://localhost';
const VIDEO = process.env.VIDEO || '/e2e-media/clip.mp4';
const OUT = process.env.OUT || '';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const failures = [];
function check(ok, label) {
  console.log(`  ${ok ? '✓' : '✗'} ${label}`);
  if (!ok) failures.push(label);
  return ok;
}

let shot = 0;
async function snap(page, name) {
  if (!OUT) return;
  await page.screenshot({ path: `${OUT}/${MODE}-${String(++shot).padStart(2, '0')}-${name}.png` }).catch(() => {});
}

// "Pantalla" del host: un canvas animado con la hora y un tono como audio del sistema.
const fakeScreen = `(() => {
  navigator.mediaDevices.getDisplayMedia = async () => {
    const c = document.createElement('canvas'); c.width = 1280; c.height = 720;
    const ctx = c.getContext('2d'); let x = 0;
    setInterval(() => {
      ctx.fillStyle = '#234'; ctx.fillRect(0, 0, 1280, 720);
      ctx.fillStyle = '#f63'; x = (x + 12) % 1280; ctx.fillRect(x, 300, 200, 120);
      ctx.fillStyle = '#fff'; ctx.font = '64px sans-serif'; ctx.fillText(new Date().toISOString(), 60, 120);
    }, 33);
    const video = c.captureStream(30).getVideoTracks()[0];
    const ac = new AudioContext(); const osc = ac.createOscillator(); const dst = ac.createMediaStreamDestination();
    osc.connect(dst); osc.start();
    return new MediaStream([video, dst.stream.getAudioTracks()[0]]);
  };
})();`;

function instrument(page, tag) {
  page.on('pageerror', (e) => console.log(`  [${tag}] error de la página: ${e.message}`));
  page.on('response', (r) => {
    // Los 4xx/5xx de la API son pistas valiosas cuando algo falla.
    if (r.status() >= 400 && /\/(api|ws)\//.test(r.url())) console.log(`  [${tag}] HTTP ${r.status()} ${r.request().method()} ${r.url().split('?')[0]}`);
  });
}

async function clickText(page, text, sel = 'button, a', timeout = 20000) {
  const h = await page.waitForFunction(
    (s, t) => [...document.querySelectorAll(s)].find((e) => e.textContent.trim().includes(t) && !e.disabled),
    { timeout },
    sel,
    text,
  );
  await h.asElement().click();
}

const bodyHas = (page, text, timeout) =>
  page.waitForFunction((t) => document.body.innerText.includes(t), { timeout }, text).then(() => true, () => false);

async function loginHost(browser, page) {
  await page.goto(`${BASE}/login`, { waitUntil: 'networkidle2' });
  const popupP = browser
    .waitForTarget((t) => t.type() === 'page' && t.url().includes('/emulator/auth/handler'), { timeout: 15000 })
    .then((t) => t.page());
  await page.click('button[aria-label="Iniciar sesión con Google"]');
  const popup = await popupP;
  await popup.waitForNetworkIdle({ idleTime: 500, timeout: 15000 }).catch(() => {});
  await popup.locator('button ::-p-text(Add new account)').click();
  await popup.locator('#autogen-button').click();
  await popup.locator('#sign-in').click();
  await page.waitForFunction(() => location.pathname === '/dashboard', { timeout: 20000 });
}

async function createRoom(page, kind) {
  await page.goto(`${BASE}/rooms/new`, { waitUntil: 'networkidle2' });
  await page.type('#room-title', `E2E ${kind} ${Date.now() % 100000}`);
  if (kind === 'live') await page.click('input[name="room-kind"][value="live"]');
  await clickText(page, 'Crear', 'button[type="submit"]');
  await page.waitForSelector('[data-testid="invite-code"]', { timeout: 20000 });
  const link = await page.$$eval('dd', (ds) => ds.map((d) => d.textContent).find((t) => t.includes('/invite/')));
  return link.trim();
}

async function joinGuest(browser, link, nick) {
  const ctx = await browser.createBrowserContext();
  const g = await ctx.newPage();
  instrument(g, nick);
  await g.setViewport({ width: 1280, height: 860 });
  await g.goto(link.replace(/^https?:\/\/[^/]+/, BASE), { waitUntil: 'networkidle2' });
  await g.type('#nick', nick);
  await clickText(g, 'Unirse', 'button[type="submit"]');
  await g.waitForFunction(() => /^\/(watch|live)\//.test(location.pathname), { timeout: 20000 });
  return g;
}

async function uploadVideo(host) {
  await clickText(host, 'Cambiar vídeo');
  await clickText(host, 'Subir nuevo', 'button');
  const input = await host.waitForSelector('input[type="file"]', { timeout: 10000 });
  await input.uploadFile(VIDEO);
  await clickText(host, 'Subir', 'button[type="submit"]');
  const t0 = Date.now();
  const ok = await host
    .waitForFunction(() => document.querySelector('video')?.readyState >= 2, { timeout: 180000 })
    .then(() => true, () => false);
  return { ok, ms: Date.now() - t0 };
}

async function chatAndReaction(host, guest) {
  const chatSel = 'textarea[placeholder="Escribe un mensaje"], input[placeholder="Escribe un mensaje"]';
  await guest.waitForSelector(chatSel, { timeout: 15000 });
  await guest.type(chatSel, 'Hola desde el E2E');
  await guest.keyboard.press('Enter');
  check(await bodyHas(host, 'Hola desde el E2E', 10000), 'el chat de la invitada llega al host');
  await guest.evaluate(() => document.querySelector('[role="toolbar"][aria-label="Reacciones"] button')?.click());
}

async function poll(host, guest) {
  const form = 'form[aria-label="Nueva encuesta"]';
  try {
    await clickText(host, 'Nueva encuesta', 'button');
    await host.waitForSelector(form, { timeout: 8000 });
    await host.type(`${form} input[placeholder="¿Quién crees que es el culpable?"]`, '¿Te gusta el E2E?');
    await host.type(`${form} input[placeholder="Opción 1"]`, 'Sí');
    await host.type(`${form} input[placeholder="Opción 2"]`, 'No');
    await clickText(host, 'Lanzar encuesta', 'button');
  } catch (e) {
    check(false, `el host lanza una encuesta (${e.message.split('\n')[0]})`);
    return;
  }
  if (!check(await bodyHas(guest, '¿Te gusta el E2E?', 10000), 'la encuesta llega a la invitada')) return;
  await guest.evaluate(() => [...document.querySelectorAll('button')].find((b) => b.textContent.trim().startsWith('Sí'))?.click());
  const counted = await host
    .waitForFunction(() => /1 voto/.test(document.body.innerText), { timeout: 10000 })
    .then(() => true, () => false);
  check(counted, 'el voto de la invitada se cuenta en el host');
}

async function trivia(host, guest, kind) {
  try {
    await clickText(host, 'Agregar pregunta', 'button');
    await host.type('input[placeholder="¿Quién dijo la frase final?"]', '¿Color del rectángulo?');
    await host.type('input[placeholder="Respuesta 1"]', 'Naranja');
    await host.type('input[placeholder="Respuesta 2"]', 'Verde');
    await host.evaluate(() => document.querySelector('[aria-label="Respuesta 1 es la correcta"]')?.click());
    // watch: se deja el segundo que propone el formulario ("en este momento"). Mientras se escribe
    // el vídeo avanzó: social-core la lanza en el acto (la marca pasó hace < 60 s).
    await clickText(host, 'Programar pregunta', 'button[type="submit"]');
    if (kind === 'live') {
      const launch = await host.waitForSelector('button[aria-label^="Lanzar ahora la pregunta"]', { timeout: 8000 });
      await launch.evaluate((b) => b.click());
    }
  } catch (e) {
    check(false, `el host programa una trivia (${e.message.split('\n')[0]})`);
    return;
  }
  const label = kind === 'live' ? 'la trivia "lanzar ahora" llega a la invitada' : 'la trivia "en este momento" llega a la invitada';
  if (!check(await bodyHas(guest, '¿Color del rectángulo?', 30000), label)) return;
  await guest.evaluate(() => [...document.querySelectorAll('[aria-label="Trivia"] button')].find((b) => b.textContent.includes('Naranja'))?.click());
  const answered = await guest
    .waitForFunction(() => /Resultado de la trivia|Respuesta enviada/.test(document.body.innerText), { timeout: 30000 })
    .then(() => true, () => false);
  check(answered, 'la invitada responde la trivia');
}

async function watchFlow(browser, host, link) {
  await clickText(host, 'Entrar a la sala');
  await host.waitForFunction(() => location.pathname.startsWith('/watch/'), { timeout: 20000 });
  const roomId = await host.evaluate(() => location.pathname.split('/')[2]);
  const up = await uploadVideo(host);
  check(up.ok, `subida a MinIO y procesado por media-worker (${up.ms} ms)`);
  if (!up.ok) return;

  const guest = await joinGuest(browser, link, 'Invitada');
  check(true, 'la invitada entra con el link y su nick');
  await host.evaluate(() => document.querySelector('button[aria-label*="eproducir"]')?.click());
  await sleep(5000);
  const [th, tg, paused] = await Promise.all([
    host.evaluate(() => document.querySelector('video')?.currentTime ?? -1),
    guest.evaluate(() => document.querySelector('video')?.currentTime ?? -1),
    guest.evaluate(() => document.querySelector('video')?.paused ?? true),
  ]);
  const drift = Math.round(Math.abs(th - tg) * 1000);
  check(!paused && th > 1 && drift < 1000, `reproducción sincronizada (host ${th.toFixed(2)} s, invitada ${tg.toFixed(2)} s, desfase ${drift} ms)`);
  await snap(guest, 'invitada-reproduce');

  await chatAndReaction(host, guest);
  await poll(host, guest);
  await trivia(host, guest, 'watch');
  await snap(host, 'host-social');

  // KPIs del panel de analítica (los procesa analytics desde analytics:events).
  let kpis = '';
  const t0 = Date.now();
  while (Date.now() - t0 < 60000) {
    await host.goto(`${BASE}/rooms/${roomId}/analytics`, { waitUntil: 'networkidle2' });
    kpis = await host
      .waitForSelector('[aria-label="Indicadores de la sesión"]', { timeout: 20000 })
      .then(() => host.evaluate(() => document.querySelector('[aria-label="Indicadores de la sesión"]').innerText.replace(/\n+/g, ' | ')))
      .catch(() => '');
    if (/Mensajes \| [1-9]/.test(kpis) && /Reacciones \| [1-9]/.test(kpis)) break;
    await sleep(5000);
  }
  check(/Mensajes \| [1-9]/.test(kpis) && /Reacciones \| [1-9]/.test(kpis), `KPIs con el chat y la reacción (${Math.round((Date.now() - t0) / 1000)} s)`);
  console.log(`    ${kpis.slice(0, 240)}`);
  await snap(host, 'analitica');
}

async function liveFlow(browser, host, link) {
  await clickText(host, 'Ir a transmitir');
  await host.waitForFunction(() => location.pathname.startsWith('/live/'), { timeout: 20000 });
  await clickText(host, 'Empezar a transmitir', 'button');
  const onAir = await host
    .waitForFunction(() => /EN VIVO/.test(document.querySelector('[aria-label="Estado de la transmisión"]')?.innerText ?? ''), { timeout: 30000 })
    .then(() => true, () => false);
  check(onAir, 'el host transmite (WHIP de vídeo y audio por el gateway)');

  const guest = await joinGuest(browser, link, 'Invitada');
  const t0 = Date.now();
  const sees = await guest
    .waitForFunction(() => {
      const v = document.querySelector('video');
      return v && v.readyState >= 2 && v.videoWidth > 0 && v.currentTime > 0;
    }, { timeout: 20000 })
    .then(() => true, () => false);
  check(sees, `la invitada ve la transmisión (WHEP, ${Date.now() - t0} ms)`);
  await snap(guest, 'invitada-en-vivo');

  await chatAndReaction(host, guest);
  await poll(host, guest);
  await trivia(host, guest, 'live');

  // Voz en escenario: el host sube, invita a la invitada y ella entra.
  await clickText(host, 'Subir al escenario', 'button').catch(() => {});
  const invite = await host.waitForSelector('button[aria-label="Invitar al escenario a Invitada"]', { timeout: 15000 }).catch(() => null);
  if (check(!!invite, 'el host ve a la invitada para subirla al escenario')) await invite.evaluate((b) => b.click());
  await sleep(1500);
  await clickText(guest, 'Subir al escenario', 'button').catch(() => clickText(guest, 'Unirse a la voz', 'button')).catch(() => {});
  const inVoice = await host
    .waitForFunction(() => (document.querySelector('ul[aria-label="En la voz"]')?.innerText ?? '').includes('Invitada'), { timeout: 20000 })
    .then(() => true, () => false);
  check(inVoice, 'host e invitada en la voz del escenario');
  await snap(host, 'host-voz');

  // Terminar el evento: la sala se deshabilita y la invitada ve el aviso (ROOM_CLOSED / 4010).
  await clickText(host, 'Terminar evento', 'button');
  const confirm = await host.waitForFunction(
    () => [...document.querySelectorAll('[role="alertdialog"] button')].find((b) => b.textContent.includes('Terminar evento')),
    { timeout: 5000 },
  );
  await sleep(400);
  await confirm.asElement().click();
  check(await bodyHas(guest, 'El evento terminó', 20000), 'la invitada ve "El evento terminó"');
  await snap(guest, 'invitada-fin');
}

(async () => {
  const browser = await puppeteer.launch({
    headless: 'new',
    executablePath: process.env.CHROME_PATH || '/usr/bin/chromium-browser',
    acceptInsecureCerts: true,
    args: [
      '--no-sandbox',
      '--ignore-certificate-errors',
      '--use-fake-ui-for-media-stream',
      '--use-fake-device-for-media-stream',
      '--autoplay-policy=no-user-gesture-required',
      '--disable-background-timer-throttling',
      '--disable-renderer-backgrounding',
      '--disable-backgrounding-occluded-windows',
    ],
  });
  let status = 0;
  try {
    console.log(`== E2E del sistema · ${MODE} · ${BASE}`);
    const host = await browser.newPage();
    instrument(host, 'host');
    await host.evaluateOnNewDocument(fakeScreen);
    await host.setViewport({ width: 1366, height: 900 });
    await loginHost(browser, host);
    check(true, 'login del host con el Firebase Auth Emulator');
    const link = await createRoom(host, MODE);
    check(link.includes('/invite/'), `sala ${MODE} creada con link de invitación`);
    if (MODE === 'live') await liveFlow(browser, host, link);
    else await watchFlow(browser, host, link);
  } catch (e) {
    check(false, `flujo interrumpido: ${e.message.split('\n')[0]}`);
  } finally {
    await browser.close();
  }
  if (failures.length) {
    console.log(`\n✗ ${failures.length} fallo(s) en ${MODE}`);
    status = 1;
  } else {
    console.log(`\n✓ ${MODE}: todo en verde`);
  }
  process.exit(status);
})();
