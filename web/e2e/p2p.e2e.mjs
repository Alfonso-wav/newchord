// E2E con dos Chrome headless reales y dispositivos falsos contra el binario Go.
// Requiere Chrome instalado (CHROME_PATH para otra ruta) y web/dist compilado.
// Ver docs/HALLAZGOS.md para lo que estos tests NO cubren.
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { after, afterEach, before, beforeEach, test } from 'node:test';
import puppeteer from 'puppeteer-core';

const ROOT = resolve(import.meta.dirname, '..', '..');
const PORT = 18080;
const URL = `http://localhost:${PORT}`;
const KEY = 'clave-de-prueba-e2e-suficientemente-larga';
const CHROME =
  process.env.CHROME_PATH ??
  [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
  ].find(existsSync);

const SCREEN_OPTS = { videoBitrate: 5_000_000, audioBitrate: 128_000, maxFramerate: 30, codec: '', hint: 'detail' };

let tmp, server, browsers, a, b, room;

const launch = () =>
  puppeteer.launch({
    executablePath: CHROME,
    headless: 'new',
    args: [
      '--use-fake-ui-for-media-stream',
      '--use-fake-device-for-media-stream',
      '--autoplay-policy=no-user-gesture-required',
    ],
  });

before(async () => {
  assert.ok(CHROME, 'Chrome no encontrado: define CHROME_PATH');
  tmp = mkdtempSync(join(tmpdir(), 'cryptopo-e2e-'));
  const bin = join(tmp, process.platform === 'win32' ? 'cryptopo.exe' : 'cryptopo');
  execFileSync('go', ['build', '-o', bin, '.'], { cwd: ROOT, stdio: 'inherit' });
  // Sin STUN: dos navegadores en la misma máquina no lo necesitan y así no hay red externa.
  server = spawn(bin, ['-addr', `127.0.0.1:${PORT}`, '-static', join(ROOT, 'web', 'dist'), '-stun', '', '-db', '', '-password', KEY], { stdio: 'ignore' });
  for (let i = 0; ; i++) {
    try {
      await fetch(URL);
      break;
    } catch (e) {
      if (i > 50) throw e;
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  browsers = await Promise.all([launch(), launch()]);
});

after(async () => {
  await Promise.all((browsers ?? []).map((x) => x.close()));
  server?.kill();
  // El proceso del servidor tarda en soltar el .exe en Windows.
  await new Promise((r) => setTimeout(r, 300));
  rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

async function openPage(browser) {
  const page = await browser.newPage();
  page.errors = [];
  page.on('console', (m) => m.type() === 'error' && page.errors.push(m.text()));
  page.on('pageerror', (e) => page.errors.push(e.message));
  await page.goto(`${URL}/#k=${KEY}`, { waitUntil: 'load' });
  await page.waitForFunction(() => window.cryptopo?.online && window.cryptopo.myId);
  return page;
}

beforeEach(async () => {
  room = 'e2e-' + Math.random().toString(36).slice(2);
  [a, b] = await Promise.all(browsers.map(openPage));
});

afterEach(async () => {
  await Promise.all([a, b].map((p) => p?.close()));
});

const join_ = (page, name) => page.evaluate((r, n) => window.cryptopo.join(r, n), room, name);
const waitFor = (page, fn, ...args) => page.waitForFunction(fn, { timeout: 15_000, polling: 100 }, ...args);

const waitConnected = async () => {
  for (const p of [a, b])
    await waitFor(p, () => {
      const [peer] = window.cryptopo.peers.values();
      return peer?.pc.connectionState === 'connected' && peer.dc?.readyState === 'open';
    });
};

async function connectPair() {
  await join_(a, 'ana');
  await join_(b, 'bea');
  await waitConnected();
}

const mic = (page) =>
  page.evaluate(async () => {
    const s = await navigator.mediaDevices.getUserMedia({ audio: true });
    window.cryptopo.addSource('mic', s, { videoBitrate: 0, audioBitrate: 96_000 });
  });

const share = (page, audio = false) =>
  page.evaluate(
    async (opts, audio) => {
      const s = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: { ideal: 30 } }, audio });
      window.cryptopo.addSource('screen', s, opts);
    },
    SCREEN_OPTS,
    audio,
  );

// Vídeo realmente decodificado, no solo la pista anunciada.
const waitDecoding = (page) =>
  waitFor(page, async () => {
    const [peer] = window.cryptopo.peers.values();
    if (!peer) return false;
    let decoded = 0;
    (await peer.pc.getStats()).forEach((r) => {
      if (r.type === 'inbound-rtp' && r.kind === 'video' && r.framesDecoded > decoded) decoded = r.framesDecoded;
    });
    return decoded > 0;
  });

const waitKind = (page, kind) =>
  waitFor(page, (k) => window.cryptopo.peerViews().some((p) => p.sources.some((s) => s.kind === k)), kind);

const rejectNextRemoteDescription = (page) =>
  page.evaluate(() => {
    const orig = RTCPeerConnection.prototype.setRemoteDescription;
    RTCPeerConnection.prototype.setRemoteDescription = function () {
      RTCPeerConnection.prototype.setRemoteDescription = orig;
      return Promise.reject(new DOMException('fallo inyectado', 'InvalidAccessError'));
    };
  });

test('dos peers conectan y abren DataChannel', async () => {
  await connectPair();
  assert.deepEqual(await a.evaluate(() => window.cryptopo.peerViews().map((p) => p.name)), ['bea']);
  assert.deepEqual(await b.evaluate(() => window.cryptopo.peerViews().map((p) => p.name)), ['ana']);
});

test('el chat llega en ambos sentidos', async () => {
  await connectPair();
  await a.evaluate(() => window.cryptopo.sendChat('hola desde ana'));
  await waitFor(b, () => window.cryptopo.chat.some((m) => m.text === 'hola desde ana' && m.name === 'ana'));
  await b.evaluate(() => window.cryptopo.sendChat('hola desde bea'));
  await waitFor(a, () => window.cryptopo.chat.some((m) => m.text === 'hola desde bea' && m.name === 'bea'));
});

test('si lo activa, quien llega tarde recibe el historial, marcado como reenviado', async () => {
  await a.evaluate(() => window.cryptopo.setShareHistory(true));
  await join_(a, 'ana');
  await a.evaluate(() => window.cryptopo.sendChat('antes de que llegues'));
  await join_(b, 'bea');
  await waitFor(b, () => window.cryptopo.chat.some((m) => m.text === 'antes de que llegues' && m.via === 'ana'));
  await a.evaluate(() => window.cryptopo.setShareHistory(false));
});

test('por defecto, quien llega tarde no ve lo ya hablado', async () => {
  await join_(a, 'ana');
  await a.evaluate(() => window.cryptopo.sendChat('privado de antes'));
  await join_(b, 'bea');
  await waitConnected();
  await a.evaluate(() => window.cryptopo.sendChat('ya estás'));
  await waitFor(b, () => window.cryptopo.chat.some((m) => m.text === 'ya estás'));
  assert.equal(await b.evaluate(() => window.cryptopo.chat.some((m) => m.text === 'privado de antes')), false);
});

test('una sala creada sigue en la lista al salir de ella y no distingue mayúsculas', async () => {
  const sala = 'Sala-' + Math.random().toString(36).slice(2, 8);
  const roomList = (page) => page.$$eval('.room-name', (r) => r.map((e) => e.textContent));
  for (const [page, name] of [[a, 'ana'], [b, 'bea']]) {
    await page.evaluate((n) => localStorage.setItem('newchord.prefs', JSON.stringify({ name: n })), name);
    await page.reload({ waitUntil: 'load' });
    await page.waitForFunction(() => window.cryptopo?.online && document.querySelector('.room-card'));
  }

  await a.type('#new-room', sala);
  await a.keyboard.press('Enter');
  await waitFor(a, (s) => window.cryptopo.room === s && document.querySelector('.room-card.active')?.textContent.includes(s), sala);

  await a.evaluate(() => [...document.querySelectorAll('.room-card')].find((e) => e.textContent.includes('general')).click());
  await waitFor(a, () => window.cryptopo.room === 'general');
  await waitFor(a, (s) => window.cryptopo.rooms.some((r) => r.name === s && r.members.length === 0), sala);
  assert.ok((await roomList(a)).includes(`${sala}/`), 'la sala vacía debe seguir en la lista');
  assert.ok((await roomList(b)).includes(`${sala}/`), 'también para los demás');

  await b.type('#new-room', sala.toLowerCase());
  await b.keyboard.press('Enter');
  await waitFor(b, (s) => window.cryptopo.room === s && document.querySelector('.room-card.active')?.textContent.includes(s), sala);
  assert.ok(!(await roomList(b)).includes(`${sala.toLowerCase()}/`), 'sin sala duplicada');
});

const enterByUi = async (page, name, sala = 'general') => {
  await page.evaluate((n) => localStorage.setItem('newchord.prefs', JSON.stringify({ name: n })), name);
  await page.reload({ waitUntil: 'load' });
  await page.waitForFunction(() => window.cryptopo?.online && document.querySelector('.room-card'));
  await page.evaluate((s) => [...document.querySelectorAll('.room-card')].find((e) => e.textContent.includes(s + '/')).click(), sala);
};

// 1×1 PNG válido.
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

test('cambiar nombre y avatar en plena sala llega a los demás y a la lista del servidor', async () => {
  await connectPair();
  await a.evaluate((png) => window.cryptopo.setProfile('ana la grande', png), PNG);
  await waitFor(b, (png) => window.cryptopo.peerViews().some((p) => p.name === 'ana la grande' && p.avatar === png), PNG);
  await waitFor(b, () => window.cryptopo.rooms.some((r) => r.members.some((m) => m.name === 'ana la grande')));
  // Un cambio solo de avatar no toca el nombre ni la conexión.
  await a.evaluate(() => window.cryptopo.setProfile('ana la grande', '🦊'));
  await waitFor(b, () => window.cryptopo.peerViews()[0]?.avatar === '🦊');
  assert.equal(await b.evaluate(() => window.cryptopo.peerViews()[0].state), 'connected');
});

test('un avatar que no es imagen rasterizada se descarta', async () => {
  await connectPair();
  const bad = [
    'data:image/svg+xml;base64,PHN2Zy8+',
    'data:text/html;base64,PGgxPmhvbGE8L2gxPg==',
    'data:image/png;base64,' + 'A'.repeat(60_000),
    'javascript:alert(1)',
  ];
  for (const avatar of bad) {
    await a.evaluate((av) => {
      const [peer] = window.cryptopo.peers.values();
      peer.dc.send(JSON.stringify({ t: 'profile', name: 'ana', avatar: av }));
    }, avatar);
  }
  await a.evaluate(() => window.cryptopo.sendChat('después'));
  await waitFor(b, () => window.cryptopo.chat.some((m) => m.text === 'después'));
  const got = await b.evaluate(() => window.cryptopo.peerViews()[0].avatar);
  assert.ok(!got.startsWith('data:'), `avatar aceptado: ${got.slice(0, 40)}`);
});

test('una sala creada se borra desde la UI, pero no con alguien dentro ni un canal fijo', async () => {
  const sala = 'borrar-' + Math.random().toString(36).slice(2, 8);
  await enterByUi(a, 'ana');
  await enterByUi(b, 'bea');
  await a.type('#new-room', sala);
  await a.keyboard.press('Enter');
  await waitFor(b, (s) => window.cryptopo.rooms.some((r) => r.name === s && r.members.length === 1), sala);
  const delButton = (page, s) => page.evaluate((s) => !!document.querySelector(`[aria-label="Borrar sala ${s}"]`), s);
  assert.equal(await delButton(b, sala), false, 'con ana dentro, bea no ve el botón');
  assert.equal(await delButton(a, 'general'), false, 'los canales fijos no se borran');
  await b.evaluate((s) => window.cryptopo.deleteRoom(s), sala); // aunque lo fuerce
  await waitFor(b, () => document.querySelector('.toast')?.textContent.includes('hay alguien dentro'));
  assert.ok(await b.evaluate((s) => window.cryptopo.rooms.some((r) => r.name === s), sala));
  await a.evaluate((s) => document.querySelector(`[aria-label="Borrar sala ${s}"]`).click(), sala);
  await waitFor(a, (s) => window.cryptopo.room === null && !window.cryptopo.rooms.some((r) => r.name === s), sala);
  await waitFor(b, (s) => !window.cryptopo.rooms.some((r) => r.name === s), sala);
});

test('la mezcla: fader, mute y solo cambian lo que suena, y el micro sale por la ganancia de envío', async () => {
  await enterByUi(a, 'ana');
  await enterByUi(b, 'bea');
  await waitConnected();
  await waitKind(b, 'mic');
  await b.keyboard.press('x');
  await waitFor(b, () => document.querySelector('.dialog.mixer .meter') && document.querySelector('#fader-master'));
  const vol = () => b.evaluate(() => [...document.querySelectorAll('audio')].map((e) => e.volume));
  assert.deepEqual(await vol(), [1]);
  const peerFader = await b.evaluate(() => document.querySelector('.strip.bus input.fader:not(#fader-master)').id);
  await b.evaluate((id) => {
    const el = document.getElementById(id);
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, '-6');
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }, peerFader);
  await waitFor(b, () => Math.abs(document.querySelector('audio').volume - 10 ** (-6 / 20)) < 0.01);
  await b.evaluate(() => document.querySelector('[aria-label="Silenciar master, lo que oyes"]').click());
  await waitFor(b, () => document.querySelector('audio').volume === 0);
  await b.evaluate(() => document.querySelector('[aria-label="Silenciar master, lo que oyes"]').click());
  await b.evaluate(() => document.querySelector('[aria-label="Solo ana"]').click());
  await waitFor(b, () => document.querySelector('audio').volume > 0.4);
  // Se guarda por dispositivo de ana, no por nombre.
  const saved = await b.evaluate(() => JSON.parse(localStorage.getItem('newchord.mix')).peers);
  const tag = await b.evaluate(() => window.cryptopo.peerViews()[0].keyTag);
  assert.equal(saved[tag].db, -6);
  // El micro de ana es el de la cadena de envío, no el del dispositivo.
  assert.equal(await a.evaluate(() => window.cryptopo.local.get('mic').stream.getAudioTracks()[0].label), 'MediaStreamAudioDestinationNode');
  // Y suena al otro lado: energía de audio recibida, no solo una pista negociada.
  await a.evaluate(() => window.cryptopo.setMicMuted(false));
  const energy = () =>
    b.evaluate(async () => {
      let e = 0;
      (await [...window.cryptopo.peers.values()][0].pc.getStats()).forEach((r) => {
        if (r.type === 'inbound-rtp' && r.kind === 'audio') e += r.totalAudioEnergy ?? 0;
      });
      return e;
    });
  const e0 = await energy();
  await waitFor(b, async (e0) => {
    let e = 0;
    (await [...window.cryptopo.peers.values()][0].pc.getStats()).forEach((r) => {
      if (r.type === 'inbound-rtp' && r.kind === 'audio') e += r.totalAudioEnergy ?? 0;
    });
    return e > e0 + 0.001;
  }, e0);
  await a.evaluate(() => window.cryptopo.leave());
  assert.equal(await a.evaluate(() => window.cryptopo.local.size), 0);
  await b.evaluate(() => localStorage.removeItem('newchord.mix'));
});

// Por la UI real: con nombre guardado y clic en sala, Stage se monta. Entrar a
// una sala abre el micro en silencio (App.tsx), así que ambos ofrecen casi a la vez.
test('flujo real por la UI: entrar, micro automático, pantalla y ficha pintada', async () => {
  for (const [page, name] of [[a, 'ana'], [b, 'bea']]) {
    await page.evaluate((n) => localStorage.setItem('newchord.prefs', JSON.stringify({ name: n })), name);
    await page.reload({ waitUntil: 'load' });
    await page.waitForFunction(() => window.cryptopo?.online && document.querySelector('.room-card'));
    await page.evaluate(() => [...document.querySelectorAll('.room-card')].find((e) => e.textContent.includes('general')).click());
  }
  await waitConnected();
  await waitKind(a, 'mic');
  await waitKind(b, 'mic');
  for (const p of [a, b]) {
    assert.equal(await p.evaluate(() => window.cryptopo.micMuted), true, 'se entra en silencio');
    assert.equal(await p.evaluate(() => window.cryptopo.local.get('mic').stream.getAudioTracks()[0].enabled), false);
  }
  await share(a);
  await waitKind(b, 'screen');
  await waitDecoding(b);
  await waitFor(b, () => [...document.querySelectorAll('.tile-label')].some((e) => e.textContent.includes('ana · pantalla')));
});

test('el servidor sin STUN entrega ICE vacío, no null', async () => {
  assert.deepEqual(await a.evaluate(() => window.cryptopo.ice), []);
});

test('la pantalla con audio llega con ambas pistas', async () => {
  await connectPair();
  await share(a, true);
  await waitKind(b, 'screen');
  const tracks = await b.evaluate(() =>
    window.cryptopo.peerViews()[0].sources.find((s) => s.kind === 'screen').stream.getTracks().map((t) => t.kind).sort(),
  );
  assert.deepEqual(tracks, ['audio', 'video']);
});

test('cortar y reanudar la emisión vuelve a llegar', async () => {
  await connectPair();
  await share(a);
  await waitKind(b, 'screen');
  await a.evaluate(() => window.cryptopo.removeSource('screen'));
  await waitFor(b, () => !window.cryptopo.peerViews().some((p) => p.sources.some((s) => s.kind === 'screen')));
  await share(a);
  await waitKind(b, 'screen');
  await waitDecoding(b);
});

test('micro en ambos lados a la vez y luego pantalla (glare)', async () => {
  await connectPair();
  await Promise.all([mic(a), mic(b)]);
  await waitKind(a, 'mic');
  await waitKind(b, 'mic');
  await share(a);
  await waitKind(b, 'screen');
  await waitDecoding(b);
  for (const p of [a, b]) await waitFor(p, () => [...window.cryptopo.peers.values()][0].pc.signalingState === 'stable');
});

test('quien llega tarde ve una emisión ya en curso', async () => {
  await join_(a, 'ana');
  await share(a);
  await join_(b, 'bea');
  await waitConnected();
  await waitKind(b, 'screen');
  await waitDecoding(b);
});

test('al salir un peer desaparece del otro lado', async () => {
  await connectPair();
  await b.evaluate(() => window.cryptopo.leave());
  await waitFor(a, () => window.cryptopo.peerViews().length === 0);
});

// H1 (docs/HALLAZGOS.md): una descripción rechazada rehace la conexión en ambos lados.
for (const [who, side] of [['el receptor', () => b], ['el emisor', () => a]]) {
  test(`si ${who} rechaza una descripción, la conexión se rehace y llega la pantalla`, async () => {
    await connectPair();
    await rejectNextRemoteDescription(side());
    await share(a);
    await waitKind(b, 'screen');
    await waitDecoding(b);
    await waitConnected();
    await a.evaluate(() => window.cryptopo.sendChat('tras rehacer'));
    await waitFor(b, () => window.cryptopo.chat.some((m) => m.text === 'tras rehacer'));
    assert.ok(side().errors.some((e) => e.includes('fallo inyectado')));
    assert.equal(await a.evaluate(() => [...window.cryptopo.peers.values()][0].gen), 1);
    assert.equal(await b.evaluate(() => [...window.cryptopo.peers.values()][0].gen), 1);
  });
}

test('si el rechazo persiste no hay bucle: se rinde y ambos lo muestran', async () => {
  await connectPair();
  await b.evaluate(() => {
    RTCPeerConnection.prototype.setRemoteDescription = () =>
      Promise.reject(new DOMException('fallo persistente', 'InvalidAccessError'));
  });
  await share(a);
  for (const p of [a, b]) await waitFor(p, () => window.cryptopo.peerViews()[0]?.failed === true);
  assert.equal(await b.evaluate(() => [...window.cryptopo.peers.values()][0].gen), 3);
  await new Promise((r) => setTimeout(r, 1500));
  assert.equal(await b.evaluate(() => [...window.cryptopo.peers.values()][0].gen), 3);
});

// H7: simula lo que hace Firefox al minimizar la ventana compartida. stop() no dispara `ended`.
const endScreenByBrowser = (page) =>
  page.evaluate(() => {
    const [t] = window.cryptopo.local.get('screen').stream.getVideoTracks();
    t.stop();
    t.dispatchEvent(new Event('ended'));
  });

const framesSeen = (page) =>
  page.evaluate(async () => {
    const [peer] = window.cryptopo.peers.values();
    let n = 0;
    (await peer.pc.getStats()).forEach((r) => {
      if (r.type === 'inbound-rtp' && r.kind === 'video') n += r.framesDecoded ?? 0;
    });
    return n;
  });

test('si el navegador termina la captura, la ficha sigue en pausa y se reanuda sin renegociar', async () => {
  await connectPair();
  await share(a);
  await waitKind(b, 'screen');
  await waitDecoding(b);

  await endScreenByBrowser(a);
  await waitFor(b, () => window.cryptopo.peerViews()[0].sources.find((s) => s.kind === 'screen')?.paused === true);
  assert.equal(await a.evaluate(() => window.cryptopo.local.get('screen').paused), true);

  const before = await framesSeen(b);
  const sdp = await b.evaluate(() => [...window.cryptopo.peers.values()][0].pc.currentRemoteDescription.sdp);
  await a.evaluate(async () => {
    const s = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: { ideal: 30 } }, audio: false });
    window.cryptopo.resumeSource('screen', s);
  });
  await waitFor(b, () => window.cryptopo.peerViews()[0].sources.find((s) => s.kind === 'screen')?.paused === false);
  await new Promise((r) => setTimeout(r, 1500));
  assert.ok((await framesSeen(b)) > before, 'no llegan frames tras reanudar');
  assert.equal(await b.evaluate(() => [...window.cryptopo.peers.values()][0].pc.currentRemoteDescription.sdp), sdp);
});

test('una emisión en pausa se puede cortar', async () => {
  await connectPair();
  await share(a);
  await waitKind(b, 'screen');
  await endScreenByBrowser(a);
  await waitFor(b, () => window.cryptopo.peerViews()[0].sources.find((s) => s.kind === 'screen')?.paused === true);
  await a.evaluate(() => window.cryptopo.removeSource('screen'));
  await waitFor(b, () => !window.cryptopo.peerViews()[0].sources.some((s) => s.kind === 'screen'));
});
