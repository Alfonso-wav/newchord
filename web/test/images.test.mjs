import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CHUNK, ImageAssembler, MAX_IMAGE, chunksOf, cleanHeader, sniffMime } from '../src/images.ts';

const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const fakePng = (size) => {
  const b = new Uint8Array(size);
  for (let i = 0; i < size; i++) b[i] = (i * 31) & 0xff;
  b.set(PNG);
  return b;
};
const head = (bytes, extra = {}) => ({ t: 'img', id: 'a1', mime: 'image/png', size: bytes.length, w: 640, h: 480, ts: Date.now(), ...extra });

test('reensambla una imagen de varios trozos tal cual', () => {
  const bytes = fakePng(CHUNK * 2 + 123);
  const a = new ImageAssembler();
  assert.ok(a.begin(head(bytes)));
  const chunks = [...chunksOf(bytes, 'a1')];
  assert.equal(chunks.length, 3);
  assert.deepEqual(a.add(chunks[0]), { done: false });
  assert.deepEqual(a.add(chunks[1]), { done: false });
  const r = a.add(chunks[2]);
  assert.equal(r.done, true);
  assert.deepEqual([...r.bytes], [...bytes]);
});

test('el formato lo deciden los bytes, no la cabecera', () => {
  assert.equal(sniffMime(new Uint8Array([0xff, 0xd8, 0xff, 0xe0])), 'image/jpeg');
  assert.equal(sniffMime(new Uint8Array([...'RIFF0000WEBP'].map((c) => c.charCodeAt(0)))), 'image/webp');
  assert.equal(sniffMime(new TextEncoder().encode('<svg xmlns=')), null);
  const svg = new TextEncoder().encode('<svg onload=alert(1)>'.padEnd(100));
  const a = new ImageAssembler();
  a.begin(head(svg));
  const r = a.add([...chunksOf(svg, 'a1')][0]);
  assert.ok('error' in r);
});

test('descarta cabeceras fuera de límites o formatos no admitidos', () => {
  const ok = { id: 'x', mime: 'image/webp', size: 10, w: 1, h: 1, ts: 0 };
  assert.ok(cleanHeader(ok));
  for (const bad of [
    { ...ok, mime: 'image/svg+xml' },
    { ...ok, mime: 'image/gif' },
    { ...ok, size: MAX_IMAGE + 1 },
    { ...ok, size: 0 },
    { ...ok, w: 100_000 },
    { ...ok, h: 1.5 },
    { ...ok, id: '' },
    { ...ok, id: 'x'.repeat(65) },
    null,
  ]) assert.equal(cleanHeader(bad), null, JSON.stringify(bad));
  assert.ok(cleanHeader({ ...ok, ts: Date.now() + 1e9 }).ts <= Date.now());
});

test('un trozo fuera de orden, de más o sin cabecera tira la imagen', () => {
  const bytes = fakePng(CHUNK * 2);
  const chunks = [...chunksOf(bytes, 'a1')];
  let a = new ImageAssembler();
  a.begin(head(bytes));
  assert.ok('error' in a.add(chunks[1]));
  assert.ok('error' in a.add(chunks[0]), 'ya no queda nada pendiente');

  a = new ImageAssembler();
  a.begin(head(bytes, { size: CHUNK + 1 }));
  a.add(chunks[0]);
  assert.ok('error' in a.add(chunks[1]), 'el último trozo excede el tamaño anunciado');

  assert.ok('error' in new ImageAssembler().add(chunks[0]));
});

test('como mucho dos imágenes a medias por peer, y caducan', () => {
  let now = 0;
  const a = new ImageAssembler(() => now);
  const b = fakePng(100);
  assert.ok(a.begin(head(b, { id: '1' })));
  assert.ok(a.begin(head(b, { id: '2' })));
  assert.equal(a.begin(head(b, { id: '3' })), false);
  assert.equal(a.begin(head(b, { id: '1' })), false, 'id repetido');
  now = 61_000;
  assert.ok(a.begin(head(b, { id: '3' })));
});
