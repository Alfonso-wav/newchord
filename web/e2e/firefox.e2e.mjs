// Firefox real <-> Chrome real con ofertas cruzadas forzadas (H2 en docs/HALLAZGOS.md).
// Requiere Firefox y Chrome instalados (FIREFOX_PATH / CHROME_PATH para otras rutas) y web/dist.
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { after, afterEach, before, beforeEach, test } from 'node:test';
import puppeteer from 'puppeteer-core';

const ROOT = resolve(import.meta.dirname, '..', '..');
const PORT = 18083;
const URL = `http://localhost:${PORT}`;
const KEY = 'clave-de-prueba-e2e-suficientemente-larga';
const CHROME =
  process.env.CHROME_PATH ??
  ['C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', '/usr/bin/google-chrome', '/usr/bin/chromium'].find(existsSync);
const FIREFOX =
  process.env.FIREFOX_PATH ??
  ['C:\\Program Files\\Mozilla Firefox\\firefox.exe', '/usr/bin/firefox', '/usr/bin/firefox-esr'].find(existsSync);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let tmp, server, ffBrowser, crBrowser, ff, cr;

before(async () => {
  assert.ok(CHROME, 'Chrome no encontrado: define CHROME_PATH');
  assert.ok(FIREFOX, 'Firefox no encontrado: define FIREFOX_PATH');
  tmp = mkdtempSync(join(tmpdir(), 'cryptopo-ff-'));
  const bin = join(tmp, process.platform === 'win32' ? 'cryptopo.exe' : 'cryptopo');
  execFileSync('go', ['build', '-o', bin, '.'], { cwd: ROOT, stdio: 'inherit' });
  server = spawn(bin, ['-addr', `127.0.0.1:${PORT}`, '-static', join(ROOT, 'web', 'dist'), '-stun', '', '-db', '', '-password', KEY], { stdio: 'ignore' });
  for (let i = 0; ; i++) {
    try {
      await fetch(URL);
      break;
    } catch (e) {
      if (i > 50) throw e;
      await sleep(100);
    }
  }
  [ffBrowser, crBrowser] = await Promise.all([
    puppeteer.launch({
      browser: 'firefox',
      executablePath: FIREFOX,
      headless: true,
      extraPrefsFirefox: {
        'media.navigator.streams.fake': true,
        'media.navigator.permission.disabled': true,
        // Sin esto ICE se queda en "connecting" entre navegadores de la misma máquina.
        'media.peerconnection.ice.obfuscate_host_addresses': false,
        'media.peerconnection.ice.loopback': true,
      },
    }),
    puppeteer.launch({
      executablePath: CHROME,
      headless: true,
      args: [
        '--use-fake-ui-for-media-stream',
        '--use-fake-device-for-media-stream',
        '--disable-features=WebRtcHideLocalIpsWithMdns',
      ],
    }),
  ]);
});

after(async () => {
  await Promise.allSettled([ffBrowser?.close(), crBrowser?.close()]);
  server?.kill();
  await sleep(300);
  rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

// Retiene la señalización entrante: permite que ambos ofrezcan sin ver la oferta del otro.
const instrument = () => {
  window.__errors = [];
  window.__hold = null;
  const sig = window.cryptopo.sig;
  const on = sig.onMessage;
  sig.onMessage = (m) => (m.type === 'signal' && window.__hold ? window.__hold.push(m) : on(m));
  window.__release = () => {
    const held = window.__hold ?? [];
    window.__hold = null;
    for (const m of held) on(m);
  };
  const ce = console.error;
  console.error = (...a) => {
    window.__errors.push(a.map(String).join(' '));
    ce(...a);
  };
};

async function open(browser) {
  const page = await browser.newPage();
  await page.goto(`${URL}/#k=${KEY}`);
  await page.waitForFunction(() => window.cryptopo?.online && window.cryptopo.myId, { timeout: 15_000 });
  await page.evaluate(instrument);
  return page;
}

beforeEach(async () => {
  [ff, cr] = await Promise.all([open(ffBrowser), open(crBrowser)]);
});

afterEach(async () => {
  await Promise.allSettled([ff?.close(), cr?.close()]);
});

const peer = (page, fn, ...args) => page.evaluate(fn, ...args);

const addMic = async () => {
  const s = await navigator.mediaDevices.getUserMedia({ audio: true });
  window.cryptopo.addSource('mic', s, { videoBitrate: 0, audioBitrate: 96_000 });
};

const addScreen = () => {
  const c = document.createElement('canvas');
  c.width = 640;
  c.height = 360;
  const g = c.getContext('2d');
  let n = 0;
  setInterval(() => {
    g.fillStyle = `hsl(${n++ % 360} 80% 50%)`;
    g.fillRect(0, 0, 640, 360);
  }, 50);
  window.cryptopo.addSource('screen', c.captureStream(20), {
    videoBitrate: 2_000_000,
    audioBitrate: 128_000,
    maxFramerate: 20,
    codec: '',
    hint: 'detail',
  });
};

// Ambos ejecutan `action` con la señalización retenida, y luego se cruzan las ofertas.
async function crossed(action) {
  const pages = [ff, cr];
  await Promise.all(pages.map((p) => p.evaluate(() => void (window.__hold = []))));
  await Promise.all(pages.map((p) => p.evaluate(action)));
  await sleep(500);
  await Promise.all(pages.map((p) => p.evaluate(() => window.__release())));
}

async function pair(politeSide) {
  const room = 'ff-' + Math.random().toString(36).slice(2);
  await ff.evaluate((r) => window.cryptopo.join(r, 'zorro'), room);
  await sleep(300);
  // Chrome también por la UI: solo mide la energía del audio que de verdad reproduce.
  await cr.evaluate(() => localStorage.setItem('newchord.prefs', JSON.stringify({ name: 'cromo' })));
  await cr.reload();
  await cr.waitForFunction(() => window.cryptopo?.online && document.querySelector('.room-card'), { timeout: 15_000 });
  await cr.evaluate(instrument);
  await cr.evaluate((r) => [...document.querySelectorAll('.room-card')].find((e) => e.textContent.includes(r + '/')).click(), room);
  for (const p of [ff, cr])
    await p.waitForFunction(
      () => {
        const [x] = window.cryptopo.peers.values();
        return x?.pc.connectionState === 'connected' && x.dc?.readyState === 'open';
      },
      { timeout: 20_000, polling: 100 },
    );
  // Fija quién cede en vez de depender del orden aleatorio de los ids.
  for (const [p, polite] of [[ff, politeSide === 'ff'], [cr, politeSide === 'cr']])
    await p.evaluate((v) => void ([...window.cryptopo.peers.values()][0].polite = v), polite);
}

const settled = (p) =>
  p.waitForFunction(
    () => {
      const [x] = window.cryptopo.peers.values();
      return x?.pc.signalingState === 'stable' && !x.makingOffer;
    },
    { timeout: 10_000, polling: 100 },
  );

const received = (p) =>
  p.waitForFunction(
    () => {
      const [x] = window.cryptopo.peers.values();
      const kinds = new Set(Object.values(x?.kinds ?? {}));
      const tracks = [...(x?.streams.values() ?? [])].flatMap((s) => s.getTracks().map((t) => t.kind));
      return kinds.has('mic') && kinds.has('screen') && tracks.includes('audio') && tracks.includes('video');
    },
    { timeout: 10_000, polling: 100 },
  );

const framesDecoded = (p) =>
  p.evaluate(async () => {
    const [x] = window.cryptopo.peers.values();
    let frames = 0;
    (await x.pc.getStats()).forEach((s) => {
      if (s.type === 'inbound-rtp' && s.kind === 'video') frames += s.framesDecoded ?? 0;
    });
    return frames;
  });

for (const polite of ['cr', 'ff']) {
  test(`ofertas cruzadas de micro y pantalla con ${polite === 'cr' ? 'Chrome' : 'Firefox'} polite`, async () => {
    await pair(polite);

    await crossed(addMic);
    await Promise.all([settled(ff), settled(cr)]);

    await crossed(addScreen);
    await Promise.all([settled(ff), settled(cr)]);
    await Promise.all([received(ff), received(cr)]);

    await sleep(1500);
    assert.ok((await framesDecoded(ff)) > 0, 'Firefox no decodifica vídeo de Chrome');
    assert.ok((await framesDecoded(cr)) > 0, 'Chrome no decodifica vídeo de Firefox');
    assert.deepEqual(await ff.evaluate(() => window.__errors), []);
    assert.deepEqual(await cr.evaluate(() => window.__errors), []);
  });
}

// H1 con los dos navegadores: al rehacer tras un rechazo no debe volver el error de H2.
for (const who of ['cr', 'ff']) {
  test(`${who === 'cr' ? 'Chrome' : 'Firefox'} rechaza una descripción y la conexión se rehace`, async () => {
    await pair('cr');
    await Promise.all([ff.evaluate(addMic), cr.evaluate(addMic)]);
    await Promise.all([settled(ff), settled(cr)]);
    await (who === 'cr' ? cr : ff).evaluate(() => {
      const orig = RTCPeerConnection.prototype.setRemoteDescription;
      RTCPeerConnection.prototype.setRemoteDescription = function () {
        RTCPeerConnection.prototype.setRemoteDescription = orig;
        return Promise.reject(new DOMException('fallo inyectado', 'InvalidAccessError'));
      };
    });
    await crossed(addScreen);
    await Promise.all([received(ff), received(cr)]);
    await Promise.all([settled(ff), settled(cr)]);
    await sleep(1500);
    assert.ok((await framesDecoded(ff)) > 0, 'Firefox no decodifica vídeo de Chrome');
    assert.ok((await framesDecoded(cr)) > 0, 'Chrome no decodifica vídeo de Firefox');
    for (const p of [ff, cr]) {
      const errors = await p.evaluate(() => window.__errors);
      assert.deepEqual(errors.filter((e) => !e.includes('fallo inyectado')), []);
    }
  });
}

// H7 en el navegador afectado. El minimizado real pide el selector de Firefox, y Firefox no
// entrega un `ended` sintético de dispatchEvent: se llama directamente al listener de la app.
test('Firefox pierde la captura, Chrome conserva la ficha en pausa y se reanuda', async () => {
  await pair('cr');
  await ff.evaluate(() => {
    window.__endedListeners = new Map();
    const add = MediaStreamTrack.prototype.addEventListener;
    MediaStreamTrack.prototype.addEventListener = function (type, fn, ...rest) {
      if (type === 'ended') window.__endedListeners.set(this, [...(window.__endedListeners.get(this) ?? []), fn]);
      return add.call(this, type, fn, ...rest);
    };
  });
  await ff.evaluate(addScreen);
  const paused = (want) =>
    cr
      .waitForFunction(
        (w) => window.cryptopo.peerViews()[0].sources.find((s) => s.kind === 'screen')?.paused === w,
        { timeout: 10_000, polling: 100 },
        want,
      )
      .catch(async (e) => {
        const seen = await cr.evaluate(() => {
          const [p] = window.cryptopo.peers.values();
          return { sig: p.pc.signalingState, kinds: p.kinds, paused: p.paused, streams: [...p.streams.keys()] };
        });
        const local = await ff.evaluate(() => {
          const s = window.cryptopo.local.get('screen');
          return { id: s?.stream.id, paused: s?.paused, sig: [...window.cryptopo.peers.values()][0].pc.signalingState };
        });
        throw new Error(`esperando paused=${want}: ${e.message} cr=${JSON.stringify(seen)} ff=${JSON.stringify(local)}`);
      });
  await paused(false);
  await sleep(1000);
  await ff.evaluate(() => {
    const [t] = window.cryptopo.local.get('screen').stream.getVideoTracks();
    t.stop();
    for (const fn of window.__endedListeners.get(t)) fn();
  });
  await paused(true);
  await sleep(500);
  const before = await framesDecoded(cr);
  await ff.evaluate(() => {
    const c = document.createElement('canvas');
    c.width = 640;
    c.height = 360;
    const g = c.getContext('2d');
    let n = 0;
    setInterval(() => {
      g.fillStyle = `hsl(${n++ % 360} 80% 50%)`;
      g.fillRect(0, 0, 640, 360);
    }, 50);
    window.cryptopo.resumeSource('screen', c.captureStream(20));
  });
  await paused(false);
  await sleep(1500);
  assert.ok((await framesDecoded(cr)) > before, 'Chrome no recibe frames tras reanudar');
});

// Perfil y mezcla con Firefox de verdad: entra por la UI (micro por la cadena de envío),
// cambia nombre y avatar, abre la mezcla y su micro procesado suena en Chrome.
test('Firefox: micro con ganancia de envío suena en Chrome, mezcla con medidores y perfil nuevo', async () => {
  const room = 'ff-' + Math.random().toString(36).slice(2);
  await ff.evaluate(() => localStorage.setItem('newchord.prefs', JSON.stringify({ name: 'zorro' })));
  await ff.reload();
  await ff.waitForFunction(() => window.cryptopo?.online && document.querySelector('#new-room'), { timeout: 15_000 });
  await ff.evaluate(instrument);
  await ff.type('#new-room', room);
  await ff.keyboard.press('Enter');
  await ff.waitForFunction(() => window.cryptopo.local.has('mic'), { timeout: 15_000 });
  assert.equal(await ff.evaluate(() => window.cryptopo.local.get('mic').release !== undefined), true);
  // Chrome también por la UI: solo mide la energía del audio que de verdad reproduce.
  await cr.evaluate(() => localStorage.setItem('newchord.prefs', JSON.stringify({ name: 'cromo' })));
  await cr.reload();
  await cr.waitForFunction(() => window.cryptopo?.online && document.querySelector('.room-card'), { timeout: 15_000 });
  await cr.evaluate(instrument);
  await cr.evaluate((r) => [...document.querySelectorAll('.room-card')].find((e) => e.textContent.includes(r + '/')).click(), room);
  await cr.waitForFunction(() => window.cryptopo.peerViews()[0]?.sources.some((s) => s.kind === 'mic'), { timeout: 20_000, polling: 100 });

  await ff.evaluate(() => window.cryptopo.setMicMuted(false));
  const energy = () =>
    cr.evaluate(async () => {
      let e = 0;
      (await [...window.cryptopo.peers.values()][0].pc.getStats()).forEach((r) => {
        if (r.type === 'inbound-rtp' && r.kind === 'audio') e += r.totalAudioEnergy ?? 0;
      });
      return e;
    });
  const e0 = await energy();
  let e1 = e0;
  for (let i = 0; i < 50 && e1 <= e0 + 0.001; i++) {
    await sleep(200);
    e1 = await energy();
  }
  assert.ok(e1 > e0 + 0.001, `sin audio de Firefox en Chrome: ${e0} → ${e1}`);

  await ff.evaluate(() => document.activeElement?.blur()); // el foco seguía en el campo de sala
  await ff.keyboard.press('x');
  await ff.waitForFunction(() => document.querySelector('#fader-send-mic') && !document.querySelector('#fader-send-mic').disabled, { timeout: 5_000 });
  await ff.waitForFunction(
    () => parseFloat(getComputedStyle(document.querySelector('.meter')).getPropertyValue('--lvl')) > 0,
    { timeout: 10_000, polling: 100 },
  );

  await ff.evaluate(() => window.cryptopo.setProfile('zorro plateado', '🦊'));
  await cr.waitForFunction(() => window.cryptopo.peerViews()[0]?.name === 'zorro plateado' && window.cryptopo.peerViews()[0].avatar === '🦊', {
    timeout: 10_000,
    polling: 100,
  });
});


// Imágenes en los dos sentidos, archivo SQLite (OPFS) en Firefox y el modelo del dictado
// cargando bajo el CSP de Firefox, que no deja importar blob: (useWasmCache = false).
test('Firefox: imágenes en ambos sentidos, archivo local y dictado que arranca', { timeout: 240_000 }, async () => {
  await pair('ff');
  const sendImage = (color) =>
    new Promise((resolve, reject) => {
      const c = document.createElement('canvas');
      c.width = 640;
      c.height = 480;
      const g = c.getContext('2d');
      g.fillStyle = color;
      g.fillRect(0, 0, 640, 480);
      c.toBlob((b) => window.cryptopo.sendImage(b).then(resolve, reject), 'image/png');
    });
  const got = (p) => p.evaluate(() => window.cryptopo.chat.filter((m) => m.kind === 'image' && !m.mine).map((m) => [m.image.w, m.image.h, m.image.url.slice(0, 5)]));
  await ff.evaluate(sendImage, '#f00');
  await cr.evaluate(sendImage, '#0f0');
  for (const p of [ff, cr]) await p.waitForFunction(() => window.cryptopo.chat.some((m) => m.kind === 'image' && !m.mine), { timeout: 20_000, polling: 200 });
  assert.deepEqual(await got(ff), [[640, 480, 'blob:']]);
  assert.deepEqual(await got(cr), [[640, 480, 'blob:']]);
  const stats = await ff.evaluate(async () => {
    await new Promise((r) => setTimeout(r, 300));
    return window.cryptopo.archive.stats();
  });
  assert.equal(stats.persistent, true, 'Firefox sin OPFS: el archivo quedaría en memoria');
  assert.ok(stats.images >= 2, JSON.stringify(stats));

  await ff.evaluate(async () => {
    const s = await navigator.mediaDevices.getUserMedia({ audio: true });
    window.cryptopo.addSource('mic', s, { videoBitrate: 0, audioBitrate: 96_000 });
    window.cryptopoVoice.set({ dictate: true });
  });
  await ff.waitForFunction(() => ['on', 'error'].includes(window.cryptopoVoice.stt.phase), { timeout: 180_000, polling: 500 });
  assert.equal(await ff.evaluate(() => window.cryptopoVoice.stt.phase), 'on', JSON.stringify(await ff.evaluate(() => window.cryptopoVoice.stt)));
});
