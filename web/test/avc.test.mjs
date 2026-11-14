import assert from 'node:assert/strict';
import { test } from 'node:test';
import { avcCodecString, nalUnits, parsePacket } from '../src/avc.ts';

// SPS + PPS + IDR como los emite MediaCodec (High, nivel 4.0), con prefijos largos y cortos.
const SPS = [0x67, 0x64, 0x00, 0x28, 0xac, 0xd9];
const PPS = [0x68, 0xeb, 0xe3];
const IDR = [0x65, 0x88, 0x84, 0x00];
const KEY = new Uint8Array([0, 0, 0, 1, ...SPS, 0, 0, 0, 1, ...PPS, 0, 0, 1, ...IDR]);

test('separa las NAL sin arrastrar el cero del prefijo largo', () => {
  const nals = [...nalUnits(KEY)].map((n) => [...n]);
  assert.deepEqual(nals, [SPS, PPS, IDR]);
});

test('saca la cadena de codec del SPS', () => {
  assert.equal(avcCodecString(KEY), 'avc1.640028');
});

test('sin SPS no hay cadena de codec', () => {
  assert.equal(avcCodecString(new Uint8Array([0, 0, 1, 0x41, 0x9a])), '');
  assert.equal(avcCodecString(new Uint8Array([])), '');
});

test('lee la cabecera de los paquetes de la app', () => {
  const buf = new ArrayBuffer(13);
  const v = new DataView(buf);
  v.setUint8(0, 1);
  v.setUint8(1, 1);
  v.setBigInt64(2, 123456789n);
  new Uint8Array(buf, 10).set([7, 8, 9]);
  const p = parsePacket(buf);
  assert.equal(p.type, 1);
  assert.equal(p.key, true);
  assert.equal(p.timestamp, 123456789);
  assert.deepEqual([...p.data], [7, 8, 9]);
  assert.equal(parsePacket(new ArrayBuffer(4)), null);
});
