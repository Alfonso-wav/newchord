import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  authProof, openInvite, parseInvite, deriveKeys, deriveMaster, dtlsFingerprints, evaluateTrust, keyTag, markVerified, newIdentityPair, open,
  safeName, safeText, safetyNumber, seal, signBinding, toIdentity, verifyBinding,
} from '../src/e2e.ts';

globalThis.localStorage ??= { getItem: () => null, setItem() {}, removeItem() {} };

const keysFor = async (s) => deriveKeys(await deriveMaster(s));
const shared = await keysFor('clave de prueba compartida');
const other = await keysFor('otra clave distinta de la sala');

// Mismo vector en auth_test.go: el servidor y el navegador deben derivar lo mismo.
test('la prueba coincide con la del servidor Go', async () => {
  assert.equal(await authProof(shared.auth, 'reto'), 'd2144718f194dec9ae0d1ed85a7a7dc9f57983c4a62950f50a323fa512ce4c2b');
});

test('la clave se normaliza igual que en el servidor', async () => {
  const k = await keysFor('  clave de prueba compartida\n');
  assert.equal(await authProof(k.auth, 'reto'), await authProof(shared.auth, 'reto'));
});

test('sellar y abrir devuelve lo mismo, y el texto no va en claro', async () => {
  const e = await seal(shared.signal, { description: { sdp: 'SECRETO' } }, 'Sala', 'a', 'b', 1);
  assert.ok(!JSON.stringify(e).includes('SECRETO'));
  assert.deepEqual(await open(shared.signal, e, 'sala', 'a', 'b'), { description: { sdp: 'SECRETO' } });
});

test('otra clave de sala no puede abrir la señalización', async () => {
  const e = await seal(shared.signal, { x: 1 }, 'sala', 'a', 'b', 1);
  await assert.rejects(open(other.signal, e, 'sala', 'a', 'b'));
});

test('el servidor no puede redirigir, reflejar, repetir en otra sala ni alterar', async () => {
  const e = await seal(shared.signal, { x: 1 }, 'sala', 'a', 'b', 7);
  await assert.rejects(open(shared.signal, e, 'sala', 'a', 'c'), undefined, 'otro destinatario');
  await assert.rejects(open(shared.signal, e, 'sala', 'b', 'a'), undefined, 'reflejado');
  await assert.rejects(open(shared.signal, e, 'otra', 'a', 'b'), undefined, 'otra sala');
  await assert.rejects(open(shared.signal, { ...e, seq: 8 }, 'sala', 'a', 'b'), undefined, 'otro orden');
  const flipped = (e.ct[0] === 'A' ? 'B' : 'A') + e.ct.slice(1);
  await assert.rejects(open(shared.signal, { ...e, ct: flipped }, 'sala', 'a', 'b'), undefined, 'alterado');
  await assert.rejects(open(shared.signal, { v: 1 }, 'sala', 'a', 'b'), undefined, 'mal formado');
});

test('las huellas DTLS se normalizan y se recogen de todo el SDP', () => {
  const sdp = 'v=0\r\na=fingerprint:SHA-256 aa:bb\r\nm=audio\r\na=fingerprint:sha-256 AA:BB\r\nm=video\r\na=fingerprint:sha-256 CC:DD\r\n';
  assert.equal(dtlsFingerprints(sdp), 'sha-256 AA:BB,sha-256 CC:DD');
});

const id = async () => toIdentity(await newIdentityPair());

test('la firma ata identidad, nombre y las dos huellas DTLS', async () => {
  const ana = await id();
  const sig = await signBinding(ana, 'Sala', 'ana', 'FP-ANA', 'FP-BEA');
  assert.equal(await verifyBinding(ana.pub, sig, 'sala', 'ana', 'FP-ANA', 'FP-BEA'), true);
  // Un intermediario en DTLS hace que cada lado vea una huella distinta.
  assert.equal(await verifyBinding(ana.pub, sig, 'sala', 'ana', 'FP-MITM', 'FP-BEA'), false);
  assert.equal(await verifyBinding(ana.pub, sig, 'sala', 'ana', 'FP-ANA', 'FP-MITM'), false);
  assert.equal(await verifyBinding(ana.pub, sig, 'sala', 'cris', 'FP-ANA', 'FP-BEA'), false, 'otro nombre');
  assert.equal(await verifyBinding(ana.pub, sig, 'otra', 'ana', 'FP-ANA', 'FP-BEA'), false, 'otra sala');
  assert.equal(await verifyBinding((await id()).pub, sig, 'sala', 'ana', 'FP-ANA', 'FP-BEA'), false, 'otra clave');
  assert.equal(await verifyBinding('no es base64 !!', sig, 'sala', 'ana', 'a', 'b'), false, 'clave basura');
});

test('la identidad no se puede extraer', async () => {
  const { privateKey } = await newIdentityPair();
  assert.equal(privateKey.extractable, false);
  await assert.rejects(crypto.subtle.exportKey('pkcs8', privateKey));
});

test('el código de seguridad es simétrico y cambia con la clave', async () => {
  const [a, b, c] = [await id(), await id(), await id()];
  const n = await safetyNumber(a.pub, b.pub);
  assert.match(n, /^(\d{5} ){5}\d{5}$/);
  assert.equal(await safetyNumber(b.pub, a.pub), n);
  assert.notEqual(await safetyNumber(a.pub, c.pub), n);
  assert.match(await keyTag(a.pub), /^[0-9a-f]{8}$/);
});

test('avisa si un nombre conocido llega con otra clave', () => {
  const book = { verified: {}, names: {} };
  assert.equal(evaluateTrust(book, 'Ana', 'K1'), 'new');
  assert.equal(evaluateTrust(book, 'ana', 'K1'), 'new');
  assert.equal(evaluateTrust(book, 'ANA', 'K2'), 'changed');
  markVerified(book, 'ana', 'K2');
  assert.equal(evaluateTrust(book, 'ana', 'K2'), 'verified');
  assert.equal(evaluateTrust(book, 'ana', 'K1'), 'changed', 'la antigua ya no vale');
});

test('el texto ajeno no puede imitar nombres ni invertir la escritura', () => {
  assert.equal(safeName('an​a‮'), 'ana');
  assert.equal(safeName('x'.repeat(50)).length, 32);
  assert.equal(safeName(null), '');
  assert.equal(safeText('hola‮adios'), 'holaadios');
  assert.equal(safeText('👨‍👩'), '👨‍👩', 'emoji compuesto intacto');
  assert.equal(safeText('y'.repeat(5000)).length, 4000);
});

// Mismo vector en invite_token_test.go: el navegador abre lo que sella Go.
const inviteK = Uint8Array.from({ length: 32 }, (_, i) => i);
const inviteCt = 'K3e/EBzJMvseEi2dvwcL3SGta3rqHocbw7AoZDpeoVRKYw0F5RlUJzgn';
const inviteIv = btoa(String.fromCharCode(...Array.from({ length: 12 }, (_, i) => 100 + i)));

test('la invitación sellada por Go se abre con la k del enlace', async () => {
  assert.equal(await openInvite(inviteK, 'ID-DE-PRUEBA', inviteIv, inviteCt), 'clave de prueba compartida');
});

test('la invitación no abre con otra k ni con otro id', async () => {
  const wrong = inviteK.slice();
  wrong[0] ^= 1;
  await assert.rejects(openInvite(wrong, 'ID-DE-PRUEBA', inviteIv, inviteCt));
  await assert.rejects(openInvite(inviteK, 'OTRO-ID', inviteIv, inviteCt));
});

test('parseInvite solo acepta el formato exacto', () => {
  const id = 'A'.repeat(22);
  const k = 'B'.repeat(43);
  assert.deepEqual(parseInvite(`#i=${id}.${k}`)?.id, id);
  assert.equal(parseInvite(`#i=${id}.${k}x`), null);
  assert.equal(parseInvite(`#i=${id}`), null);
  assert.equal(parseInvite(`#k=${id}.${k}`), null);
});
