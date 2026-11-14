// Ataques reales contra dos Chrome: servidor hostil que manipula la señalización, participante
// malicioso, y el CSP funcionando con toda la interfaz. Ver "Modelo de amenazas" en docs/SEGURIDAD.md.
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { after, afterEach, before, beforeEach, test } from 'node:test';
import puppeteer from 'puppeteer-core';

const ROOT = resolve(import.meta.dirname, '..', '..');
const PORT = 18084;
const URL = `http://localhost:${PORT}`;
const KEY = 'clave-de-prueba-seguridad-larga';
const CHROME =
  process.env.CHROME_PATH ??
  ['C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', '/usr/bin/google-chrome', '/usr/bin/chromium'].find(existsSync);

let tmp, server, browsers, a, b, room;

const launch = () =>
  puppeteer.launch({
    executablePath: CHROME,
    headless: 'new',
    args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required'],
  });

before(async () => {
  assert.ok(CHROME, 'Chrome no encontrado: define CHROME_PATH');
  tmp = mkdtempSync(join(tmpdir(), 'cryptopo-sec-'));
  const bin = join(tmp, process.platform === 'win32' ? 'cryptopo.exe' : 'cryptopo');
  execFileSync('go', ['build', '-o', bin, '.'], { cwd: ROOT, stdio: 'inherit' });
  server = spawn(bin, ['-addr', `127.0.0.1:${PORT}`, '-stun', '', '-password', KEY], { stdio: 'ignore', cwd: tmp });
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
  await new Promise((r) => setTimeout(r, 300));
  rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

async function openPage(browser, name) {
  const page = await browser.newPage();
  page.violations = [];
  page.external = [];
  await page.evaluateOnNewDocument(() => {
    window.__csp = [];
    document.addEventListener('securitypolicyviolation', (e) => window.__csp.push(`${e.violatedDirective} ${e.blockedURI}`));
  });
  page.on('request', (r) => {
    if (!r.url().startsWith(URL) && !r.url().startsWith('data:') && !r.url().startsWith('blob:')) page.external.push(r.url());
  });
  await page.goto(`${URL}/#k=${KEY}`, { waitUntil: 'load' });
  // La clave se guarda al entrar: recargar antes la perdería.
  await page.waitForFunction(() => window.cryptopo?.myId && window.cryptopo.auth === 'ok');
  await page.evaluate((n) => localStorage.setItem('newchord.prefs', JSON.stringify({ name: n })), name);
  await page.reload({ waitUntil: 'load' });
  await page.waitForFunction(() => window.cryptopo?.myId && window.cryptopo.auth === 'ok');
  return page;
}

beforeEach(async () => {
  room = 'sec-' + Math.random().toString(36).slice(2);
  a = await openPage(browsers[0], 'ana');
  b = await openPage(browsers[1], 'bea');
});

afterEach(async () => {
  await Promise.all([a, b].map((p) => p?.close()));
});

const waitFor = (page, fn, ...args) => page.waitForFunction(fn, { timeout: 20_000, polling: 100 }, ...args);
const join_ = (page, name) => page.evaluate((r, n) => window.cryptopo.join(r, n), room, name);
const firstPeer = () => [...window.cryptopo.peers.values()][0];

const waitProven = async () => {
  for (const p of [a, b]) await waitFor(p, () => [...window.cryptopo.peers.values()][0]?.proven === true);
};

test('todo el tráfico visible al servidor va cifrado: ni SDP ni huellas ni IPs', async () => {
  await a.evaluate(() => {
    window.__wire = [];
    const orig = window.cryptopo.sig.send.bind(window.cryptopo.sig);
    window.cryptopo.sig.send = (m) => {
      window.__wire.push(JSON.stringify(m));
      orig(m);
    };
  });
  await join_(a, 'ana');
  await join_(b, 'bea');
  await waitProven();
  const wire = await a.evaluate(() => window.__wire);
  const signals = wire.filter((m) => m.includes('"signal"'));
  assert.ok(signals.length > 0);
  for (const m of signals) {
    assert.ok(!/fingerprint|candidate|sdp|ice-ufrag/i.test(m), `en claro: ${m.slice(0, 120)}`);
    assert.deepEqual(Object.keys(JSON.parse(m).data).sort(), ['ct', 'iv', 'seq', 'v']);
  }
});

test('la conexión queda demostrada con identidad y ambos ven el mismo código de seguridad', async () => {
  await join_(a, 'ana');
  await join_(b, 'bea');
  await waitProven();
  const view = (p) => p.evaluate(() => window.cryptopo.peerViews()[0]);
  await waitFor(a, () => window.cryptopo.peerViews()[0]?.safety);
  await waitFor(b, () => window.cryptopo.peerViews()[0]?.safety);
  const [va, vb] = [await view(a), await view(b)];
  assert.match(va.safety, /^(\d{5} ){5}\d{5}$/);
  assert.equal(va.safety, vb.safety);
  assert.equal(va.trust, 'new');

  await a.evaluate(() => window.cryptopo.verifyPeer(window.cryptopo.peerViews()[0].id));
  assert.equal((await view(a)).trust, 'verified');
});

test('servidor hostil: una señal alterada no se acepta y se avisa', async () => {
  await join_(a, 'ana');
  await b.evaluate(() => {
    const sig = window.cryptopo.sig;
    const on = sig.onMessage;
    sig.onMessage = (m) => {
      if (m.type === 'signal') m.data = { ...m.data, ct: 'AAAA' + m.data.ct.slice(4) };
      on(m);
    };
  });
  await join_(b, 'bea');
  await waitFor(b, () => window.cryptopo.peerViews()[0]?.tampered === true);
  assert.notEqual(await b.evaluate(() => [...window.cryptopo.peers.values()][0].pc.connectionState), 'connected');
  await waitFor(b, () => [...document.querySelectorAll('.tile-label')].some((e) => e.textContent.includes('clave distinta')) || !document.querySelector('.tile-label'));
});

test('servidor hostil: una señal repetida se descarta', async () => {
  await a.evaluate(() => {
    const sig = window.cryptopo.sig;
    const on = sig.onMessage;
    window.__signals = [];
    sig.onMessage = (m) => {
      if (m.type === 'signal') window.__signals.push(m);
      on(m);
    };
  });
  await join_(a, 'ana');
  await join_(b, 'bea');
  await waitProven();
  const replayed = await a.evaluate(async () => {
    const sig = window.cryptopo.sig;
    const { sdp } = [...window.cryptopo.peers.values()][0].pc.currentRemoteDescription;
    for (const m of [...window.__signals]) sig.onMessage(m);
    await new Promise((r) => setTimeout(r, 500));
    const p = [...window.cryptopo.peers.values()][0];
    return { same: p.pc.currentRemoteDescription.sdp === sdp, tampered: p.tampered, state: p.pc.connectionState };
  });
  assert.deepEqual(replayed, { same: true, tampered: true, state: 'connected' });
});

test('servidor hostil: quien no tiene la clave de sala no conecta aunque el servidor lo presente', async () => {
  await join_(a, 'ana');
  // Un fantasma enviado por el servidor, sin clave: nunca se llega a abrir nada con él.
  const state = await a.evaluate(async () => {
    window.cryptopo.sig.onMessage({ type: 'peer-joined', id: 'fantasma', name: 'bea' });
    window.cryptopo.sig.onMessage({ type: 'signal', from: 'fantasma', data: { v: 1, seq: 1, iv: 'AAAAAAAAAAAAAAAA', ct: 'AAAA' } });
    await new Promise((r) => setTimeout(r, 800));
    const p = window.cryptopo.peers.get('fantasma');
    return { conn: p.pc.connectionState, dc: p.dc?.readyState ?? null, proven: p.proven, tampered: p.tampered };
  });
  assert.deepEqual(state, { conn: 'new', dc: null, proven: false, tampered: true });
});

test('intermediario con la clave de sala: una firma sobre otra huella DTLS corta la conexión', async () => {
  await join_(a, 'ana');
  await b.evaluate(() => {
    // Simula a quien se ha metido en medio: su firma cubre huellas que no son las de esta conexión.
    const mesh = window.cryptopo;
    const orig = mesh.sendIdentity.bind(mesh);
    mesh.sendIdentity = async (p) => {
      const desc = Object.getOwnPropertyDescriptor(RTCPeerConnection.prototype, 'localDescription');
      Object.defineProperty(p.pc, 'localDescription', { get: () => ({ sdp: 'a=fingerprint:sha-256 00:00:00\r\n' }) });
      await orig(p);
      Object.defineProperty(p.pc, 'localDescription', desc);
    };
  });
  await join_(b, 'bea');
  await waitFor(a, () => window.cryptopo.peerViews()[0]?.trust === 'bad');
  assert.equal(await a.evaluate(() => window.cryptopo.peerViews()[0].state), 'closed');
});

test('participante malicioso: no puede escribir en nombre de otro ni marcar nada como tuyo', async () => {
  await join_(a, 'ana');
  await join_(b, 'bea');
  await waitProven();
  const myId = await a.evaluate(() => window.cryptopo.myId);
  await b.evaluate((target) => {
    const p = [...window.cryptopo.peers.values()][0];
    const send = (m) => p.dc.send(JSON.stringify(m));
    const forged = { id: 'x1', from: target, name: 'ana', text: 'falso\u202Etexto', ts: 1e15 };
    send({ t: 'chat', msg: forged });
    send({ t: 'history', msgs: [{ id: 'x2', from: target, name: 'ana', text: 'dijo ana', ts: 1 }] });
    send({ t: 'history', msgs: [{ id: 'x3', from: target, name: 'ana', text: 'segundo historial', ts: 1 }] });
    send({ t: 'meta', muted: 'si', streams: { s1: 'virus', s2: 'screen' }, paused: ['nope', 'screen'] });
    send({ t: 'chat', msg: { id: 'y'.repeat(500), name: 'ana', text: 'id enorme', ts: 1 } });
    send({ t: 'chat', msg: { id: 'x4', text: { no: 'texto' } } });
  }, myId);
  await waitFor(a, () => window.cryptopo.chat.some((m) => m.id === 'x2'));
  const chat = await a.evaluate(() => window.cryptopo.chat);
  const now = Date.now();
  const x1 = chat.find((m) => m.id === 'x1');
  assert.equal(x1.name, 'bea', 'el autor lo pone la conexión');
  assert.notEqual(x1.from, myId);
  assert.equal(x1.text, 'falsotexto', 'sin bidi');
  assert.ok(x1.ts <= now, 'sin fechas futuras');
  const x2 = chat.find((m) => m.id === 'x2');
  assert.equal(x2.via, 'bea', 'historial marcado como reenviado');
  assert.notEqual(x2.from, myId);
  assert.ok(!chat.some((m) => m.id === 'x3'), 'un solo historial por conexión');
  assert.ok(!chat.some((m) => m.text === 'id enorme'));
  assert.ok(!chat.some((m) => m.id === 'x4'));
  const kinds = await a.evaluate(() => {
    const p = [...window.cryptopo.peers.values()][0];
    return { kinds: p.kinds, paused: p.paused, muted: p.muted };
  });
  assert.deepEqual(kinds, { kinds: { s2: 'screen' }, paused: ['screen'], muted: true });
});

test('participante malicioso: el aluvión de datos se descarta sin colgar al resto', async () => {
  await join_(a, 'ana');
  await join_(b, 'bea');
  await waitProven();
  await b.evaluate(() => {
    const p = [...window.cryptopo.peers.values()][0];
    for (let i = 0; i < 2000; i++) p.dc.send(JSON.stringify({ t: 'chat', msg: { id: `f${i}`, text: 'spam', ts: 1 } }));
  });
  await new Promise((r) => setTimeout(r, 1500));
  const n = await a.evaluate(() => window.cryptopo.chat.length);
  assert.ok(n < 200, `aceptó ${n}`);
  await new Promise((r) => setTimeout(r, 1000));
  await b.evaluate(() => window.cryptopo.sendChat('sigo aquí'));
  await waitFor(a, () => window.cryptopo.chat.some((m) => m.text === 'sigo aquí'));
});

test('nada se envía por el canal antes de demostrar la identidad', async () => {
  await join_(a, 'ana');
  await a.evaluate(() => {
    const orig = window.cryptopo.onIdentity.bind(window.cryptopo);
    window.cryptopo.onIdentity = () => {}; // el otro nunca queda demostrado
    window.__restore = orig;
    window.__sent = [];
    const send = RTCDataChannel.prototype.send;
    RTCDataChannel.prototype.send = function (m) {
      window.__sent.push(JSON.parse(m).t);
      return send.call(this, m);
    };
  });
  await join_(b, 'bea');
  await waitFor(a, () => [...window.cryptopo.peers.values()][0]?.dc?.readyState === 'open');
  await a.evaluate(() => window.cryptopo.sendChat('secreto temprano'));
  await new Promise((r) => setTimeout(r, 800));
  assert.deepEqual(await a.evaluate(() => [...new Set(window.__sent)]), ['id']);
  assert.equal(await b.evaluate(() => window.cryptopo.chat.some((m) => m.text === 'secreto temprano')), false);
});

test('la interfaz funciona entera bajo el CSP y no contacta con terceros', async () => {
  for (const [p, n] of [[a, 'ana'], [b, 'bea']]) {
    await p.evaluate(() => [...document.querySelectorAll('.room-card')].find((e) => e.textContent.includes('general')).click());
    await waitFor(p, () => window.cryptopo.room === 'general');
    await waitFor(p, () => document.querySelector('.tile'));
    assert.ok(n);
  }
  await waitProven();
  await a.waitForSelector('.trust-row');
  await a.click('.trust-row');
  await a.waitForSelector('.safety');
  await a.type('#composer', 'hola <img src=x onerror=alert(1)>');
  await a.keyboard.press('Enter');
  await waitFor(b, () => [...document.querySelectorAll('.msg-text')].some((e) => e.textContent.includes('<img src=x')));
  assert.equal(await b.evaluate(() => document.querySelector('.msg-text img')), null, 'el texto no se interpreta como HTML');
  await a.evaluate(() => window.cryptopo.react('¡Fistro!'));
  await a.evaluate(() => document.activeElement.blur());
  await a.keyboard.press('p');
  await a.waitForSelector('.dialog');
  await a.evaluate(async () => {
    const s = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
    window.cryptopo.addSource('screen', s, { videoBitrate: 1_000_000, audioBitrate: 0, codec: '', hint: 'detail' });
  });
  await waitFor(b, () => window.cryptopo.peerViews()[0].sources.some((s) => s.kind === 'screen'));

  for (const p of [a, b]) {
    assert.deepEqual(await p.evaluate(() => window.__csp), [], 'violaciones del CSP');
    assert.deepEqual(p.external, [], 'peticiones a terceros');
    const fonts = await p.evaluate(async () => {
      await document.fonts.ready;
      return [...new Set([...document.fonts].filter((f) => f.status === 'loaded').map((f) => f.family.replace(/["']/g, '')))].sort();
    });
    assert.deepEqual(fonts, ['JetBrains Mono', 'VT323'], 'fuentes locales');
  }
  // El CSP bloquea de verdad.
  const blocked = await a.evaluate(() => {
    try {
      const s = document.createElement('script');
      s.textContent = 'window.__inline = 1';
      document.head.append(s);
    } catch {
      /* Trusted Types lo corta antes incluso de llegar al CSP */
    }
    return window.__inline;
  });
  assert.equal(blocked, undefined, 'script inline ejecutado');
});

// Los timeouts de lectura y escritura del servidor no deben alcanzar al WebSocket. También vale
// para -join: interfaz de este binario y señalización en otro servidor.
test('la señalización sobrevive a los timeouts HTTP, también con -join', async () => {
  const bin = join(tmp, process.platform === 'win32' ? 'cryptopo.exe' : 'cryptopo');
  const LOCAL = `http://127.0.0.1:${PORT + 1}`;
  const proxy = spawn(bin, ['-join', URL, '-addr', `127.0.0.1:${PORT + 1}`], { stdio: 'ignore', cwd: tmp });
  try {
    for (let i = 0; ; i++) {
      try {
        await fetch(LOCAL);
        break;
      } catch (e) {
        if (i > 50) throw e;
        await new Promise((r) => setTimeout(r, 100));
      }
    }
    const c = await browsers[0].newPage();
    await c.goto(`${LOCAL}/#k=${KEY}`, { waitUntil: 'load' });
    await c.waitForFunction(() => window.cryptopo?.myId && window.cryptopo.auth === 'ok');
    await c.evaluate((r) => window.cryptopo.join(r, 'carla'), room);
    await join_(b, 'bea');
    await waitFor(c, () => [...window.cryptopo.peers.values()][0]?.proven === true);
    const id = await c.evaluate(() => window.cryptopo.myId);
    await new Promise((r) => setTimeout(r, 35_000));
    assert.equal(await c.evaluate(() => window.cryptopo.online && window.cryptopo.myId), id, 'la conexión se cortó');
    await b.evaluate(() => window.cryptopo.sendChat('sigues ahí'));
    await waitFor(c, () => window.cryptopo.chat.some((m) => m.text === 'sigues ahí'));
    await c.close();
  } finally {
    proxy.kill();
  }
});

// Por decisión del dueño, la consola registra por defecto; -db "" lo apaga (lo usa mesh.e2e.mjs).
test('por defecto se registra en cryptopo.db', () => {
  assert.equal(existsSync(join(tmp, 'cryptopo.db')), true);
});

test('el servidor sin clave se niega a arrancar, y sin TLS fuera de local también', () => {
  const bin = join(tmp, process.platform === 'win32' ? 'cryptopo.exe' : 'cryptopo');
  const refuse = (args) => {
    try {
      execFileSync(bin, args, { stdio: 'pipe', env: { ...process.env, CRYPTOPO_PASSWORD: '', CRYPTOPO_VERIFIER: '', NEWCHORD_PASSWORD: '', NEWCHORD_VERIFIER: '' }, timeout: 5000 });
      return '';
    } catch (e) {
      return String(e.stderr);
    }
  };
  assert.match(refuse(['-addr', '127.0.0.1:0']), /falta la clave/);
  assert.match(refuse(['-addr', '127.0.0.1:0', '-password', 'corta']), /al menos 16/);
  assert.match(refuse(['-addr', ':0', '-password', KEY]), /sin TLS/);
});
