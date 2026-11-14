import { useEffect, useRef, useState } from 'react';
import { colorFor } from '../fx';
import { mesh, useMesh, useVoice } from '../hooks';
import type { ChatMsg } from '../mesh';
import { localVoices } from '../speech';
import { STT_LANGS } from '../stt';
import type { ArchiveStats } from '../archive';

const time = (ts: number) => new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
const ONLY_EMOJI = /^(\p{Extended_Pictographic}|\p{Emoji_Component}|\s){1,12}$/u;
const SAY = /^\/(decir|say)\s+/i;

const imageFiles = (list: DataTransferItemList | FileList | null | undefined) =>
  [...(list ?? [])]
    .map((x) => (x instanceof File ? x : x.kind === 'file' ? x.getAsFile() : null))
    .filter((f): f is File => !!f && f.type.startsWith('image/'))
    .slice(0, 4);

const KIND_MARK: Record<string, [string, string]> = {
  stt: ['🎙', 'Dictado: transcrito en el navegador de quien habla'],
  tts: ['🔊', 'Para leer en voz alta en la sala'],
};

function Message({ msg, mine, onOpen }: { msg: ChatMsg; mine: boolean; onOpen: (m: ChatMsg) => void }) {
  const big = !msg.kind && ONLY_EMOJI.test(msg.text) && !/^\d+$/.test(msg.text.trim());
  const mark = msg.kind ? KIND_MARK[msg.kind] : undefined;
  const cls = ['msg', mine && 'mine', msg.kind && `kind-${msg.kind}`, msg.stored && 'stored'].filter(Boolean).join(' ');
  return (
    <div className={cls} style={{ ['--c' as string]: colorFor(msg.name) }}>
      <span className="ts">{time(msg.ts)}</span>
      <span className="author">
        <span className="dim">&lt;</span>
        {msg.name}
        <span className="dim">&gt;</span>
      </span>
      {msg.via && <span className="via dim" title={`Reenviado por ${msg.via}: el autor no está demostrado`}>[vía {msg.via}]</span>}
      {msg.image ? (
        <button className="msg-img" type="button" onClick={() => onOpen(msg)} title="Ver en grande">
          <img src={msg.image.url} width={msg.image.w || undefined} height={msg.image.h || undefined} alt={`Imagen de ${msg.name}`} loading="lazy" />
        </button>
      ) : (
        <span className={'msg-text' + (big ? ' big' : '')}>
          {mark && (
            <span className="kind-mark" title={mark[1]} aria-label={mark[1]}>
              {mark[0]}{' '}
            </span>
          )}
          {msg.text}
        </span>
      )}
    </div>
  );
}

const fmtBytes = (n: number) => (n > 1e6 ? `${(n / 1e6).toFixed(1)} MB` : `${Math.ceil(n / 1e3)} kB`);

function Tools({ onError }: { onError: (e: string) => void }) {
  const m = useMesh();
  const v = useVoice();
  const s = v.settings;
  const [stats, setStats] = useState<ArchiveStats | null>(null);
  const [confirm, setConfirm] = useState<'' | 'room' | 'all'>('');
  const [, setTick] = useState(0);
  useEffect(() => {
    if (typeof speechSynthesis === 'undefined') return;
    const f = () => setTick((x) => x + 1);
    speechSynthesis.addEventListener('voiceschanged', f);
    return () => speechSynthesis.removeEventListener('voiceschanged', f);
  }, []);
  const refresh = () => void m.archive?.stats().then(setStats, () => setStats(null));
  useEffect(refresh, [m.chat.length]);
  const voices = localVoices();
  const st = v.stt;
  const sttLabel =
    st.phase === 'loading' ? `cargando modelo ${st.pct}%` : st.phase === 'on' ? (st.busy ? 'transcribiendo…' : 'escuchando') : st.phase === 'error' ? `error: ${st.message}` : '';

  async function exportDb() {
    try {
      const bytes = await m.archive!.exportFile();
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([bytes], { type: 'application/vnd.sqlite3' }));
      a.download = `cryptopo-${new Date().toISOString().slice(0, 10)}.sqlite3`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
    } catch (e) {
      onError(`No se pudo exportar: ${(e as Error).message}`);
    }
  }

  async function clear(which: 'room' | 'all') {
    if (confirm !== which) return setConfirm(which);
    setConfirm('');
    await m.clearArchive(which === 'room' ? m.room : null).catch((e) => onError(`No se pudo borrar: ${(e as Error).message}`));
    refresh();
  }

  return (
    <div className="chat-tools" role="region" aria-label="Voz y archivo">
      <fieldset>
        <legend>dictado</legend>
        <label className="history-toggle" title="Whisper corre en este navegador: el audio no sale de aquí, solo el texto, cifrado a la sala">
          <input type="checkbox" checked={s.dictate} onChange={(e) => v.set({ dictate: e.target.checked })} disabled={!m.local.has('mic')} /> transcribir mi micro
        </label>
        <select aria-label="Idioma del dictado" value={s.lang} onChange={(e) => v.set({ lang: e.target.value })}>
          {STT_LANGS.map(([id, label]) => (
            <option key={id} value={id}>
              {label}
            </option>
          ))}
        </select>
        {sttLabel && <span className={'stt-state' + (st.phase === 'error' ? ' bad' : '')} role="status">{sttLabel}</span>}
        {st.phase === 'loading' && st.pct === 0 && <span className="dim tools-note">La primera vez baja ~100 MB del servidor; luego queda en caché.</span>}
      </fieldset>
      <fieldset>
        <legend>leer en voz alta</legend>
        {v.canSpeak ? (
          <>
            <label className="history-toggle">
              <input type="checkbox" checked={s.sayAloud} onChange={(e) => v.set({ sayAloud: e.target.checked })} /> mensajes 🔊
            </label>
            <label className="history-toggle">
              <input type="checkbox" checked={s.readChat} onChange={(e) => v.set({ readChat: e.target.checked })} /> chat
            </label>
            <label className="history-toggle">
              <input type="checkbox" checked={s.readStt} onChange={(e) => v.set({ readStt: e.target.checked })} /> transcripciones
            </label>
            {voices.length ? (
              <select aria-label="Voz" value={s.voice} onChange={(e) => v.set({ voice: e.target.value })}>
                <option value="">voz: automática</option>
                {voices.map((x) => (
                  <option key={x.voiceURI} value={x.voiceURI}>
                    {x.name} ({x.lang})
                  </option>
                ))}
              </select>
            ) : (
              <span className="dim tools-note">Sin voces locales en este sistema: no se lee nada (las de red mandarían el texto fuera).</span>
            )}
          </>
        ) : (
          <span className="dim tools-note">Este navegador no tiene síntesis de voz. Puedes mandar mensajes 🔊 igualmente.</span>
        )}
      </fieldset>
      <fieldset>
        <legend>archivo local</legend>
        <label className="history-toggle" title="SQLite en este navegador. Ni el servidor ni los demás lo ven">
          <input type="checkbox" checked={m.saveLocal} onChange={(e) => m.setSaveLocal(e.target.checked)} /> guardar chat, imágenes y transcripciones
        </label>
        {m.archive?.failed ? (
          <span className="stt-state bad">no disponible: {m.archive.failed}</span>
        ) : (
          stats && (
            <span className="dim tools-note">
              {stats.messages} mensajes · {stats.images} imágenes · {stats.transcripts} transcripciones · {fmtBytes(stats.bytes)}
              {!stats.persistent && ' · solo en memoria: este navegador no deja guardar'}
            </span>
          )
        )}
        <div className="tools-row">
          <button type="button" className="tool-btn" onClick={exportDb} disabled={!m.archive || !!m.archive.failed}>
            exportar .sqlite3
          </button>
          <button type="button" className="tool-btn danger" onClick={() => clear('room')}>
            {confirm === 'room' ? '¿seguro? otra vez' : `borrar #${m.room}`}
          </button>
          <button type="button" className="tool-btn danger" onClick={() => clear('all')}>
            {confirm === 'all' ? '¿seguro? otra vez' : 'borrar todo'}
          </button>
        </div>
      </fieldset>
    </div>
  );
}

// Chat estilo IRC: hora, <nick> y texto en una línea.
export function Chat({ onError = () => {} }: { onError?: (e: string) => void }) {
  const m = useMesh();
  const [text, setText] = useState('');
  const [say, setSay] = useState(false);
  const [tools, setTools] = useState(false);
  const [drag, setDrag] = useState(false);
  const [sending, setSending] = useState(0);
  const [big, setBig] = useState<ChatMsg | null>(null);
  const end = useRef<HTMLDivElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    end.current?.scrollIntoView({ block: 'end', behavior: 'smooth' });
  }, [m.chat.length]);

  useEffect(() => {
    if (!big) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setBig(null);
    addEventListener('keydown', onKey);
    return () => removeEventListener('keydown', onKey);
  }, [big]);

  async function sendImages(files: File[]) {
    for (const f of files) {
      setSending((n) => n + 1);
      try {
        await mesh.sendImage(f);
      } catch (e) {
        onError(`Imagen no enviada: ${(e as Error).message}`);
      } finally {
        setSending((n) => n - 1);
      }
    }
  }

  const stored = m.chat.filter((x) => x.stored).length;

  return (
    <section
      className={'chat' + (drag ? ' dragging' : '')}
      aria-label="Chat"
      onDragOver={(e) => {
        if (![...e.dataTransfer.items].some((i) => i.kind === 'file')) return;
        e.preventDefault();
        setDrag(true);
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node)) setDrag(false);
      }}
      onDrop={(e) => {
        e.preventDefault();
        setDrag(false);
        void sendImages(imageFiles(e.dataTransfer.files));
      }}
    >
      <header className="chat-head" style={{ ['--c' as string]: colorFor(m.room ?? '') }}>
        <span className="chat-title">#{m.room}</span>
        <span className="chat-head-tools">
          <label className="history-toggle dim" title="Si lo activas, quien entre en la sala recibe de ti lo ya hablado">
            <input type="checkbox" checked={m.shareHistory} onChange={(e) => m.setShareHistory(e.target.checked)} /> pasar historial
          </label>
          <button type="button" className={'head-btn' + (tools ? ' on' : '')} aria-expanded={tools} onClick={() => setTools(!tools)}>
            voz/archivo {tools ? '▴' : '▾'}
          </button>
        </span>
      </header>
      {tools && <Tools onError={onError} />}
      <div className="messages">
        <div className="sys">-!- te has unido a #{m.room}</div>
        {stored > 0 && <div className="sys">-!- {stored} mensajes del archivo local de este navegador</div>}
        {m.chat.length === 0 && (
          <div className="chat-empty">
            <div className="chat-empty-big">di algo_</div>
            -!- los mensajes van cifrados de navegador a navegador. ningún servidor los ve ni los guarda.
          </div>
        )}
        {m.chat.map((msg) => (
          <Message key={msg.id} msg={msg} mine={!!msg.mine || msg.from === m.myId} onOpen={setBig} />
        ))}
        {sending > 0 && <div className="sys">-!- preparando imagen…</div>}
        <div ref={end} />
      </div>
      <form
        className="composer"
        style={{ ['--c' as string]: colorFor(m.name) }}
        onSubmit={(e) => {
          e.preventDefault();
          const aloud = say || SAY.test(text);
          m.sendChat(text.replace(SAY, ''), aloud ? 'tts' : 'chat');
          setText('');
        }}
      >
        <label htmlFor="composer" className="composer-prompt">
          [{m.name}]
        </label>
        <input
          id="composer"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onPaste={(e) => {
            const files = imageFiles(e.clipboardData.items);
            if (!files.length) return;
            e.preventDefault();
            void sendImages(files);
          }}
          maxLength={4000}
          autoComplete="off"
          spellCheck={false}
          placeholder={say ? 'se leerá en voz alta a la sala' : 'escribe, pega una imagen o /decir algo'}
        />
        <button
          type="button"
          className={'composer-btn' + (say ? ' on' : '')}
          aria-pressed={say}
          title="Decir: lo que escribas se lee en voz alta en la sala"
          onClick={() => setSay(!say)}
        >
          🔊
        </button>
        <button type="button" className="composer-btn" title="Enviar imagen (también puedes pegarla o arrastrarla)" onClick={() => fileInput.current?.click()}>
          img
        </button>
        <input
          ref={fileInput}
          type="file"
          accept="image/*"
          multiple
          hidden
          aria-label="Imagen para enviar"
          onChange={(e) => {
            void sendImages(imageFiles(e.target.files));
            e.target.value = '';
          }}
        />
      </form>
      {big?.image && (
        <div className="lightbox" role="dialog" aria-label={`Imagen de ${big.name}`} onClick={() => setBig(null)}>
          <img src={big.image.url} alt={`Imagen de ${big.name}`} />
          <span className="lightbox-cap">
            &lt;{big.name}&gt; {time(big.ts)} · {big.image.w}×{big.image.h} · esc para cerrar
          </span>
        </div>
      )}
    </section>
  );
}
