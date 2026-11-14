// Se ejecuta dentro del contenedor de Playwright (ver relay.e2e.mjs): WebKit y Chromium de Linux,
// los dos con -relay-only contra un coturn real con use-auth-secret.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { after, before, test } from 'node:test';

const { chromium, webkit } = createRequire('/tmp/pw/')('playwright-core');
const PORT = 8080;
const URL = `http://localhost:${PORT}`;
const KEY = 'clave-de-prueba-turn-larga';

let server, browsers, cr, wk;
const logs = [];

before(async () => {
  server = spawn(
    '/nc/cryptopo',
    ['-addr', `127.0.0.1:${PORT}`, '-password', KEY, '-db', '', '-stun', '', '-relay-only',
      '-turn', 'turn:nc-turn:3478?transport=udp', '-turn-secret', process.env.TURN_SECRET],
    { stdio: ['ignore', 'inherit', 'inherit'] },
  );
  for (let i = 0; ; i++) {
    try {
      await fetch(URL);
      break;
    } catch (e) {
      if (i > 50) throw e;
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  browsers = [
    await chromium.launch({ args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] }),
    await webkit.launch(),
  ];
  [cr, wk] = await Promise.all(
    browsers.map(async (b, i) => {
      const p = await (await b.newContext()).newPage();
      p.on('pageerror', (e) => logs.push(`${i} ${e.message}`));
      p.on('console', (m) => m.type() === 'error' && logs.push(`${i} ${m.text()}`));
      await p.goto(`${URL}/#k=${KEY}`);
      await p.waitForFunction(() => window.cryptopo?.myId && window.cryptopo.auth === 'ok');
      return p;
    }),
  );
});

after(async () => {
  await Promise.all((browsers ?? []).map((b) => b.close()));
  server?.kill();
});

const shareCanvas = () => {
  const c = document.createElement('canvas');
  c.width = 320;
  c.height = 180;
  const g = c.getContext('2d');
  let n = 0;
  setInterval(() => {
    g.fillStyle = `hsl(${n++ % 360} 80% 50%)`;
    g.fillRect(0, 0, 320, 180);
  }, 50);
  window.cryptopo.addSource('screen', c.captureStream(20), { videoBitrate: 500_000, audioBitrate: 64_000, maxFramerate: 20, codec: '', hint: 'detail' });
};

const stats = (p) =>
  p.evaluate(async () => {
    const [x] = window.cryptopo.peers.values();
    const r = await x.pc.getStats();
    let frames = 0;
    let pair;
    r.forEach((s) => {
      if (s.type === 'inbound-rtp' && s.kind === 'video') frames += s.framesDecoded ?? 0;
      if (s.type === 'candidate-pair' && s.nominated && s.state === 'succeeded') pair = s;
    });
    const types = [];
    r.forEach((s) => {
      if (pair && (s.id === pair.localCandidateId || s.id === pair.remoteCandidateId)) types.push(s.candidateType);
    });
    const local = [];
    r.forEach((s) => s.type === 'local-candidate' && local.push(s.candidateType));
    return { frames, types, local, relay: window.cryptopo.relay };
  });

test('WebKit conserva la clave al recargar justo después de entrar', async () => {
  for (let i = 0; i < 5; i++) {
    const p = await (await browsers[1].newContext()).newPage();
    await p.goto(`${URL}/#k=${KEY}`);
    await p.waitForFunction(() => window.cryptopo?.myId && window.cryptopo.auth === 'ok', null, { polling: 10 });
    await p.reload();
    await p.waitForFunction(() => window.cryptopo?.myId && window.cryptopo.auth !== 'needed', null, { timeout: 15_000 }).catch(() => {});
    assert.equal(await p.evaluate(() => window.cryptopo.auth), 'ok', `intento ${i}: clave perdida`);
    await p.context().close();
  }
});

test('WebKit ↔ Chromium solo por TURN: identidad, código, chat y vídeo en ambos sentidos', async () => {
  await cr.evaluate(() => window.cryptopo.join('general', 'cris'));
  await wk.evaluate(() => window.cryptopo.join('general', 'safi'));
  const ready = () => {
    const p = [...window.cryptopo.peers.values()][0];
    return p?.proven && p.pc.connectionState === 'connected' && p.safety;
  };
  for (const p of [cr, wk]) {
    await p.waitForFunction(ready, null, { timeout: 30_000, polling: 200 }).catch(async (e) => {
      console.log(await p.evaluate(() => JSON.stringify([...window.cryptopo.peers.values()].map((x) => ({ s: x.pc.connectionState, ice: x.pc.iceConnectionState, proven: x.proven })))), logs);
      throw e;
    });
  }
  assert.equal(await cr.evaluate(() => window.cryptopo.peerViews()[0].safety), await wk.evaluate(() => window.cryptopo.peerViews()[0].safety));

  await wk.evaluate(() => window.cryptopo.sendChat('hola desde webkit'));
  await cr.waitForFunction(() => window.cryptopo.chat.some((m) => m.text === 'hola desde webkit' && m.name === 'safi'), null, { timeout: 10_000 });
  await cr.evaluate(() => window.cryptopo.sendChat('hola desde chromium'));
  await wk.waitForFunction(() => window.cryptopo.chat.some((m) => m.text === 'hola desde chromium' && m.name === 'cris'), null, { timeout: 10_000 });

  await cr.evaluate(shareCanvas);
  await wk.evaluate(shareCanvas);
  await new Promise((r) => setTimeout(r, 6000));
  const [sc, sw] = [await stats(cr), await stats(wk)];
  console.log('chromium', JSON.stringify(sc), 'webkit', JSON.stringify(sw));
  for (const s of [sc, sw]) {
    assert.equal(s.relay, true);
    assert.deepEqual(s.types, ['relay', 'relay'], 'el par elegido no es relay-relay');
    assert.ok(s.local.length > 0 && s.local.every((t) => t === 'relay'), `candidatos locales no relay: ${s.local}`);
  }
  assert.ok(sw.frames > 0, 'WebKit no decodifica vídeo de Chromium');
  assert.ok(sc.frames > 0, 'Chromium no decodifica vídeo de WebKit');
  assert.deepEqual(logs, []);
});
