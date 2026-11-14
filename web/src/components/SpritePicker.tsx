import { useEffect, useState } from 'react';
import { SPRITES, SPRITE_COLORS, spriteAvatar, type SpriteId } from '../sprites';

export type SpriteChoice = { sprite: SpriteId; color: string };

// Rejilla de sprites (ya teñidos con el color actual) y muestras de color. Cada cambio entrega el
// avatar terminado, como PNG data:.
export function SpritePicker({ value, onChange }: { value: SpriteChoice | null; onChange: (choice: SpriteChoice, avatar: string) => void }) {
  const color = value?.color ?? '';
  const [thumbs, setThumbs] = useState<Record<string, string>>({});

  useEffect(() => {
    let live = true;
    void Promise.all(SPRITES.map(async (s) => [s.id, await spriteAvatar(s.id, color)] as const)).then((all) => {
      if (live) setThumbs(Object.fromEntries(all));
    });
    return () => void (live = false);
  }, [color]);

  const pick = async (choice: SpriteChoice) => onChange(choice, await spriteAvatar(choice.sprite, choice.color));
  const custom = color && !SPRITE_COLORS.includes(color);

  return (
    <div className="sprite-picker">
      <div className="sprites" role="radiogroup" aria-label="Sprite">
        {SPRITES.map((s) => (
          <button
            key={s.id}
            type="button"
            role="radio"
            aria-checked={value?.sprite === s.id}
            aria-label={s.label}
            title={s.label}
            className={'sprite' + (value?.sprite === s.id ? ' on' : '')}
            onClick={() => void pick({ sprite: s.id, color })}
          >
            {thumbs[s.id] && <img src={thumbs[s.id]} alt="" draggable={false} />}
          </button>
        ))}
      </div>
      <div className="swatches" role="radiogroup" aria-label="Color del sprite">
        {SPRITE_COLORS.map((c) => (
          <button
            key={c || 'orig'}
            type="button"
            role="radio"
            aria-checked={color === c}
            aria-label={c || 'colores originales'}
            title={c || 'colores originales'}
            className={'swatch' + (color === c ? ' on' : '') + (c ? '' : ' orig')}
            style={c ? { background: c } : undefined}
            onClick={() => void pick({ sprite: value?.sprite ?? SPRITES[0].id, color: c })}
          />
        ))}
        <label className={'swatch custom' + (custom ? ' on' : '')} title="otro color" style={custom ? { background: color } : undefined}>
          <input
            type="color"
            value={custom ? color : '#5fff5f'}
            aria-label="Otro color"
            onChange={(e) => void pick({ sprite: value?.sprite ?? SPRITES[0].id, color: e.target.value })}
          />
        </label>
      </div>
    </div>
  );
}
