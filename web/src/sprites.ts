// Avatares de sprite: pixel art de assets/ teñido del color que elija cada uno. Se pinta en un canvas
// y sale un PNG data: normal, así viaja por el mismo camino que una foto (cleanAvatar) y nadie más
// necesita conocer los sprites.
import invader from '../../assets/otros/invader-verde.png';
import nave from '../../assets/otros/nave.png';
import anda from '../../assets/topos/topo-anda.png';
import detective from '../../assets/topos/topo-detective.png';
import hoyo from '../../assets/topos/topo-hoyo.png';
import minero from '../../assets/topos/topo-minero.png';
import tieso from '../../assets/topos/topo-tieso.png';

// frame: [x, y, ancho, alto] dentro de la imagen; las tiras usan su primer fotograma.
// mono: sprites de un solo color, que se rellenan; el resto se tiñe conservando las sombras.
export const SPRITES = [
  { id: 'invader', label: 'invasor', url: invader, frame: [0, 0, 16, 16], mono: true },
  { id: 'nave', label: 'nave', url: nave, frame: [0, 0, 64, 64], mono: false },
  { id: 'anda', label: 'topo', url: anda, frame: [0, 0, 67, 75], mono: false },
  { id: 'hoyo', label: 'topo en hoyo', url: hoyo, frame: [0, 0, 64, 64], mono: false },
  { id: 'detective', label: 'topo detective', url: detective, frame: [0, 0, 64, 64], mono: false },
  { id: 'tieso', label: 'topo tieso', url: tieso, frame: [0, 0, 64, 64], mono: false },
  { id: 'minero', label: 'topo minero', url: minero, frame: [0, 0, 220, 258], mono: false },
] as const;

export type SpriteId = (typeof SPRITES)[number]['id'];

// '' = colores originales del sprite.
export const SPRITE_COLORS = ['', '#5fff5f', '#ffd75f', '#5fd7ff', '#ff5fd7', '#ff5f5f', '#5f87ff', '#e8e8e8'];

const images = new Map<string, Promise<HTMLImageElement>>();
function load(url: string) {
  let p = images.get(url);
  if (!p) {
    p = new Promise((ok, fail) => {
      const img = new Image();
      img.onload = () => ok(img);
      img.onerror = () => fail(new Error('No se pudo cargar el sprite'));
      img.src = url;
    });
    images.set(url, p);
  }
  return p;
}

function rgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

// Teñido tipo "colorear": la luminancia de cada píxel (estirada a todo el rango del sprite) decide
// cuánto se oscurece o aclara el color elegido. Los sprites de un color se rellenan sin más.
function tint(data: Uint8ClampedArray, hex: string, mono: boolean) {
  const [r, g, b] = rgb(hex);
  const lum = (i: number) => 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
  let lo = 255;
  let hi = 0;
  for (let i = 0; i < data.length; i += 4) {
    if (!data[i + 3]) continue;
    const l = lum(i);
    lo = Math.min(lo, l);
    hi = Math.max(hi, l);
  }
  for (let i = 0; i < data.length; i += 4) {
    if (!data[i + 3]) continue;
    // 0.15–0.95: lo más oscuro no llega a negro puro y lo más claro no se queda en blanco.
    const t = mono || hi === lo ? 0.5 : 0.15 + (0.8 * (lum(i) - lo)) / (hi - lo);
    const k = t < 0.5 ? t * 2 : (t - 0.5) * 2;
    data[i] = t < 0.5 ? r * k : r + (255 - r) * k;
    data[i + 1] = t < 0.5 ? g * k : g + (255 - g) * k;
    data[i + 2] = t < 0.5 ? b * k : b + (255 - b) * k;
  }
}

// Sprite + color → PNG data: cuadrado, escalado sin suavizar (a entero si cabe) y centrado.
export async function spriteAvatar(id: SpriteId, color: string): Promise<string> {
  const s = SPRITES.find((x) => x.id === id) ?? SPRITES[0];
  const [fx, fy, fw, fh] = s.frame;
  const img = await load(s.url);
  const src = document.createElement('canvas');
  src.width = fw;
  src.height = fh;
  const sg = src.getContext('2d');
  if (!sg) throw new Error('Sin canvas');
  sg.drawImage(img, fx, fy, fw, fh, 0, 0, fw, fh);
  if (color) {
    const px = sg.getImageData(0, 0, fw, fh);
    tint(px.data, color, s.mono);
    sg.putImageData(px, 0, 0);
  }
  const big = Math.max(fw, fh);
  const scale = big <= 128 ? Math.floor(128 / big) : 1 / Math.ceil(big / 130);
  const side = Math.round(big * scale);
  const out = document.createElement('canvas');
  out.width = out.height = side;
  const g = out.getContext('2d');
  if (!g) throw new Error('Sin canvas');
  g.imageSmoothingEnabled = false;
  const w = Math.round(fw * scale);
  const h = Math.round(fh * scale);
  g.drawImage(src, 0, 0, fw, fh, Math.floor((side - w) / 2), Math.floor((side - h) / 2), w, h);
  return out.toDataURL('image/png');
}
