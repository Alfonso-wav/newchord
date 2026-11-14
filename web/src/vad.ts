// Corte de la voz en frases para Whisper: energía frente a un suelo de ruido que se adapta.
// Sin DOM ni modelo, para poder probarlo en node con señales sintéticas.

export const RATE = 16_000;
const FRAME = 480; // 30 ms
const START_FRAMES = 3; // 90 ms de voz seguida para empezar
const END_MS = 800; // silencio que cierra la frase
const PREROLL_MS = 300;
const MIN_SPEECH_MS = 400;
export const MAX_SEGMENT_MS = 20_000;
const MIN_LEVEL = 0.008;

export interface Segment {
  audio: Float32Array;
  startedAt: number; // reloj de quien llama, en ms
}

export class Segmenter {
  private floor = 0.003;
  private pre: Float32Array[] = [];
  private cur: Float32Array[] | null = null;
  private speechFrames = 0;
  private run = 0;
  private silence = 0;
  private startedAt = 0;
  private rest = new Float32Array(0);
  private clock = 0; // ms de audio recibido

  private onSegment: (s: Segment) => void;
  private origin: number;

  constructor(onSegment: (s: Segment) => void, origin = 0) {
    this.onSegment = onSegment;
    this.origin = origin;
  }

  push(samples: Float32Array) {
    let buf = samples;
    if (this.rest.length) {
      buf = new Float32Array(this.rest.length + samples.length);
      buf.set(this.rest);
      buf.set(samples, this.rest.length);
    }
    let off = 0;
    for (; off + FRAME <= buf.length; off += FRAME) this.frame(buf.slice(off, off + FRAME));
    this.rest = buf.slice(off);
  }

  // Tira lo que haya a medias (mientras suena la síntesis de voz, por ejemplo).
  reset() {
    this.cur = null;
    this.pre = [];
    this.run = 0;
  }

  // Corta lo que haya (al silenciar o apagar el dictado).
  flush() {
    if (this.cur) this.close();
    this.pre = [];
    this.run = 0;
  }

  private frame(f: Float32Array) {
    let sum = 0;
    for (const v of f) sum += v * v;
    const rms = Math.sqrt(sum / f.length);
    const ms = (FRAME / RATE) * 1000;
    this.clock += ms;
    const voiced = rms > Math.max(MIN_LEVEL, this.floor * 3);
    // El suelo baja rápido y sube despacio; con voz, mucho más despacio (un ruido nuevo y
    // constante tarda un par de minutos en dejar de contar como voz).
    const up = voiced ? 0.0001 : 0.001;
    this.floor = rms < this.floor ? this.floor * 0.9 + rms * 0.1 : this.floor * (1 - up) + rms * up;

    if (!this.cur) {
      this.pre.push(f);
      if (this.pre.length > PREROLL_MS / ms + START_FRAMES) this.pre.shift();
      this.run = voiced ? this.run + 1 : 0;
      if (this.run >= START_FRAMES) {
        this.cur = this.pre;
        this.pre = [];
        this.speechFrames = this.run;
        this.silence = 0;
        this.startedAt = this.origin + this.clock - this.cur.length * ms;
      }
      return;
    }
    this.cur.push(f);
    if (voiced) {
      this.speechFrames++;
      this.silence = 0;
    } else this.silence += ms;
    if (this.silence >= END_MS || this.cur.length * ms >= MAX_SEGMENT_MS) this.close();
  }

  private close() {
    const frames = this.cur!;
    this.cur = null;
    this.run = 0;
    const ms = (FRAME / RATE) * 1000;
    if (this.speechFrames * ms < MIN_SPEECH_MS) return;
    const audio = new Float32Array(frames.length * FRAME);
    frames.forEach((f, i) => audio.set(f, i * FRAME));
    this.onSegment({ audio, startedAt: this.startedAt });
  }
}

// Whisper rellena el silencio con frases de subtítulos con las que se entrenó. Fuera.
const JUNK = [
  /amara\.org/i,
  /subt[ií]tul/i,
  /gracias por ver/i,
  /suscr[ií]bete/i,
  /thanks? for watching/i,
  /^\s*[[(].*[\])]\s*$/, // [Música], (aplausos)
];

export function cleanTranscript(text: string): string {
  const t = text.replace(/\s+/g, ' ').trim();
  if (!/\p{L}/u.test(t)) return '';
  if (JUNK.some((r) => r.test(t))) return '';
  return t.slice(0, 1000);
}
