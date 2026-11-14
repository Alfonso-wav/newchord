import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { Archive } from './archive';
import { Mesh } from './mesh';
import { Signaling, wsUrl } from './signaling';
import { Voice } from './voice';

export const mesh = new Mesh(new Signaling(wsUrl()));
mesh.archive = new Archive();
export const voice = new Voice(mesh);

export function useMesh() {
  useSyncExternalStore(mesh.subscribe, mesh.getVersion);
  return mesh;
}

export function useVoice() {
  useSyncExternalStore(voice.subscribe, voice.getVersion);
  return voice;
}

export function useLocalStorage<T>(key: string, initial: T) {
  const [v, setV] = useState<T>(() => {
    try {
      const raw = localStorage.getItem(key);
      return raw ? { ...initial, ...JSON.parse(raw) } : initial;
    } catch {
      return initial;
    }
  });
  useEffect(() => {
    localStorage.setItem(key, JSON.stringify(v));
  }, [key, v]);
  return [v, setV] as const;
}

// ---- audio ----

let ctx: AudioContext | null = null;
export function audioCtx() {
  ctx ??= new AudioContext();
  if (ctx.state === 'suspended') void ctx.resume();
  return ctx;
}

export function useSpeaking(stream?: MediaStream) {
  const [on, setOn] = useState(false);
  useEffect(() => {
    if (!stream || !stream.getAudioTracks().length) return;
    const c = audioCtx();
    const src = c.createMediaStreamSource(stream);
    const an = c.createAnalyser();
    an.fftSize = 512;
    src.connect(an);
    const buf = new Float32Array(an.fftSize);
    let hold = 0;
    const id = setInterval(() => {
      an.getFloatTimeDomainData(buf);
      let sum = 0;
      for (const v of buf) sum += v * v;
      if (Math.sqrt(sum / buf.length) > 0.015) hold = 3;
      else if (hold > 0) hold--;
      setOn(hold > 0);
    }, 100);
    return () => {
      clearInterval(id);
      src.disconnect();
      setOn(false);
    };
  }, [stream]);
  return on;
}

// ---- stats ----

export interface VStat {
  peer?: string;
  w?: number;
  h?: number;
  fps?: number;
  kbps?: number;
  codec?: string;
  impl?: string;
  limit?: string;
}

type Prev = Map<string, { bytes: number; ts: number }>;

function parse(report: RTCStatsReport, type: 'inbound-rtp' | 'outbound-rtp', prev: Prev, key: string): VStat | null {
  let rtp: Record<string, any> | undefined;
  report.forEach((s) => {
    if (s.type === type && s.kind === 'video') rtp = s;
  });
  if (!rtp) return null;
  const bytes = type === 'inbound-rtp' ? rtp.bytesReceived : rtp.bytesSent;
  const last = prev.get(key);
  prev.set(key, { bytes, ts: rtp.timestamp });
  const codec = rtp.codecId ? report.get(rtp.codecId)?.mimeType?.replace('video/', '') : undefined;
  return {
    w: rtp.frameWidth,
    h: rtp.frameHeight,
    fps: rtp.framesPerSecond,
    kbps: last && rtp.timestamp > last.ts ? ((bytes - last.bytes) * 8) / (rtp.timestamp - last.ts) : undefined,
    codec,
    impl: rtp.decoderImplementation ?? rtp.encoderImplementation,
    limit: rtp.qualityLimitationReason !== 'none' ? rtp.qualityLimitationReason : undefined,
  };
}

export function useInboundStats(peerId: string, track: MediaStreamTrack | undefined, enabled: boolean) {
  const [stat, setStat] = useState<VStat | null>(null);
  const prev = useRef<Prev>(new Map());
  useEffect(() => {
    if (!enabled || !track) return;
    const id = setInterval(async () => {
      const r = mesh.receiverFor(peerId, track);
      if (r) setStat(parse(await r.getStats(), 'inbound-rtp', prev.current, 'in'));
    }, 1000);
    return () => clearInterval(id);
  }, [peerId, track, enabled]);
  return stat;
}

export function useOutboundStats(kind: 'camera' | 'screen' | 'file', enabled: boolean) {
  const [stats, setStats] = useState<VStat[]>([]);
  const prev = useRef<Prev>(new Map());
  useEffect(() => {
    if (!enabled) return;
    const id = setInterval(async () => {
      const out: VStat[] = [];
      for (const { peer, sender } of mesh.sendersFor(kind)) {
        const s = parse(await sender.getStats(), 'outbound-rtp', prev.current, peer);
        if (s) out.push({ ...s, peer });
      }
      setStats(out);
    }, 1000);
    return () => clearInterval(id);
  }, [kind, enabled]);
  return stats;
}

export function fmtStat(s: VStat) {
  const parts = [
    s.w && s.h ? `${s.w}×${s.h}` : '',
    s.fps ? `${Math.round(s.fps)}fps` : '',
    s.kbps !== undefined ? `${(s.kbps / 1000).toFixed(1)} Mbps` : '',
    s.codec ?? '',
    s.impl ?? '',
    s.limit ? `⚠ ${s.limit}` : '',
  ];
  return parts.filter(Boolean).join(' · ');
}

// Acceso desde la consola para depurar: window.cryptopo.peerViews(), etc.
(window as unknown as { cryptopo: Mesh }).cryptopo = mesh;
(window as unknown as { cryptopoVoice: Voice }).cryptopoVoice = voice;
