// Voz del sistema (Web Speech, speechSynthesis) para iPad/iPhone: Kokoro ocupa ~300 MB aun en su versión liviana y
// Safari en iOS cerraba la pestaña por memoria (2026-10-24, dos veces seguidas). No es la "voz del NAO" armada con
// Kokoro: es una voz del dispositivo en el idioma pedido, con los parámetros de ALTextToSpeech que el sistema admite.
// APPROX: pitchShift → pitch (Web Speech va de 0 a 2), speed → rate; doubleVoice no existe aquí.

import type { SpeechBackend, SpeechRequest } from '../naoqi/ALTextToSpeech';

const LANG: Record<SpeechRequest['lang'], string[]> = {
  es: ['es-419', 'es-MX', 'es-US', 'es-CO', 'es-ES', 'es'],
  'en-us': ['en-US', 'en'],
};

export class NativeSpeech implements SpeechBackend {
  engine = '';
  onReady?: (engine: string) => void;
  private gain = 1;

  constructor() {
    // iOS solo deja hablar después de un gesto: la primera vez se dice algo vacío al tocar la pantalla
    const unlock = () => speechSynthesis.speak(new SpeechSynthesisUtterance(''));
    addEventListener('pointerdown', unlock, { once: true });
  }

  /** Nada que descargar: solo se avisa cuál quedó */
  preload(): void {
    const ready = () => {
      this.engine = `sistema (${this.pick('es')?.name ?? 'voz por defecto'})`;
      this.onReady?.(this.engine);
    };
    if (speechSynthesis.getVoices().length) ready();
    else speechSynthesis.addEventListener('voiceschanged', ready, { once: true });
  }

  setOutput(gain: number): void {
    this.gain = gain;
  }

  speak(req: SpeechRequest): Promise<void> {
    return new Promise((resolve) => {
      const u = new SpeechSynthesisUtterance(req.text);
      const voice = this.pick(req.lang);
      if (voice) u.voice = voice;
      u.lang = voice?.lang ?? LANG[req.lang][0];
      u.rate = Math.min(Math.max(req.speed, 0.5), 2);
      u.pitch = Math.min(Math.max(req.pitchShift || 1, 0), 2);
      u.volume = Math.min(Math.max(req.volume * this.gain, 0), 1);
      u.onend = () => resolve();
      u.onerror = () => resolve();
      speechSynthesis.speak(u);
    });
  }

  stop(): void {
    speechSynthesis.cancel();
  }

  private pick(lang: SpeechRequest['lang']): SpeechSynthesisVoice | undefined {
    const voices = speechSynthesis.getVoices();
    for (const tag of LANG[lang]) {
      const v = voices.find((x) => x.lang.replace('_', '-').toLowerCase().startsWith(tag.toLowerCase()));
      if (v) return v;
    }
    return undefined;
  }
}
