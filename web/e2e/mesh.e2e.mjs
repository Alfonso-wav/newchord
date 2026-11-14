// Sala llena: 6 Chrome a la vez (el máximo de -max-room). Cada par debe conectar, demostrar identidad
// y ver el mismo código de seguridad; el chat debe llegar a todos con el autor correcto.
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
const KEY = 'clave-de-prueba-malla-completa';
const N = Number(process.env.MESH_N ?? 6);
const CHROME =
  process.env.CHROME_PATH ??
  ['C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', '/usr/bin/google-chrome', '/usr/bin/chromium'].find(existsSync);
const NAMES = ['ana', 'bea', 'cris', 'dani', 'eva', 'fran'].slice(0, N);

let tmp, server, browsers, pages;

before(async () => {
  assert.ok(CHROME, 'Chrome no encontrado: define CHROME_PATH');
  tmp = mkdtempSync(join(tmpdir(), 'cryptopo-mesh-'));
  const bin = join(tmp, process.platform === 'win32' ? 'cryptopo.exe' : 'cryptopo');
  execFileSync('go', ['build', '-o', bin, '.'], { cwd: ROOT, stdio: 'inherit' });
  server = spawn(bin, ['-addr', `127.0.0.1:${PORT}`, '-stun', '', '-password', KEY, '-db', ''], { stdio: 'ignore', cwd: tmp });
  for (let i = 0; ; i++) {
    try {
      await fetch(URL);
      break;
    } catch (e) {
      if (i > 50) throw e;
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  browsers = await Promise.all(
    NAMES.map(() =>
      puppeteer.launch({
        executablePath: CHROME,
        headless: 'new',
        args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required'],
      }),
    ),
  );
  pages = await Promise.all(
    browsers.map(async (br, i) => {
      const page = await br.newPage();
      await page.goto(`${URL}/#k=${KEY}`, { waitUntil: 'load' });
      await page.waitForFunction(() => window.cryptopo?.myId && window.cryptopo.auth === 'ok');
      await page.evaluate((n) => localStorage.setItem('newchord.prefs', JSON.stringify({ name: n })), NAMES[i]);
      await page.reload({ waitUntil: 'load' });
      await page.waitForFunction(() => window.cryptopo?.myId && window.cryptopo.auth === 'ok');
      return page;
    }),
  );
});

after(async () => {
  await Promise.all((browsers ?? []).map((x) => x.close()));
  server?.kill();
  await new Promise((r) => setTimeout(r, 300));
  rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

const waitFor = (page, fn, ...args) => page.waitForFunction(fn, { timeout: 45_000, polling: 200 }, ...args);

test(`${N} personas: malla completa, identidad demostrada y códigos simétricos`, async () => {
  for (let i = 0; i < N; i++) {
    await pages[i].evaluate((n) => window.cryptopo.join('general', n), NAMES[i]);
    await new Promise((r) => setTimeout(r, 300));
  }
  for (const p of pages) {
    await waitFor(
      p,
      (n) => {
        const ps = [...window.cryptopo.peers.values()];
        return ps.length === n - 1 && ps.every((x) => x.proven && x.pc.connectionState === 'connected' && x.safety);
      },
      N,
    );
  }
  const views = await Promise.all(pages.map((p) => p.evaluate(() => window.cryptopo.peerViews())));
  for (let i = 0; i < N; i++) {
    assert.deepEqual(views[i].map((v) => v.name).sort(), NAMES.filter((_, j) => j !== i).sort());
    for (const v of views[i]) {
      assert.equal(v.tampered, false, `${NAMES[i]} ve ${v.name} alterado`);
      assert.equal(v.duplicate, false);
      const j = NAMES.indexOf(v.name);
      const back = views[j].find((w) => w.name === NAMES[i]);
      assert.equal(v.safety, back.safety, `código ${NAMES[i]}↔${v.name}`);
    }
  }
  const codes = new Set(views.flatMap((vs) => vs.map((v) => v.safety)));
  assert.equal(codes.size, (N * (N - 1)) / 2, 'cada par tiene su propio código');
});

test(`${N} personas: el chat llega a todos con su autor`, async () => {
  await Promise.all(pages.map((p, i) => p.evaluate((t) => window.cryptopo.sendChat(t), `hola de ${NAMES[i]}`)));
  for (let i = 0; i < N; i++) {
    await waitFor(
      pages[i],
      (names, me) => names.every((n) => n === me || window.cryptopo.chat.some((m) => m.text === `hola de ${n}` && m.name === n && !m.via)),
      NAMES,
      NAMES[i],
    );
  }
});

test('la séptima persona no cabe', async () => {
  if (N < 6) return;
  const br = browsers[0];
  const ctx = await br.createBrowserContext();
  const p = await ctx.newPage();
  await p.goto(`${URL}/#k=${KEY}`, { waitUntil: 'load' });
  await p.waitForFunction(() => window.cryptopo?.myId && window.cryptopo.auth === 'ok');
  await p.evaluate(() => window.cryptopo.join('general', 'gus'));
  await new Promise((r) => setTimeout(r, 2000));
  assert.equal(await p.evaluate(() => window.cryptopo.room), null);
  assert.equal(await pages[0].evaluate(() => window.cryptopo.peers.size), N - 1);
  await ctx.close();
});

test('con -db "" no se crea ninguna base', () => {
  assert.equal(existsSync(join(tmp, 'cryptopo.db')), false);
});
