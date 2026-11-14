// Captura de fuentes y ajustes de codificación para exprimir la calidad.

export type Hint = '' | 'detail' | 'text' | 'motion';

export interface EncodeOpts {
  videoBitrate: number; // bps
  audioBitrate: number; // bps
  maxFramerate?: number;
  codec?: string; // mimeType, p.ej. 'video/AV1'; '' = automático
  hint?: Hint;
}

export interface ShareSettings {
  res: 'native' | '2160' | '1440' | '1080' | '720';
  fps: number;
  mbps: number;
  codec: string;
  hint: Hint;
  audio: boolean;
}

export const defaultShare: ShareSettings = {
  res: 'native',
  fps: 60,
  mbps: 20,
  codec: '',
  hint: 'detail',
  audio: true,
};

const RES: Record<string, [number, number]> = {
  '2160': [3840, 2160],
  '1440': [2560, 1440],
  '1080': [1920, 1080],
  '720': [1280, 720],
};

export function captureScreen(s: ShareSettings): Promise<MediaStream> {
  const video: MediaTrackConstraints = { frameRate: { ideal: s.fps, max: s.fps } };
  if (s.res !== 'native') {
    const [w, h] = RES[s.res];
    video.width = { ideal: w, max: w };
    video.height = { ideal: h, max: h };
  }
  // Sin procesado de voz: el audio de sistema/pestaña tiene que llegar tal cual.
  const audio = s.audio
    ? { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 2 }
    : false;
  return navigator.mediaDevices.getDisplayMedia({
    video,
    audio,
    selfBrowserSurface: 'exclude',
    systemAudio: 'include',
    surfaceSwitching: 'include',
  } as DisplayMediaStreamOptions);
}

export function captureCamera(): Promise<MediaStream> {
  return navigator.mediaDevices.getUserMedia({
    video: { width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 30 } },
  });
}

export function captureMic(): Promise<MediaStream> {
  return navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
  });
}

export function captureElement(el: HTMLVideoElement): MediaStream {
  const v = el as HTMLVideoElement & { captureStream?: () => MediaStream; mozCaptureStream?: () => MediaStream };
  const fn = v.captureStream ?? v.mozCaptureStream;
  if (!fn) throw new Error('Este navegador no soporta captureStream()');
  return fn.call(v);
}

const AUX = /^video\/(rtx|red|ulpfec|flexfec)/i;

export function videoCodecs(): string[] {
  const caps = RTCRtpReceiver.getCapabilities('video')?.codecs ?? [];
  return [...new Set(caps.map((c) => c.mimeType).filter((m) => !AUX.test(m)))];
}

// Pone el codec elegido primero en la oferta de este transceiver.
// Hay que llamarlo justo tras addTrack, antes de que corra la negociación.
export function applyCodecPreference(pc: RTCPeerConnection, sender: RTCRtpSender, mime?: string) {
  if (!mime) return;
  const t = pc.getTransceivers().find((t) => t.sender === sender);
  const caps = RTCRtpReceiver.getCapabilities('video')?.codecs;
  if (!t || !caps || !('setCodecPreferences' in t)) return;
  const first = caps.filter((c) => c.mimeType.toLowerCase() === mime.toLowerCase());
  if (!first.length) return;
  try {
    t.setCodecPreferences([...first, ...caps.filter((c) => !first.includes(c))]);
  } catch (e) {
    console.warn('setCodecPreferences', e);
  }
}

export async function applyEncoding(sender: RTCRtpSender, o: EncodeOpts) {
  const p = sender.getParameters() as RTCRtpSendParameters & { degradationPreference?: string };
  // Sin encodings aún (antes de negociar) no se puede tocar; se reaplica al conectar.
  if (!p.encodings?.length) return;
  const e = p.encodings[0] as RTCRtpEncodingParameters & { priority?: string; networkPriority?: string };
  e.priority = 'high';
  e.networkPriority = 'high';
  if (sender.track?.kind === 'video') {
    e.maxBitrate = o.videoBitrate;
    e.scaleResolutionDownBy = 1;
    if (o.maxFramerate) e.maxFramerate = o.maxFramerate;
    p.degradationPreference =
      o.hint === 'motion' ? 'maintain-framerate' : o.hint ? 'maintain-resolution' : 'balanced';
  } else {
    e.maxBitrate = o.audioBitrate;
  }
  try {
    await sender.setParameters(p);
  } catch {
    delete p.degradationPreference;
    try {
      await sender.setParameters(p);
    } catch (err) {
      console.warn('setParameters', err);
    }
  }
}

// Chrome arranca los envíos de vídeo a ~300 kbps y sube despacio; con
// x-google-start-bitrate el 4K se ve nítido en segundos. Opus en estéreo y a
// tope para que el audio de pelis/juegos no suene a llamada. Se aplica a la
// descripción remota porque esos parámetros gobiernan lo que *enviamos*.
const START_KBPS = 8000;
const MAX_KBPS = 100000;
const VIDEO_CODECS = /^(vp8|vp9|av1|h264|h265)$/;

function extraParams(kind: string, codec = ''): Record<string, string> | null {
  if (kind === 'video' && VIDEO_CODECS.test(codec))
    return { 'x-google-start-bitrate': String(START_KBPS), 'x-google-max-bitrate': String(MAX_KBPS) };
  if (kind === 'audio' && codec === 'opus')
    return { stereo: '1', 'sprop-stereo': '1', maxaveragebitrate: '510000' };
  return null;
}

function mergeParams(existing: string, extra: Record<string, string>) {
  const kv = existing.split(';').filter(Boolean).map((p) => p.split('='));
  const map = new Map(kv.map(([k, v]) => [k.trim(), v ?? '']));
  for (const [k, v] of Object.entries(extra)) map.set(k, v);
  return [...map].map(([k, v]) => (v === '' ? k : `${k}=${v}`)).join(';');
}

// Quién cede ante ofertas cruzadas. Entre navegadores distintos cede siempre Firefox:
// Chromium no puede ceder ante él, ni con rollback explícito, porque conserva los ids de
// extensión RTP de su oferta y rechaza los de Firefox (H2 en docs/HALLAZGOS.md).
// Ambos lados llegan a la misma conclusión: cada oferta revela su navegador.
export function yieldsInGlare(localUserAgent: string, remoteSdp: string, polite: boolean): boolean {
  const localFirefox = /\bFirefox\//.test(localUserAgent);
  const remoteFirefox = /^o=mozilla/m.test(remoteSdp);
  return localFirefox === remoteFirefox ? polite : localFirefox;
}

export function mungeRemoteSdp(sdp: string): string {
  return sdp
    .split(/\r\n(?=m=)/)
    .map((sec) => {
      const kind = sec.startsWith('m=video') ? 'video' : sec.startsWith('m=audio') ? 'audio' : '';
      if (!kind) return sec;
      const lines = sec.split('\r\n');
      const names = new Map<string, string>();
      for (const l of lines) {
        const m = /^a=rtpmap:(\d+) ([^/]+)/.exec(l);
        if (m) names.set(m[1], m[2].toLowerCase());
      }
      const withFmtp = new Set<string>();
      const out: string[] = [];
      for (const l of lines) {
        const f = /^a=fmtp:(\d+) (.*)$/.exec(l);
        if (f) {
          withFmtp.add(f[1]);
          const extra = extraParams(kind, names.get(f[1]));
          out.push(extra ? `a=fmtp:${f[1]} ${mergeParams(f[2], extra)}` : l);
        } else out.push(l);
      }
      // Codecs sin línea fmtp (p.ej. VP8): se la añadimos tras su rtpmap.
      const final: string[] = [];
      for (const l of out) {
        final.push(l);
        const m = /^a=rtpmap:(\d+) /.exec(l);
        if (m && !withFmtp.has(m[1])) {
          const extra = extraParams(kind, names.get(m[1]));
          if (extra) final.push(`a=fmtp:${m[1]} ${mergeParams('', extra)}`);
        }
      }
      return final.join('\r\n');
    })
    .join('\r\n');
}
