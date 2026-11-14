import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MAX_SEGMENT_MS, RATE, Segmenter, cleanTranscript } from '../src/vad.ts';

const silence = (ms, level = 0.001) => {
  const n = Math.round((ms / 1000) * RATE);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = (Math.random() * 2 - 1) * level;
  return out;
};
const tone = (ms, amp = 0.2) => {
  const n = Math.round((ms / 1000) * RATE);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = Math.sin((2 * Math.PI * 220 * i) / RATE) * amp;
  return out;
};

function run(parts, step = 1600) {
  const segs = [];
  const s = new Segmenter((x) => segs.push(x), 1000);
  for (const p of parts) for (let i = 0; i < p.length; i += step) s.push(p.subarray(i, i + step));
  return { segs, s };
}

test('una frase entre silencios da un segmento con su principio', () => {
  const { segs } = run([silence(1000), tone(1200), silence(1200)]);
  assert.equal(segs.length, 1);
  const ms = (segs[0].audio.length / RATE) * 1000;
  assert.ok(ms >= 1200 && ms < 2600, `${ms} ms`);
  assert.ok(Math.abs(segs[0].startedAt - 2000) < 350, `empieza en ${segs[0].startedAt}`);
});

test('el silencio y los chasquidos sueltos no dan nada', () => {
  assert.equal(run([silence(5000)]).segs.length, 0);
  assert.equal(run([silence(1000), tone(150), silence(2000)]).segs.length, 0);
});

test('dos frases separadas por una pausa larga son dos segmentos', () => {
  const { segs } = run([silence(500), tone(800), silence(1500), tone(900), silence(1500)]);
  assert.equal(segs.length, 2);
});

test('una frase larguísima se corta en trozos de como mucho el máximo', () => {
  const { segs } = run([silence(300), tone(45_000), silence(1000)]);
  assert.ok(segs.length >= 3);
  for (const s of segs) assert.ok((s.audio.length / RATE) * 1000 <= MAX_SEGMENT_MS + 30);
});

test('flush entrega lo que estaba a medias', () => {
  const { segs, s } = run([silence(500), tone(1000)]);
  assert.equal(segs.length, 0);
  s.flush();
  assert.equal(segs.length, 1);
});

test('fuera las alucinaciones típicas de Whisper', () => {
  for (const junk of ['Subtítulos realizados por la comunidad de Amara.org', '¡Gracias por ver el vídeo!', '[Música]', ' ... ', '(aplausos)'])
    assert.equal(cleanTranscript(junk), '', junk);
  assert.equal(cleanTranscript('  hola,   ¿qué tal?  '), 'hola, ¿qué tal?');
});
