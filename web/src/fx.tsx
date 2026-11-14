import { useEffect, useState } from 'react';
import { audioCtx, mesh } from './hooks';
import type { MeshEvent } from './mesh';

// Paleta ANSI brillante: cada persona tiene un color estable derivado de su
// nombre, igual en todos los navegadores sin tener que mandarlo por la red.
export const CANDY = ['#5fff5f', '#ffd75f', '#5fd7ff', '#ff5fd7', '#ff875f', '#af87ff', '#5fffd7', '#ff5f5f'];
const GLYPHS = ['*', '+', '#', '@', '%', '&', '$', '~', '>', '█', '▓', '░'];

export function colorFor(name: string) {
  let h = 2166136261;
  for (let i = 0; i < name.length; i++) h = Math.imul(h ^ name.charCodeAt(i), 16777619);
  // FNV solo deja los bits bajos mal repartidos para nombres cortos: avalancha final.
  h ^= h >>> 16;
  h = Math.imul(h, 0x45d9f3b);
  h ^= h >>> 16;
  return CANDY[(h >>> 0) % CANDY.length];
}

export const reducedMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

// ---- sonido: blips sintetizados, nada que descargar ----

let sfxOn = localStorage.getItem('newchord.sfx') !== '0';
export const sfxEnabled = () => sfxOn;
export function setSfx(on: boolean) {
  sfxOn = on;
  localStorage.setItem('newchord.sfx', on ? '1' : '0');
}

function tones(notes: [freq: number, at: number, dur: number][], type: OscillatorType = 'triangle', vol = 0.08) {
  if (!sfxOn) return;
  const c = audioCtx();
  const t0 = c.currentTime;
  for (const [f, at, dur] of notes) {
    const o = c.createOscillator();
    const g = c.createGain();
    o.type = type;
    o.frequency.value = f;
    g.gain.setValueAtTime(0, t0 + at);
    g.gain.linearRampToValueAtTime(vol, t0 + at + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + at + dur);
    o.connect(g).connect(c.destination);
    o.start(t0 + at);
    o.stop(t0 + at + dur + 0.02);
  }
}

export const sfx = {
  join: () => tones([[523, 0, 0.12], [659, 0.08, 0.12], [784, 0.16, 0.2]]),
  leave: () => tones([[659, 0, 0.12], [440, 0.09, 0.22]]),
  live: () => tones([[392, 0, 0.1], [523, 0.07, 0.1], [659, 0.14, 0.1], [1047, 0.21, 0.35]], 'square', 0.05),
  chat: () => tones([[1175, 0, 0.07], [1568, 0.05, 0.1]], 'sine', 0.06),
  pop: () => tones([[880 + Math.random() * 400, 0, 0.08]], 'sine', 0.05),
  click: () => tones([[220, 0, 0.05]], 'square', 0.03),
};

// ---- capa visual ----

interface Floater {
  id: number;
  emoji: string;
  x: number;
  drift: number;
  name: string;
}
interface Burst {
  id: number;
  x: number;
  y: number;
}
interface Toast {
  id: number;
  text: string;
  color: string;
  kind: string;
}

let seq = 0;

export function confettiAt(x: number, y: number) {
  window.dispatchEvent(new CustomEvent('cryptopo:burst', { detail: { x, y } }));
}

export function FxLayer() {
  const [floaters, setFloaters] = useState<Floater[]>([]);
  const [bursts, setBursts] = useState<Burst[]>([]);
  const [toasts, setToasts] = useState<Toast[]>([]);

  useEffect(() => {
    const later = <T extends { id: number }>(set: (f: (xs: T[]) => T[]) => void, id: number, ms: number) =>
      setTimeout(() => set((xs) => xs.filter((x) => x.id !== id)), ms);

    const burst = (x: number, y: number) => {
      if (reducedMotion()) return;
      const id = ++seq;
      setBursts((b) => [...b, { id, x, y }]);
      later(setBursts, id, 1200);
    };
    const toast = (text: string, color: string, kind: string) => {
      const id = ++seq;
      setToasts((t) => [...t.slice(-3), { id, text, color, kind }]);
      later(setToasts, id, 3500);
    };

    const onBurst = (e: Event) => {
      const { x, y } = (e as CustomEvent).detail;
      burst(x, y);
    };
    window.addEventListener('cryptopo:burst', onBurst);

    const off = mesh.onEvent((e: MeshEvent) => {
      switch (e.type) {
        case 'react': {
          sfx.pop();
          const id = ++seq;
          setFloaters((f) => [...f.slice(-40), { id, emoji: e.emoji, x: 10 + Math.random() * 80, drift: Math.random() * 80 - 40, name: e.name }]);
          later(setFloaters, id, 2600);
          break;
        }
        case 'join':
          sfx.join();
          toast(`*** ${e.name} ha entrado en el canal`, colorFor(e.name), 'join');
          burst(innerWidth / 2, innerHeight * 0.35);
          break;
        case 'leave':
          sfx.leave();
          toast(`*** ${e.name} se ha ido (Quit)`, colorFor(e.name), 'leave');
          break;
        case 'live':
          sfx.live();
          toast(`● REC  ${e.name} está emitiendo`, colorFor(e.name), 'live');
          burst(innerWidth / 2, innerHeight / 2);
          break;
        case 'rename':
          toast(`*** ${e.name} ahora se llama ${e.to}`, colorFor(e.to), 'join');
          break;
        case 'chat':
          sfx.chat();
          break;
      }
    });
    return () => {
      off();
      window.removeEventListener('cryptopo:burst', onBurst);
    };
  }, []);

  return (
    <div className="fx" aria-live="polite">
      {floaters.map((f) => (
        <div key={f.id} className="floater" style={{ left: `${f.x}%`, ['--drift' as string]: `${f.drift}px`, ['--c' as string]: colorFor(f.name) }}>
          <span className="floater-emoji">{f.emoji}</span>
          <span className="floater-name">{f.name}</span>
        </div>
      ))}
      {bursts.map((b) => (
        <div key={b.id} className="burst" style={{ left: b.x, top: b.y }}>
          {Array.from({ length: 22 }, (_, i) => (
            <i key={i} style={{ ['--a' as string]: `${(i / 22) * 360}deg`, ['--d' as string]: `${90 + (i % 3) * 55}px`, color: CANDY[i % CANDY.length] }}>
              {GLYPHS[(i * 7) % GLYPHS.length]}
            </i>
          ))}
        </div>
      ))}
      <div className="toasts">
        {toasts.map((t) => (
          <div key={t.id} className={`event-toast ${t.kind}`} style={{ ['--c' as string]: t.color }}>
            {t.text}
          </div>
        ))}
      </div>
    </div>
  );
}
