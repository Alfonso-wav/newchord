import { useState } from 'react';
import { colorFor, setSfx, sfxEnabled } from '../fx';
import { useMesh } from '../hooks';
import { Icon } from './Icons';
import { Profile } from './Profile';
import type { SpriteChoice } from './SpritePicker';

// `avatar` ya viene limpio (cleanAvatar): imagen data: rasterizada, glifo corto o nada.
export function Avatar({ name, avatar = '', size = 28, speaking }: { name: string; avatar?: string; size?: number; speaking?: boolean }) {
  const image = avatar.startsWith('data:image/');
  return (
    <span
      className={'av' + (speaking ? ' speaking' : '') + (image ? ' img' : '')}
      style={{ ['--c' as string]: colorFor(name), width: size, height: size, fontSize: size * (avatar && !image ? 0.6 : 0.8) }}
      title={name}
    >
      {image ? <img src={avatar} alt="" width={size} height={size} draggable={false} /> : avatar || name.slice(0, 1).toUpperCase()}
    </span>
  );
}

const TRUST_LABEL = { pending: 'comprobando…', bad: '✗ identidad falsa', verified: '✓ verificado', new: '? sin verificar', changed: '⚠ CLAVE CAMBIADA' };

// Códigos de seguridad: compararlos por otro medio demuestra que no hay nadie en medio.
function Trust() {
  const m = useMesh();
  const [open, setOpen] = useState<string | null>(null);
  const peers = m.peerViews();
  if (!peers.length) return null;
  return (
    <section className="trust" aria-label="Seguridad de la conexión">
      <div className="trust-title dim">seguridad</div>
      {peers.map((p) => {
        const warn = p.trust === 'bad' || p.trust === 'changed' || p.tampered || p.duplicate;
        return (
          <div key={p.id} className={'trust-peer ' + p.trust + (warn ? ' warn' : '')}>
            <button className="trust-row" onClick={() => setOpen(open === p.id ? null : p.id)} aria-expanded={open === p.id}>
              <span className="trust-name">{p.name}</span>
              <span className="trust-state">{p.tampered ? '✗ clave distinta' : TRUST_LABEL[p.trust]}</span>
            </button>
            {p.duplicate && <div className="trust-note">⚠ otra persona usa este nombre: comprueba quién es</div>}
            {open === p.id && p.safety && (
              <div className="trust-detail">
                <code className="safety">{p.safety}</code>
                <p className="dim">Comparad este código por teléfono o en persona. Si en los dos lados es igual, nadie está en medio.</p>
                {p.trust !== 'verified' && (
                  <button className="mini-btn" onClick={() => m.verifyPeer(p.id)}>
                    es igual: marcar verificado
                  </button>
                )}
              </div>
            )}
          </div>
        );
      })}
    </section>
  );
}

export function Sidebar({ onJoin, onProfile, sprite }: { onJoin: (room: string) => void; onProfile: (name: string, avatar: string, sprite: SpriteChoice | null) => void; sprite: SpriteChoice | null }) {
  const m = useMesh();
  const [profile, setProfile] = useState(false);
  const [custom, setCustom] = useState('');
  const [sfx, setSfxState] = useState(sfxEnabled());

  return (
    <aside className="rail">
      <div className="logo" aria-label="cryptopo">
        <img className="logo-mark" src="/logo.svg" alt="" aria-hidden />
        cryptopo<span className="cursor" aria-hidden />
      </div>
      <div className="cmd" aria-hidden>
        <span className="prompt">$</span> ls -l ~/salas
      </div>
      <nav className="rooms" aria-label="Salas">
        {m.rooms.map((r, i) => {
          const active = m.room === r.name;
          const last = i === m.rooms.length - 1;
          // Solo las creadas, y vacías salvo tú: borrar no sirve para echar a nadie.
          const deletable = !r.fixed && r.members.every((p) => p.id === m.myId);
          return (
            <div key={r.name} className="room-row">
            <button
              className={'room-card' + (active ? ' active' : '') + (r.members.length ? ' busy' : '')}
              style={{ ['--c' as string]: colorFor(r.name) }}
              onClick={() => !active && onJoin(r.name)}
              aria-current={active ? 'true' : undefined}
            >
              <span className="room-top">
                <span className="branch" aria-hidden>
                  {last ? '└──' : '├──'}
                </span>
                <span className="room-name">{r.name}/</span>
                {active ? <span className="here">◀ aquí</span> : r.members.length > 0 && <span className="room-count">[{r.members.length}]</span>}
              </span>
              {r.members.map((p, j) => (
                <span key={p.id} className="member" style={{ ['--c' as string]: colorFor(p.name) }}>
                  <span className="branch" aria-hidden>
                    {last ? '    ' : '│   '}
                    {j === r.members.length - 1 ? '└── ' : '├── '}
                  </span>
                  {p.name}
                  {p.id === m.myId && <span className="dim"> (tú)</span>}
                </span>
              ))}
            </button>
            {deletable && (
              <button className="room-del" onClick={() => m.deleteRoom(r.name)} title={`Borrar ${r.name}`} aria-label={`Borrar sala ${r.name}`}>
                <Icon name="trash" size={14} />
              </button>
            )}
            </div>
          );
        })}
        <form
          className="new-room"
          onSubmit={(e) => {
            e.preventDefault();
            if (custom.trim()) onJoin(custom.trim());
            setCustom('');
          }}
        >
          <label htmlFor="new-room">
            <span className="prompt">$</span> mkdir
          </label>
          <input id="new-room" value={custom} onChange={(e) => setCustom(e.target.value)} placeholder="nueva-sala" maxLength={40} spellCheck={false} />
        </form>
      </nav>
      <Trust />
      <footer className="me-card" style={{ ['--c' as string]: colorFor(m.name || '?') }}>
        {profile && <Profile name={m.name} avatar={m.avatar} sprite={sprite} onSave={onProfile} onClose={() => setProfile(false)} />}
        <button className="me-avatar" onClick={() => setProfile(!profile)} title="Cambiar nombre y avatar" aria-label="Perfil" aria-expanded={profile}>
          <Avatar name={m.name || '?'} avatar={m.avatar} size={34} />
        </button>
        <div className="me-info">
          <span className="me-name">
            {m.name}
            <span className="dim">@cryptopo</span>
          </span>
          <span className="me-status">
            <span className={'dot ' + (m.online ? 'on' : 'off')}>{m.online ? '[ conectado ]' : '[ reconectando… ]'}</span>
            {m.room && <span className="dim"> ~/salas/{m.room}</span>}
          </span>
        </div>
        <button
          className={'mini-btn' + (sfx ? ' on' : '')}
          onClick={() => {
            setSfx(!sfx);
            setSfxState(!sfx);
          }}
          aria-label={sfx ? 'Silenciar efectos' : 'Activar efectos'}
          title="Efectos de sonido"
        >
          sfx:{sfx ? 'on' : 'off'}
        </button>
        <button className="mini-btn" onClick={() => void m.forgetKey()} title="Salir y borrar la clave de este navegador">
          olvidar
        </button>
      </footer>
    </aside>
  );
}
