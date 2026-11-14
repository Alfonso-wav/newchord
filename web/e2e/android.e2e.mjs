// App Android en un emulador (o móvil por USB) + Chrome de escritorio en la misma sala.
// El móvil emite su pantalla por el puente nativo (MediaProjection → H.264 → WebCodecs) y
// Chrome tiene que recibirla; luego se corta desde la web y desde la notificación.
//
// Requiere: adb con un dispositivo arrancado, y el APK de depuración compilado
// (cd android; ./gradlew assembleDebug). Los diálogos del sistema se pulsan con
// uiautomator buscando el texto en inglés (imagen del emulador por defecto).
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { after, before, test } from 'node:test';
import puppeteer from 'puppeteer-core';

const ROOT = resolve(import.meta.dirname, '..', '..');
const PORT = 18093;
const DEVTOOLS = 18094;
const KEY = 'clave-de-prueba-app-android';
const PKG = 'com.alfo.cryptopo.debug';
const APK = join(ROOT, 'android', 'app', 'build', 'outputs', 'apk', 'debug', 'app-debug.apk');
const SDK = process.env.ANDROID_HOME ?? join(process.env.LOCALAPPDATA ?? '', 'Android', 'Sdk');
const ADB = process.env.ADB ?? [join(SDK, 'platform-tools', 'adb.exe'), join(SDK, 'platform-tools', 'adb')].find(existsSync) ?? 'adb';
const CHROME =
  process.env.CHROME_PATH ??
  ['C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', '/usr/bin/google-chrome', '/usr/bin/chromium'].find(existsSync);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Con tope de tiempo: un emulador colgado debe fallar la prueba, no bloquearla.
const adb = (...args) => execFileSync(ADB, args, { encoding: 'utf8', timeout: 60_000, env: { ...process.env, MSYS_NO_PATHCONV: '1' } });

// Nodos de la pantalla actual con texto y centro.
function screenNodes() {
  adb('shell', 'uiautomator', 'dump', '/sdcard/nc-ui.xml');
  const xml = adb('exec-out', 'cat', '/sdcard/nc-ui.xml');
  return [...xml.matchAll(/text="([^"]*)"[^>]*?bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/g)].map((m) => ({
    text: m[1],
    x: (Number(m[2]) + Number(m[4])) >> 1,
    y: (Number(m[3]) + Number(m[5])) >> 1,
  }));
}

async function tapText(re, timeout = 15_000) {
  const end = Date.now() + timeout;
  for (;;) {
    const n = screenNodes().find((x) => re.test(x.text));
    if (n) return adb('shell', 'input', 'tap', String(n.x), String(n.y));
    if (Date.now() > end) throw new Error(`no aparece ${re} en pantalla`);
    await sleep(500);
  }
}

// Diálogo de MediaProjection: Android 14+ pregunta app suelta o pantalla entera.
async function acceptCapture() {
  const end = Date.now() + 40_000;
  let nodes = [];
  while (!(nodes = screenNodes()).some((n) => /^(Start|Start now)$/.test(n.text))) {
    if (Date.now() > end) throw new Error(`no aparece el diálogo de captura; en pantalla: ${nodes.map((n) => n.text).join(' · ')}`);
    await sleep(500);
  }
  if (nodes.some((n) => n.text === 'A single app')) {
    await tapText(/^A single app$/);
    await sleep(800);
    await tapText(/^Entire screen$/);
    await sleep(800);
  }
  await tapText(/^(Start|Start now)$/);
}

let tmp, server, chrome, pc, phoneBrowser, phone;

const devices = (() => {
  try {
    return adb('devices').split('\n').filter((l) => /\tdevice\s*$/.test(l));
  } catch {
    return [];
  }
})();
const skip = !devices.length ? 'sin dispositivo adb' : !existsSync(APK) ? 'falta el APK: cd android; ./gradlew assembleDebug' : false;

before(async () => {
  if (skip) return;
  assert.ok(CHROME, 'Chrome no encontrado: define CHROME_PATH');
  tmp = mkdtempSync(join(tmpdir(), 'cryptopo-android-'));
  const bin = join(tmp, process.platform === 'win32' ? 'cryptopo.exe' : 'cryptopo');
  execFileSync('go', ['build', '-o', bin, '.'], { cwd: ROOT, stdio: 'inherit' });
  server = spawn(bin, ['-addr', `127.0.0.1:${PORT}`, '-password', KEY, '-db', ''], { stdio: 'ignore', cwd: tmp });
  for (let i = 0; ; i++) {
    try {
      await fetch(`http://localhost:${PORT}`);
      break;
    } catch (e) {
      if (i > 50) throw e;
      await sleep(100);
    }
  }

  // App limpia, con permisos ya dados: aquí se prueba el puente, no los diálogos de permisos.
  adb('install', '-r', '-g', APK);
  adb('shell', 'pm', 'clear', PKG);
  for (const p of ['RECORD_AUDIO', 'CAMERA', 'POST_NOTIFICATIONS']) adb('shell', 'pm', 'grant', PKG, `android.permission.${p}`);
  adb('shell', 'settings', 'put', 'system', 'accelerometer_rotation', '0');
  adb('shell', 'settings', 'put', 'system', 'user_rotation', '0');
  adb('reverse', `tcp:${PORT}`, `tcp:${PORT}`);
  adb('shell', 'am', 'start', '-a', 'android.intent.action.SEND', '-t', 'text/plain', '--es', 'android.intent.extra.TEXT',
    `http://localhost:${PORT}/#k=${KEY}`, '-n', `${PKG}/com.alfo.cryptopo.MainActivity`);
  let pid = '';
  for (let i = 0; i < 50 && !pid; i++) {
    await sleep(200);
    pid = adb('shell', 'pidof', PKG).trim();
  }
  assert.ok(pid, 'la app no arrancó');
  adb('forward', `tcp:${DEVTOOLS}`, `localabstract:webview_devtools_remote_${pid}`);
  for (let i = 0; !phone; i++) {
    try {
      phoneBrowser = await puppeteer.connect({ browserURL: `http://127.0.0.1:${DEVTOOLS}`, defaultViewport: null });
      phone = (await phoneBrowser.pages()).find((p) => p.url().startsWith(`http://localhost:${PORT}`));
    } catch (e) {
      if (i > 30) throw e;
    }
    if (!phone) await sleep(500);
  }

  chrome = await puppeteer.launch({
    executablePath: CHROME,
    headless: 'new',
    args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required'],
  });
  pc = await chrome.newPage();
  await pc.goto(`http://localhost:${PORT}/#k=${KEY}`, { waitUntil: 'load' });

  for (const [page, name] of [[phone, 'movil'], [pc, 'pc']]) {
    await page.waitForFunction(() => window.cryptopo?.myId && window.cryptopo.auth === 'ok', { timeout: 30_000 });
    await page.evaluate((n) => localStorage.setItem('newchord.prefs', JSON.stringify({ name: n })), name);
    await page.reload({ waitUntil: 'load' });
    await page.waitForFunction(() => window.cryptopo?.myId && window.cryptopo.auth === 'ok', { timeout: 30_000 });
    await page.evaluate((n) => window.cryptopo.join('general', n), name);
  }
});

after(async () => {
  phoneBrowser?.disconnect();
  await chrome?.close();
  if (!skip) {
    try {
      adb('shell', 'am', 'force-stop', PKG);
      adb('reverse', '--remove', `tcp:${PORT}`);
      adb('forward', '--remove', `tcp:${DEVTOOLS}`);
    } catch {}
  }
  server?.kill();
  await sleep(300);
  if (tmp) rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

const waitFor = (page, fn, ...args) => page.waitForFunction(fn, { timeout: 45_000, polling: 300 }, ...args);

// Clic por DOM: el clic por coordenadas de CDP no acierta en el WebView.
async function startSharing() {
  await phone.evaluate(() => {
    const live = document.querySelector('.go-live');
    if (live.getAttribute('aria-expanded') !== 'true') live.click();
  });
  await waitFor(phone, () => [...document.querySelectorAll('button')].some((b) => /elegir pantalla/.test(b.textContent)));
  await phone.evaluate(() => [...document.querySelectorAll('button')].find((b) => /elegir pantalla/.test(b.textContent)).click());
  await acceptCapture();
  await waitFor(phone, () => window.cryptopo.local.get('screen')?.stream.getVideoTracks()[0]?.readyState === 'live');
}

// Fotogramas de vídeo que Chrome ha decodificado de la pista de pantalla del móvil.
const received = () =>
  pc.evaluate(async () => {
    let best = { frames: 0, w: 0, h: 0 };
    for (const p of window.cryptopo.peers.values()) {
      (await p.pc.getStats()).forEach((r) => {
        if (r.type === 'inbound-rtp' && r.kind === 'video' && (r.framesDecoded ?? 0) > best.frames)
          best = { frames: r.framesDecoded, w: r.frameWidth, h: r.frameHeight };
      });
    }
    return best;
  });

test('la pantalla del móvil llega a Chrome, también al girar', { skip }, async () => {
  await waitFor(pc, () => [...window.cryptopo.peers.values()].some((p) => p.proven && p.pc.connectionState === 'connected'));
  await startSharing();
  const kinds = await phone.evaluate(() => window.cryptopo.local.get('screen').stream.getTracks().map((t) => t.constructor.name));
  assert.ok(kinds.every((k) => k === 'MediaStreamTrackGenerator'), `pistas: ${kinds}`);

  let r;
  for (let i = 0; i < 60 && !((r = await received()).frames > 20 && r.h > r.w); i++) await sleep(500);
  assert.ok(r.frames > 20, `Chrome solo decodificó ${r.frames} fotogramas`);
  assert.ok(r.h > r.w, `en vertical se esperaba más alto que ancho: ${r.w}x${r.h}`);

  // Girar: mismo VirtualDisplay, codificador nuevo, la página reconfigura con el SPS nuevo.
  adb('shell', 'settings', 'put', 'system', 'user_rotation', '1');
  try {
    for (let i = 0; i < 60 && !((r = await received()).w > r.h); i++) await sleep(500);
    assert.ok(r.w > r.h, `tras girar se esperaba apaisado: ${r.w}x${r.h}`);
  } finally {
    adb('shell', 'settings', 'put', 'system', 'user_rotation', '0');
  }
});

test('cortar desde la web libera la captura del sistema', { skip }, async () => {
  if (!(await phone.evaluate(() => window.cryptopo.local.has('screen')))) await startSharing();
  await phone.evaluate(() => window.cryptopo.removeSource('screen'));
  let out = '';
  for (let i = 0; i < 20 && !/Media Projection:\s*\r?\n\s*null/.test(out); i++) {
    await sleep(300);
    out = adb('shell', 'dumpsys', 'media_projection');
  }
  assert.match(out, /Media Projection:\s*\r?\n\s*null/);
});

test('"Dejar de emitir" en la notificación pausa la emisión en la web', { skip }, async () => {
  await startSharing();
  adb('shell', 'cmd', 'statusbar', 'expand-notifications');
  try {
    await sleep(1200);
    // Canal de importancia baja: la notificación sale plegada y hay que abrirla.
    if (!screenNodes().some((n) => n.text === 'Dejar de emitir')) {
      const title = screenNodes().find((n) => n.text === 'Emitiendo tu pantalla');
      assert.ok(title, 'no aparece la notificación de emisión');
      adb('shell', 'input', 'swipe', String(title.x), String(title.y), String(title.x), String(title.y + 400), '200');
    }
    await tapText(/^Dejar de emitir$/);
  } finally {
    adb('shell', 'cmd', 'statusbar', 'collapse');
  }
  await waitFor(phone, () => window.cryptopo.local.get('screen')?.paused === true);
});
