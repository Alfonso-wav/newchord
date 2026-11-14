// Imágenes, mensajes en voz alta (TTS), dictado (STT con Whisper local) y archivo SQLite del
// navegador, con dos Chrome reales. El dictado escucha una frase de la voz Helena de Windows,
// inyectada como micro falso (--use-file-for-fake-audio-capture): solo corre en Windows.
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { after, afterEach, before, beforeEach, test } from 'node:test';
import puppeteer from 'puppeteer-core';

const ROOT = resolve(import.meta.dirname, '..', '..');
const PORT = 18085;
const URL = `http://localhost:${PORT}`;
const KEY = 'clave-de-prueba-e2e-suficientemente-larga';
const CHROME =
  process.env.CHROME_PATH ??
  ['C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', 'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe', '/usr/bin/google-chrome', '/usr/bin/chromium'].find(
    existsSync,
  );
const PHRASE = 'Hola a todos. Esto es una prueba del dictado.';

let tmp, server, browsers, a, b, room, wav;

// Voz de Windows → WAV. Sin System.Speech (o fuera de Windows) no hay prueba de dictado.
function speechWav(dir) {
  if (process.platform !== 'win32') return null;
  const out = join(dir, 'frase.wav');
  const ps = `Add-Type -AssemblyName System.Speech; $s = New-Object System.Speech.Synthesis.SpeechSynthesizer;
    $v = $s.GetInstalledVoices() | Where-Object { $_.VoiceInfo.Culture.Name -like 'es-*' } | Select-Object -First 1;
    if (-not $v) { exit 3 }; $s.SelectVoice($v.VoiceInfo.Name);
    $s.SetOutputToWaveFile('${out}'); $s.Speak('${PHRASE}'); $s.Speak(' '); $s.Dispose()`;
  try {
    execFileSync('powershell', ['-NoProfile', '-Command', ps], { stdio: 'ignore' });
    return out;
  } catch {
    return null;
  }
}

// Síntesis de voz falsa: headless no tiene voces, y así se ve qué se habría leído.
const fakeSpeech = () => {
  window.__spoken = [];
  const voice = { voiceURI: 'falsa', name: 'Falsa', lang: 'es-ES', localService: true, default: true };
  const synth = {
    speaking: false,
    getVoices: () => [voice],
    speak(u) {
      window.__spoken.push(u.text);
      setTimeout(() => u.onend?.(), 20);
    },
    cancel() {},
    addEventListener() {},
    removeEventListener() {},
  };
  Object.defineProperty(window, 'speechSynthesis', { value: synth, configurable: true });
  window.SpeechSynthesisUtterance = class {
    constructor(text) {
      this.text = text;
    }
  };
};

const launch = (extra = []) =>
  puppeteer.launch({
    executablePath: CHROME,
    headless: 'new',
    args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required', ...extra],
  });

before(async () => {
  assert.ok(CHROME, 'Chrome no encontrado: define CHROME_PATH');
  tmp = mkdtempSync(join(tmpdir(), 'cryptopo-extras-'));
  wav = speechWav(tmp);
  const bin = join(tmp, process.platform === 'win32' ? 'cryptopo.exe' : 'cryptopo');
  execFileSync('go', ['build', '-o', bin, '.'], { cwd: ROOT, stdio: 'inherit' });
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
  // a habla con la frase grabada si la hay; b, con el pitido de siempre.
  browsers = await Promise.all([launch(wav ? [`--use-file-for-fake-audio-capture=${wav}`] : []), launch()]);
});

after(async () => {
  await Promise.all((browsers ?? []).map((x) => x.close()));
  server?.kill();
  await new Promise((r) => setTimeout(r, 300));
  rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

// Por la UI hace falta nombre guardado; se guarda la clave primero (ver CLAUDE.md) y se recarga.
async function openPage(browser, name) {
  const page = await browser.newPage();
  page.errors = [];
  page.on('console', (m) => m.type() === 'error' && page.errors.push(m.text()));
  page.on('pageerror', (e) => page.errors.push(e.message));
  await page.evaluateOnNewDocument(fakeSpeech);
  await page.goto(`${URL}/#k=${KEY}`, { waitUntil: 'load' });
  await page.waitForFunction(() => window.cryptopo?.myId && window.cryptopo.auth === 'ok');
  await page.evaluate((n) => localStorage.setItem('newchord.prefs', JSON.stringify({ name: n, avatar: '', sprite: null })), name);
  await page.reload({ waitUntil: 'load' });
  await page.waitForFunction(() => window.cryptopo?.online && window.cryptopo.myId && window.cryptopo.auth === 'ok');
  return page;
}

const waitFor = (page, fn, timeout = 20_000, ...args) => page.waitForFunction(fn, { timeout, polling: 200 }, ...args);

async function connectPair() {
  for (const [p, n] of [[a, 'ana'], [b, 'bea']]) await p.evaluate((r, n) => window.cryptopo.join(r, n), room, n);
  for (const p of [a, b])
    await waitFor(p, () => {
      const [peer] = window.cryptopo.peers.values();
      return peer?.proven && peer.dc?.readyState === 'open';
    });
  await waitFor(a, () => document.querySelector('#composer'));
}

beforeEach(async () => {
  room = 'extras-' + Math.random().toString(36).slice(2);
  [a, b] = await Promise.all([openPage(browsers[0], 'ana'), openPage(browsers[1], 'bea')]);
});

afterEach(async () => {
  for (const p of [a, b]) assert.deepEqual(p.errors.filter((e) => !/favicon|ERR_|net::/.test(e)), [], `errores en consola de ${p === a ? 'a' : 'b'}`);
  await Promise.all([a, b].map((p) => p?.close()));
});

const archived = (page, kind) =>
  page.evaluate(async (r, k) => (await window.cryptopo.archive.list(r)).filter((x) => x.kind === k).map(({ data, ...x }) => ({ ...x, bytes: data?.length ?? 0 })), room, kind);

test('una imagen llega recodificada, se ve en el chat del otro y se guarda en su SQLite', async () => {
  await connectPair();
  // PNG de 1200×900 con ruido (pesa) y EXIF imposible de conservar: se recodifica.
  const png = await a.evaluate(async () => {
    const c = document.createElement('canvas');
    c.width = 1200;
    c.height = 900;
    const g = c.getContext('2d');
    const img = g.createImageData(1200, 900);
    for (let i = 0; i < img.data.length; i++) img.data[i] = (i * 2654435761) >>> 24;
    g.putImageData(img, 0, 0);
    g.fillStyle = '#f0f';
    g.fillRect(100, 100, 300, 200);
    const blob = await new Promise((r) => c.toBlob(r, 'image/png'));
    return [...new Uint8Array(await blob.arrayBuffer())];
  });
  const file = join(tmp, 'prueba.png');
  writeFileSync(file, Buffer.from(png));
  const input = await a.$('input[type=file][accept="image/*"]');
  await input.uploadFile(file);

  await waitFor(b, () => document.querySelector('.msg.kind-image img')?.complete, 30_000);
  const seen = await b.evaluate(() => {
    const img = document.querySelector('.msg.kind-image img');
    return { src: img.src, w: img.naturalWidth, h: img.naturalHeight, author: img.closest('.msg').querySelector('.author').textContent };
  });
  assert.match(seen.src, /^blob:/);
  assert.deepEqual([seen.w, seen.h, seen.author], [1200, 900, '<ana>']);

  // Los dos lo tienen en su archivo; el de b con los bytes y el autor fijado por la conexión.
  await waitFor(b, async (r) => (await window.cryptopo.archive.list(r)).some((x) => x.kind === 'image'), 10_000, room);
  const [rowB] = await archived(b, 'image');
  const [rowA] = await archived(a, 'image');
  assert.equal(rowB.author, 'ana');
  assert.equal(rowB.mine, 0);
  assert.equal(rowA.mine, 1);
  assert.ok(rowB.bytes > 1000 && rowB.bytes <= 2_000_000, `${rowB.bytes} bytes`);
  assert.equal(rowB.bytes, rowA.bytes);
  assert.ok(['image/webp', 'image/jpeg'].includes(rowB.mime), rowB.mime);

  // Al volver a entrar, la imagen sale del archivo local aunque nadie la reenvíe.
  await b.evaluate(() => window.cryptopo.leave());
  await b.evaluate((r) => window.cryptopo.join(r, 'bea'), room);
  await waitFor(b, () => document.querySelector('.msg.stored.kind-image img')?.naturalWidth === 1200);
});

test('una imagen que no es lo que dice ser no se enseña ni se guarda', async () => {
  await connectPair();
  // a manda a mano una cabecera PNG con contenido SVG.
  await a.evaluate(() => {
    const [peer] = window.cryptopo.peers.values();
    const body = btoa('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>');
    const size = atob(body).length;
    peer.dc.send(JSON.stringify({ t: 'img', id: 'malo', mime: 'image/png', size, w: 10, h: 10, ts: Date.now() }));
    peer.dc.send(JSON.stringify({ t: 'imgc', id: 'malo', i: 0, d: body }));
  });
  a.errors.length = 0;
  await a.evaluate((r) => window.cryptopo.sendChat('después', 'chat'), room);
  await waitFor(b, () => window.cryptopo.chat.some((m) => m.text === 'después'));
  assert.equal(await b.evaluate(() => window.cryptopo.chat.some((m) => m.id === 'malo')), false);
  assert.deepEqual(await archived(b, 'image'), []);
});

test('«decir» se lee en voz alta en la sala, y el chat solo si se activa', async () => {
  await connectPair();
  await a.type('#composer', '/decir buenas tardes');
  await a.keyboard.press('Enter');
  await waitFor(b, () => window.__spoken.includes('buenas tardes'));
  assert.ok(await a.evaluate(() => window.__spoken.includes('buenas tardes')), 'quien lo escribe también lo oye');
  assert.equal(await b.evaluate(() => document.querySelector('.msg.kind-tts .msg-text')?.textContent), '🔊 buenas tardes');

  await a.evaluate(() => window.cryptopo.sendChat('esto no se lee'));
  await waitFor(b, () => window.cryptopo.chat.some((m) => m.text === 'esto no se lee'));
  await b.evaluate(() => window.cryptopoVoice.set({ readChat: true }));
  await a.evaluate(() => window.cryptopo.sendChat('esto sí'));
  await waitFor(b, () => window.__spoken.includes('ana: esto sí'));
  assert.ok(!(await b.evaluate(() => window.__spoken.some((t) => t.includes('no se lee')))));
  const [row] = await archived(b, 'tts');
  assert.equal(row.text, 'buenas tardes');
});

test('el dictado transcribe la voz en el navegador de quien habla y la sala lo recibe', { skip: !wav && 'sin voz española de Windows', timeout: 240_000 }, async () => {
  await connectPair();
  await a.evaluate(async () => {
    const s = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } });
    window.cryptopo.addSource('mic', s, { videoBitrate: 0, audioBitrate: 96_000 });
    window.cryptopo.setMicMuted(false);
    window.cryptopoVoice.set({ dictate: true, lang: 'spanish' });
  });
  await waitFor(a, () => window.cryptopoVoice.stt.phase === 'on' || window.cryptopoVoice.stt.phase === 'error', 120_000);
  assert.equal(await a.evaluate(() => window.cryptopoVoice.stt.phase), 'on', JSON.stringify(await a.evaluate(() => window.cryptopoVoice.stt)));
  await b.evaluate(() => window.cryptopoVoice.set({ readStt: true }));
  // Dos frases con pausa entre medias: dos segmentos. El fichero se repite en bucle.
  await waitFor(b, () => /hola.*prueba.*dictado/is.test(window.cryptopo.chat.filter((m) => m.kind === 'stt').map((m) => m.text).join(' ')), 120_000);
  const said = await b.evaluate(() => window.cryptopo.chat.filter((m) => m.kind === 'stt').map((m) => m.text));
  console.log('transcrito:', said);
  await waitFor(b, () => window.__spoken.some((t) => t.startsWith('ana: ')));
  const rows = await archived(b, 'stt');
  assert.ok(rows.length >= 1 && rows.every((r) => r.author === 'ana'));
  // Que no salga nada hacia fuera lo garantiza el CSP (connect-src 'self'), también en el worker.
});
