// Síntesis de voz con las voces del sistema. Solo las locales (localService): las «Google …» de
// Chrome mandan el texto a Google para leerlo, y eso no sale de aquí.

const synth: SpeechSynthesis | undefined = typeof speechSynthesis !== 'undefined' ? speechSynthesis : undefined;
const MAX_QUEUE = 6;

let voices: SpeechSynthesisVoice[] = [];
const refresh = () => {
  voices = (synth?.getVoices() ?? []).filter((v) => v.localService);
};
refresh();
synth?.addEventListener?.('voiceschanged', refresh);

export const ttsSupported = () => !!synth;
export const localVoices = () => voices;

function pickVoice(uri: string, lang: string) {
  return voices.find((v) => v.voiceURI === uri) ?? voices.find((v) => v.lang.toLowerCase().startsWith(lang)) ?? voices.find((v) => v.default) ?? voices[0] ?? null;
}

let pending = 0;
let onSpeaking: (on: boolean) => void = () => {};
export const watchSpeaking = (fn: (on: boolean) => void) => {
  onSpeaking = fn;
};

// Devuelve false si no hay voz local con la que leerlo.
export function speak(text: string, opts: { voice?: string; lang?: string; rate?: number } = {}): boolean {
  if (!synth) return false;
  const voice = pickVoice(opts.voice ?? '', opts.lang ?? 'es');
  if (!voice) return false;
  // Si se acumula (alguien escribe muy rápido), se salta lo viejo.
  if (pending >= MAX_QUEUE) {
    synth.cancel();
    pending = 0;
  }
  const u = new SpeechSynthesisUtterance(text.slice(0, 600));
  u.voice = voice;
  u.lang = voice.lang;
  u.rate = opts.rate ?? 1;
  const done = () => {
    pending = Math.max(0, pending - 1);
    if (!pending) onSpeaking(false);
  };
  u.onend = done;
  u.onerror = done;
  pending++;
  onSpeaking(true);
  synth.speak(u);
  return true;
}

export function stopSpeaking() {
  synth?.cancel();
  pending = 0;
  onSpeaking(false);
}
