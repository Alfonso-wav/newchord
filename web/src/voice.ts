// Voz y texto en la sala: leer en voz alta (TTS, voces del sistema) y dictar (STT, Whisper local).
// Une la malla con speech.ts y stt.ts; la interfaz lee `voice.settings` y `voice.stt`.
import type { Mesh } from './mesh';
import { speak, stopSpeaking, ttsSupported, watchSpeaking } from './speech';
import { Dictation, type SttState } from './stt';

export interface VoiceSettings {
  sayAloud: boolean; // los mensajes «decir» (🔊) suenan
  readChat: boolean; // leer el chat de los demás
  readStt: boolean; // leer lo que los demás dictan
  dictate: boolean; // transcribir mi micro y mandarlo a la sala
  lang: string; // idioma de Whisper
  voice: string; // voiceURI elegida; '' = la primera local en español
  rate: number;
}

const KEY = 'cryptopo.voice';
const DEFAULTS: VoiceSettings = { sayAloud: true, readChat: false, readStt: false, dictate: false, lang: 'spanish', voice: '', rate: 1 };

function load(): VoiceSettings {
  try {
    return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(KEY) ?? '{}'), dictate: false };
  } catch {
    return { ...DEFAULTS };
  }
}

export class Voice {
  settings = load();
  stt: SttState = { phase: 'off' };
  canSpeak = ttsSupported();
  private version = 0;
  private listeners = new Set<() => void>();
  private dictation: Dictation;

  constructor(private mesh: Mesh) {
    this.dictation = new Dictation(
      (text, ts) => mesh.sendChat(text, 'stt', ts),
      () => {
        this.stt = this.dictation.state;
        if (this.stt.phase === 'error' && this.settings.dictate) this.settings = { ...this.settings, dictate: false };
        this.emit();
      },
    );
    watchSpeaking((on) => this.dictation.hold(on));
    mesh.onEvent((e) => {
      if (e.type !== 'message') return;
      const { msg, self } = e;
      const s = this.settings;
      const lang = s.lang === 'english' ? 'en' : s.lang === 'catalan' ? 'ca' : 'es';
      const opts = { voice: s.voice, lang, rate: s.rate };
      if (msg.kind === 'tts' && s.sayAloud && !msg.stored) speak(msg.text, opts);
      else if (self) return;
      else if ((msg.kind ?? 'chat') === 'chat' && s.readChat) speak(`${msg.name}: ${msg.text}`, opts);
      else if (msg.kind === 'stt' && s.readStt) speak(`${msg.name}: ${msg.text}`, opts);
    });
    // El dictado sigue a la sala y al micro: fuera de sala o sin micro, apagado.
    mesh.subscribe(() => this.sync());
  }

  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => void this.listeners.delete(fn);
  };
  getVersion = () => this.version;

  set(patch: Partial<VoiceSettings>) {
    this.settings = { ...this.settings, ...patch };
    const { dictate: _, ...persist } = this.settings;
    localStorage.setItem(KEY, JSON.stringify(persist));
    if (patch.lang !== undefined && this.dictation.running) this.dictation.stop();
    if (!this.settings.sayAloud && !this.settings.readChat && !this.settings.readStt) stopSpeaking();
    this.sync();
    this.emit();
  }

  private sync() {
    const mic = this.mesh.local.get('mic')?.stream;
    const want = this.settings.dictate && !!this.mesh.room && !!mic;
    if (want && mic) {
      if (!this.dictation.running) void this.dictation.start(mic, this.settings.lang);
      else this.dictation.attach(mic);
    } else if (this.dictation.running) this.dictation.stop();
  }

  private emit() {
    this.version++;
    for (const f of this.listeners) f();
  }
}
