// Dictado: Whisper base en este navegador. Modelo y runtime los sirve el propio binario
// (scripts/stt-assets.mjs): ni Hugging Face ni ningún CDN se enteran de nada. El audio no sale
// de aquí; solo el texto, y lo manda la malla por el DataChannel cifrado.
import { env, pipeline, type AutomaticSpeechRecognitionPipeline } from '@huggingface/transformers';
import { RATE, Segmenter, cleanTranscript, type Segment } from './vad';

const MODEL = 'onnx-community/whisper-base';
const MAX_QUEUE = 3; // si se acumula más, lo viejo ya no interesa

env.allowRemoteModels = false;
env.allowLocalModels = true;
env.localModelPath = '/stt/models/';
env.useBrowserCache = true;
// Sin caché propia de transformers.js: en Firefox convertiría el runtime en un blob: que el CSP
// no deja importar.
env.useWasmCache = false;
const wasm = env.backends.onnx.wasm!;
// transformers.js apunta el .wasm a jsDelivr. Sin ruta, ONNX usa el que Vite deja junto al worker
// (lo encuentra por import.meta.url) y el código de arranque va dentro del propio paquete.
wasm.wasmPaths = undefined;
wasm.numThreads = 1; // sin aislamiento entre orígenes no hay SharedArrayBuffer
wasm.proxy = false;

export type SttIn = { type: 'init'; lang: string; port: MessagePort } | { type: 'hold'; on: boolean } | { type: 'flush' };
export type SttOut =
  | { type: 'progress'; pct: number }
  | { type: 'ready' }
  | { type: 'busy'; on: boolean }
  | { type: 'text'; text: string; startedAt: number }
  | { type: 'error'; message: string };

const post = (m: SttOut) => postMessage(m);
let asr: AutomaticSpeechRecognitionPipeline | null = null;
let lang = 'spanish';
let hold = false;
const queue: Segment[] = [];
let working = false;

// La hora sale del reloj de pared al cerrar la frase: el del audio se para mientras hay pausa.
const segmenter = new Segmenter((s) => {
  queue.push({ audio: s.audio, startedAt: Date.now() - (s.audio.length / RATE) * 1000 });
  while (queue.length > MAX_QUEUE) queue.shift();
  void drain();
});

async function drain() {
  if (working || !asr) return;
  working = true;
  post({ type: 'busy', on: true });
  try {
    while (queue.length) {
      const s = queue.shift()!;
      const out = await asr(s.audio, lang === 'auto' ? { task: 'transcribe' } : { language: lang, task: 'transcribe' });
      const text = cleanTranscript((Array.isArray(out) ? out[0] : out).text ?? '');
      if (text) post({ type: 'text', text, startedAt: s.startedAt });
    }
  } catch (e) {
    post({ type: 'error', message: (e as Error).message });
  } finally {
    working = false;
    post({ type: 'busy', on: false });
  }
}

async function init(m: Extract<SttIn, { type: 'init' }>) {
  lang = m.lang;
  m.port.onmessage = (e: MessageEvent<Float32Array>) => {
    if (hold) return;
    segmenter.push(e.data);
  };
  try {
    asr = await pipeline('automatic-speech-recognition', MODEL, {
      device: 'wasm',
      dtype: 'q8',
      progress_callback: (p) => {
        if (p.status === 'progress_total') post({ type: 'progress', pct: Math.round(p.progress) });
      },
    });
    post({ type: 'ready' });
    void drain();
  } catch (e) {
    post({ type: 'error', message: (e as Error).message });
  }
}

onmessage = (e: MessageEvent<SttIn>) => {
  const m = e.data;
  if (m.type === 'init') void init(m);
  else if (m.type === 'hold') {
    hold = m.on;
    if (hold) segmenter.reset();
  } else if (m.type === 'flush') segmenter.flush();
};
