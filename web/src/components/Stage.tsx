import { useEffect, useRef, useState, type ReactNode } from 'react';
import { fmtStat, mesh, useInboundStats, useMesh, useOutboundStats, useSpeaking } from '../hooks';
import { colorFor, confettiAt, sfx } from '../fx';
import { captureElement, type EncodeOpts } from '../media';
import type { SourceKind } from '../mesh';
import { Icon } from './Icons';
import { Avatar } from './Sidebar';
import { FLOOR_DB, fmtDb, peerKey, useMix } from '../mixer';
import { Topo } from './Topo';

const KIND_LABEL: Record<SourceKind, string> = { mic: 'micro', camera: 'cámara', screen: 'pantalla', file: 'vídeo' };

function Video({ stream, mirror }: { stream: MediaStream; mirror?: boolean }) {
  const ref = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    if (ref.current && ref.current.srcObject !== stream) ref.current.srcObject = stream;
  }, [stream]);
  return <video ref={ref} autoPlay playsInline muted className={mirror ? 'mirror' : ''} />;
}

// Las pistas de audio remotas suenan por aquí; los <video> van siempre mudos.
function AudioSink({ stream, volume }: { stream: MediaStream; volume: number }) {
  const ref = useRef<HTMLAudioElement>(null);
  useEffect(() => {
    if (ref.current && ref.current.srcObject !== stream) ref.current.srcObject = stream;
  }, [stream]);
  useEffect(() => {
    if (ref.current) ref.current.volume = volume;
  }, [volume]);
  return <audio ref={ref} autoPlay />;
}

interface TileProps {
  tileKey: string;
  color: string;
  live?: boolean;
  focus: string | null;
  setFocus: (k: string | null) => void;
  label: ReactNode;
  speaking?: boolean;
  stats?: string[];
  showStats?: boolean;
  onToggleStats?: () => void;
  children: ReactNode;
  extra?: ReactNode;
}

function Tile(p: TileProps) {
  const ref = useRef<HTMLDivElement>(null);
  const focused = p.focus === p.tileKey;
  return (
    <div
      ref={ref}
      className={'tile' + (focused ? ' focused' : '') + (p.speaking ? ' speaking' : '') + (p.live ? ' live' : '')}
      style={{ ['--c' as string]: p.color }}
      onClick={() => p.setFocus(focused ? null : p.tileKey)}
      onDoubleClick={() => ref.current?.requestFullscreen()}
    >
      {p.children}
      {p.live && (
        <span className="live-badge">
          <span className="live-dot" />
          REC
        </span>
      )}
      <div className="tile-bar" onClick={(e) => e.stopPropagation()} onDoubleClick={(e) => e.stopPropagation()}>
        <span className="tile-label">{p.label}</span>
        {p.extra}
        {p.onToggleStats && (
          <button className={'icon-btn' + (p.showStats ? ' on' : '')} title="Stats" aria-label="Stats" onClick={p.onToggleStats}>
            <Icon name="stats" size={16} />
          </button>
        )}
        <button className="icon-btn" title="Pantalla completa" aria-label="Pantalla completa" onClick={() => ref.current?.requestFullscreen()}>
          <Icon name="expand" size={16} />
        </button>
      </div>
      {p.showStats && p.stats && p.stats.length > 0 && (
        <div className="stats">
          {p.stats.map((s, i) => (
            <div key={i}>{s}</div>
          ))}
        </div>
      )}
    </div>
  );
}

type Common = { focus: string | null; setFocus: (k: string | null) => void };

function RemoteVideoTile({ peerId, name, kind, stream, paused, ...c }: Common & { peerId: string; name: string; kind: SourceKind; stream: MediaStream; paused: boolean }) {
  const [show, setShow] = useState(false);
  const stat = useInboundStats(peerId, stream.getVideoTracks()[0], show);
  return (
    <Tile
      {...c}
      tileKey={`${peerId}:${stream.id}`}
      color={colorFor(name)}
      live={!paused && (kind === 'screen' || kind === 'file')}
      label={`${name} · ${KIND_LABEL[kind]}${paused ? ' · en pausa' : ''}`}
      stats={stat ? [fmtStat(stat)] : ['midiendo…']}
      showStats={show}
      onToggleStats={() => setShow(!show)}
    >
      <Video stream={stream} />
    </Tile>
  );
}

function LocalVideoTile({ kind, stream, color, paused, ...c }: Common & { kind: 'camera' | 'screen'; stream: MediaStream; color: string; paused: boolean }) {
  const [show, setShow] = useState(false);
  const stats = useOutboundStats(kind, show);
  return (
    <Tile
      {...c}
      tileKey={`local:${kind}`}
      color={color}
      live={!paused && kind === 'screen'}
      label={`Tú · ${KIND_LABEL[kind]}${paused ? ' · en pausa' : ''}`}
      stats={stats.length ? stats.map((s) => `→ ${s.peer}: ${fmtStat(s)}`) : ['nadie recibiendo']}
      showStats={show}
      onToggleStats={() => setShow(!show)}
    >
      <Video stream={stream} mirror={kind === 'camera'} />
    </Tile>
  );
}

function AvatarTile({ name, avatar, label, mic, muted, extra, ...c }: Common & { tileKey: string; name: string; avatar: string; label: string; mic?: MediaStream; muted: boolean; extra?: ReactNode }) {
  const speaking = useSpeaking(muted ? undefined : mic);
  return (
    <Tile {...c} color={colorFor(name)} label={label} speaking={speaking} extra={extra}>
      <div className="avatar">
        <div className="avatar-rings" aria-hidden>
          <i />
          <i />
          <i />
        </div>
        <Avatar name={name} avatar={avatar} size={110} speaking={speaking} />
        {muted && (
          <div className="avatar-muted" aria-label="Micro silenciado">
            <Icon name="micOff" size={16} />
          </div>
        )}
      </div>
    </Tile>
  );
}

// El emisor ve su propio <video controls>; lo que se reproduce aquí es lo que
// reciben los demás vía captureStream(). Play/pausa/seek mandan para todos.
function FileTile({ file, opts, onClose, color, ...c }: Common & { file: File; opts: EncodeOpts; onClose: () => void; color: string }) {
  const ref = useRef<HTMLVideoElement>(null);
  const [show, setShow] = useState(false);
  const stats = useOutboundStats('file', show);
  const [url] = useState(() => URL.createObjectURL(file));
  const optsRef = useRef(opts);
  optsRef.current = opts;

  useEffect(() => {
    const el = ref.current!;
    let stream: MediaStream | null = null;
    const start = () => {
      if (stream) return;
      stream = captureElement(el);
      mesh.addSource('file', stream, optsRef.current);
      // Chrome añade las pistas cuando hay datos; re-adjunta si aparecen más tarde.
      stream.onaddtrack = () => mesh.addSource('file', stream!, optsRef.current);
    };
    el.addEventListener('playing', start);
    return () => {
      el.removeEventListener('playing', start);
      mesh.removeSource('file');
      URL.revokeObjectURL(url);
    };
  }, [url]);

  return (
    <Tile
      {...c}
      tileKey="local:file"
      color={color}
      live
      label={`Tú · ${file.name}`}
      stats={stats.length ? stats.map((s) => `→ ${s.peer}: ${fmtStat(s)}`) : ['dale a play para emitir']}
      showStats={show}
      onToggleStats={() => setShow(!show)}
      extra={
        <button className="icon-btn" title="Dejar de emitir" aria-label="Dejar de emitir" onClick={onClose}>
          <Icon name="x" size={16} />
        </button>
      }
    >
      <video ref={ref} src={url} controls playsInline onClick={(e) => e.stopPropagation()} />
    </Tile>
  );
}

export function Stage({ file, fileOpts, onCloseFile }: { file: File | null; fileOpts: EncodeOpts; onCloseFile: () => void }) {
  const m = useMesh();
  const [focus, setFocus] = useState<string | null>(null);
  const mix = useMix();
  const c = { focus, setFocus };
  const peers = m.peerViews();
  const local = m.local;
  const present = peers.map(peerKey);
  const me = colorFor(m.name);

  const tiles: ReactNode[] = [];
  if (file) tiles.push(<FileTile key="local:file" file={file} opts={fileOpts} onClose={onCloseFile} color={me} {...c} />);
  for (const kind of ['screen', 'camera'] as const) {
    const s = local.get(kind);
    if (s) tiles.push(<LocalVideoTile key={`local:${kind}`} kind={kind} stream={s.stream} color={me} paused={!!s.paused} {...c} />);
  }
  if (!local.has('camera'))
    tiles.push(<AvatarTile key="avatar:me" tileKey="avatar:me" name={m.name} avatar={m.avatar} label={`${m.name} (tú)`} mic={local.get('mic')?.stream} muted={m.micMuted} {...c} />);

  for (const p of peers) {
    const vids = p.sources.filter((s) => s.stream.getVideoTracks().length > 0);
    for (const s of vids)
      tiles.push(<RemoteVideoTile key={`${p.id}:${s.id}`} peerId={p.id} name={p.name} kind={s.kind} stream={s.stream} paused={s.paused} {...c} />);
    if (!vids.some((s) => s.kind === 'camera')) {
      const key = peerKey(p);
      const fader = mix.peer(key);
      tiles.push(
        <AvatarTile
          key={`avatar:${p.id}`}
          tileKey={`avatar:${p.id}`}
          name={p.name}
          avatar={p.avatar}
          label={
            p.trust === 'bad'
              ? `${p.name} · identidad falsa`
              : p.tampered
                ? `${p.name} · clave distinta`
                : p.failed
                  ? `${p.name} · sin conexión`
                  : p.state === 'connected'
                    ? `${p.name}${p.trust === 'changed' || p.duplicate ? ' ⚠' : ''}`
                    : `${p.name} · conectando…`
          }
          mic={p.sources.find((s) => s.kind === 'mic')?.stream}
          muted={p.muted}
          extra={
            <input
              className="volume"
              type="range"
              min={FLOOR_DB}
              max={0}
              step={0.5}
              value={fader.db}
              title={`Volumen ${fmtDb(fader.db)} dB · mezcla completa con X`}
              aria-label={`Volumen de ${p.name}`}
              onChange={(e) => mix.setPeer(key, { db: Number(e.target.value) })}
            />
          }
          {...c}
        />,
      );
    }
  }

  const hasFocus = focus !== null && tiles.some((t) => (t as { key: string }).key === focus);

  return (
    <div className={'stage' + (hasFocus ? ' has-focus' : '') + ` n${Math.min(tiles.length, 6)}`}>
      {tiles}
      {peers.length === 0 && <Alone />}
      {peers.flatMap((p) =>
        p.sources
          .filter((s) => s.stream.getAudioTracks().length > 0)
          .map((s) => <AudioSink key={`audio:${p.id}:${s.id}`} stream={s.stream} volume={Math.min(1, mix.gain(peerKey(p), s.kind, present))} />),
      )}
    </div>
  );
}

function Alone() {
  const [copied, setCopied] = useState(false);
  return (
    <div className="alone">
      <Topo />
      <div className="alone-big">
        <span className="dim">$</span> who
        <br />
        <span>(nadie más)</span>
        <span className="cursor" aria-hidden />
      </div>
      <button
        className="btn chunky"
        onClick={async (e) => {
          await navigator.clipboard.writeText(location.href);
          setCopied(true);
          sfx.join();
          const r = e.currentTarget.getBoundingClientRect();
          confettiAt(r.left + r.width / 2, r.top + r.height / 2);
          setTimeout(() => setCopied(false), 2000);
        }}
      >
        <Icon name="link" /> {copied ? 'copiado ✓' : 'cp enlace --portapapeles'}
      </button>
    </div>
  );
}
