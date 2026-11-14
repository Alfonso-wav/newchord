// Puente con la app Android (android/). El WebView no tiene getDisplayMedia: la app captura
// la pantalla con MediaProjection, la codifica en H.264 y manda los NAL por un MessagePort.
// Aquí se decodifican con WebCodecs y se convierten en una pista normal, así que el mesh,
// el cifrado y quien mira no notan la diferencia.

import { avcCodecString, parsePacket, PACKET_AUDIO, PACKET_VIDEO } from './avc';
import type { ShareSettings } from './media';

// La app añade esto al user agent: sirve para elegir valores por defecto antes del enlace.
export const inAndroidApp = /\bcryptopo-android\/\d/.test(navigator.userAgent);

const HELLO = 'cryptopo-android:1';

// No están en lib.dom: Chromium los tiene, también en el WebView de Android.
interface TrackGenerator extends MediaStreamTrack {
  writable: WritableStream<VideoFrame | AudioData>;
}
type TrackGeneratorCtor = new (init: { kind: 'video' | 'audio' }) => TrackGenerator;
const Generator = (globalThis as unknown as { MediaStreamTrackGenerator?: TrackGeneratorCtor }).MediaStreamTrackGenerator;

type NativeMsg = { t: string; [k: string]: unknown };

let port: MessagePort | null = null;
const waiters = new Set<(m: NativeMsg) => boolean>();
let pipe: ScreenPipe | null = null;

if (inAndroidApp) {
  window.addEventListener('message', (e) => {
    if (e.data !== HELLO || !e.ports[0]) return;
    port?.close();
    port = e.ports[0];
    port.onmessage = (ev) => onNative(ev.data);
  });
}

function send(m: NativeMsg) {
  port?.postMessage(JSON.stringify(m));
}

function onNative(data: unknown) {
  if (data instanceof ArrayBuffer) return pipe?.packet(data);
  if (typeof data !== 'string') return;
  // Sin soporte de ArrayBuffer en el puerto, la app manda el binario en base64 tras una 'b'.
  if (data.startsWith('b')) {
    const bin = atob(data.slice(1));
    const buf = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
    return pipe?.packet(buf.buffer);
  }
  let m: NativeMsg;
  try {
    m = JSON.parse(data);
  } catch {
    return;
  }
  for (const w of [...waiters]) if (w(m)) waiters.delete(w);
  if (m.t === 'screen-ended') pipe?.end();
  if (m.t === 'log') console.info('[android]', m.msg);
}

function waitFor(pred: (m: NativeMsg) => boolean, ms: number): Promise<NativeMsg> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      waiters.delete(w);
      reject(new Error('la app no responde'));
    }, ms);
    const w = (m: NativeMsg) => {
      if (!pred(m)) return false;
      clearTimeout(timer);
      resolve(m);
      return true;
    };
    waiters.add(w);
  });
}

// En la app se sube por datos móviles y a cada persona por separado (malla):
// 1080p30 a 4 Mbps aguanta 5 copias en un 4G decente.
export const androidShare: ShareSettings = { res: '1080', fps: 30, mbps: 4, codec: '', hint: 'motion', audio: true };

const LONG_SIDE: Record<ShareSettings['res'], number> = { native: 0, '2160': 3840, '1440': 2560, '1080': 1920, '720': 1280 };

export async function captureAndroidScreen(s: ShareSettings): Promise<MediaStream> {
  if (!port) throw new Error('la app aún no ha enlazado con la página; recarga');
  if (typeof VideoDecoder === 'undefined') throw new Error('este WebView no tiene WebCodecs; actualiza Android System WebView');
  pipe?.end();
  // El tramo app → página no sale del móvil: bitrate de sobra para que la segunda
  // codificación (la de WebRTC) parta de una imagen limpia.
  const kbps = Math.min(40_000, Math.max(8_000, s.mbps * 2_000));
  const reply = waitFor((m) => m.t === 'screen-started' || m.t === 'screen-error', 120_000);
  send({ t: 'screen-start', maxLong: LONG_SIDE[s.res], fps: s.fps, kbps, audio: s.audio });
  const m = await reply;
  if (m.t === 'screen-error') throw new DOMException(String(m.msg ?? 'cancelado'), String(m.name ?? 'NotAllowedError'));
  pipe = new ScreenPipe(s.fps, m.audio === true);
  return pipe.stream;
}

class ScreenPipe {
  readonly stream = new MediaStream();
  private decoder: VideoDecoder | null = null;
  private codec = '';
  private waitingKey = true;
  private ended = false;
  private videoWriter: WritableStreamDefaultWriter<VideoFrame> | null = null;
  private audioWriter: WritableStreamDefaultWriter<AudioData> | null = null;
  private canvas: HTMLCanvasElement | null = null;
  private ctx: CanvasRenderingContext2D | null = null;

  constructor(fps: number, audio: boolean) {
    if (Generator) {
      const v = new Generator({ kind: 'video' });
      this.videoWriter = v.writable.getWriter() as WritableStreamDefaultWriter<VideoFrame>;
      this.adopt(v);
      if (audio) {
        const a = new Generator({ kind: 'audio' });
        this.audioWriter = a.writable.getWriter() as WritableStreamDefaultWriter<AudioData>;
        this.adopt(a);
      }
    } else {
      // Sin generador de pistas: lienzo + captureStream. Sin audio en este camino.
      this.canvas = document.createElement('canvas');
      this.ctx = this.canvas.getContext('2d');
      for (const t of this.canvas.captureStream(fps).getTracks()) this.adopt(t);
    }
    this.newDecoder();
  }

  // Parar la pista desde el mesh (cortar o reanudar) tiene que parar también la captura.
  private adopt(t: MediaStreamTrack) {
    const stop = t.stop.bind(t);
    t.stop = () => {
      stop();
      this.end(false);
    };
    this.stream.addTrack(t);
  }

  private newDecoder() {
    if (this.decoder && this.decoder.state !== 'closed') this.decoder.close();
    this.codec = '';
    this.waitingKey = true;
    this.decoder = new VideoDecoder({
      output: (f) => this.frame(f),
      error: (e) => {
        console.warn('[android] decoder', e);
        if (this.ended) return;
        this.newDecoder();
        send({ t: 'keyframe' });
      },
    });
  }

  private frame(f: VideoFrame) {
    if (this.ended) return f.close();
    if (this.videoWriter) {
      // Si la pista no da abasto se descarta: mejor saltar un fotograma que acumular retraso.
      if ((this.videoWriter.desiredSize ?? 1) <= 0) return f.close();
      this.videoWriter.write(f).catch(() => f.close());
      return;
    }
    const c = this.canvas!;
    if (c.width !== f.displayWidth || c.height !== f.displayHeight) {
      c.width = f.displayWidth;
      c.height = f.displayHeight;
    }
    this.ctx?.drawImage(f, 0, 0);
    f.close();
  }

  packet(buf: ArrayBuffer) {
    if (this.ended) return;
    const p = parsePacket(buf);
    if (!p) return;
    if (p.type === PACKET_VIDEO) this.video(p.key, p.timestamp, p.data);
    else if (p.type === PACKET_AUDIO) this.audio(p.timestamp, p.data);
  }

  private video(key: boolean, timestamp: number, data: Uint8Array<ArrayBuffer>) {
    const dec = this.decoder!;
    if (key) {
      // Cada clave trae su SPS: si cambia (giro de pantalla, otro tamaño) se reconfigura.
      const codec = avcCodecString(data);
      if (codec && codec !== this.codec) {
        dec.configure({ codec, optimizeForLatency: true, hardwareAcceleration: 'prefer-hardware' });
        this.codec = codec;
      }
      if (this.codec) this.waitingKey = false;
    }
    if (this.waitingKey) return;
    try {
      dec.decode(new EncodedVideoChunk({ type: key ? 'key' : 'delta', timestamp, data }));
    } catch (e) {
      console.warn('[android] decode', e);
      this.newDecoder();
      send({ t: 'keyframe' });
    }
  }

  private audio(timestamp: number, data: Uint8Array<ArrayBuffer>) {
    const w = this.audioWriter;
    if (!w || (w.desiredSize ?? 1) <= 0) return;
    // PCM 16 bits, estéreo intercalado, 48 kHz (ScreenCapture.kt).
    const a = new AudioData({ format: 's16', sampleRate: 48_000, numberOfChannels: 2, numberOfFrames: data.byteLength / 4, timestamp, data });
    w.write(a).catch(() => a.close());
  }

  // fromNative=false cuando para la página: entonces hay que avisar a la app, no al mesh.
  end(fromNative = true) {
    if (this.ended) return;
    this.ended = true;
    if (pipe === this) pipe = null;
    if (!fromNative) send({ t: 'screen-stop' });
    if (this.decoder && this.decoder.state !== 'closed') this.decoder.close();
    void this.videoWriter?.close().catch(() => {});
    void this.audioWriter?.close().catch(() => {});
    if (fromNative) {
      // La app cortó (notificación, sistema): el mesh se entera por 'ended', como en escritorio.
      for (const t of this.stream.getTracks()) {
        t.stop();
        t.dispatchEvent(new Event('ended'));
      }
    }
  }
}
