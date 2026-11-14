// La clave por la UI real: pantalla, fallo, entrada, recarga, enlace, y salas ocultas antes de entrar.
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { after, before, test } from 'node:test';
import puppeteer from 'puppeteer-core';

const ROOT = resolve(import.meta.dirname, '..', '..');
const PORT = 18082;
const URL = `http://localhost:${PORT}`;
const KEY = 'clave-de-prueba-suficientemente-larga';
const OTHER_KEY = 'otra-clave-de-prueba-tambien-larga';
const CHROME =
  process.env.CHROME_PATH ??
  [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
  ].find(existsSync);

let tmp, bin, server, browser;

const waitServer = async () => {
  for (let i = 0; ; i++) {
    try {
      await fetch(URL);
      return;
    } catch (e) {
      if (i > 50) throw e;
      await new Promise((r) => setTimeout(r, 100));
    }
  }
};

const startServer = async (key) => {
  server = spawn(bin, ['-addr', `127.0.0.1:${PORT}`, '-static', join(ROOT, 'web', 'dist'), '-stun', '', '-db', '', '-password', key], { stdio: 'ignore' });
  await waitServer();
};

before(async () => {
  assert.ok(CHROME, 'Chrome no encontrado: define CHROME_PATH');
  tmp = mkdtempSync(join(tmpdir(), 'cryptopo-pw-'));
  bin = join(tmp, process.platform === 'win32' ? 'cryptopo.exe' : 'cryptopo');
  execFileSync('go', ['build', '-o', bin, '.'], { cwd: ROOT, stdio: 'inherit' });
  await startServer(KEY);
  browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: 'new',
    args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'],
  });
});

after(async () => {
  await browser?.close();
  server?.kill();
  await new Promise((r) => setTimeout(r, 300));
  rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

async function submit(page, value) {
  await page.waitForSelector('#password');
  await page.type('#password', value);
  await page.keyboard.press('Enter');
}

async function enterName(page, name) {
  await page.waitForSelector('#name');
  await page.type('#name', name);
  await page.keyboard.press('Enter');
}

test('pide la clave, rechaza la mala y recuerda la buena sin guardarla en claro', async () => {
  const ctx = await browser.createBrowserContext();
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(URL);

  await page.waitForSelector('#password');
  assert.equal(await page.$('#name'), null, 'la clave se pide antes que el nombre');
  assert.equal(await page.$('.rail'), null, 'las salas no deben verse sin clave');
  assert.deepEqual(await page.evaluate(() => window.cryptopo.rooms), []);

  await submit(page, OTHER_KEY);
  await page.waitForSelector('.login-error', { timeout: 10_000 });

  await submit(page, KEY);
  await enterName(page, 'ana');
  await page.waitForFunction(() => window.cryptopo.myId && window.cryptopo.rooms.length > 0, { timeout: 10_000 });
  assert.equal(await page.$('#password'), null);
  assert.equal(await page.evaluate(() => window.cryptopo.name), 'ana');

  await page.reload();
  await page.waitForFunction(() => window.cryptopo?.myId && window.cryptopo.auth === 'ok', { timeout: 10_000 });
  assert.equal(await page.$('#password'), null, 'recargar no debe volver a pedirla');

  const stored = await page.evaluate(async () => {
    const db = await new Promise((res) => {
      const r = indexedDB.open('newchord-keys', 1);
      r.onsuccess = () => res(r.result);
    });
    const master = await new Promise((res) => {
      const r = db.transaction('keys').objectStore('keys').get('master');
      r.onsuccess = () => res(r.result);
    });
    return { type: master?.type, extractable: master?.extractable, local: JSON.stringify(localStorage) };
  });
  assert.equal(stored.type, 'secret');
  assert.equal(stored.extractable, false, 'el maestro no se puede sacar del navegador');
  assert.ok(!stored.local.includes(KEY), 'la clave no está en localStorage');
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('el enlace con clave entra solo y la borra de la barra de direcciones', async () => {
  const ctx = await browser.createBrowserContext();
  const page = await ctx.newPage();
  await page.goto(`${URL}/#k=${encodeURIComponent(KEY)}`);
  await enterName(page, 'dani');
  await page.waitForFunction(() => window.cryptopo.myId && window.cryptopo.rooms.length > 0, { timeout: 10_000 });
  assert.equal(await page.evaluate(() => location.hash), '');
  assert.equal(await page.$('#password'), null);
  await ctx.close();
});

test('olvidar la clave vuelve a la pantalla y no se recupera al recargar', async () => {
  const ctx = await browser.createBrowserContext();
  const page = await ctx.newPage();
  await page.goto(`${URL}/#k=${encodeURIComponent(KEY)}`);
  await enterName(page, 'eva');
  await page.waitForFunction(() => window.cryptopo.auth === 'ok' && window.cryptopo.rooms.length > 0, { timeout: 10_000 });
  await page.evaluate(() => window.cryptopo.forgetKey());
  await page.waitForSelector('#password');
  await page.reload();
  await page.waitForSelector('#password', { timeout: 10_000 });
  await ctx.close();
});

test('una clave guardada que ya no vale vuelve a la pantalla', async () => {
  const ctx = await browser.createBrowserContext();
  const page = await ctx.newPage();
  await page.goto(`${URL}/#k=${encodeURIComponent(KEY)}`);
  await enterName(page, 'bea');
  await page.waitForFunction(() => window.cryptopo.auth === 'ok' && window.cryptopo.rooms.length > 0, { timeout: 10_000 });

  server.kill();
  await new Promise((r) => setTimeout(r, 300));
  await startServer(OTHER_KEY);

  await page.waitForSelector('.login-error', { timeout: 15_000 });
  await page.reload();
  await page.waitForSelector('#password', { timeout: 10_000 });
  await submit(page, OTHER_KEY);
  await page.waitForFunction(() => window.cryptopo.auth === 'ok' && window.cryptopo.rooms.length > 0, { timeout: 10_000 });
  await ctx.close();
});

test('la clave no vale como nombre, ni escrita ni ya guardada', async () => {
  server.kill(); // el test anterior lo deja con OTHER_KEY
  await new Promise((r) => setTimeout(r, 300));
  await startServer(KEY);
  const ctx = await browser.createBrowserContext();
  const page = await ctx.newPage();
  await page.goto(`${URL}/#k=${encodeURIComponent(KEY)}`);
  await enterName(page, KEY);
  await page.waitForSelector('.login-error', { timeout: 10_000 });
  assert.equal(await page.$eval('#name', (i) => i.value), '');
  assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('newchord.prefs') ?? '{}').name ?? ''), '');

  await enterName(page, 'flor');
  await page.waitForFunction(() => window.cryptopo.myId && window.cryptopo.rooms.length > 0, { timeout: 10_000 });

  // Lo que dejó la versión anterior: la clave, o una generada y truncada a 32, guardada como nombre.
  const generated = 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6';
  for (const bad of [KEY, generated]) {
    await page.evaluate((n) => localStorage.setItem('newchord.prefs', JSON.stringify({ name: n, avatar: '' })), bad);
    await page.reload();
    await page.waitForSelector('#name', { timeout: 10_000 });
    assert.equal(await page.evaluate(() => window.cryptopo.name), '');
  }
  await ctx.close();
});
