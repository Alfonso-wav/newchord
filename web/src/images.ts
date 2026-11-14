// Imágenes por el DataChannel: se anuncian con una cabecera y llegan en trozos base64, en orden
// (el canal es ordenado y fiable). Este módulo no toca el DOM ni importa nada: lo usa la malla y lo
// prueba node (test/images.test.mjs).

function toB64(bytes: Uint8Array) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

function fromB64(s: string) {
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(s)) throw new Error('base64');
  const raw = atob(s);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

export const IMAGE_MIMES = ['image/webp', 'image/jpeg', 'image/png'] as const;
export type ImageMime = (typeof IMAGE_MIMES)[number];
export const MAX_IMAGE = 2_000_000; // bytes ya recodificados
export const MAX_SIDE = 2048; // lo que se envía; lo que se acepta llega hasta MAX_ACCEPT_SIDE
export const MAX_ACCEPT_SIDE = 8192;
export const CHUNK = 48 * 1024; // 64 KiB en base64, lejos del límite de mensaje del canal
export const MAX_INFLIGHT = 2; // imágenes a medio llegar por peer
export const IMAGE_TIMEOUT_MS = 60_000;

export interface ImageHeader {
  t: 'img';
  id: string;
  mime: ImageMime;
  size: number;
  w: number;
  h: number;
  ts: number;
}

export interface ImageChunk {
  t: 'imgc';
  id: string;
  i: number;
  d: string;
}

const isMime = (m: unknown): m is ImageMime => IMAGE_MIMES.includes(m as ImageMime);
const intIn = (v: unknown, lo: number, hi: number) => Number.isInteger(v) && (v as number) >= lo && (v as number) <= hi;

export const chunkCount = (size: number) => Math.ceil(size / CHUNK);

// Cabecera de otro peer: o cuadra entera o no se acepta.
export function cleanHeader(raw: unknown, maxId = 64): ImageHeader | null {
  const h = raw as Partial<ImageHeader> | null;
  if (!h || typeof h.id !== 'string' || !h.id || h.id.length > maxId) return null;
  if (!isMime(h.mime) || !intIn(h.size, 1, MAX_IMAGE)) return null;
  if (!intIn(h.w, 1, MAX_ACCEPT_SIDE) || !intIn(h.h, 1, MAX_ACCEPT_SIDE)) return null;
  const ts = Number.isFinite(h.ts) ? Math.min(h.ts as number, Date.now()) : Date.now();
  return { t: 'img', id: h.id, mime: h.mime, size: h.size as number, w: h.w as number, h: h.h as number, ts };
}

// Los primeros bytes mandan, no la etiqueta: lo que dice ser PNG y no lo es, fuera.
export function sniffMime(b: Uint8Array): ImageMime | null {
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.length >= 8 && [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((x, i) => b[i] === x)) return 'image/png';
  const ascii = (from: number, to: number) => String.fromCharCode(...b.subarray(from, to));
  if (b.length >= 12 && ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') return 'image/webp';
  return null;
}

export function* chunksOf(bytes: Uint8Array, id: string): Generator<ImageChunk> {
  for (let i = 0, off = 0; off < bytes.length; i++, off += CHUNK) {
    yield { t: 'imgc', id, i, d: toB64(bytes.subarray(off, off + CHUNK)) };
  }
}

interface Pending {
  head: ImageHeader;
  parts: Uint8Array[];
  got: number;
  started: number;
}

export type AssembleResult = { done: false } | { done: true; head: ImageHeader; bytes: Uint8Array<ArrayBuffer> } | { error: string };

// Reensambla las imágenes de un peer. Cualquier incoherencia descarta esa imagen entera.
export class ImageAssembler {
  private pending = new Map<string, Pending>();
  private now: () => number;

  constructor(now: () => number = Date.now) {
    this.now = now;
  }

  begin(raw: unknown): boolean {
    this.expire();
    const head = cleanHeader(raw);
    if (!head || this.pending.has(head.id) || this.pending.size >= MAX_INFLIGHT) return false;
    this.pending.set(head.id, { head, parts: [], got: 0, started: this.now() });
    return true;
  }

  add(raw: unknown): AssembleResult {
    const c = raw as Partial<ImageChunk> | null;
    const p = typeof c?.id === 'string' ? this.pending.get(c.id) : undefined;
    if (!c || !p) return { error: 'trozo sin cabecera' };
    const fail = (error: string): AssembleResult => {
      this.pending.delete(p.head.id);
      return { error };
    };
    if (c.i !== p.parts.length || typeof c.d !== 'string' || c.d.length > Math.ceil(CHUNK / 3) * 4) return fail('trozo fuera de orden');
    let part: Uint8Array;
    try {
      part = fromB64(c.d);
    } catch {
      return fail('base64 inválido');
    }
    const last = c.i === chunkCount(p.head.size) - 1;
    if (part.length === 0 || part.length > CHUNK || (!last && part.length !== CHUNK) || p.got + part.length > p.head.size) return fail('tamaño que no cuadra');
    p.parts.push(part);
    p.got += part.length;
    if (!last) return { done: false };
    this.pending.delete(p.head.id);
    if (p.got !== p.head.size) return { error: 'imagen incompleta' };
    const bytes = new Uint8Array(p.head.size);
    let off = 0;
    for (const x of p.parts) {
      bytes.set(x, off);
      off += x.length;
    }
    if (sniffMime(bytes) !== p.head.mime) return { error: 'el contenido no es el formato anunciado' };
    return { done: true, head: p.head, bytes };
  }

  expire() {
    const now = this.now();
    for (const [id, p] of this.pending) if (now - p.started > IMAGE_TIMEOUT_MS) this.pending.delete(id);
  }

  clear() {
    this.pending.clear();
  }
}
