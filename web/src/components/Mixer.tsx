import { useEffect, useRef } from 'react';
import { colorFor } from '../fx';
import { useMesh } from '../hooks';
import type { SourceKind } from '../mesh';
import { FLOOR_DB, RECV_MAX_DB, SEND_MAX_DB, fmtDb, gainToDb, measure, micProcessed, peerKey, useMix, type Fader } from '../mixer';
import { Avatar } from './Sidebar';

const KIND_LABEL: Record<SourceKind, string> = { mic: 'micro', camera: 'cámara', screen: 'pantalla', file: 'vídeo' };
const METER_MIN = -60;
const TICKS = [0, -6, -12, -24, -36, -48];

type Input = { stream: MediaStream; gain: number };

const pct = (db: number) => Math.max(0, Math.min(1, (db - METER_MIN) / -METER_MIN)) * 100;
const hasAudio = (s: MediaStream) => s.getAudioTracks().length > 0;

// Medidor vertical en dBFS de lo que de verdad suena (tras todos los faders): RMS en la
// barra, pico con retención y testigo de saturación. Se pinta fuera de React.
export function Meter({ inputs, label }: { inputs: Input[]; label: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const live = useRef(inputs);
  live.current = inputs;
  useEffect(() => {
    let raf = 0;
    let hold = -Infinity;
    let holdAt = 0;
    let clipUntil = 0;
    let level = -Infinity;
    let last = performance.now();
    const draw = (now: number) => {
      const el = ref.current;
      if (el) {
        const { rms, peak } = measure(live.current);
        const peakDb = gainToDb(peak);
        if (peakDb >= hold || now - holdAt > 1200) {
          hold = peakDb;
          holdAt = now;
        }
        if (peakDb >= -0.3) clipUntil = now + 1500;
        // Sube al instante y cae a 24 dB/s: se lee sin parpadeo.
        const rmsDb = gainToDb(rms);
        level = Math.max(rmsDb, Math.max(level, METER_MIN) - ((now - last) / 1000) * 24);
        last = now;
        el.style.setProperty('--lvl', `${pct(level)}%`);
        el.style.setProperty('--peak', `${pct(hold)}%`);
        el.classList.toggle('clip', now < clipUntil);
        el.dataset.peak = hold > METER_MIN ? hold.toFixed(0) : '-∞';
      }
      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, []);
  return (
    <div ref={ref} className="meter" role="img" aria-label={`Nivel de ${label}`}>
      <div className="meter-fill" />
      <div className="meter-peak" />
      {TICKS.map((t) => (
        <i key={t} className="meter-tick" style={{ bottom: `${pct(t)}%` }} data-db={t} />
      ))}
    </div>
  );
}

interface StripProps {
  id: string;
  label: string;
  sub: string;
  color: string;
  fader: Fader;
  max: number;
  onChange: (f: Partial<Fader>) => void;
  inputs: Input[];
  solo?: boolean;
  onSolo?: () => void;
  bus?: boolean;
  disabled?: string; // por qué el fader no actúa
  muteLabel?: string;
}

function Strip(p: StripProps) {
  const zero = ((0 - FLOOR_DB) / (p.max - FLOOR_DB)) * 100;
  return (
    <div className={'strip' + (p.bus ? ' bus' : '') + (p.fader.mute ? ' muted' : '')} style={{ ['--c' as string]: p.color }}>
      <div className="strip-sub">{p.sub}</div>
      <output className="strip-db" htmlFor={p.id}>
        {fmtDb(p.fader.db)}
        <small> dB</small>
      </output>
      <div className="strip-body">
        <Meter inputs={p.inputs} label={`${p.label}, ${p.sub}`} />
        <div className="fader-wrap" style={{ ['--zero' as string]: `${zero}%` }}>
          <input
            id={p.id}
            className="fader"
            type="range"
            min={FLOOR_DB}
            max={p.max}
            step={0.5}
            value={p.fader.db}
            disabled={!!p.disabled}
            title={p.disabled ?? 'Doble clic: 0 dB'}
            aria-label={`Ganancia de ${p.label}, ${p.sub}`}
            aria-valuetext={`${fmtDb(p.fader.db)} dB`}
            onChange={(e) => p.onChange({ db: Number(e.target.value) })}
            onDoubleClick={() => p.onChange({ db: 0 })}
          />
        </div>
      </div>
      <div className="strip-btns">
        <button
          className={'mini-btn mute' + (p.fader.mute ? ' on' : '')}
          aria-pressed={p.fader.mute}
          aria-label={`Silenciar ${p.label}, ${p.sub}`}
          title={p.muteLabel ?? 'Silenciar'}
          onClick={() => p.onChange({ mute: !p.fader.mute })}
        >
          M
        </button>
        {p.onSolo && (
          <button className={'mini-btn solo' + (p.solo ? ' on' : '')} aria-pressed={p.solo} aria-label={`Solo ${p.label}`} title="Solo: oír solo a quien lo tenga" onClick={p.onSolo}>
            S
          </button>
        )}
      </div>
      <div className="strip-label" title={p.label}>
        {p.label}
      </div>
    </div>
  );
}

function ReadonlyStrip({ sub, color, stream }: { sub: string; color: string; stream: MediaStream }) {
  return (
    <div className="strip readonly" style={{ ['--c' as string]: color }}>
      <div className="strip-sub">{sub}</div>
      <div className="strip-db">tal cual</div>
      <div className="strip-body">
        <Meter inputs={[{ stream, gain: 1 }]} label={`tu ${sub}`} />
      </div>
      <div className="strip-label">tú</div>
    </div>
  );
}

export function Mixer({ onClose }: { onClose: () => void }) {
  const m = useMesh();
  const mix = useMix();
  const peers = m.peerViews();
  const present = peers.map(peerKey);
  const me = colorFor(m.name);
  const send = mix.send();
  const mic = m.local.get('mic');
  const all: Input[] = [];

  return (
    <div className="dialog mixer" role="dialog" aria-label="Mesa de mezclas">
      <div className="dialog-title">
        <span>┤ mezcla ├</span>
        <button className="mini-btn" onClick={onClose} aria-label="Cerrar">
          [x]
        </button>
      </div>
      <div className="console">
        <section className="channel-group" style={{ ['--c' as string]: me }} aria-label="Lo que envías">
          <header className="group-head">
            <Avatar name={m.name} avatar={m.avatar} size={22} />
            <span>{m.name} (tú)</span>
          </header>
          <div className="group-strips">
            {mic ? (
              <Strip
                id="fader-send-mic"
                label="tú"
                sub="micro → envío"
                color={me}
                fader={{ db: send.db, mute: m.micMuted }}
                max={SEND_MAX_DB}
                inputs={[{ stream: mic.stream, gain: 1 }]}
                onChange={(f) => {
                  if (f.db !== undefined) mix.setSend({ db: f.db });
                  if (f.mute !== undefined) m.setMicMuted(f.mute);
                }}
                muteLabel="Silenciar micro (M)"
                disabled={micProcessed() ? undefined : 'Sin control de envío: el audio del navegador no arrancó'}
              />
            ) : (
              <div className="strip empty">sin micro</div>
            )}
            {(['screen', 'file'] as const).map((k) => {
              const s = m.local.get(k);
              return s && hasAudio(s.stream) ? <ReadonlyStrip key={k} sub={`${KIND_LABEL[k]} → envío`} color={me} stream={s.stream} /> : null;
            })}
          </div>
        </section>

        {peers.map((p) => {
          const key = peerKey(p);
          const color = colorFor(p.name);
          const sources = p.sources.filter((s) => hasAudio(s.stream));
          const inputs = sources.map((s) => ({ stream: s.stream, gain: mix.gain(key, s.kind, present) }));
          all.push(...inputs);
          return (
            <section key={p.id} className="channel-group" style={{ ['--c' as string]: color }} aria-label={`Canales de ${p.name}`}>
              <header className="group-head">
                <Avatar name={p.name} avatar={p.avatar} size={22} />
                <span>{p.name}</span>
              </header>
              <div className="group-strips">
                {sources.length === 0 && <div className="strip empty">sin audio</div>}
                {sources.map((s, i) => (
                  <Strip
                    key={s.id}
                    id={`fader-${p.id}-${s.kind}`}
                    label={p.name}
                    sub={KIND_LABEL[s.kind]}
                    color={color}
                    fader={mix.source(key, s.kind)}
                    max={RECV_MAX_DB}
                    inputs={[inputs[i]]}
                    onChange={(f) => mix.setSource(key, s.kind, f)}
                  />
                ))}
                <Strip
                  bus
                  id={`fader-${p.id}`}
                  label={p.name}
                  sub="persona"
                  color={color}
                  fader={mix.peer(key)}
                  max={RECV_MAX_DB}
                  inputs={inputs}
                  onChange={(f) => mix.setPeer(key, f)}
                  solo={mix.soloed(key)}
                  onSolo={() => mix.toggleSolo(key)}
                />
              </div>
            </section>
          );
        })}

        <section className="channel-group master" style={{ ['--c' as string]: 'var(--amber)' }} aria-label="Salida">
          <header className="group-head">
            <span>salida</span>
          </header>
          <div className="group-strips">
            <Strip bus id="fader-master" label="master" sub="lo que oyes" color="var(--amber)" fader={mix.master()} max={RECV_MAX_DB} inputs={all} onChange={(f) => mix.setMaster(f)} />
          </div>
        </section>
      </div>
      <p className="mixer-note dim">
        Los medidores marcan lo que suena tras los faders. Recibir solo baja: para subir a alguien, que suba su envío. Se guarda por
        dispositivo, aunque cambie de nombre.
      </p>
    </div>
  );
}
