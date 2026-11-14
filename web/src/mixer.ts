// Mesa de mezclas: estado de faders y medidores de nivel.
//
// Lo que se oye sigue saliendo por <audio>, con su volumen: así la cancelación de eco del
// navegador tiene la referencia de lo que suena. Web Audio solo mide, salvo en el micro
// propio, donde una ganancia antes de enviar deja subir o bajar lo que oyen los demás.
// Por eso los faders de recepción llegan a 0 dB y el de envío a +12 dB.

import { useSyncExternalStore } from 'react';
import { audioCtx } from './hooks';
import { captureMic } from './media';
import type { Mesh, SourceKind } from './mesh';

export const FLOOR_DB = -60; // abajo del todo: silencio
export const RECV_MAX_DB = 0;
export const SEND_MAX_DB = 12;

export const dbToGain = (db: number) => (db <= FLOOR_DB ? 0 : 10 ** (db / 20));
export const gainToDb = (g: number) => (g <= 0 ? -Infinity : 20 * Math.log10(g));
export const fmtDb = (db: number) => (db <= FLOOR_DB || !Number.isFinite(db) ? '-∞' : (db > 0 ? '+' : '') + db.toFixed(1));

export interface Fader {
  db: number;
  mute: boolean;
}

interface MixState {
  master: Fader;
  send: Fader; // ganancia del micro propio antes de enviarlo
  peers: Record<string, Fader>; // por clave de dispositivo: sobrevive a cambios de nombre
  sources: Record<string, Fader>; // `${peer}:${kind}`
}

const KEY = 'newchord.mix';
const UNITY: Fader = { db: 0, mute: false };
const MAX_ENTRIES = 200;

function cleanFader(f: unknown, max: number): Fader {
  const x = f as Partial<Fader> | null;
  const db = Number(x?.db);
  return { db: Number.isFinite(db) ? Math.min(max, Math.max(FLOOR_DB, db)) : 0, mute: x?.mute === true };
}

function cleanMap(m: unknown): Record<string, Fader> {
  const out: Record<string, Fader> = {};
  for (const [k, v] of Object.entries((m as Record<string, unknown>) ?? {}).slice(-MAX_ENTRIES)) out[String(k).slice(0, 80)] = cleanFader(v, RECV_MAX_DB);
  return out;
}

function load(): MixState {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? '{}');
    return { master: cleanFader(raw.master, RECV_MAX_DB), send: cleanFader(raw.send, SEND_MAX_DB), peers: cleanMap(raw.peers), sources: cleanMap(raw.sources) };
  } catch {
    return { master: { ...UNITY }, send: { ...UNITY }, peers: {}, sources: {} };
  }
}

let state = load();
let version = 0;
const listeners = new Set<() => void>();
// El solo no se guarda: uno olvidado dejaría mudo a todo el mundo en la siguiente llamada.
const solos = new Set<string>();

function commit() {
  localStorage.setItem(KEY, JSON.stringify(state));
  version++;
  for (const f of listeners) f();
}

export const sourceKey = (peer: string, kind: SourceKind) => `${peer}:${kind}`;

export const mix = {
  master: () => state.master,
  send: () => state.send,
  peer: (key: string) => state.peers[key] ?? UNITY,
  source: (peer: string, kind: SourceKind) => state.sources[sourceKey(peer, kind)] ?? UNITY,
  soloed: (key: string) => solos.has(key),

  setMaster(f: Partial<Fader>) {
    state = { ...state, master: cleanFader({ ...state.master, ...f }, RECV_MAX_DB) };
    commit();
  },
  setSend(f: Partial<Fader>) {
    state = { ...state, send: cleanFader({ ...state.send, ...f }, SEND_MAX_DB) };
    commit();
  },
  setPeer(key: string, f: Partial<Fader>) {
    state = { ...state, peers: { ...state.peers, [key]: cleanFader({ ...mix.peer(key), ...f }, RECV_MAX_DB) } };
    commit();
  },
  setSource(peer: string, kind: SourceKind, f: Partial<Fader>) {
    const k = sourceKey(peer, kind);
    state = { ...state, sources: { ...state.sources, [k]: cleanFader({ ...mix.source(peer, kind), ...f }, RECV_MAX_DB) } };
    commit();
  },
  toggleSolo(key: string) {
    if (!solos.delete(key)) solos.add(key);
    commit();
  },

  // Ganancia lineal de la fuente, hasta el master. `present` son las claves de quienes están
  // ahora en la sala: un solo de alguien que ya se fue no silencia a nadie.
  gain(peer: string, kind: SourceKind, present: string[]) {
    const anySolo = present.some((k) => solos.has(k));
    if (anySolo && !solos.has(peer)) return 0;
    const parts = [state.master, mix.peer(peer), mix.source(peer, kind)];
    if (parts.some((f) => f.mute)) return 0;
    return parts.reduce((g, f) => g * dbToGain(f.db), 1);
  },
};

export function useMix() {
  useSyncExternalStore(
    (fn) => {
      listeners.add(fn);
      return () => void listeners.delete(fn);
    },
    () => version,
  );
  return mix;
}

// ---- medición ----

const taps = new WeakMap<MediaStreamTrack, AnalyserNode>();

// Un analizador por pista, compartido por todos los medidores que la miran.
function tap(track: MediaStreamTrack): AnalyserNode | null {
  let an = taps.get(track);
  if (an) return an;
  if (track.readyState === 'ended') return null;
  try {
    const c = audioCtx();
    const src = c.createMediaStreamSource(new MediaStream([track]));
    an = c.createAnalyser();
    an.fftSize = 1024;
    src.connect(an);
    track.addEventListener('ended', () => src.disconnect(), { once: true });
    taps.set(track, an);
    return an;
  } catch {
    return null;
  }
}

const buf = new Float32Array(1024);

// Nivel de un conjunto de pistas, cada una con su ganancia: RMS y pico, en lineal.
export function measure(inputs: { stream: MediaStream; gain: number }[]) {
  let sumSq = 0;
  let peak = 0;
  for (const { stream, gain } of inputs) {
    if (gain <= 0) continue;
    for (const t of stream.getAudioTracks()) {
      if (!t.enabled) continue;
      const an = tap(t);
      if (!an) continue;
      an.getFloatTimeDomainData(buf);
      let s = 0;
      let p = 0;
      for (const v of buf) {
        s += v * v;
        const a = Math.abs(v);
        if (a > p) p = a;
      }
      sumSq += (s / buf.length) * gain * gain;
      peak = Math.max(peak, p * gain);
    }
  }
  return { rms: Math.sqrt(sumSq), peak };
}

// ---- micro propio con ganancia de envío ----

export interface MicChain {
  stream: MediaStream;
  release: () => void;
  processed: boolean;
}

let sendNode: GainNode | null = null;
listeners.add(() => {
  if (sendNode) sendNode.gain.value = state.send.mute ? 0 : dbToGain(state.send.db);
});

// Pasa el micro por una ganancia antes de enviarlo. Si el contexto de audio no arranca
// (sin gesto del usuario), se envía tal cual: mejor sin fader que mudo.
export async function micChain(raw: MediaStream, onEnded: () => void): Promise<MicChain> {
  const stopRaw = () => raw.getTracks().forEach((t) => t.stop());
  for (const t of raw.getAudioTracks()) t.addEventListener('ended', onEnded, { once: true });
  const c = audioCtx();
  if (c.state !== 'running') await Promise.race([c.resume(), new Promise((r) => setTimeout(r, 500))]);
  if (c.state !== 'running') return { stream: raw, release: stopRaw, processed: false };
  const src = c.createMediaStreamSource(raw);
  const gain = c.createGain();
  const dest = c.createMediaStreamDestination();
  dest.channelCount = 1;
  gain.gain.value = state.send.mute ? 0 : dbToGain(state.send.db);
  src.connect(gain).connect(dest);
  sendNode = gain;
  return {
    stream: dest.stream,
    processed: true,
    release() {
      src.disconnect();
      gain.disconnect();
      if (sendNode === gain) sendNode = null;
      stopRaw();
    },
  };
}

export const micProcessed = () => sendNode !== null;

// Captura el micro y lo publica a través de la ganancia de envío.
export async function startMic(m: Mesh) {
  const raw = await captureMic();
  let stream: MediaStream | null = null;
  const chain = await micChain(raw, () => {
    if (stream && m.local.get('mic')?.stream === stream) m.removeSource('mic');
  });
  stream = chain.stream;
  m.addSource('mic', chain.stream, { videoBitrate: 0, audioBitrate: 96_000 }, chain.release);
}

// Clave estable de un peer para sus ajustes: la de su dispositivo cuando ya la demostró.
export const peerKey = (p: { keyTag: string; id: string }) => p.keyTag || p.id;
