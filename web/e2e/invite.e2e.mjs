// Invitación de un solo uso en Chrome real: entra sin pedir clave, solo vale una vez y no lleva la clave.
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { after, before, test } from 'node:test';
import puppeteer from 'puppeteer-core';

const ROOT = resolve(import.meta.dirname, '..', '..');
const PORT = 18091;
const URL = `http://localhost:${PORT}`;
const KEY = 'clave-de-prueba-suficientemente-larga';
const CHROME =
  process.env.CHROME_PATH ??
  [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
  ].find(existsSync);

let tmp, server, browser;
const links = [];

before(async () => {
  assert.ok(CHROME, 'Chrome no encontrado: define CHROME_PATH');
  tmp = mkdtempSync(join(tmpdir(), 'cryptopo-inv-'));
  const bin = join(tmp, process.platform === 'win32' ? 'cryptopo.exe' : 'cryptopo');
  execFileSync('go', ['build', '-o', bin, '.'], { cwd: ROOT, stdio: 'inherit' });
  server = spawn(bin, ['-addr', `127.0.0.1:${PORT}`, '-static', join(ROOT, 'web', 'dist'), '-stun', '', '-db', '', '-password', KEY, '-invite', URL], { stdio: ['ignore', 'pipe', 'ignore'] });
  let out = '';
  server.stdout.on('data', (d) => (out += d));
  for (let i = 0; !out.includes('#i='); i++) {
    assert.ok(i < 100, 'el servidor no imprimió la invitación');
    await new Promise((r) => setTimeout(r, 100));
  }
  links.push(/\S+#i=\S+/.exec(out)[0]);
  for (let i = 0; ; i++) {
    try {
      await fetch(URL);
      break;
    } catch (e) {
      if (i > 50) throw e;
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new', args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] });
});

after(async () => {
  await browser?.close();
  server?.kill();
  await new Promise((r) => setTimeout(r, 300));
  rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

async function enterName(page, name) {
  await page.waitForSelector('#name');
  await page.type('#name', name);
  await page.keyboard.press('Enter');
}

test('el enlace no lleva la clave de sala', () => {
  assert.ok(!links[0].includes(KEY) && !links[0].includes('#k='));
  assert.match(links[0], /#i=[\w-]{22}\.[\w-]{43}$/);
});

test('entra sin pedir clave, borra el fragmento y recuerda la clave', async () => {
  const ctx = await browser.createBrowserContext();
  const page = await ctx.newPage();
  await page.goto(links[0]);
  await enterName(page, 'ana');
  await page.waitForFunction(() => window.cryptopo.myId && window.cryptopo.auth === 'ok', { timeout: 15_000 });
  assert.equal(await page.evaluate(() => location.hash), '');
  assert.equal(await page.$('#password'), null);
  await page.reload();
  await page.waitForFunction(() => window.cryptopo?.myId && window.cryptopo.auth === 'ok', { timeout: 10_000 });
  await ctx.close();
});

test('un segundo dispositivo con el mismo enlace no entra', async () => {
  const ctx = await browser.createBrowserContext();
  const page = await ctx.newPage();
  await page.goto(links[0]);
  await page.waitForSelector('#password', { timeout: 15_000 });
  assert.ok(!(await page.evaluate(() => window.cryptopo.myId)), 'sin clave no hay sesión');
  assert.deepEqual(await page.evaluate(() => window.cryptopo.rooms), []);
  await ctx.close();
});

test('quien ya tiene la clave puede reabrir un enlace gastado', async () => {
  const ctx = await browser.createBrowserContext();
  const page = await ctx.newPage();
  await page.goto(`${URL}/#k=${encodeURIComponent(KEY)}`);
  await enterName(page, 'bea');
  await page.waitForFunction(() => window.cryptopo.myId && window.cryptopo.auth === 'ok', { timeout: 15_000 });
  await page.goto(links[0]);
  await page.waitForFunction(() => window.cryptopo?.myId && window.cryptopo.auth === 'ok', { timeout: 15_000 });
  assert.equal(await page.$('#password'), null);
  await ctx.close();
});
