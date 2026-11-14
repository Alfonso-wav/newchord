import { useEffect, useState } from 'react';
import { Chat } from './components/Chat';
import { Controls } from './components/Controls';
import { Avatar, Sidebar } from './components/Sidebar';
import { Stage } from './components/Stage';
import { FxLayer, colorFor, confettiAt, sfx } from './fx';
import { audioCtx, useLocalStorage, useMesh } from './hooks';
import { startMic } from './mixer';
import { androidShare, inAndroidApp } from './android';
import { defaultShare, type EncodeOpts, type ShareSettings } from './media';
import { SpritePicker, type SpriteChoice } from './components/SpritePicker';
import { spriteAvatar } from './sprites';

const BOOT: ['OK' | 'INFO', string][] = [
  ['OK', 'Iniciado núcleo WebRTC.'],
  ['OK', 'Señalización cifrada de extremo a extremo.'],
  ['OK', 'Cargados codecs: AV1 VP9 H264 Opus/estéreo.'],
  ['OK', 'Servidor de señalización alcanzado.'],
  ['INFO', 'Topología: malla P2P. Cero servidores de media.'],
  ['OK', 'Objetivo alcanzado: pantalla a resolución nativa.'],
];

// Forma de las claves que genera cryptopo (base64url, 43): nadie se llama así.
const looksLikeKey = (s: string) => /^[A-Za-z0-9_-]{24,}$/.test(s.trim());
const KEY_AS_NAME = 'Eso es la clave del servidor, no tu nombre. Escribe cómo quieres que te vean.';

type Prefs = { name: string; avatar: string; sprite: SpriteChoice | null };

function screenOpts(s: ShareSettings): EncodeOpts {
  return { videoBitrate: s.mbps * 1_000_000, audioBitrate: 256_000, maxFramerate: s.fps, codec: s.codec, hint: s.hint };
}

function fileOpts(s: ShareSettings): EncodeOpts {
  return { videoBitrate: s.mbps * 1_000_000, audioBitrate: 256_000, codec: s.codec, hint: 'motion' };
}

export function App() {
  const m = useMesh();
  const [prefs, setPrefs] = useLocalStorage<Prefs>('newchord.prefs', { name: '', avatar: '', sprite: null });
  const [share, setShare] = useLocalStorage<ShareSettings>('newchord.share', inAndroidApp ? androidShare : defaultShare);
  const [draft, setDraft] = useState(prefs.name);
  const [passDraft, setPassDraft] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [error, setError] = useState('');
  const [nameError, setNameError] = useState('');
  // Al crear el usuario se elige sprite y color; el avatar se pinta al entrar.
  const [choice, setChoice] = useState<SpriteChoice>(prefs.sprite ?? { sprite: 'invader', color: '#5fff5f' });
  const [choicePreview, setChoicePreview] = useState('');
  useEffect(() => {
    void spriteAvatar(choice.sprite, choice.color).then((url) => setChoicePreview((p) => p || url));
  }, []);

  // El perfil guardado vale desde el principio, también fuera de una sala.
  if (prefs.name && !m.name) {
    m.name = prefs.name;
    m.avatar = prefs.avatar ?? '';
  }

  // Quien entró antes con la clave como nombre la tiene guardada: se le vuelve a preguntar.
  const keyReady = m.keyChecked && m.auth === 'ok';
  useEffect(() => {
    if (!keyReady || !prefs.name) return;
    let live = true;
    void (async () => {
      if (!(looksLikeKey(prefs.name) || (await m.isServerKey(prefs.name))) || !live) return;
      m.name = '';
      setDraft('');
      setNameError(KEY_AS_NAME);
      setPrefs({ ...prefs, name: '' });
    })();
    return () => void (live = false);
  }, [keyReady, prefs.name]);

  useEffect(() => {
    if (m.notice) {
      setError(m.notice);
      m.notice = '';
    }
  }, [m.notice]);

  useEffect(() => {
    if (!error) return;
    const t = setTimeout(() => setError(''), 6000);
    return () => clearTimeout(t);
  }, [error]);

  async function join(room: string) {
    audioCtx(); // desbloquea audio dentro del gesto del usuario
    setFile(null);
    m.join(room, prefs.name, prefs.avatar);
    if (!m.local.has('mic')) {
      try {
        await startMic(m);
      } catch (e) {
        setError(`Sin micro: ${(e as Error).message}`);
      }
    }
  }

  if (m.auth === 'insecure') {
    return (
      <div className="gate">
        <div className="gate-card">
          <h1 className="wordmark" aria-label="cryptopo">
            <img className="wordmark-mark" src="/logo.svg" alt="" aria-hidden />
            cryptopo<span className="cursor" aria-hidden />
          </h1>
          <p className="login-error" role="alert">
            Esta página no va por HTTPS. El navegador no permite cifrar aquí y cryptopo no funciona sin cifrado. Pide un enlace https://.
          </p>
        </div>
      </div>
    );
  }

  // Sin esto, con auth aún 'ok' por defecto, saldría el nombre antes que la clave.
  if (!m.keyChecked) return <div className="gate" />;

  // Clave antes que nombre: si el primer campo es el nombre, quien trae la clave la escribe ahí.
  if (m.auth !== 'ok') {
    return (
      <div className="gate">
        <div className="gate-card">
          <h1 className="wordmark" aria-label="cryptopo">
            <img className="wordmark-mark" src="/logo.svg" alt="" aria-hidden />
            cryptopo<span className="cursor" aria-hidden />
          </h1>
          <form
            className="login"
            style={{ ['--c' as string]: prefs.name ? colorFor(prefs.name) : 'var(--green)' }}
            onSubmit={(e) => {
              e.preventDefault();
              if (!passDraft || m.authBusy) return;
              void m.submitPassword(passDraft);
              setPassDraft('');
            }}
          >
            <label htmlFor="password">clave:</label>
            <input id="password" type="password" autoFocus value={passDraft} onChange={(e) => setPassDraft(e.target.value)} autoComplete="current-password" />
            <button className="key-btn" type="submit" disabled={!passDraft || m.authBusy}>
              ⏎ ENTER
            </button>
          </form>
          {m.auth === 'failed' && !m.authBusy && (
            <p className="login-error" role="alert">
              Clave incorrecta.
            </p>
          )}
        </div>
      </div>
    );
  }

  if (!prefs.name) {
    const name = draft.trim();
    return (
      <div className="gate">
        <div className="gate-card">
          <pre className="boot" aria-hidden>
            {BOOT.map(([status, text], i) => (
              <span key={i} className="boot-line" style={{ ['--i' as string]: i }}>
                [<b className={status === 'OK' ? 'ok' : 'warn'}>{status === 'OK' ? '  OK  ' : ' INFO '}</b>] {text}
                {'\n'}
              </span>
            ))}
          </pre>
          <h1 className="wordmark" aria-label="cryptopo">
            <img className="wordmark-mark" src="/logo.svg" alt="" aria-hidden />
            {'cryptopo'.split('').map((ch, i) => (
              <span key={i} style={{ ['--i' as string]: i }}>
                {ch}
              </span>
            ))}
            <span className="cursor" aria-hidden />
          </h1>
          <p className="tagline">
            <span className="dim">#</span> voz, vídeo y pantalla <mark>a resolución nativa</mark>, de navegador a navegador.
          </p>
          <form
            className="login"
            style={{ ['--c' as string]: name ? colorFor(name) : 'var(--green)' }}
            onSubmit={async (e) => {
              e.preventDefault();
              if (!name) return;
              audioCtx(); // dentro del gesto, antes de esperar a la comprobación
              if (looksLikeKey(name) || (await m.isServerKey(name))) {
                setDraft('');
                setNameError(KEY_AS_NAME);
                return;
              }
              setNameError('');
              sfx.join();
              // la capa FX de la app se monta tras este render
              setTimeout(() => confettiAt(innerWidth / 2, innerHeight / 2), 60);
              setPrefs({ ...prefs, name: name.slice(0, 32), avatar: await spriteAvatar(choice.sprite, choice.color), sprite: choice });
            }}
          >
            <label htmlFor="name">tu nombre:</label>
            <input id="name" autoFocus value={draft} onChange={(e) => setDraft(e.target.value)} maxLength={64} autoComplete="nickname" spellCheck={false} placeholder="como te verán los demás" />
            <button className="key-btn" type="submit" disabled={!name}>
              ⏎ ENTER
            </button>
          </form>
          {nameError && (
            <p className="login-error" role="alert">
              {nameError}
            </p>
          )}
          <div className="login-sprite">
            <Avatar name={name || '?'} avatar={choicePreview} size={72} />
            <SpritePicker
              value={choice}
              onChange={(c, avatar) => {
                setChoice(c);
                setChoicePreview(avatar);
              }}
            />
          </div>
        </div>
        <FxLayer />
      </div>
    );
  }

  return (
    <div className="app">
      <Sidebar
        onJoin={join}
        sprite={prefs.sprite}
        onProfile={async (name, avatar, sprite) => {
          if (looksLikeKey(name) || (await m.isServerKey(name))) return setError(KEY_AS_NAME);
          setPrefs({ name, avatar, sprite });
          m.setProfile(name, avatar);
        }}
      />
      {m.room ? (
        <>
          <main className="main">
            <Stage file={file} fileOpts={fileOpts(share)} onCloseFile={() => setFile(null)} />
            <Controls
              share={share}
              setShare={setShare}
              screenOpts={screenOpts}
              onFile={setFile}
              onLeave={() => {
                setFile(null);
                m.leave();
              }}
              onError={setError}
            />
          </main>
          <Chat onError={setError} />
        </>
      ) : (
        <main className="main empty-main">
          <div className="pick">
            <div className="prompt-line">
              <span style={{ color: colorFor(prefs.name) }}>{prefs.name}@cryptopo</span>:<span className="blue">~</span>$ cd ~/salas/
            </div>
            <div className="pick-big">
              hola, <span style={{ color: colorFor(prefs.name) }}>{prefs.name}</span>.
              <br />
              elige sala<span className="cursor" aria-hidden />
            </div>
            <p>Audio, vídeo y chat van cifrados de navegador a navegador. El servidor solo os presenta y no puede leer lo que os decís. Entras con el micro en silencio.</p>
          </div>
        </main>
      )}
      {error && (
        <div className="toast" role="alert">
          {error}
        </div>
      )}
      <FxLayer />
    </div>
  );
}
