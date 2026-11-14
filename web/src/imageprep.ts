// Antes de enviar, toda imagen se vuelve a pintar y codificar: así se va el EXIF (GPS incluido),
// el formato queda en WebP o JPEG y el tamaño cabe en MAX_IMAGE.
import { MAX_IMAGE, MAX_SIDE, sniffMime, type ImageMime } from './images';

const MAX_INPUT = 40_000_000;

export interface PreparedImage {
  bytes: Uint8Array<ArrayBuffer>;
  mime: ImageMime;
  w: number;
  h: number;
}

const toBlob = (c: HTMLCanvasElement, mime: string, q: number) => new Promise<Blob | null>((ok) => c.toBlob(ok, mime, q));

export async function prepareImage(file: Blob): Promise<PreparedImage> {
  if (file.size > MAX_INPUT) throw new Error('la imagen pesa demasiado (máx. 40 MB)');
  const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' }).catch(() => {
    throw new Error('no es una imagen que este navegador sepa abrir');
  });
  try {
    let scale = Math.min(1, MAX_SIDE / Math.max(bmp.width, bmp.height));
    for (let attempt = 0; attempt < 6; attempt++, scale *= 0.7) {
      const w = Math.max(1, Math.round(bmp.width * scale));
      const h = Math.max(1, Math.round(bmp.height * scale));
      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      const g = canvas.getContext('2d')!;
      g.drawImage(bmp, 0, 0, w, h);
      let blob = await toBlob(canvas, 'image/webp', 0.85);
      // Safari no codifica WebP y devuelve PNG: entonces JPEG, sobre blanco porque no tiene alfa.
      if (blob?.type !== 'image/webp') {
        g.fillStyle = '#fff';
        g.fillRect(0, 0, w, h);
        g.drawImage(bmp, 0, 0, w, h);
        blob = await toBlob(canvas, 'image/jpeg', 0.85);
      }
      if (!blob) continue;
      if (blob.size > MAX_IMAGE) continue;
      const bytes = new Uint8Array(await blob.arrayBuffer());
      const mime = sniffMime(bytes);
      if (mime) return { bytes, mime, w, h };
    }
    throw new Error('no se pudo dejar la imagen por debajo de 2 MB');
  } finally {
    bmp.close();
  }
}

// Lo que llega se decodifica antes de enseñarlo: si el navegador no puede, no se muestra.
export async function decodedSize(bytes: Uint8Array<ArrayBuffer>, mime: ImageMime) {
  const bmp = await createImageBitmap(new Blob([bytes], { type: mime }));
  const size = { w: bmp.width, h: bmp.height };
  bmp.close();
  return size;
}
