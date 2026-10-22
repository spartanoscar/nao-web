// ALTextToSpeech: hacer hablar al robot. Misma firma que NAOqi 2.8.
// Docs: reference/naoqi-2.8-api/naoqi_audio_altexttospeech-api.md
// La voz original del NAO (motor comercial de Nuance, antes Acapela) no se puede usar; la voz base es
// Kokoro-82M y encima se aplican los parámetros documentados con los que NAOqi define la voz oficial
// (pitchShift, doubleVoice…). La capa NAOqi no conoce el audio: usa un SpeechBackend (audio/speech.ts).

import { NaoqiError } from './args';

const SERVICE = 'ALTextToSpeech';

export interface SpeechRequest {
  text: string;
  voice: string;
  lang: 'es' | 'en-us';
  /** Kokoro: 1 = normal (NAOqi speed 100) */
  speed: number;
  volume: number;
  pitchShift: number;
  doubleVoice: number;
  doubleVoiceLevel: number;
  doubleVoiceTimeShift: number;
}

export interface SpeechBackend {
  speak(req: SpeechRequest): Promise<void>;
  stop(): void;
}

/** Voces de Kokoro por idioma NAOqi (las de español vienen en el modelo aunque kokoro-js no las liste) */
const VOICES: Record<string, { lang: SpeechRequest['lang']; voices: string[] }> = {
  Spanish: { lang: 'es', voices: ['ef_dora', 'em_alex', 'em_santa'] },
  English: { lang: 'en-us', voices: ['af_heart', 'af_bella', 'am_michael', 'am_puck', 'bf_emma', 'bm_george'] },
};

/** Rangos de setParameter según la doc (fuera de rango → error, como el robot) */
const RANGES: Record<string, [number, number, boolean]> = {
  // [mín, máx, 0 permitido = apagado]
  pitchShift: [1, 4, true],
  doubleVoice: [1, 4, true],
  doubleVoiceLevel: [0, 4, false],
  doubleVoiceTimeShift: [0, 0.5, false],
  speed: [50, 400, false],
  defaultVoiceSpeed: [50, 400, false],
};

/**
 * Valores por defecto del simulador. APPROX: los de la voz oficial venían en un XML del robot que no
 * tenemos; se eligen de oído para un timbre infantil y ligeramente robótico (ajustables en el panel).
 */
export const NAO_VOICE_DEFAULTS = {
  voice: 'ef_dora',
  pitchShift: 1.18,
  doubleVoice: 0,
  doubleVoiceLevel: 0,
  doubleVoiceTimeShift: 0,
  speed: 100,
};

export class ALTextToSpeech {
  private language = 'Spanish';
  private voice = NAO_VOICE_DEFAULTS.voice;
  private volume = 1;
  private readonly params: Record<string, number> = {
    pitchShift: NAO_VOICE_DEFAULTS.pitchShift,
    doubleVoice: NAO_VOICE_DEFAULTS.doubleVoice,
    doubleVoiceLevel: NAO_VOICE_DEFAULTS.doubleVoiceLevel,
    doubleVoiceTimeShift: NAO_VOICE_DEFAULTS.doubleVoiceTimeShift,
    speed: NAO_VOICE_DEFAULTS.speed,
    defaultVoiceSpeed: NAO_VOICE_DEFAULTS.speed,
  };
  /** Lo pone Session cuando hay audio (sin backend, say() falla con un mensaje claro) */
  backend: SpeechBackend | null = null;

  /** Blocking. Dice el texto (opcionalmente en otro idioma) y se resuelve al terminar de hablar. */
  async say(text: string, language?: string): Promise<void> {
    if (!this.backend) throw new NaoqiError(SERVICE, 'say', 'no hay salida de audio');
    const lang = language ? this.languageInfo('say', language) : VOICES[this.language];
    const voice = language && language !== this.language ? lang.voices[0] : this.voice;
    await this.backend.speak({
      text: String(text),
      voice,
      lang: lang.lang,
      speed: this.params.speed / 100,
      volume: this.volume,
      pitchShift: this.params.pitchShift,
      doubleVoice: this.params.doubleVoice,
      doubleVoiceLevel: this.params.doubleVoiceLevel,
      doubleVoiceTimeShift: this.params.doubleVoiceTimeShift,
    });
  }

  stopAll(): void {
    this.backend?.stop();
  }

  setParameter(parameter: string, value: number): void {
    const range = RANGES[parameter];
    if (!range) throw new NaoqiError(SERVICE, 'setParameter', `parámetro desconocido "${parameter}"`);
    const [min, max, zeroOff] = range;
    if (!(Number.isFinite(value) && ((value >= min && value <= max) || (zeroOff && value === 0)))) {
      throw new NaoqiError(SERVICE, 'setParameter', `${parameter} fuera de rango [${min} - ${max}]${zeroOff ? ' (0 = apagado)' : ''}`);
    }
    this.params[parameter] = value;
    if (parameter === 'defaultVoiceSpeed') this.params.speed = value; // "Setting this parameter also resets the speed"
  }

  getParameter(parameter: string): number {
    if (!(parameter in this.params)) throw new NaoqiError(SERVICE, 'getParameter', `parámetro desconocido "${parameter}"`);
    return this.params[parameter];
  }

  resetSpeed(): void {
    this.params.speed = this.params.defaultVoiceSpeed;
  }

  /** Volumen 0–1 */
  setVolume(volume: number): void {
    this.volume = Math.min(Math.max(volume, 0), 1);
  }

  getVolume(): number {
    return this.volume;
  }

  setLanguage(language: string): void {
    this.languageInfo('setLanguage', language);
    this.language = language;
    this.voice = VOICES[language].voices[0];
  }

  getLanguage(): string {
    return this.language;
  }

  getAvailableLanguages(): string[] {
    return Object.keys(VOICES);
  }

  getSupportedLanguages(): string[] {
    return this.getAvailableLanguages();
  }

  setVoice(voiceID: string): void {
    const lang = Object.entries(VOICES).find(([, v]) => v.voices.includes(voiceID));
    if (!lang) throw new NaoqiError(SERVICE, 'setVoice', `voz desconocida "${voiceID}" (getAvailableVoices)`);
    this.language = lang[0];
    this.voice = voiceID;
  }

  getVoice(): string {
    return this.voice;
  }

  getAvailableVoices(): string[] {
    return Object.values(VOICES).flatMap((v) => v.voices);
  }

  private languageInfo(method: string, language: string) {
    const info = VOICES[language];
    if (!info) throw new NaoqiError(SERVICE, method, `idioma no disponible "${language}" (getAvailableLanguages)`);
    return info;
  }
}
