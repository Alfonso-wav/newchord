import * as api from './wailsjs/go/main/App';
import { drawPets, type Session } from './pets';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

let state: Awaited<ReturnType<typeof api.State>> | undefined;
let tab = 'sessions';
let settingsShown = false;
let errorText = '';
let sessions: Session[] = [];
let tick = 0;

// Todo lo que viene de la base lo escribe gente de internet: solo textContent, nunca HTML.
function rows(id: string, data: { cells: string[]; cls?: string }[]) {
  const body = document.querySelector(`#${id} tbody`)!;
  const frag = document.createDocumentFragment();
  for (const r of data) {
    const tr = document.createElement('tr');
    if (r.cls) tr.className = r.cls;
    for (const c of r.cells) tr.insertCell().textContent = c;
    frag.append(tr);
  }
  body.replaceChildren(frag);
}

function when(iso: string) {
  if (!iso) return '';
  const d = new Date(iso);
  return `${d.toLocaleDateString(undefined, { day: '2-digit', month: '2-digit' })} ${d.toLocaleTimeString()}`;
}

function light(text: string, cls: string) {
  const s = document.createElement('span');
  s.textContent = text;
  s.className = cls;
  return s;
}

const FUNNEL_TEXT: Record<string, string> = {
  off: 'cerrado', starting: 'abriendo…', login: 'sin sesión', approve: 'por aprobar', on: 'ABIERTO', error: 'error',
};

const APPROVE_TEXT: Record<string, [string, string]> = {
  login: ['Entra con tu cuenta de Tailscale (gratis, con Google, GitHub o Microsoft). Solo la primera vez.', 'Iniciar sesión'],
  approve: ['Tailscale pide activar HTTPS y Funnel en tu cuenta. Solo la primera vez.', 'Aprobar'],
};

function paint() {
  if (!state) return;
  const { server, funnel, url, approveUrl, hasPassword, message, turn } = state;
  const turnText = turn === 'on' ? 'integrado' : turn === 'own' ? 'propio' : turn === 'off' ? 'apagado'
    : server ? 'integrado, espera al Funnel' : 'integrado, al arrancar';
  $('lights').replaceChildren(
    light(`server: ${server ? 'activo' : 'parado'}`, server ? 'on-l' : 'off-l'),
    light(`funnel: ${FUNNEL_TEXT[funnel] ?? funnel}`, funnel === 'off' ? 'off-l' : 'warn-l'),
    light(`turn: ${turnText}`, turn === 'on' || turn === 'own' ? 'on-l' : turn === 'off' ? 'off-l' : 'warn-l'),
  );

  const sv = $<HTMLButtonElement>('server');
  sv.textContent = server ? 'Parar server' : 'Arrancar server';
  sv.className = server ? 'danger' : 'primary';
  sv.disabled = !hasPassword && !server;

  const fn = $<HTMLButtonElement>('funnel');
  fn.textContent = funnel === 'off' ? 'Abrir al exterior' : 'Cerrar Funnel';
  fn.className = funnel === 'off' ? '' : 'danger';
  fn.disabled = !server;
  $<HTMLButtonElement>('call').disabled = !server;

  // Uno u otro: activar uno apaga el otro.
  const builtinOn = turn === 'on' || turn === 'local';
  const tb = $<HTMLButtonElement>('turnBuiltin');
  tb.textContent = builtinOn ? 'Desactivar TURN integrado' : 'Activar TURN integrado';
  tb.className = builtinOn ? 'danger' : '';
  const to = $<HTMLButtonElement>('turnOwn');
  to.textContent = turn === 'own' ? 'Desactivar TURN propio' : 'Activar TURN propio';
  to.className = turn === 'own' ? 'danger' : '';

  $('urlRow').hidden = !url;
  $('url').textContent = url;
  $('approveRow').hidden = !approveUrl;
  const [hint, label] = APPROVE_TEXT[funnel] ?? APPROVE_TEXT.approve;
  $('approveText').textContent = hint;
  $('approve').textContent = label;

  const text = errorText || message || (hasPassword ? '' : 'Lo primero: pon una clave en Settings.');
  $('msg').hidden = !text;
  $('msg').textContent = text;
}

async function refresh() {
  try {
    state = await api.State();
    if (!state.hasPassword && !settingsShown) {
      settingsShown = true;
      void select('settings');
    }
    paint();
    if (tab === 'sessions') {
      sessions = await api.Sessions();
      drawPets($('rooms'), $('gone'), sessions, state.server, tick);
    } else if (tab === 'logs') {
      const e = await api.Events();
      rows('logs', e.map((r) => ({
        cells: [when(r.ts), r.kind, r.name, r.ip, r.detail],
        cls: r.kind === 'auth-failed' || r.kind === 'ws-rejected' ? 'bad' : '',
      })));
    }
  } catch (e) {
    errorText = String(e);
    paint();
  }
}

async function select(name: string) {
  tab = name;
  for (const b of document.querySelectorAll<HTMLButtonElement>('nav button')) b.classList.toggle('on', b.dataset.tab === name);
  for (const s of document.querySelectorAll<HTMLElement>('.tab')) s.hidden = s.id !== name;
  if (name === 'settings') {
    const s = await api.Settings();
    $<HTMLInputElement>('password').value = s.password;
    $<HTMLInputElement>('port').value = String(s.port);
    $<HTMLInputElement>('channels').value = s.channels;
  } else {
    void refresh();
  }
}

function action(fn: () => Promise<unknown> | void) {
  return async () => {
    errorText = '';
    try {
      await fn();
    } catch (e) {
      errorText = String(e);
    }
    void refresh();
  };
}

for (const b of document.querySelectorAll<HTMLButtonElement>('nav button')) b.onclick = () => void select(b.dataset.tab!);
$('server').onclick = action(() => (state?.server ? api.StopServer() : api.StartServer()));
$('funnel').onclick = action(() => (state?.funnel === 'off' ? api.StartFunnel() : api.StopFunnel()));
$('call').onclick = action(() => api.OpenCall());
$('turnBuiltin').onclick = action(() => api.SetTURN(state?.turn === 'on' || state?.turn === 'local' ? 'off' : 'builtin'));
$('turnOwn').onclick = action(() => api.SetTURN(state?.turn === 'own' ? 'off' : 'own'));
$('invite').onclick = action(() => api.CopyInvite());
$('whatsapp').onclick = action(() => api.ShareWhatsApp());
$('approve').onclick = action(() => api.OpenURL(state?.approveUrl ?? ''));
$<HTMLInputElement>('show').onchange = (e) => {
  $<HTMLInputElement>('password').type = (e.target as HTMLInputElement).checked ? 'text' : 'password';
};
$('genKey').onclick = action(async () => {
  $<HTMLInputElement>('password').value = await api.NewKey();
  $<HTMLInputElement>('show').checked = true;
  $<HTMLInputElement>('password').type = 'text';
});
$('clearLogs').onclick = action(() => api.ClearLogs());
$('form').onsubmit = (e) => {
  e.preventDefault();
  void action(async () => {
    await api.SaveSettings({
      password: $<HTMLInputElement>('password').value,
      port: Number($<HTMLInputElement>('port').value),
      channels: $<HTMLInputElement>('channels').value,
    } as Parameters<typeof api.SaveSettings>[0]);
    await select('sessions');
  })();
};

void refresh();
setInterval(() => void refresh(), 2000);
// Los bichos se mueven entre refrescos con los datos ya cargados.
setInterval(() => {
  tick++;
  if (tab === 'sessions' && state) drawPets($('rooms'), $('gone'), sessions, state.server, tick);
}, 200);

// Tooltips de data-tip: un solo nodo fixed, colocado dentro de la ventana.
{
  const tip = document.createElement('div');
  tip.id = 'tooltip';
  document.body.appendChild(tip);
  const hide = () => tip.classList.remove('on');
  const show = (el: HTMLElement) => {
    tip.textContent = el.dataset.tip ?? '';
    tip.classList.add('on');
    const m = 8;
    const r = el.getBoundingClientRect();
    const w = tip.offsetWidth;
    const h = tip.offsetHeight;
    const left = Math.max(m, Math.min(r.left, window.innerWidth - w - m));
    let top = r.bottom + 6;
    if (top + h > window.innerHeight - m) top = Math.max(m, r.top - h - 6);
    tip.style.left = `${left}px`;
    tip.style.top = `${top}px`;
  };
  const target = (e: Event) => (e.target as HTMLElement | null)?.closest?.<HTMLElement>('[data-tip]') ?? null;
  document.addEventListener('mouseover', (e) => { const t = target(e); if (t) show(t); });
  document.addEventListener('mouseout', (e) => { if (target(e)) hide(); });
  document.addEventListener('focusin', (e) => { const t = target(e); if (t) show(t); });
  document.addEventListener('focusout', hide);
  window.addEventListener('scroll', hide, true);
}
