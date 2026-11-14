import { useRef, useState } from 'react';
import { colorFor } from '../fx';
import { MAX_AVATAR, cleanAvatar } from '../mesh';
import { Avatar } from './Sidebar';
import { SpritePicker, type SpriteChoice } from './SpritePicker';

const GLYPHS = ['@', '#', '$', '%', '&', '*', '~', '>', '!', '?', '+', 'λ'];
const SIZE = 128;
const MAX_FILE = 20 * 1024 * 1024;

// Recorta al centro, reduce a 128×128 y vuelve a codificar: sale una imagen nueva, sin
// metadatos ni nada del archivo original, lo bastante pequeña para el DataChannel.
async function toAvatar(file: File): Promise<string> {
  if (!file.type.startsWith('image/')) throw new Error('No es una imagen');
  if (file.size > MAX_FILE) throw new Error('Imagen demasiado grande (máx. 20 MB)');
  const bmp = await createImageBitmap(file);
  const side = Math.min(bmp.width, bmp.height);
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = SIZE;
  const g = canvas.getContext('2d');
  if (!g) throw new Error('Sin canvas');
  g.imageSmoothingQuality = 'high';
  g.drawImage(bmp, (bmp.width - side) / 2, (bmp.height - side) / 2, side, side, 0, 0, SIZE, SIZE);
  bmp.close();
  for (const q of [0.85, 0.7, 0.5, 0.35]) {
    let url = canvas.toDataURL('image/webp', q);
    if (!url.startsWith('data:image/webp')) url = canvas.toDataURL('image/jpeg', q); // Safari no codifica WebP
    if (url.length <= MAX_AVATAR && cleanAvatar(url)) return url;
  }
  throw new Error('No se pudo reducir la imagen');
}

export function Profile({ name, avatar, sprite, onSave, onClose }: { name: string; avatar: string; sprite: SpriteChoice | null; onSave: (name: string, avatar: string, sprite: SpriteChoice | null) => void; onClose: () => void }) {
  const [draft, setDraft] = useState(name);
  const [av, setAv] = useState(avatar);
  // Solo marca el sprite mientras el avatar sigue siendo ese sprite.
  const [spr, setSpr] = useState(avatar.startsWith('data:image/png') ? sprite : null);
  const [error, setError] = useState('');
  const file = useRef<HTMLInputElement>(null);
  const clean = draft.trim();
  const changed = clean !== name || av !== avatar;

  return (
    <div
      className="dialog profile"
      role="dialog"
      aria-label="Tu perfil"
      style={{ ['--c' as string]: colorFor(clean || name) }}
      onKeyDown={(e) => e.key === 'Escape' && onClose()}
    >
      <div className="dialog-title">
        <span>┤ perfil ├</span>
        <button className="mini-btn" onClick={onClose} aria-label="Cerrar">
          [x]
        </button>
      </div>
      <form
        className="profile-form"
        onSubmit={(e) => {
          e.preventDefault();
          if (!clean) return;
          onSave(clean.slice(0, 32), av, spr);
          onClose();
        }}
      >
        <div className="profile-top">
          <Avatar name={clean || name} avatar={av} size={72} />
          <div className="profile-pic">
            <button type="button" className="mini-btn" onClick={() => file.current?.click()}>
              subir imagen
            </button>
            <button type="button" className="mini-btn" onClick={() => (setAv(''), setSpr(null))} disabled={!av}>
              quitar
            </button>
            <input
              ref={file}
              type="file"
              accept="image/png,image/jpeg,image/webp,image/gif,image/avif"
              hidden
              onChange={async (e) => {
                const f = e.target.files?.[0];
                e.target.value = '';
                if (!f) return;
                try {
                  setAv(await toAvatar(f));
                  setSpr(null);
                  setError('');
                } catch (err) {
                  setError((err as Error).message);
                }
              }}
            />
          </div>
        </div>
        <SpritePicker
          value={spr}
          onChange={(c, url) => {
            setSpr(c);
            setAv(url);
          }}
        />
        <div className="glyphs" role="radiogroup" aria-label="Avatar de símbolo">
          {GLYPHS.map((g) => (
            <button key={g} type="button" role="radio" aria-checked={av === g} className={'glyph' + (av === g ? ' on' : '')} onClick={() => (setAv(g), setSpr(null))}>
              {g}
            </button>
          ))}
        </div>
        <div className="field">
          <label className="field-label" htmlFor="profile-name">
            Nombre
          </label>
          <input id="profile-name" value={draft} onChange={(e) => setDraft(e.target.value)} maxLength={32} autoComplete="nickname" spellCheck={false} autoFocus />
        </div>
        {error && (
          <p className="login-error" role="alert">
            {error}
          </p>
        )}
        <p className="dim profile-note">
          El avatar va directo a cada persona por la conexión cifrada; el servidor no lo ve. El nombre sí, para la lista de salas.
        </p>
        <div className="dialog-actions">
          <button className="btn chunky" type="submit" disabled={!clean || !changed}>
            guardar ⏎
          </button>
        </div>
      </form>
    </div>
  );
}
