import { useEffect, useRef, useState } from 'react';
import { confettiAt, sfx } from '../fx';
import { useMesh } from '../hooks';
import { captureAndroidScreen, inAndroidApp } from '../android';
import { captureCamera, captureScreen as captureDesktopScreen, videoCodecs, type EncodeOpts, type ShareSettings } from '../media';
import { REACTIONS } from '../mesh';
import { startMic } from '../mixer';
import { Mixer } from './Mixer';
import { Icon, type IconName } from './Icons';

// El WebView de Android no tiene getDisplayMedia: la pantalla llega por la app.
const captureScreen = inAndroidApp ? captureAndroidScreen : captureDesktopScreen;

interface Props {
  share: ShareSettings;
  setShare: (s: ShareSettings) => void;
  screenOpts: (s: ShareSettings) => EncodeOpts;
  onFile: (f: File) => void;
  onLeave: () => void;
  onError: (msg: string) => void;
}

function Seg<T extends string | number>({ value, options, onChange, label }: { value: T; options: [T, string][]; onChange: (v: T) => void; label: string }) {
  return (
    <div className="field">
      <span className="field-label">{label}</span>
      <div className="seg" role="radiogroup" aria-label={label}>
        {options.map(([v, text]) => (
          <button key={String(v)} role="radio" aria-checked={value === v} className={value === v ? 'on' : ''} onClick={() => onChange(v)}>
            <span className="radio" aria-hidden>
              {value === v ? '(•)' : '( )'}
            </span>
            {text}
          </button>
        ))}
      </div>
    </div>
  );
}

function DockButton({ icon, label, on, off, kbd, onClick }: { icon: IconName; label: string; on?: boolean; off?: boolean; kbd: string; onClick: () => void }) {
  return (
    <button className={'dock-btn' + (on ? ' on' : '') + (off ? ' off' : '')} onClick={onClick} aria-pressed={on} title={`${label} (${kbd})`}>
      <span className="fkey">{kbd}</span>
      <span className="flabel">
        <Icon name={icon} size={20} />
        {label}
      </span>
    </button>
  );
}

const BAR = 38;
function bar(frac: number) {
  const n = Math.round(frac * BAR);
  return '█'.repeat(n) + '░'.repeat(BAR - n);
}

const typing = (e: KeyboardEvent) => {
  const t = e.target as HTMLElement;
  return t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable;
};

export function Controls({ share, setShare, screenOpts, onFile, onLeave, onError }: Props) {
  const m = useMesh();
  const [dialog, setDialogState] = useState(false);
  const [mixer, setMixerState] = useState(false);
  // Un panel a la vez: los dos salen del mismo sitio.
  const setDialog = (v: boolean | ((d: boolean) => boolean)) =>
    setDialogState((d) => {
      const next = typeof v === 'function' ? v(d) : v;
      if (next) setMixerState(false);
      return next;
    });
  const setMixer = (v: boolean | ((d: boolean) => boolean)) =>
    setMixerState((d) => {
      const next = typeof v === 'function' ? v(d) : v;
      if (next) setDialogState(false);
      return next;
    });
  const fileInput = useRef<HTMLInputElement>(null);
  const sharing = m.local.has('screen');
  const paused = !!m.local.get('screen')?.paused;

  async function toggleMic() {
    sfx.click();
    if (m.local.has('mic')) return m.setMicMuted(!m.micMuted);
    try {
      await startMic(m);
    } catch (e) {
      onError(`Micro: ${(e as Error).message}`);
    }
  }

  async function toggleCam() {
    sfx.click();
    if (m.local.has('camera')) return m.removeSource('camera');
    try {
      m.addSource('camera', await captureCamera(), { videoBitrate: 3_000_000, audioBitrate: 0, hint: 'motion' });
    } catch (e) {
      onError(`Cámara: ${(e as Error).message}`);
    }
  }

  async function startScreen() {
    setDialog(false);
    try {
      const stream = await captureScreen(share);
      m.addSource('screen', stream, screenOpts(share));
      sfx.live();
      confettiAt(innerWidth / 2, innerHeight - 90);
    } catch (e) {
      if ((e as Error).name !== 'NotAllowedError') onError(`Pantalla: ${(e as Error).message}`);
    }
  }

  async function resumeScreen() {
    setDialog(false);
    try {
      m.resumeSource('screen', await captureScreen(share));
      sfx.live();
    } catch (e) {
      // Cancelar el selector lleva al diálogo: es donde se puede cortar la emisión.
      if ((e as Error).name === 'NotAllowedError') setDialog(true);
      else onError(`Pantalla: ${(e as Error).message}`);
    }
  }

  function applyLive() {
    setDialog(false);
    m.updateOpts('screen', screenOpts(share));
  }

  // Atajos: M micro, C cámara, P pantalla, V vídeo, 1–8 reacciones.
  const keys = useRef({ toggleMic, toggleCam });
  keys.current = { toggleMic, toggleCam };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (typing(e) || e.ctrlKey || e.metaKey || e.altKey) return;
      const k = e.key.toLowerCase();
      if (k === 'm') keys.current.toggleMic();
      else if (k === 'c') keys.current.toggleCam();
      else if (k === 'p') setDialog((d) => !d);
      else if (k === 'v') fileInput.current?.click();
      else if (k === 'x') setMixer((x) => !x);
      else if (/^[1-8]$/.test(k)) m.react(REACTIONS[Number(k) - 1]);
      else if (k === 'escape') {
        setDialog(false);
        setMixer(false);
      }
    };
    addEventListener('keydown', onKey);
    return () => removeEventListener('keydown', onKey);
  }, [m]);

  const viewers = m.peerCount();
  const micOn = m.local.has('mic') && !m.micMuted;
  const upload = share.mbps * Math.max(viewers, 1);

  return (
    <div className="dock-wrap">
      <div className="top-row">
      <div className="reactions" role="toolbar" aria-label="Reacciones">
        {REACTIONS.map((r, i) => (
          <button key={r} className="react-btn" onClick={() => m.react(r)} title={`Reaccionar (${i + 1})`} aria-label={`Reaccionar ${r}`}>
            {r}
          </button>
        ))}
      </div>
      <button
        className={'mix-btn' + (mixer ? ' on' : '')}
        aria-pressed={mixer}
        title="Mesa de mezclas (X)"
        onClick={() => {
          sfx.click();
          setMixer(!mixer);
        }}
      >
        <span className="fkey">X</span>
        <Icon name="mixer" size={18} /> mezcla
      </button>
      </div>
      <div className="dock">
        <DockButton icon={micOn ? 'mic' : 'micOff'} label={micOn ? 'micro' : 'mudo'} on={micOn} off={!micOn} kbd="M" onClick={toggleMic} />
        <DockButton icon="cam" label="cámara" on={m.local.has('camera')} kbd="C" onClick={toggleCam} />
        <button
          className={'go-live' + (sharing ? ' is-live' : '')}
          onClick={() => {
            sfx.click();
            if (paused) resumeScreen();
            else setDialog(!dialog);
          }}
          aria-expanded={dialog}
        >
          <span className="fkey">P</span>
          {paused ? (
            <span className="flabel">⏸ EN PAUSA · reanudar</span>
          ) : sharing ? (
            <span className="flabel">
              <span className="live-dot" /> REC · EN DIRECTO
            </span>
          ) : (
            <span className="flabel">
              <Icon name="screen" size={20} /> ./emitir --pantalla
            </span>
          )}
        </button>
        <DockButton icon="file" label="vídeo" kbd="V" onClick={() => fileInput.current?.click()} />
        <input
          ref={fileInput}
          type="file"
          accept="video/*,.mkv"
          hidden
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) onFile(f);
            e.target.value = '';
          }}
        />
        <button className="dock-btn leave" onClick={onLeave} title="Salir de la sala">
          <span className="fkey">^D</span>
          <span className="flabel">
            <Icon name="leave" size={20} />
            exit
          </span>
        </button>
      </div>

      {mixer && <Mixer onClose={() => setMixer(false)} />}
      {dialog && (
        <div className="dialog" role="dialog" aria-label={sharing ? 'Ajustes de emisión' : 'Compartir pantalla'}>
          <div className="dialog-title">
            <span>┤ {paused ? 'emisión en pausa' : sharing ? 'ajustes en directo' : 'sal en directo'} ├</span>
            <button className="mini-btn" onClick={() => setDialog(false)} aria-label="Cerrar">
              [x]
            </button>
          </div>
          {paused && (
            <p className="pause-note">
              El navegador cortó la captura; Firefox lo hace al minimizar la ventana compartida. Los demás conservan tu
              ficha en pausa. Para reanudar hay que volver a elegir qué compartir.
            </p>
          )}
          {!sharing && (
            <>
              <Seg
                label="Resolución"
                value={share.res}
                onChange={(res) => setShare({ ...share, res })}
                options={[
                  ['native', 'NATIVA'],
                  ['2160', '4K'],
                  ['1440', '1440'],
                  ['1080', '1080'],
                  ['720', '720'],
                ]}
              />
              <Seg
                label="FPS"
                value={share.fps}
                onChange={(fps) => setShare({ ...share, fps })}
                options={[
                  [30, '30'],
                  [60, '60'],
                  [120, '120'],
                  [144, '144'],
                ]}
              />
              <div className="field">
                <label className="field-label" htmlFor="codec">
                  Codec
                </label>
                <select id="codec" value={share.codec} onChange={(e) => setShare({ ...share, codec: e.target.value })}>
                  <option value="">Automático</option>
                  {videoCodecs().map((c) => (
                    <option key={c} value={c}>
                      {c.replace('video/', '')}
                    </option>
                  ))}
                </select>
              </div>
              <label className="toggle">
                <input type="checkbox" checked={share.audio} onChange={(e) => setShare({ ...share, audio: e.target.checked })} />
                <span className="toggle-track" aria-hidden />
                Audio del sistema / pestaña
              </label>
            </>
          )}
          <Seg
            label="Prioridad"
            value={share.hint}
            onChange={(hint) => setShare({ ...share, hint })}
            options={[
              ['detail', 'NITIDEZ · texto'],
              ['motion', 'FLUIDEZ · juegos'],
            ]}
          />
          <div className="field">
            <label className="field-label" htmlFor="mbps">
              Bitrate <b className="big-num">{share.mbps}</b> Mbps
            </label>
            <div className="slider-wrap">
              <span className="slider-bar" aria-hidden>
                [<span className="fill">{bar((share.mbps - 2) / 78)}</span>]
              </span>
              <input
                id="mbps"
                className="slider"
                type="range"
                min={2}
                max={80}
                step={1}
                value={share.mbps}
                onChange={(e) => setShare({ ...share, mbps: Number(e.target.value) })}
              />
            </div>
          </div>
          <div className={'upload' + (upload > 100 ? ' hot' : '')}>
            <span>tu subida</span>
            <b>{upload} Mbps</b>
            <small>
              {share.mbps} × {Math.max(viewers, 1)} {viewers === 1 ? 'espectador' : 'espectadores'} · malla P2P
            </small>
          </div>
          <div className="dialog-actions">
            {sharing ? (
              <>
                <button
                  className="btn ghost-danger"
                  onClick={() => {
                    setDialog(false);
                    m.removeSource('screen');
                  }}
                >
                  cortar emisión
                </button>
                {paused ? (
                  <button className="btn chunky" onClick={resumeScreen}>
                    elegir y reanudar ⏎
                  </button>
                ) : (
                  <button className="btn chunky" onClick={applyLive}>
                    aplicar
                  </button>
                )}
              </>
            ) : (
              <button className="btn chunky wide" onClick={startScreen}>
                <span className="live-dot" /> elegir pantalla y emitir ⏎
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
