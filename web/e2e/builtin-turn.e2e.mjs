// TURN integrado (turn_builtin.go) con dos Chrome reales y -relay-only: la única ruta
// posible es relay ↔ relay por TCP a 127.0.0.1, la misma que usa el panel. No cubre el
// tramo de Funnel (TLS en 8443), que exige una cuenta de Tailscale: ver docs/HALLAZGOS.md.
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { after, before, test } from 'node:test';
import puppeteer from 'puppeteer-core';

const ROOT = resolve(import.meta.dirname, '..', '..');
const PORT = 18086;
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

let tmp, server, browsers;

const launch = () =>
  puppeteer.launch({
    executablePath: CHROME,
    headless: 'new',
    args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required'],
  });

before(async () => {
  assert.ok(CHROME, 'Chrome no encontrado: define CHROME_PATH');
  tmp = mkdtempSync(join(tmpdir(), 'cryptopo-bturn-'));
  const bin = join(tmp, process.platform === 'win32' ? 'cryptopo.exe' : 'cryptopo');
  execFileSync('go', ['build', '-o', bin, '.'], { cwd: ROOT, stdio: 'inherit' });
  server = spawn(
    bin,
    ['-addr', `127.0.0.1:${PORT}`, '-static', join(ROOT, 'web', 'dist'), '-stun', '', '-db', '', '-password', KEY, '-builtin-turn', '-relay-only'],
    { stdio: 'ignore' },
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
  browsers = await Promise.all([launch(), launch()]);
});

after(async () => {
  await Promise.all((browsers ?? []).map((x) => x.close()));
  server?.kill();
  await new Promise((r) => setTimeout(r, 300));
  rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

async function openPage(browser) {
  const page = await browser.newPage();
  await page.goto(`${URL}/#k=${KEY}`, { waitUntil: 'load' });
  await page.waitForFunction(() => window.cryptopo?.online && window.cryptopo.myId);
  return page;
}

const waitFor = (page, fn, ...args) => page.waitForFunction(fn, { timeout: 20_000, polling: 100 }, ...args);

test('dos Chrome conectan solo por el TURN integrado y el audio llega', async () => {
  const room = 'bturn-' + Math.random().toString(36).slice(2);
  const [a, b] = await Promise.all(browsers.map(openPage));

  const ice = await a.evaluate(() => window.cryptopo.ice);
  assert.equal(ice.length, 1, 'con -relay-only solo debe haber el TURN');
  assert.match(ice[0].urls[0], /^turn:127\.0\.0\.1:\d+\?transport=tcp$/);
  assert.ok(ice[0].username && ice[0].credential, 'sin credenciales');

  await a.evaluate((r) => window.cryptopo.join(r, 'ana'), room);
  await b.evaluate((r) => window.cryptopo.join(r, 'bea'), room);
  for (const p of [a, b])
    await waitFor(p, () => {
      const [peer] = window.cryptopo.peers.values();
      return peer?.pc.connectionState === 'connected' && peer.dc?.readyState === 'open';
    });

  await a.evaluate(async () => {
    const s = await navigator.mediaDevices.getUserMedia({ audio: true });
    window.cryptopo.addSource('mic', s, { videoBitrate: 0, audioBitrate: 96_000 });
    window.cryptopo.setMicMuted(false); // el micro entra silenciado
  });
  // Paquetes de audio recibidos por el relay. La energía solo se mide al reproducir, y sin
  // la UI montada no hay <audio>: eso ya lo cubre p2p.e2e.mjs por la vía directa.
  await waitFor(b, async () => {
    const [peer] = window.cryptopo.peers.values();
    let n = 0;
    (await peer.pc.getStats()).forEach((r) => {
      if (r.type === 'inbound-rtp' && r.kind === 'audio') n += r.packetsReceived;
    });
    return n > 100;
  });

  const pair = await b.evaluate(async () => {
    const [peer] = window.cryptopo.peers.values();
    const stats = await peer.pc.getStats();
    let pairId;
    stats.forEach((r) => {
      if (r.type === 'transport' && r.selectedCandidatePairId) pairId = r.selectedCandidatePairId;
    });
    const p = stats.get(pairId);
    const local = stats.get(p.localCandidateId);
    const remote = stats.get(p.remoteCandidateId);
    return { local: local.candidateType, remote: remote.candidateType, relayProtocol: local.relayProtocol, address: remote.address };
  });
  assert.deepEqual([pair.local, pair.remote], ['relay', 'relay'], JSON.stringify(pair));
  assert.equal(pair.relayProtocol, 'tcp');
  assert.equal(pair.address, '127.0.0.1');

  await Promise.all([a.close(), b.close()]);
});
