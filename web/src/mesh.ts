import type { Envelope } from './e2e';
import type { RoomInfo, ServerMsg, Signaling, SignalData } from './signaling';
import { applyCodecPreference, applyEncoding, mungeRemoteSdp, yieldsInGlare, type EncodeOpts } from './media';
import { ImageAssembler, chunksOf, type ImageChunk, type ImageHeader, type ImageMime } from './images';
import { decodedSize, prepareImage } from './imageprep';
import type { Archive, ArchiveRow } from './archive';
import {
  authProof, deleteKey, deriveKeys, deriveMaster, dtlsFingerprints, evaluateTrust, keyTag, loadIdentity, loadKey, loadTrust,
  markVerified, open, openInvite, parseInvite, safeName, safeText, safetyNumber, saveKey, seal, signBinding, verifyBinding,
  type Identity, type RoomKeys, type TrustState,
} from './e2e';

export type SourceKind = 'mic' | 'camera' | 'screen' | 'file';

export interface LocalSource {
  kind: SourceKind;
  stream: MediaStream;
  opts: EncodeOpts;
  paused?: boolean; // el navegador terminó la captura; se reanuda con un clic
  release?: () => void; // suelta lo que haya detrás del stream (p. ej. la cadena de ganancia del micro)
}

export type ChatKind = 'chat' | 'image' | 'stt' | 'tts';
const TEXT_KINDS: ChatKind[] = ['chat', 'stt', 'tts'];

export interface ChatImage {
  url: string; // blob: local, ya decodificado
  w: number;
  h: number;
  mime: ImageMime;
}

export interface ChatMsg {
  id: string;
  from: string;
  name: string;
  text: string;
  ts: number;
  via?: string; // reenviado por este peer al entrar: el autor no está demostrado
  kind?: ChatKind; // sin kind, 'chat': así lo entienden las versiones anteriores
  image?: ChatImage;
  key?: string; // etiqueta de la clave de quien lo dijo, para el archivo
  mine?: boolean;
  stored?: boolean; // sacado del archivo local, no de esta sesión
}

export interface RemoteSource {
  id: string;
  kind: SourceKind;
  stream: MediaStream;
  paused: boolean;
}

export interface PeerView {
  id: string;
  name: string;
  muted: boolean;
  state: RTCPeerConnectionState;
  failed: boolean;
  sources: RemoteSource[];
  trust: TrustState;
  tampered: boolean; // señalización que no se pudo descifrar: otra clave o manipulada
  keyTag: string;
  safety: string;
  duplicate: boolean; // otro participante usa el mismo nombre
  avatar: string; // '' (inicial), un glifo corto o una imagen data: ya validada
}

type DataMsg =
  | { t: 'id'; pub: string; name: string; sig: string }
  | { t: 'meta'; muted: boolean; streams: Record<string, SourceKind>; paused?: SourceKind[] }
  | { t: 'chat'; msg: ChatMsg }
  | { t: 'history'; msgs: ChatMsg[] }
  | { t: 'react'; emoji: string }
  | { t: 'profile'; name: string; avatar: string }
  | ImageHeader
  | ImageChunk;

// Eventos puntuales para efectos (sonido, confeti, reacciones flotantes).
export type MeshEvent =
  | { type: 'join' | 'leave' | 'live' | 'chat'; name: string }
  | { type: 'react'; name: string; emoji: string; self: boolean }
  | { type: 'message'; msg: ChatMsg; self: boolean }
  | { type: 'rename'; name: string; to: string };

export const REACTIONS = ['¡Fistro!', '¡Condemor!', '¡Cobarde!', 'No puedor', "You talkin' to me?", "I'm walkin' here!", 'Rock is dead', 'Dope show'];

export const MAX_AVATAR = 48_000; // caracteres del data: URL; 128×128 en WebP o JPEG cabe de sobra
const AVATAR_IMAGE = /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/;

// Lo que manda otro peer: o una imagen rasterizada en un formato cerrado (nada de SVG), o un glifo corto.
export function cleanAvatar(raw: unknown): string {
  const s = String(raw ?? '');
  if (s.startsWith('data:')) return s.length <= MAX_AVATAR && AVATAR_IMAGE.test(s) ? s : '';
  return safeName(s, 2);
}

interface Peer {
  id: string;
  name: string;
  pc: RTCPeerConnection;
  dc: RTCDataChannel | null;
  polite: boolean;
  ready: boolean; // ya puede llevar pistas locales (ver createPeer)
  makingOffer: boolean;
  ignoreOffer: boolean;
  queue: Promise<void>;
  senders: Map<SourceKind, RTCRtpSender[]>;
  streams: Map<string, MediaStream>;
  kinds: Record<string, SourceKind>; // streamId -> tipo, según la meta del peer
  paused: SourceKind[]; // fuentes del peer en pausa, según su meta
  muted: boolean;
  gen: number; // sube cada vez que se rehace la conexión
  resets: number[]; // instantes de los últimos intentos de rehacerla
  remoteResets: number[]; // los pedidos por el otro: uno con la clave no puede agotarnos a base de rehacer
  failed: boolean; // intentos agotados: chat y media pueden no funcionar
  // Identidad: hasta que el otro la demuestre no se le envía ni se acepta nada por el canal.
  proven: boolean;
  outbox: DataMsg[];
  proofTimer?: ReturnType<typeof setTimeout>;
  pub: string;
  tag: string;
  safety: string;
  trust: TrustState;
  tampered: boolean;
  dataQueue: Promise<void>;
  tokens: number;
  lastFill: number;
  gotHistory: boolean;
  avatar: string;
  images: ImageAssembler;
  bytes: number; // cubo de bytes de entrada: las imágenes no van por el de mensajes
  bytesFill: number;
  sendBytes: number; // y el mismo cubo visto desde aquí, para no pasarse al enviar
  sendFill: number;
  bulk: Promise<void>; // envíos largos (imágenes), uno detrás de otro
}

const MAX_CHAT = 500;
const MAX_RESETS = 3;
const RESET_WINDOW_MS = 60_000;
const MAX_PEERS = 16; // el servidor los limita, pero un servidor hostil no debe agotar el navegador
const MAX_DC_MESSAGE = 200_000; // por debajo del límite de SCTP
const MAX_ID_LEN = 64;
const MAX_STREAMS = 8;
const PROOF_TIMEOUT_MS = 15_000;
const DC_BUCKET = 60;
const DC_REFILL = 20; // mensajes por segundo de cada peer
const BYTE_BUCKET = 8_000_000; // caracteres; una imagen de 2 MB son ~2,7 M en base64
const BYTE_REFILL = 2_000_000; // por segundo
const SEND_BUCKET = BYTE_BUCKET * 0.75; // al enviar, con margen sobre lo que acepta el otro
const SEND_REFILL = BYTE_REFILL * 0.75;
const DC_HIGH_WATER = 1_000_000;
const ARCHIVE_LOAD = 200;
const KINDS: SourceKind[] = ['mic', 'camera', 'screen', 'file'];
const HISTORY_KEY = 'newchord.shareHistory';
const LEGACY_PASSWORD_KEY = 'newchord.password';
const SAVE_KEY = 'cryptopo.saveLocal';
const isKind = (k: unknown): k is SourceKind => KINDS.includes(k as SourceKind);

// Malla completa: una RTCPeerConnection por peer, "perfect negotiation" para
// que cualquiera pueda añadir/quitar pistas sin coordinar quién ofrece.
export class Mesh {
  myId = '';
  name = '';
  avatar = '';
  room: string | null = null;
  rooms: RoomInfo[] = [];
  online = false;
  micMuted = true; // se entra en silencio: hablar es una decisión, no un efecto de entrar
  notice = '';
  // Enseñar lo ya hablado a quien entra lo decide cada uno; por defecto, no.
  shareHistory = localStorage.getItem(HISTORY_KEY) === '1';
  chat: ChatMsg[] = [];
  archive: Archive | null = null;
  saveLocal = localStorage.getItem(SAVE_KEY) !== '0';
  local = new Map<SourceKind, LocalSource>();
  private peers = new Map<string, Peer>();
  private ice: RTCIceServer[] = [];
  private relay = false;
  // 'ok' también mientras se reintenta la guardada: reconectar en plena llamada no saca a la pantalla de contraseña.
  auth: 'ok' | 'needed' | 'failed' | 'insecure' = 'ok';
  authBusy = false;
  // Hasta saber si hay clave guardada no se enseña ninguna pantalla: así la de clave nunca llega tarde.
  keyChecked = false;
  private master: CryptoKey | null = null;
  private keys: RoomKeys | null = null;
  private nonce = '';
  private invite: { id: string; k: Uint8Array<ArrayBuffer> } | null = null; // enlace /#i= aún sin canjear
  private stored: CryptoKey | null = null; // clave guardada: respaldo si la invitación ya no vale
  private ready: Promise<void>;
  private identity: Identity | null = null;
  private trustBook = loadTrust();
  private sendChains = new Map<string, Promise<void>>();
  private recvChains = new Map<string, Promise<void>>();
  private seqOut = new Map<string, number>();
  private seqIn = new Map<string, number>();
  private listeners = new Set<() => void>();
  private eventListeners = new Set<(e: MeshEvent) => void>();
  private version = 0;

  constructor(private sig: Signaling) {
    // La clave del enlace se quita de la barra antes de nada: fuera de historial y de capturas.
    const secret = this.takeFragmentSecret();
    localStorage.removeItem(LEGACY_PASSWORD_KEY); // versiones anteriores la guardaban en claro
    this.ready = this.init(secret);
    sig.onMessage = (m) => this.onServer(m);
    sig.onStatus = (online) => {
      this.online = online;
      if (!online) {
        this.closePeers();
        this.seqIn.clear();
        this.seqOut.clear();
      }
      this.emit();
    };
  }

  private takeFragmentSecret() {
    this.invite = parseInvite(location.hash);
    if (this.invite || location.hash.startsWith('#i=')) {
      history.replaceState(null, '', location.pathname + location.search);
      return '';
    }
    const match = /^#k=(.+)$/.exec(location.hash);
    if (!match) return '';
    history.replaceState(null, '', location.pathname + location.search);
    try {
      return decodeURIComponent(match[1]);
    } catch {
      return '';
    }
  }

  private async init(secret: string) {
    if (!crypto.subtle) {
      this.auth = 'insecure';
      this.keyChecked = true;
      this.emit();
      return;
    }
    if (typeof RTCPeerConnection === 'undefined') this.notice = 'Este navegador no admite WebRTC: no podrás conectar con nadie.';
    this.identity = await loadIdentity();
    if (secret) {
      this.master = await deriveMaster(secret);
    } else if (this.invite) {
      // Con invitación se canjea esa; la clave guardada solo sirve si el enlace ya no vale.
      this.stored = (await loadKey<CryptoKey>('master')) ?? null;
    } else {
      this.master = (await loadKey<CryptoKey>('master')) ?? null;
    }
    if (this.master) this.keys = await deriveKeys(this.master);
    else if (!this.invite) this.auth = 'needed';
    this.keyChecked = true;
    this.emit();
  }

  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => void this.listeners.delete(fn);
  };
  getVersion = () => this.version;
  onEvent(fn: (e: MeshEvent) => void) {
    this.eventListeners.add(fn);
    return () => void this.eventListeners.delete(fn);
  }
  private fire(e: MeshEvent) {
    for (const f of this.eventListeners) f(e);
  }

  // Consola: await cryptopo.iceDiag(). Tipos de candidato y par elegido por peer.
  async iceDiag() {
    const out: Record<string, unknown>[] = [];
    for (const p of this.peers.values()) {
      const stats = await p.pc.getStats();
      const types = { local: new Set<string>(), remote: new Set<string>() };
      let pair: Record<string, unknown> | null = null;
      const byId = new Map<string, RTCStats & Record<string, unknown>>();
      stats.forEach((r) => byId.set(r.id, r as RTCStats & Record<string, unknown>));
      stats.forEach((r) => {
        const x = r as RTCStats & Record<string, unknown>;
        if (r.type === 'local-candidate') types.local.add(`${x.candidateType}/${x.protocol}`);
        if (r.type === 'remote-candidate') types.remote.add(`${x.candidateType}/${x.protocol}`);
        if (r.type === 'candidate-pair' && (x.nominated || x.state === 'succeeded')) {
          const l = byId.get(x.localCandidateId as string);
          const rm = byId.get(x.remoteCandidateId as string);
          pair = { state: x.state, local: l?.candidateType, remote: rm?.candidateType, rtt: x.currentRoundTripTime };
        }
      });
      out.push({ name: p.name, ice: p.pc.iceConnectionState, conn: p.pc.connectionState, gathering: p.pc.iceGatheringState, local: [...types.local], remote: [...types.remote], pair });
    }
    return JSON.stringify(out, null, 1);
  }

  react(emoji: string) {
    if (!REACTIONS.includes(emoji)) return;
    this.broadcast({ t: 'react', emoji });
    this.fire({ type: 'react', name: this.name, emoji, self: true });
  }
  private emit() {
    this.version++;
    for (const f of this.listeners) f();
  }

  async submitPassword(secret: string) {
    this.authBusy = true;
    this.emit();
    this.master = await deriveMaster(secret);
    this.keys = await deriveKeys(this.master);
    await this.sendProof();
    this.emit();
  }

  // ¿Es este texto la clave del servidor? No hay clave en claro con la que comparar: se deriva y se
  // compara la firma. Sirve para no aceptar la clave como nombre (se envía y registra sin cifrar).
  async isServerKey(text: string) {
    if (!this.keys || text.trim().length < 16) return false;
    const probe = 'newchord-name-check';
    const k = await deriveKeys(await deriveMaster(text));
    return (await authProof(k.auth, probe)) === (await authProof(this.keys.auth, probe));
  }

  private async sendProof() {
    if (this.keys && this.nonce) this.sig.send({ type: 'auth', proof: await authProof(this.keys.auth, this.nonce) });
  }

  // Salir y olvidar la clave de este navegador. La identidad se queda: es la del dispositivo.
  async forgetKey() {
    this.leave();
    this.master = null;
    this.keys = null;
    this.auth = 'needed';
    await deleteKey('master');
    this.sig.reconnect();
    this.emit();
  }

  setShareHistory(on: boolean) {
    this.shareHistory = on;
    localStorage.setItem(HISTORY_KEY, on ? '1' : '0');
    this.emit();
  }

  verifyPeer(id: string) {
    const p = this.peers.get(id);
    if (!p?.pub) return;
    markVerified(this.trustBook, p.name, p.pub);
    p.trust = 'verified';
    this.emit();
  }

  // ---- sala ----

  join(room: string, name: string, avatar = this.avatar) {
    this.closePeers();
    const changed = this.room?.toLowerCase() !== room.toLowerCase();
    if (changed) this.resetChat();
    this.room = room;
    this.name = name;
    this.avatar = cleanAvatar(avatar);
    this.sig.send({ type: 'join', room, name });
    if (changed) void this.loadArchive(room);
    this.emit();
  }

  // Solo salas creadas por usuarios y sin nadie más dentro; si estás tú, sales.
  deleteRoom(room: string) {
    if (this.room?.toLowerCase() === room.toLowerCase()) this.leave();
    this.sig.send({ type: 'delete-room', room });
  }

  leave() {
    this.sig.send({ type: 'leave' });
    this.closePeers();
    for (const k of [...this.local.keys()]) this.removeSource(k);
    this.micMuted = true;
    this.room = null;
    this.resetChat();
    this.emit();
  }

  // Cambiar nombre o avatar sin salir de la sala. El nombre que ven los demás llega por el
  // DataChannel, de un peer ya demostrado; al servidor solo le llega para la lista de salas.
  setProfile(name: string, avatar: string) {
    name = safeName(name);
    if (!name) return;
    const renamed = name !== this.name;
    this.name = name;
    this.avatar = cleanAvatar(avatar);
    if (this.room && renamed) this.sig.send({ type: 'rename', name });
    this.broadcast(this.profile());
    this.emit();
  }

  private profile(): DataMsg {
    return { t: 'profile', name: this.name, avatar: this.avatar };
  }

  peerViews(): PeerView[] {
    const names = [...this.peers.values()].map((p) => p.name.toLowerCase());
    return [...this.peers.values()].map((p) => ({
      id: p.id,
      name: p.name,
      muted: p.muted,
      state: p.pc.connectionState,
      failed: p.failed,
      sources: [...p.streams.values()]
        .filter((s) => p.kinds[s.id] && s.getTracks().length > 0)
        .map((s) => ({ id: s.id, kind: p.kinds[s.id], stream: s, paused: p.paused.includes(p.kinds[s.id]) })),
      trust: p.trust,
      tampered: p.tampered,
      keyTag: p.tag,
      safety: p.safety,
      duplicate: names.filter((n) => n === p.name.toLowerCase()).length > 1 || p.name.toLowerCase() === this.name.toLowerCase(),
      avatar: p.avatar,
    }));
  }

  // ---- fuentes locales ----

  addSource(kind: SourceKind, stream: MediaStream, opts: EncodeOpts, release?: () => void) {
    if (this.local.has(kind)) this.removeSource(kind, this.local.get(kind)!.stream !== stream);
    for (const t of stream.getVideoTracks()) t.contentHint = opts.hint ?? '';
    if (kind !== 'mic') for (const t of stream.getAudioTracks()) t.contentHint = 'music';
    if (kind === 'mic') for (const t of stream.getAudioTracks()) t.enabled = !this.micMuted;
    for (const t of stream.getTracks()) this.watchEnded(kind, stream, t);
    const src: LocalSource = { kind, stream, opts, release };
    this.local.set(kind, src);
    this.broadcastMeta();
    for (const p of this.peers.values()) if (p.ready) this.attach(p, src);
    this.emit();
  }

  private watchEnded(kind: SourceKind, stream: MediaStream, track: MediaStreamTrack) {
    track.addEventListener('ended', () => {
      const src = this.local.get(kind);
      if (src?.stream !== stream) return;
      if (kind !== 'screen') return this.removeSource(kind);
      // Firefox termina la pista al minimizar la ventana compartida. Sin un clic no se
      // puede volver a capturar: la emisión queda en pausa hasta reanudar o cortar (H7).
      // No mirar si la pista sigue en el stream: Firefox puede haberla sacado ya.
      if (track.kind !== 'video' || stream.getVideoTracks().some((t) => t.readyState === 'live')) return;
      src.paused = true;
      this.broadcastMeta();
      this.emit();
    });
  }

  // Sustituye las pistas sin renegociar: quienes miran conservan su ficha.
  resumeSource(kind: SourceKind, fresh: MediaStream) {
    const src = this.local.get(kind);
    if (!src) return;
    for (const t of src.stream.getTracks()) {
      src.stream.removeTrack(t);
      t.stop();
    }
    const tracks = fresh.getTracks();
    for (const t of tracks) {
      if (t.kind === 'video') t.contentHint = src.opts.hint ?? '';
      else t.contentHint = 'music';
      src.stream.addTrack(t);
      this.watchEnded(kind, src.stream, t);
    }
    for (const p of this.peers.values()) {
      if (!p.ready) continue;
      const free = [...(p.senders.get(kind) ?? [])];
      const senders: RTCRtpSender[] = [];
      for (const t of tracks) {
        const i = free.findIndex((s) => s.track?.kind === t.kind);
        if (i >= 0) {
          const [s] = free.splice(i, 1);
          void s.replaceTrack(t);
          senders.push(s);
        } else senders.push(p.pc.addTrack(t, src.stream));
      }
      for (const s of free) p.pc.removeTrack(s);
      p.senders.set(kind, senders);
      for (const s of senders) applyEncoding(s, src.opts);
    }
    src.paused = false;
    this.broadcastMeta();
    this.emit();
  }

  removeSource(kind: SourceKind, stop = true) {
    const src = this.local.get(kind);
    if (!src) return;
    this.local.delete(kind);
    for (const p of this.peers.values()) this.detach(p, kind);
    if (stop) {
      for (const t of src.stream.getTracks()) t.stop();
      src.release?.();
    }
    this.broadcastMeta();
    this.emit();
  }

  // Cambios de bitrate/fps en caliente, sin renegociar.
  updateOpts(kind: SourceKind, opts: EncodeOpts) {
    const src = this.local.get(kind);
    if (!src) return;
    src.opts = opts;
    for (const t of src.stream.getVideoTracks()) t.contentHint = opts.hint ?? '';
    for (const p of this.peers.values()) for (const s of p.senders.get(kind) ?? []) applyEncoding(s, opts);
    this.emit();
  }

  setMicMuted(muted: boolean) {
    this.micMuted = muted;
    for (const t of this.local.get('mic')?.stream.getAudioTracks() ?? []) t.enabled = !muted;
    this.broadcastMeta();
    this.emit();
  }

  private attach(p: Peer, src: LocalSource) {
    const senders = src.stream.getTracks().map((t) => p.pc.addTrack(t, src.stream));
    p.senders.set(src.kind, senders);
    for (const s of senders) {
      if (s.track?.kind === 'video') applyCodecPreference(p.pc, s, src.opts.codec);
      applyEncoding(s, src.opts);
    }
  }

  private detach(p: Peer, kind: SourceKind) {
    for (const s of p.senders.get(kind) ?? []) {
      try {
        p.pc.removeTrack(s);
      } catch {
        /* pc cerrada */
      }
    }
    p.senders.delete(kind);
  }

  // ---- stats (para comprobar resolución/fps/encoder reales) ----

  receiverFor(peerId: string, track: MediaStreamTrack) {
    return this.peers.get(peerId)?.pc.getReceivers().find((r) => r.track === track);
  }

  sendersFor(kind: SourceKind) {
    return [...this.peers.values()].flatMap((p) =>
      (p.senders.get(kind) ?? []).filter((s) => s.track?.kind === 'video').map((sender) => ({ peer: p.name, sender })),
    );
  }

  peerCount() {
    return this.peers.size;
  }

  // ---- chat ----

  // 'tts': lo que escribes se lee en voz alta a la sala; 'stt': lo que has dicho, transcrito aquí.
  sendChat(text: string, kind: 'chat' | 'tts' | 'stt' = 'chat', ts = Date.now()) {
    text = text.trim().slice(0, 4000);
    if (!text || !this.room) return;
    const msg: ChatMsg = { id: crypto.randomUUID(), from: this.myId, name: this.name, text, ts: Math.min(ts, Date.now()), mine: true };
    if (kind !== 'chat') msg.kind = kind;
    this.addChat([msg]);
    this.record(msg);
    this.broadcast({ t: 'chat', msg: { id: msg.id, from: msg.from, name: msg.name, text, ts: msg.ts, kind: msg.kind } });
    this.fire({ type: 'message', msg, self: true });
    this.emit();
  }

  // Se recodifica aquí (sin EXIF, WebP o JPEG, <= 2 MB) y va a cada peer en trozos por el canal.
  async sendImage(file: Blob) {
    const room = this.room;
    if (!room) return;
    const img = await prepareImage(file);
    if (this.room !== room) return;
    const id = crypto.randomUUID();
    const ts = Date.now();
    const msg: ChatMsg = {
      id, from: this.myId, name: this.name, text: '', ts, kind: 'image', mine: true,
      image: { url: URL.createObjectURL(new Blob([img.bytes], { type: img.mime })), w: img.w, h: img.h, mime: img.mime },
    };
    this.addChat([msg]);
    this.record(msg, img.bytes);
    const head: ImageHeader = { t: 'img', id, mime: img.mime, size: img.bytes.length, w: img.w, h: img.h, ts };
    for (const p of this.peers.values()) {
      if (!p.proven) continue;
      p.bulk = p.bulk.then(() => this.sendBulk(p, [head, ...chunksOf(img.bytes, id)])).catch((e) => console.warn('imagen', e));
    }
    this.emit();
  }

  setSaveLocal(on: boolean) {
    this.saveLocal = on;
    localStorage.setItem(SAVE_KEY, on ? '1' : '0');
    this.emit();
  }

  private addChat(msgs: ChatMsg[]) {
    const seen = new Set(this.chat.map((m) => m.id));
    const fresh = msgs.filter(
      (m) => m && typeof m.id === 'string' && typeof m.text === 'string' && !seen.has(m.id),
    );
    if (!fresh.length) return;
    const all = [...this.chat, ...fresh].sort((a, b) => a.ts - b.ts);
    for (const m of all.slice(0, -MAX_CHAT)) if (m.image) URL.revokeObjectURL(m.image.url);
    this.chat = all.slice(-MAX_CHAT);
    this.emit();
  }

  private resetChat() {
    for (const m of this.chat) if (m.image) URL.revokeObjectURL(m.image.url);
    this.chat = [];
  }

  // Al archivo local, si está activado. Un fallo al guardar no corta nada de la llamada.
  private record(msg: ChatMsg, data?: Uint8Array) {
    if (!this.saveLocal || !this.archive || !this.room || msg.stored) return;
    const row: ArchiveRow = {
      room: this.room.toLowerCase(),
      id: msg.id,
      kind: msg.kind ?? 'chat',
      author: msg.name,
      author_key: msg.key ?? '',
      via: msg.via ?? null,
      mine: msg.mine ? 1 : 0,
      text: msg.text,
      mime: msg.image?.mime ?? null,
      width: msg.image?.w ?? null,
      height: msg.image?.h ?? null,
      data: data ?? null,
      ts: msg.ts,
    };
    this.archive.add(row).catch((e) => console.warn('archivo local', e));
  }

  private async loadArchive(room: string) {
    if (!this.archive) return;
    let rows: ArchiveRow[];
    try {
      rows = await this.archive.list(room, ARCHIVE_LOAD);
    } catch (e) {
      console.warn('archivo local', e);
      return;
    }
    if (this.room?.toLowerCase() !== room.toLowerCase()) return;
    const msgs: ChatMsg[] = [];
    for (const r of rows) {
      const msg: ChatMsg = {
        id: r.id,
        from: r.mine ? this.myId : 'archivo:' + r.author_key,
        name: r.author,
        text: r.text,
        ts: r.ts,
        via: r.via ?? undefined,
        kind: r.kind,
        key: r.author_key,
        mine: !!r.mine,
        stored: true,
      };
      if (r.kind === 'image') {
        if (!r.data || !r.mime) continue;
        msg.image = { url: URL.createObjectURL(new Blob([new Uint8Array(r.data)], { type: r.mime })), w: r.width ?? 0, h: r.height ?? 0, mime: r.mime as ImageMime };
      }
      msgs.push(msg);
    }
    this.addChat(msgs);
  }

  async clearArchive(room: string | null) {
    await this.archive?.clear(room);
    // Lo ya enseñado de esta sesión se queda; lo sacado del archivo, no.
    for (const m of this.chat) if (m.stored && m.image) URL.revokeObjectURL(m.image.url);
    this.chat = this.chat.filter((m) => !m.stored);
    this.emit();
  }

  // ---- señalización ----

  private async onAuthChallenge(nonce: string) {
    await this.ready;
    this.nonce = nonce;
    if (this.keys) await this.sendProof();
    else if (this.invite) this.sig.send({ type: 'redeem', id: this.invite.id });
    else if (this.auth !== 'insecure') this.auth = 'needed';
    this.emit();
  }

  private async onInvite(m: Extract<ServerMsg, { type: 'invite' }>) {
    await this.ready;
    const inv = this.invite;
    if (!inv) return;
    try {
      this.master = await deriveMaster(await openInvite(inv.k, inv.id, m.iv, m.ct));
      this.keys = await deriveKeys(this.master);
    } catch {
      return this.onInviteFailed();
    }
    this.invite = null;
    this.authBusy = true;
    await this.sendProof();
    this.emit();
  }

  private async onInviteFailed() {
    await this.ready;
    this.invite = null;
    if (this.stored) {
      this.master = this.stored;
      this.keys = await deriveKeys(this.master);
      await this.sendProof();
    } else if (this.auth !== 'insecure') {
      this.auth = 'needed';
      this.notice = 'La invitación caducó o ya se usó. Pide otra, o escribe la clave.';
    }
    this.emit();
  }

  private async onAuthFailed(nonce: string) {
    await this.ready;
    this.nonce = nonce;
    this.master = null;
    this.keys = null;
    await deleteKey('master');
    this.auth = 'failed';
    this.authBusy = false;
    this.emit();
  }

  // Sin clave no se entra aunque el servidor diga que sí: un servidor sin reto no rebaja nada.
  private async onHello(m: Extract<ServerMsg, { type: 'hello' }>) {
    await this.ready;
    // Guardar antes de exponer myId: «myId y auth ok» implica que la clave ya está en disco.
    if (this.keys && this.master) await saveKey('master', this.master);
    this.myId = m.id;
    this.ice = m.ice ?? [];
    this.relay = !!m.relay;
    this.rooms = this.cleanRooms(m.rooms);
    if (!this.keys) {
      if (this.auth !== 'insecure') this.auth = 'needed';
      this.emit();
      return;
    }
    this.auth = 'ok';
    this.authBusy = false;
    if (this.room) this.sig.send({ type: 'join', room: this.room, name: this.name });
    this.emit();
  }

  private cleanRooms(rooms: RoomInfo[]): RoomInfo[] {
    return (rooms ?? []).map((r) => ({
      name: safeName(r.name, 40),
      fixed: !!r.fixed,
      members: (r.members ?? []).map((p) => ({ id: String(p.id), name: safeName(p.name) })),
    }));
  }

  private onServer(m: ServerMsg) {
    switch (m.type) {
      case 'auth-required':
        void this.onAuthChallenge(m.nonce);
        return;
      case 'auth-failed':
        void this.onAuthFailed(m.nonce);
        return;
      case 'invite':
        void this.onInvite(m);
        return;
      case 'invite-failed':
        void this.onInviteFailed();
        return;
      case 'hello':
        void this.onHello(m);
        return;
      case 'room-full':
        this.notice = `La sala ${safeName(m.room, 40)} está llena.`;
        this.closePeers();
        for (const k of [...this.local.keys()]) this.removeSource(k);
        this.micMuted = true;
        this.room = null;
        this.resetChat();
        break;
      case 'room-busy':
        this.notice = `No se puede borrar ${safeName(m.room, 40)}: hay alguien dentro.`;
        break;
      case 'rooms':
        this.rooms = this.cleanRooms(m.rooms);
        break;
      case 'joined':
        // El servidor unifica mayúsculas. La comprobación descarta un "joined" de una sala ya abandonada.
        if (this.room?.toLowerCase() === m.room.toLowerCase()) this.room = m.room;
        for (const p of m.peers) this.createPeer(p.id, safeName(p.name), true);
        break;
      case 'peer-joined': {
        const name = safeName(m.name);
        this.createPeer(m.id, name, false);
        this.fire({ type: 'join', name });
        break;
      }
      case 'peer-left': {
        const name = this.peers.get(m.id)?.name;
        this.closePeer(m.id);
        if (name) this.fire({ type: 'leave', name });
        break;
      }
      case 'signal': {
        // En cadena por emisor: descifrar es asíncrono y el orden importa.
        const next = (this.recvChains.get(m.from) ?? Promise.resolve()).then(() => this.openSignal(m.from, m.data));
        this.recvChains.set(m.from, next.catch(() => {}));
        return;
      }
    }
    this.emit();
  }

  private async openSignal(from: string, env: Envelope) {
    const before = this.peers.get(from);
    if (!before || !this.keys || !this.room) return;
    let data: SignalData;
    try {
      data = (await open(this.keys.signal, env, this.room, from, this.myId)) as SignalData;
      if ((this.seqIn.get(from) ?? 0) >= env.seq) throw new Error('señal repetida');
      this.seqIn.set(from, env.seq);
    } catch (e) {
      // Sin clave común no hay conexión posible, y es lo correcto: no se degrada a nada.
      console.warn('señalización rechazada', from, e);
      const q = this.peers.get(from);
      if (q) {
        q.tampered = true;
        this.emit();
      }
      return;
    }
    const p = this.peers.get(from);
    if (!p) return;
    p.tampered = false;
    const gen = data.gen ?? 0;
    if (data.reset) {
      const now = Date.now();
      p.remoteResets = p.remoteResets.filter((t) => now - t < RESET_WINDOW_MS);
      if (gen > p.gen && p.remoteResets.length < MAX_RESETS * 2) {
        p.remoteResets.push(now);
        this.rebuild(p, gen);
      }
    } else if (gen === p.gen && data.failed) {
      p.failed = true;
      this.emit();
    } else if (gen === p.gen) {
      p.queue = p.queue.then(() => this.onSignal(p, data)).catch((e) => this.onSignalError(p, data, e));
    }
  }

  // Solo el recién llegado (initiator) abre canal y pistas de entrada; el otro
  // espera a la primera oferta. Si ambos ofrecen a la vez al arrancar, Chrome
  // falla con "Failed to start SCTP transport" al resolver el glare.
  private createPeer(id: string, name: string, initiator: boolean, prev?: Peer) {
    this.closePeer(id);
    if (this.peers.size >= MAX_PEERS) throw new Error('demasiados peers');
    const pc = new RTCPeerConnection({ iceServers: this.ice, bundlePolicy: 'max-bundle', iceTransportPolicy: this.relay ? 'relay' : 'all' });
    const p: Peer = {
      id,
      name,
      pc,
      dc: null,
      polite: this.myId < id,
      ready: initiator,
      makingOffer: false,
      ignoreOffer: false,
      queue: Promise.resolve(),
      senders: new Map(),
      streams: new Map(),
      kinds: prev?.kinds ?? {},
      paused: prev?.paused ?? [],
      muted: prev?.muted ?? false,
      gen: prev?.gen ?? 0,
      resets: prev?.resets ?? [],
      remoteResets: prev?.remoteResets ?? [],
      failed: false,
      proven: false,
      outbox: [],
      pub: '',
      tag: '',
      safety: '',
      trust: 'pending',
      tampered: false,
      dataQueue: Promise.resolve(),
      tokens: DC_BUCKET,
      lastFill: Date.now(),
      gotHistory: false,
      avatar: prev?.avatar ?? '',
      images: new ImageAssembler(),
      bytes: BYTE_BUCKET,
      bytesFill: Date.now(),
      sendBytes: SEND_BUCKET,
      sendFill: Date.now(),
      bulk: Promise.resolve(),
    };
    this.peers.set(id, p);

    pc.onnegotiationneeded = async () => {
      try {
        p.makingOffer = true;
        await pc.setLocalDescription();
        this.signal(p, { description: pc.localDescription!.toJSON() });
      } catch (e) {
        if (pc.signalingState !== 'closed') console.error('negotiation', e);
      } finally {
        p.makingOffer = false;
      }
    };
    pc.onicecandidate = ({ candidate }) => {
      if (candidate) this.signal(p, { candidate: candidate.toJSON() });
    };
    // Diagnóstico de ICE (docs/HALLAZGOS.md, H8): estado y errores, sin direcciones.
    pc.oniceconnectionstatechange = () => console.info('ice', p.name, pc.iceConnectionState, 'gathering', pc.iceGatheringState);
    pc.onicecandidateerror = (e) => {
      const ev = e as RTCPeerConnectionIceErrorEvent;
      console.warn('ice error', p.name, ev.errorCode, ev.errorText, ev.url);
    };
    pc.ontrack = (ev) => {
      const s = ev.streams[0];
      if (!s) return;
      if (!p.streams.has(s.id)) {
        p.streams.set(s.id, s);
        s.addEventListener('removetrack', () => {
          if (s.getTracks().length === 0) p.streams.delete(s.id);
          this.emit();
        });
      }
      this.emit();
    };
    // Los encodings solo existen tras negociar: reaplicar al cerrar cada ronda.
    const reapply = () => {
      for (const [kind, senders] of p.senders) {
        const opts = this.local.get(kind)?.opts;
        if (opts) for (const s of senders) applyEncoding(s, opts);
      }
    };
    pc.onsignalingstatechange = () => {
      if (pc.signalingState === 'stable') reapply();
    };
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'failed') pc.restartIce();
      if (pc.connectionState === 'connected') reapply();
      this.emit();
    };
    const setupChannel = (dc: RTCDataChannel) => {
      p.dc = dc;
      dc.onopen = () => void this.sendIdentity(p);
      dc.onmessage = (e) => {
        if (typeof e.data !== 'string' || e.data.length > MAX_DC_MESSAGE || !this.allowBytes(p, e.data.length)) return;
        let m: DataMsg;
        try {
          m = JSON.parse(e.data);
        } catch {
          return; // mensaje corrupto
        }
        // Los trozos de imagen solo cuentan por bytes: una imagen son decenas de mensajes.
        if (m?.t !== 'imgc' && !this.allowData(p)) return;
        // En cadena: comprobar la firma es asíncrono y nada puede adelantarla.
        p.dataQueue = p.dataQueue.then(() => this.onData(p, m)).catch(() => {
          /* mensaje corrupto */
        });
      };
    };
    pc.ondatachannel = (ev) => setupChannel(ev.channel);

    if (initiator) {
      setupChannel(pc.createDataChannel('room'));
      for (const src of this.local.values()) this.attach(p, src);
    }
    return p;
  }

  // Todo lo que ve el servidor va sellado; sin clave no sale nada.
  private signal(p: Peer, data: SignalData) {
    const keys = this.keys;
    const room = this.room;
    if (!keys || !room) return;
    const seq = (this.seqOut.get(p.id) ?? 0) + 1;
    this.seqOut.set(p.id, seq);
    const payload = { ...data, gen: p.gen };
    const from = this.myId;
    const next = (this.sendChains.get(p.id) ?? Promise.resolve())
      .then(() => seal(keys.signal, payload, room, from, p.id, seq))
      .then((env) => this.sig.send({ type: 'signal', to: p.id, data: env }));
    this.sendChains.set(p.id, next.catch((e) => console.error('señal', e)));
  }

  // ---- identidad del otro extremo ----

  private async sendIdentity(p: Peer) {
    if (!this.identity || this.peers.get(p.id) !== p) return;
    const local = dtlsFingerprints(p.pc.localDescription?.sdp ?? '');
    const remote = dtlsFingerprints(p.pc.currentRemoteDescription?.sdp ?? '');
    const sig = await signBinding(this.identity, this.room ?? '', this.name, local, remote);
    if (p.dc?.readyState === 'open') p.dc.send(JSON.stringify({ t: 'id', pub: this.identity.pub, name: this.name, sig }));
    p.proofTimer = setTimeout(() => {
      if (!p.proven && this.peers.get(p.id) === p) this.rejectPeer(p);
    }, PROOF_TIMEOUT_MS);
  }

  private async onIdentity(p: Peer, m: Extract<DataMsg, { t: 'id' }>) {
    if (p.proven || !this.identity) return;
    const pub = String(m.pub ?? '');
    const name = safeName(m.name);
    const remote = dtlsFingerprints(p.pc.currentRemoteDescription?.sdp ?? '');
    const local = dtlsFingerprints(p.pc.localDescription?.sdp ?? '');
    if (!name || !remote || !local || !(await verifyBinding(pub, String(m.sig ?? ''), this.room ?? '', name, remote, local))) {
      this.rejectPeer(p);
      return;
    }
    clearTimeout(p.proofTimer);
    p.name = name;
    p.pub = pub;
    p.tag = await keyTag(pub);
    p.safety = await safetyNumber(this.identity.pub, pub);
    p.trust = evaluateTrust(this.trustBook, name, pub);
    p.proven = true;
    this.sendMeta(p);
    this.send(p, this.profile());
    if (this.shareHistory && this.chat.length) this.sendHistory(p);
    for (const queued of p.outbox.splice(0)) this.send(p, queued);
    this.emit();
  }

  // Firma que no cuadra: lo que dice ser no es lo que hay al otro lado de esta conexión.
  private rejectPeer(p: Peer) {
    console.error('identidad rechazada', p.id);
    p.trust = 'bad';
    p.failed = true;
    p.pc.close();
    this.emit();
  }

  private allowData(p: Peer) {
    const now = Date.now();
    p.tokens = Math.min(DC_BUCKET, p.tokens + ((now - p.lastFill) / 1000) * DC_REFILL);
    p.lastFill = now;
    if (p.tokens < 1) return false;
    p.tokens--;
    return true;
  }

  private allowBytes(p: Peer, n: number) {
    const now = Date.now();
    p.bytes = Math.min(BYTE_BUCKET, p.bytes + ((now - p.bytesFill) / 1000) * BYTE_REFILL);
    p.bytesFill = now;
    if (p.bytes < n) return false;
    p.bytes -= n;
    return true;
  }

  // Mensajes largos con contrapresión: no se llena el búfer del canal ni el cubo del otro.
  private async sendBulk(p: Peer, msgs: Iterable<DataMsg>) {
    const dc = p.dc;
    if (!dc) return;
    const alive = () => dc.readyState === 'open' && this.peers.get(p.id) === p;
    const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
    for (const m of msgs) {
      if (!alive()) return;
      const text = JSON.stringify(m);
      for (;;) {
        const now = Date.now();
        p.sendBytes = Math.min(SEND_BUCKET, p.sendBytes + ((now - p.sendFill) / 1000) * SEND_REFILL);
        p.sendFill = now;
        if (p.sendBytes >= text.length && dc.bufferedAmount < DC_HIGH_WATER) break;
        await wait(50);
        if (!alive()) return;
      }
      p.sendBytes -= text.length;
      dc.send(text);
    }
  }

  private sendHistory(p: Peer) {
    const msgs: ChatMsg[] = [];
    let size = 0;
    // Solo texto de esta sesión: ni imágenes ni lo sacado del archivo local.
    for (const m of this.chat.filter((x) => !x.stored && TEXT_KINDS.includes(x.kind ?? 'chat')).slice(-200).reverse()) {
      size += JSON.stringify(m).length;
      if (size > MAX_DC_MESSAGE / 2) break;
      msgs.unshift(m);
    }
    this.send(p, { t: 'history', msgs });
  }

  // Una descripción rechazada deja al otro en have-local-offer, sin renegociar nunca
  // más (H1). No hay forma de volver atrás: se rehace la conexión en ambos lados.
  private onSignalError(p: Peer, data: SignalData, e: unknown) {
    if (this.peers.get(p.id) !== p) return; // conexión ya sustituida
    console.error(e);
    if (!data.description) return;
    const now = Date.now();
    p.resets = p.resets.filter((t) => now - t < RESET_WINDOW_MS);
    if (p.resets.length >= MAX_RESETS) {
      p.failed = true;
      this.signal(p, { failed: true });
      this.emit();
      return;
    }
    p.resets.push(now);
    const next = this.rebuild(p, p.gen + 1);
    this.signal(next, { reset: true });
  }

  // Inicia siempre el mismo lado, para que nunca esperen los dos ni ofrezcan a la vez.
  private rebuild(p: Peer, gen: number) {
    const next = this.createPeer(p.id, p.name, this.myId < p.id, { ...p, gen });
    this.emit();
    return next;
  }

  private async onSignal(p: Peer, data: SignalData) {
    if (this.peers.get(p.id) !== p) return;
    const { pc } = p;
    if (data.description) {
      const desc = data.description;
      const collision = desc.type === 'offer' && (p.makingOffer || pc.signalingState !== 'stable');
      p.ignoreOffer = collision && !yieldsInGlare(navigator.userAgent, desc.sdp ?? '', p.polite);
      if (p.ignoreOffer) return;
      await pc.setRemoteDescription({ type: desc.type, sdp: mungeRemoteSdp(desc.sdp ?? '') });
      if (desc.type === 'offer') {
        await pc.setLocalDescription();
        this.signal(p, { description: pc.localDescription!.toJSON() });
        if (!p.ready) {
          p.ready = true;
          for (const src of this.local.values()) this.attach(p, src);
        }
      }
    } else if (data.candidate) {
      try {
        await pc.addIceCandidate(data.candidate);
      } catch (e) {
        if (!p.ignoreOffer) console.warn('candidate', e);
      }
    }
  }

  // El autor lo pone esta conexión, no el mensaje: nadie puede escribir en nombre de otro.
  private cleanChat(raw: ChatMsg, from: string, name: string, via?: string, key?: string): ChatMsg | null {
    if (!raw || typeof raw.text !== 'string' || typeof raw.id !== 'string' || raw.id.length > MAX_ID_LEN || !raw.id) return null;
    const text = safeText(raw.text);
    if (!text.trim()) return null;
    const ts = Number.isFinite(raw.ts) ? Math.min(raw.ts, Date.now()) : Date.now();
    const msg: ChatMsg = { id: raw.id, from, name, text, ts, via, key };
    const kind = raw.kind ?? 'chat';
    if (!TEXT_KINDS.includes(kind)) return null;
    if (kind !== 'chat') msg.kind = kind;
    return msg;
  }

  private async onImage(p: Peer, raw: ImageChunk) {
    const r = p.images.add(raw);
    if ('error' in r) return console.warn('imagen rechazada', p.name, r.error);
    if (!r.done) return;
    let size: { w: number; h: number };
    try {
      size = await decodedSize(r.bytes, r.head.mime);
    } catch {
      return console.warn('imagen que no decodifica', p.name);
    }
    if (this.peers.get(p.id) !== p || this.chat.some((m) => m.id === r.head.id)) return;
    const msg: ChatMsg = {
      id: r.head.id, from: p.id, name: p.name, text: '', ts: r.head.ts, kind: 'image', key: p.tag,
      image: { url: URL.createObjectURL(new Blob([r.bytes], { type: r.head.mime })), w: size.w, h: size.h, mime: r.head.mime },
    };
    this.addChat([msg]);
    this.record(msg, r.bytes);
    this.fire({ type: 'chat', name: p.name });
    this.emit();
  }

  private async onData(p: Peer, m: DataMsg) {
    if (this.peers.get(p.id) !== p) return;
    if (m.t === 'id') return this.onIdentity(p, m);
    if (!p.proven) return;
    switch (m.t) {
      case 'meta': {
        const wasLive = Object.values(p.kinds).some((k) => k === 'screen' || k === 'file');
        p.muted = !!m.muted;
        p.kinds = Object.fromEntries(
          Object.entries(m.streams ?? {})
            .filter(([id, k]) => id.length <= MAX_ID_LEN && isKind(k))
            .slice(0, MAX_STREAMS),
        );
        p.paused = Array.isArray(m.paused) ? m.paused.filter(isKind) : [];
        const live = Object.values(p.kinds).some((k) => k === 'screen' || k === 'file');
        if (live && !wasLive) this.fire({ type: 'live', name: p.name });
        break;
      }
      case 'chat':
      {
        const msg = this.cleanChat(m.msg, p.id, p.name, undefined, p.tag);
        if (!msg || this.chat.some((x) => x.id === msg.id)) return;
        this.addChat([msg]);
        this.record(msg);
        this.fire({ type: 'chat', name: p.name });
        this.fire({ type: 'message', msg, self: false });
        break;
      }
      case 'img':
        p.images.begin(m);
        return;
      case 'imgc':
        return this.onImage(p, m);
      case 'profile': {
        const name = safeName(m.name);
        if (!name) return;
        p.avatar = cleanAvatar(m.avatar);
        if (name !== p.name) {
          const old = p.name;
          p.name = name;
          // El nombre nuevo pasa por la misma libreta: si ya era de otra clave, avisa.
          p.trust = evaluateTrust(this.trustBook, name, p.pub);
          this.fire({ type: 'rename', name: old, to: name });
        }
        break;
      }
      case 'react':
        if (REACTIONS.includes(m.emoji)) this.fire({ type: 'react', name: p.name, emoji: m.emoji, self: false });
        return;
      case 'history':
        if (p.gotHistory || !Array.isArray(m.msgs)) return;
        p.gotHistory = true;
        // No hay firma por mensaje: quedan marcados como contados por este peer.
        {
          const seen = new Set(this.chat.map((x) => x.id));
          const msgs = m.msgs
            .slice(-200)
            .map((x) => this.cleanChat(x, `via:${p.id}`, safeName(x?.name), p.name))
            .filter((x): x is ChatMsg => !!x && !seen.has(x.id));
          this.addChat(msgs);
          for (const x of msgs) this.record(x);
        }
        break;
    }
    this.emit();
  }

  private meta(): DataMsg {
    const streams: Record<string, SourceKind> = {};
    for (const s of this.local.values()) streams[s.stream.id] = s.kind;
    const paused = [...this.local.values()].filter((s) => s.paused).map((s) => s.kind);
    return { t: 'meta', muted: this.micMuted, streams, paused };
  }

  private sendMeta(p: Peer) {
    this.send(p, this.meta());
  }

  private broadcastMeta() {
    this.broadcast(this.meta());
  }

  private send(p: Peer, m: DataMsg) {
    if (p.dc?.readyState !== 'open') return;
    if (!p.proven) {
      if (p.outbox.length < 64) p.outbox.push(m);
      return;
    }
    try {
      p.dc.send(JSON.stringify(m));
    } catch (e) {
      console.warn('datachannel', e);
    }
  }

  private broadcast(m: DataMsg) {
    for (const p of this.peers.values()) this.send(p, m);
  }

  private closePeer(id: string) {
    const p = this.peers.get(id);
    if (!p) return;
    clearTimeout(p.proofTimer);
    p.images.clear();
    p.pc.close();
    this.peers.delete(id);
  }

  private closePeers() {
    for (const id of [...this.peers.keys()]) this.closePeer(id);
  }
}
