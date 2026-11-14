// Pestaña Sesiones: cada persona en sala es un bicho en texto, al estilo tamagotchi.
// Los nombres los escribe gente de internet: todo va por textContent, nunca HTML.

export type Session = { name: string; room: string; ip: string; joinedAt: string; leftAt: string; reason: string };

type Seg = [string, string?];
type Line = Seg[];

const SLOT = 12;

const LEFT: Record<string, [string, string, string]> = {
  leave: ['~', 'd', 'se fue'],
  disconnect: ['x', 'r', 'se cayó'],
  switch: ['>', 'a', 'cambió de sala'],
  delete: ['·', 'd', 'sala borrada'],
  'password-changed': ['!', 'a', 'clave cambiada'],
  'server-stop': ['■', 'd', 'server parado'],
  interrupted: ['x', 'r', 'cortado'],
};

// Fuera lo que rompe el ancho fijo (emoji, CJK, controles): se ve como ·.
function clean(s: string, max: number) {
  const t = Array.from((s || '?').replace(/[^\x20-\x7e\u00a0-\u024f]/g, '·'));
  return t.length > max ? t.slice(0, max - 1).join('') + '…' : t.join('');
}

function hash(s: string) {
  let h = 7;
  for (const c of s) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return h;
}

function age(ms: number) {
  const m = Math.max(0, Math.floor(ms / 60000));
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}`;
}

function len(l: Line) {
  return l.reduce((n, [t]) => n + Array.from(t).length, 0);
}

function pad(l: Line, w: number): Line {
  const n = len(l);
  return n < w ? [...l, [' '.repeat(w - n)]] : l;
}

function box(title: Line, w: number, body: Line[]): Line[] {
  const top: Line = [['┌─ ', 'l'], ...title, [' ', 'l']];
  top.push(['─'.repeat(Math.max(0, w + 1 - len(top))) + '┐', 'l']);
  return [
    top,
    ...body.map((l): Line => [['│', 'l'], ...pad(l, w), ['│', 'l']]),
    [['└' + '─'.repeat(w) + '┘', 'l']],
  ];
}

// Ánimo según el tiempo en sala: recién llegado, contento, tranquilo, dormido.
function pet(s: Session, now: number, tick: number) {
  const ms = now - Date.parse(s.joinedAt);
  const h = hash(s.name + s.joinedAt);
  const t = tick + (h % 13);
  const mood = ms < 2 * 60e3 ? 'new' : ms < 30 * 60e3 ? 'happy' : ms < 2 * 3600e3 ? 'calm' : 'sleepy';
  const blink = mood !== 'sleepy' && t % 11 === 0;
  const face = blink ? '(-_-)' : { new: '(o.o)', happy: '(^_^)', calm: '(•_•)', sleepy: '(-_-)' }[mood];
  const float: Seg = mood === 'new' ? ['  !', 'a']
    : mood === 'sleepy' ? [t % 4 < 2 ? '   z' : '  Z ', 'd']
    : mood === 'happy' && t % 6 < 2 ? ['   ♪', 'g'] : [''];
  const still = mood === 'sleepy';
  const step = still ? 1 : [0, 1, 2, 3, 2, 1][Math.floor(t / 2) % 6];
  const arms = still ? '/|_|\\' : t % 2 ? '\\|_|/' : '/|_|\\';
  const legs = still || t % 4 < 2 ? ' / \\ ' : ' | | ';
  const sp = ' '.repeat(step + 1);
  const cls = mood === 'sleepy' ? 'd' : 'g';
  return {
    float: [[sp], float] as Line,
    head: [[sp], [face, mood === 'new' ? 'a' : 'gb']] as Line,
    arms: [[sp + arms, cls]] as Line,
    legs: [[sp + legs, cls]] as Line,
    name: [[' ' + clean(s.name, SLOT - 2), 'gb']] as Line,
    age: [[' ' + age(ms), 'd']] as Line,
  };
}

function room(name: string, live: Session[], now: number, tick: number): Line[] {
  const w = Math.max(30, live.length * SLOT + 2);
  const pets = live.map((s) => pet(s, now, tick));
  const row = (k: keyof ReturnType<typeof pet>): Line => [['  '], ...pets.flatMap((p) => pad(p[k], SLOT))];
  const ground = Array.from({ length: w }, (_, i) => '_.,_._,.'[(i + Math.floor(tick / 3)) % 8]).join('');
  return box([['#' + clean(name, 20), 'gb'], [' · ', 'l'], [`${live.length} en sala`, 'd']], w, [
    [],
    row('float'),
    row('head'),
    row('arms'),
    row('legs'),
    [[ground, 'l']],
    row('name'),
    row('age'),
  ]);
}

// Sala vacía: una bola de paja rueda por el desierto. Con el server parado no sopla el viento.
// Bola de 4×2: el borde se rellena de símbolos al azar (glitch) que cambian cada 3 ticks
// (600 ms), y un radio brillante da la vuelta al anillo, que es lo que hace que parezca que gira.
const GLITCH = '#%&@$*+=x?!/\\|<>~:;';
const RING: [number, number][] = [[0, 0], [0, 1], [0, 2], [0, 3], [1, 3], [1, 2], [1, 1], [1, 0]];
type Cell = [string, string];

// Azar repetible: el mismo seed da los mismos símbolos, así no cambian en cada fotograma.
function rnd(seed: number, n: number) {
  let h = Math.imul(seed ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul(n + 1, 0xc2b2ae35);
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

function weed(spin: number, seed: number, live: boolean): Cell[][] {
  const g: Cell[][] = [[], []];
  RING.forEach(([r, c], i) => {
    const k = (i - spin + 8) % 8;
    const hot = live && rnd(seed, i * 3) < 0.12;
    const sym = GLITCH[Math.floor(rnd(seed, i * 3 + 1) * GLITCH.length)];
    g[r][c] = k === 0 ? ['@', live ? 'gb' : 'd'] : k === 4 ? ['o', live ? 'a' : 'd']
      : [live ? sym : '#', hot ? (rnd(seed, i * 3 + 2) < 0.5 ? 'r' : 'g') : live ? 'a' : 'd'];
  });
  return g;
}

// Altura de la bola sobre el suelo en cada tick, en filas: todos los botes altos (2 filas).
const HOP = [0, 1, 2, 2, 1];

function hop(tick: number) {
  return HOP[((tick % HOP.length) + HOP.length) % HOP.length];
}

// Decorado del desierto: sol, cactus pequeño y cactus grande. Una línea por fila.
const SCENE = [
  String.raw`   \ | /`,
  String.raw`   - O -                                               _`,
  String.raw`   / | \                                              | |`,
  String.raw`                                                   _  | |  _`,
  String.raw`                                                  | | | | | |`,
  String.raw`                                                  |_|_| |_|_|`,
  String.raw`                         _                            | |`,
  String.raw`                        | |_                          | |`,
  String.raw`                        | |                           | |`,
];

function desert(server: boolean, tick: number): Line[] {
  const w = 72;
  const ground = SCENE.length - 2; // fila de arriba de la bola cuando toca el suelo
  // La bola avanza y el viento ondula a cada tick (200 ms); el giro va a un tercio (600 ms).
  const x = server ? (tick % (w + 16)) - 5 : 34;
  const ball = weed(server ? Math.floor(tick / 3) % 8 : 0, Math.floor(tick / 3), server);
  const top = ground - (server ? hop(tick) : 0);
  const lines = SCENE.map((l): Cell[] => Array.from(l.padEnd(w)).map((c) => [c, 'd']));
  if (server) {
    // Estela: sigue la trayectoria de la bola. Avanza una columna por tick, así que la columna i
    // de atrás es donde estaba hace i ticks, a la altura de su fila de abajo.
    // Se apaga hacia atrás (~ y luego -).
    for (let i = 1; i <= 14; i++) {
      const cx = x - 1 - i;
      if (cx >= 0 && cx < w) lines[ground + 1 - hop(tick - i)][cx] = [i < 9 ? '~' : '-', i < 4 ? 'a' : 'd'];
    }
  }
  ball.forEach((row, r) => {
    const tear = server && Math.random() < 0.15 ? (Math.random() < 0.5 ? -1 : 1) : 0;
    row.forEach((cell, c) => {
      const cx = x + c + tear;
      if (cx >= 0 && cx < w) lines[top + r][cx] = cell;
    });
  });
  // Celdas a segmentos: juntar las vecinas del mismo color.
  const segs = lines.map((cells): Line => cells.reduce<Line>((out, [c, cls]) => {
    const last = out[out.length - 1];
    if (last && last[1] === cls) last[0] += c;
    else out.push([c, cls]);
    return out;
  }, []));
  return box([['sala vacía', 'd']], w, [
    ...segs,
    [['_.,_._,.'.repeat(10).slice(0, w), 'l']],
    [[server ? '  nadie en sala, esperando…' : '  server parado: ni sopla el viento', 'd']],
  ]);
}

function gone(rows: Session[], now: number): Line[] {
  const today = new Date(now).toDateString();
  const todays = rows.filter((r) => new Date(r.joinedAt).toDateString() === today);
  const people = new Set(todays.map((r) => r.name)).size;
  const left = rows.filter((r) => r.leftAt || r.reason).slice(0, 8);
  const w = 52;
  const body: Line[] = [[[' hoy: ', 'd'], [`${todays.length} visitas · ${people} personas`, 'g']], []];
  for (const r of left) {
    const [icon, cls, text] = LEFT[r.reason] ?? ['?', 'd', r.reason];
    const when = r.leftAt ? new Date(r.leftAt).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }) : '--:--';
    const stay = r.leftAt ? age(Date.parse(r.leftAt) - Date.parse(r.joinedAt)) : '';
    body.push([
      [` ${icon} `, cls],
      [clean(r.name, 10).padEnd(11)],
      [('#' + clean(r.room, 9)).padEnd(11), 'd'],
      [when + ' ', 'd'],
      [text, cls],
      [stay ? ` (${stay})` : '', 'd'],
    ]);
  }
  if (!left.length) body.push([[' nadie se ha ido todavía', 'd']]);
  return box([['por aquí pasaron', 'd']], w, body);
}

function pre(lines: Line[]) {
  const el = document.createElement('pre');
  lines.forEach((l, i) => {
    if (i) el.append('\n');
    for (const [t, cls] of l) {
      if (!cls) {
        el.append(t);
        continue;
      }
      const s = document.createElement('span');
      s.className = cls;
      s.textContent = t;
      el.append(s);
    }
  });
  return el;
}

// Salas en `roomsEl` y el registro de salidas en `goneEl`.
export function drawPets(roomsEl: HTMLElement, goneEl: HTMLElement, rows: Session[], server: boolean, tick: number) {
  const now = Date.now();
  const rooms = new Map<string, Session[]>();
  for (const r of rows) {
    if (r.leftAt || r.reason) continue;
    rooms.set(r.room, [...(rooms.get(r.room) ?? []), r]);
  }
  // tick avanza cada 200 ms; los bichos van a la mitad, la bola de paja a todo ritmo.
  const boxes = [...rooms].sort(([a], [b]) => a.localeCompare(b)).map(([name, live]) =>
    room(name, live.sort((a, b) => a.joinedAt.localeCompare(b.joinedAt)), now, Math.floor(tick / 2)));
  if (!boxes.length) boxes.push(desert(server, tick));
  roomsEl.replaceChildren(...boxes.map(pre));
  goneEl.replaceChildren(pre(gone(rows, now)));
}
