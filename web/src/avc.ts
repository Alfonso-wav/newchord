// Utilidades H.264 en Annex B para el puente de pantalla de la app Android.
// Sin dependencias del DOM: se prueban con node (test/avc.test.mjs).

// Recorre las unidades NAL de un buffer Annex B (prefijos 00 00 01 o 00 00 00 01).
export function* nalUnits(buf: Uint8Array): Generator<Uint8Array> {
  let start = -1;
  let i = 0;
  while (i + 2 < buf.length) {
    if (buf[i] === 0 && buf[i + 1] === 0 && buf[i + 2] === 1) {
      if (start >= 0) {
        // Un 00 extra antes del prefijo pertenece al prefijo largo, no a la NAL anterior.
        let end = i;
        if (end > start && buf[end - 1] === 0) end--;
        yield buf.subarray(start, end);
      }
      i += 3;
      start = i;
    } else i++;
  }
  if (start >= 0 && start < buf.length) yield buf.subarray(start);
}

// Cadena de codec para WebCodecs ("avc1.PPCCLL") a partir del SPS que acompaña a cada
// fotograma clave. '' si el buffer no trae SPS.
export function avcCodecString(buf: Uint8Array): string {
  for (const nal of nalUnits(buf)) {
    if ((nal[0] & 0x1f) !== 7 || nal.length < 4) continue;
    return 'avc1.' + [nal[1], nal[2], nal[3]].map((b) => b.toString(16).padStart(2, '0')).join('');
  }
  return '';
}

// Cabecera de los paquetes binarios que manda la app (ver Bridge.kt):
// [0] tipo (1 vídeo, 2 audio) · [1] flags (bit 0: clave) · [2..9] marca de tiempo en µs, big endian.
export const PACKET_HEADER = 10;
export const PACKET_VIDEO = 1;
export const PACKET_AUDIO = 2;

export interface Packet {
  type: number;
  key: boolean;
  timestamp: number;
  data: Uint8Array<ArrayBuffer>;
}

export function parsePacket(buf: ArrayBuffer): Packet | null {
  if (buf.byteLength < PACKET_HEADER) return null;
  const v = new DataView(buf);
  return {
    type: v.getUint8(0),
    key: (v.getUint8(1) & 1) === 1,
    timestamp: Number(v.getBigInt64(2)),
    data: new Uint8Array(buf, PACKET_HEADER),
  };
}
