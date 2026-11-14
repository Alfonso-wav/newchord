// Criptografía de extremo a extremo. Sin dependencias, solo WebCrypto.
//
// Clave de sala → PBKDF2 → maestro → HKDF → { "auth": prueba al servidor; "signal": AES-GCM }.
// El servidor solo conoce "auth" y no puede obtener "signal" a partir de ella, así que no
// puede leer ni cambiar los SDP. Como el SDP lleva la huella DTLS, tampoco puede meterse en
// medio del audio, el vídeo y el chat. Misma derivación que crypto.go.
//
// Además, cada dispositivo tiene una identidad propia que firma las huellas DTLS. Sin eso,
// cualquier poseedor de la clave de sala, de acuerdo con el servidor, podría interceptar a
// los demás. Los códigos de seguridad permiten comprobarlo por otro canal.

const enc = new TextEncoder();
const dec = new TextDecoder();
const SALT = enc.encode('newchord-v1');
const ITERATIONS = 600_000;

export const toHex = (b: ArrayBuffer) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, '0')).join('');

export function toB64(b: ArrayBuffer | Uint8Array) {
  const bytes = b instanceof Uint8Array ? b : new Uint8Array(b);
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

export function fromB64(s: string) {
  const raw = atob(s);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

export function fromB64Url(s: string) {
  return fromB64(s.replace(/-/g, '+').replace(/_/g, '/'));
}

// ---- invitaciones de un solo uso (invite.go) ----

// Enlace /#i=<id>.<k>: el id lo canjea el servidor; k nunca sale del navegador.
export function parseInvite(hash: string): { id: string; k: Uint8Array<ArrayBuffer> } | null {
  const m = /^#i=([A-Za-z0-9_-]{22})\.([A-Za-z0-9_-]{43})$/.exec(hash);
  return m ? { id: m[1], k: fromB64Url(m[2]) } : null;
}

// Abre el sobre que dejó el anfitrión. Lanza si k no es la del enlace o si el sobre es de otro id.
export async function openInvite(k: Uint8Array<ArrayBuffer>, id: string, iv: string, ct: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', k, 'AES-GCM', false, ['decrypt']);
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromB64(iv), additionalData: enc.encode('newchord-invite-v1|' + id) }, key, fromB64(ct));
  return dec.decode(plain);
}

export const normalizeSecret = (s: string) => s.trim().normalize('NFC');

// El maestro no es extraíble: un script inyectado podría usarlo mientras esté en la página,
// pero no llevárselo. La clave en texto no se guarda en ningún sitio.
export async function deriveMaster(secret: string): Promise<CryptoKey> {
  const pw = await crypto.subtle.importKey('raw', enc.encode(normalizeSecret(secret)), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: SALT, iterations: ITERATIONS }, pw, 256);
  return crypto.subtle.importKey('raw', bits, 'HKDF', false, ['deriveKey']);
}

export interface RoomKeys {
  auth: CryptoKey;
  signal: CryptoKey;
}

export async function deriveKeys(master: CryptoKey): Promise<RoomKeys> {
  const hkdf = (info: string) => ({ name: 'HKDF', hash: 'SHA-256', salt: SALT, info: enc.encode(info) });
  const [auth, signal] = await Promise.all([
    crypto.subtle.deriveKey(hkdf('auth'), master, { name: 'HMAC', hash: 'SHA-256', length: 256 }, false, ['sign']),
    crypto.subtle.deriveKey(hkdf('signal'), master, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']),
  ]);
  return { auth, signal };
}

export async function authProof(auth: CryptoKey, nonce: string) {
  return toHex(await crypto.subtle.sign('HMAC', auth, enc.encode('newchord-auth-v1|' + nonce)));
}

// ---- señalización cifrada ----

export interface Envelope {
  v: 1;
  seq: number;
  iv: string;
  ct: string;
}

// Los datos adicionales atan cada mensaje a su sala, emisor, receptor y orden: el servidor
// no puede reenviarlo a otro, devolverlo a quien lo envió ni repetirlo.
const aad = (room: string, from: string, to: string, seq: number) =>
  enc.encode(`newchord-signal-v1|${room.toLowerCase()}|${from}|${to}|${seq}`);

export async function seal(key: CryptoKey, data: unknown, room: string, from: string, to: string, seq: number): Promise<Envelope> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: aad(room, from, to, seq) }, key, enc.encode(JSON.stringify(data)));
  return { v: 1, seq, iv: toB64(iv), ct: toB64(ct) };
}

// Lanza si la clave no es la misma, o si alguien tocó el mensaje o su contexto.
export async function open(key: CryptoKey, env: Envelope, room: string, from: string, to: string): Promise<unknown> {
  if (env?.v !== 1 || !Number.isSafeInteger(env.seq) || typeof env.iv !== 'string' || typeof env.ct !== 'string') throw new Error('sobre inválido');
  const plain = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: fromB64(env.iv), additionalData: aad(room, from, to, env.seq) },
    key,
    fromB64(env.ct),
  );
  return JSON.parse(dec.decode(plain));
}

// ---- identidad ----

const ALG = { name: 'ECDSA', namedCurve: 'P-256' } as const;
const SIGN = { name: 'ECDSA', hash: 'SHA-256' } as const;

export interface Identity {
  pair: CryptoKeyPair;
  pub: string; // pública en base64
}

export async function newIdentityPair(): Promise<CryptoKeyPair> {
  return crypto.subtle.generateKey(ALG, false, ['sign', 'verify']);
}

export async function toIdentity(pair: CryptoKeyPair): Promise<Identity> {
  return { pair, pub: toB64(await crypto.subtle.exportKey('raw', pair.publicKey)) };
}

// Las huellas DTLS de un SDP, normalizadas: Chrome y Firefox las ponen en sitios distintos.
export function dtlsFingerprints(sdp: string) {
  const found = new Set<string>();
  for (const [, alg, hash] of sdp.matchAll(/^a=fingerprint:(\S+) (\S+)\s*$/gim)) found.add(`${alg.toLowerCase()} ${hash.toUpperCase()}`);
  return [...found].sort().join(',');
}

const proofText = (room: string, name: string, signerFp: string, verifierFp: string) =>
  enc.encode(`newchord-id-v1|${room.toLowerCase()}|${name}|${signerFp}|${verifierFp}`);

// Firma: "soy este dispositivo, me llamo así, y esta conexión DTLS va de mi huella a la tuya".
export async function signBinding(id: Identity, room: string, name: string, localFp: string, remoteFp: string) {
  return toB64(await crypto.subtle.sign(SIGN, id.pair.privateKey, proofText(room, name, localFp, remoteFp)));
}

export async function verifyBinding(pub: string, sig: string, room: string, name: string, remoteFp: string, localFp: string) {
  try {
    const key = await crypto.subtle.importKey('raw', fromB64(pub), ALG, false, ['verify']);
    return await crypto.subtle.verify(SIGN, key, fromB64(sig), proofText(room, name, remoteFp, localFp));
  } catch {
    return false;
  }
}

export async function keyTag(pub: string) {
  return toHex(await crypto.subtle.digest('SHA-256', fromB64(pub))).slice(0, 8);
}

// 30 dígitos que salen iguales en los dos extremos. Compararlos en voz alta o por otro medio
// descarta a cualquier intermediario, incluido otro miembro de la sala.
export async function safetyNumber(pubA: string, pubB: string) {
  const [x, y] = [pubA, pubB].sort();
  const hash = new DataView(await crypto.subtle.digest('SHA-256', enc.encode(`newchord-safety-v1|${x}|${y}`)));
  const groups: string[] = [];
  for (let i = 0; i < 6; i++) groups.push(String(hash.getUint32(i * 4) % 100_000).padStart(5, '0'));
  return groups.join(' ');
}

// ---- almacén ----

const DB = 'newchord-keys';
const STORE = 'keys';

function idb<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onerror = () => reject(req.error);
    req.onsuccess = () => {
      const db = req.result;
      // Se resuelve al terminar la transacción, no la petición: hasta entonces la escritura no es
      // firme, y WebKit la pierde si la página se recarga justo después (visto en webkit.e2e.mjs).
      const tx = db.transaction(STORE, mode);
      const r = fn(tx.objectStore(STORE));
      tx.oncomplete = () => {
        db.close();
        resolve(r.result);
      };
      tx.onerror = tx.onabort = () => {
        db.close();
        reject(tx.error ?? r.error);
      };
    };
  });
}

// Con la navegación privada de algunos navegadores no se puede guardar una CryptoKey: entonces
// la clave vive solo en memoria y la identidad cambia en cada sesión, que es lo esperable ahí.
export const loadKey = async <T>(name: string): Promise<T | undefined> => {
  try {
    return await idb<T>('readonly', (s) => s.get(name));
  } catch {
    return undefined;
  }
};

export const saveKey = async (name: string, value: unknown) => {
  try {
    await idb('readwrite', (s) => s.put(value, name));
  } catch {
    /* solo en memoria */
  }
};

export const deleteKey = async (name: string) => {
  try {
    await idb('readwrite', (s) => s.delete(name));
  } catch {
    /* no había */
  }
};

export async function loadIdentity(): Promise<Identity> {
  let pair = await loadKey<CryptoKeyPair>('identity');
  if (!pair) {
    pair = await newIdentityPair();
    await saveKey('identity', pair);
  }
  return toIdentity(pair);
}

// ---- confianza ----

export type TrustState = 'pending' | 'bad' | 'verified' | 'new' | 'changed';

export interface TrustBook {
  verified: Record<string, true>; // por clave pública
  names: Record<string, string>; // nombre → clave vista por primera vez o verificada
}

const TRUST_KEY = 'newchord.trust';

export function loadTrust(): TrustBook {
  try {
    const t = JSON.parse(localStorage.getItem(TRUST_KEY) ?? '{}');
    return { verified: t.verified ?? {}, names: t.names ?? {} };
  } catch {
    return { verified: {}, names: {} };
  }
}

export const saveTrust = (t: TrustBook) => localStorage.setItem(TRUST_KEY, JSON.stringify(t));

// Primera vez que se ve un nombre: se apunta su clave. Si luego llega otra con ese nombre, avisa.
export function evaluateTrust(book: TrustBook, name: string, pub: string): TrustState {
  if (book.verified[pub]) return 'verified';
  const key = name.toLowerCase();
  if (!book.names[key]) {
    book.names[key] = pub;
    saveTrust(book);
    return 'new';
  }
  return book.names[key] === pub ? 'new' : 'changed';
}

export function markVerified(book: TrustBook, name: string, pub: string) {
  book.verified[pub] = true;
  book.names[name.toLowerCase()] = pub;
  saveTrust(book);
}

// ---- texto que viene de otros ----

// Para nombres: sin controles ni caracteres de formato, que permiten imitar otro nombre.
export const safeName = (s: unknown, max = 32) =>
  [...String(s ?? '').replace(/[\p{Cc}\p{Cf}]/gu, '').trim()].slice(0, max).join('');

// Para chat: el ZWJ se conserva, que los emoji compuestos lo usan; el bidi no, que invierte el texto.
export const safeText = (s: unknown, max = 4000) =>
  String(s ?? '')
    .replace(/[‪-‮⁦-⁩‎‏؜]/g, '')
    .slice(0, max);
