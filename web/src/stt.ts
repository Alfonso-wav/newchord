// Dictado del micro propio: worklet → worker de Whisper → texto. Ver stt.worker.ts.
import captureURL from './worklets/capture.js?url';
import workerURL from './stt.worker.ts?worker&url';
import { audioCtx } from './hooks';
import { scriptURL } from './tt';
import type { SttIn, SttOut } from './stt.worker';

export type SttState = { phase: 'off' } | { phase: 'loading'; pct: number } | { phase: 'on'; busy: boolean } | { phase: 'error'; message: string };

export const STT_LANGS: [string, string][] = [
  ['spanish', 'español'],
  ['english', 'inglés'],
  ['catalan', 'catalán'],
  ['auto', 'detectar'],
];

const worklets = new WeakSet<AudioContext>();

export class Dictation {
  state: SttState = { phase: 'off' };
  private worker: Worker | null = null;
  private node: AudioWorkletNode | null = null;
  private src: MediaStreamAudioSourceNode | null = null;
  private sink: GainNode | null = null;
  private stream: MediaStream | null = null;

  constructor(
    private onText: (text: string, startedAt: number) => void,
    private onState: () => void,
  ) {}

  get running() {
    return this.state.phase === 'loading' || this.state.phase === 'on';
  }

  async start(stream: MediaStream, lang: string) {
    this.stop();
    this.set({ phase: 'loading', pct: 0 });
    try {
      const ctx = audioCtx();
      if (!worklets.has(ctx)) {
        await ctx.audioWorklet.addModule(scriptURL(captureURL));
        worklets.add(ctx);
      }
      const worker = new Worker(scriptURL(workerURL), { type: 'module', name: 'dictado' });
      this.worker = worker;
      worker.onmessage = (e: MessageEvent<SttOut>) => this.onWorker(e.data);
      worker.onerror = (e) => this.set({ phase: 'error', message: e.message || 'el dictado se cerró' });
      const ch = new MessageChannel();
      this.node = new AudioWorkletNode(ctx, 'cryptopo-capture', { numberOfInputs: 1, numberOfOutputs: 1, channelCount: 1, channelCountMode: 'explicit' });
      this.node.port.postMessage({ port: ch.port1 }, [ch.port1]);
      worker.postMessage({ type: 'init', lang, port: ch.port2 } satisfies SttIn, [ch.port2]);
      this.attach(stream);
      // Sin salida conectada algunos motores no procesan el nodo: va a un destino mudo.
      this.sink = ctx.createGain();
      this.sink.gain.value = 0;
      this.node.connect(this.sink).connect(ctx.destination);
    } catch (e) {
      this.stop();
      this.set({ phase: 'error', message: (e as Error).message });
    }
  }

  // El micro puede cambiar (otro dispositivo, reanudar): se reengancha sin recargar el modelo.
  attach(stream: MediaStream) {
    if (!this.node || stream === this.stream) return;
    this.src?.disconnect();
    this.stream = stream;
    this.src = audioCtx().createMediaStreamSource(stream);
    this.src.connect(this.node);
  }

  // Mientras habla la síntesis de voz no se escucha: se dictaría a sí misma.
  hold(on: boolean) {
    this.worker?.postMessage({ type: 'hold', on } satisfies SttIn);
  }

  flush() {
    this.worker?.postMessage({ type: 'flush' } satisfies SttIn);
  }

  stop() {
    this.src?.disconnect();
    this.node?.disconnect();
    this.sink?.disconnect();
    this.worker?.terminate();
    this.src = this.node = this.sink = this.worker = this.stream = null;
    if (this.state.phase !== 'error') this.set({ phase: 'off' });
  }

  private onWorker(m: SttOut) {
    if (m.type === 'progress' && this.state.phase === 'loading') this.set({ phase: 'loading', pct: m.pct });
    else if (m.type === 'ready') this.set({ phase: 'on', busy: false });
    else if (m.type === 'busy' && this.state.phase === 'on') this.set({ phase: 'on', busy: m.on });
    else if (m.type === 'text') this.onText(m.text, m.startedAt);
    else if (m.type === 'error') {
      this.stop();
      this.set({ phase: 'error', message: m.message });
    }
  }

  private set(s: SttState) {
    this.state = s;
    this.onState();
  }
}
