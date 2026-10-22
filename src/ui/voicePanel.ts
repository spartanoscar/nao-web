// Panel de voz (en el panel oculto): hacer hablar al robot con ALTextToSpeech y ajustar de oído los
// parámetros documentados de su voz. Todo pasa por la API NAOqi (say, setParameter, setVoice).

import type { SpeechStatus } from '../audio/speech';
import type { ALTextToSpeech } from '../naoqi/ALTextToSpeech';
import { NAO_VOICE_DEFAULTS } from '../naoqi/ALTextToSpeech';

const STORAGE_KEY = 'nao.voice';
const PARAMS = ['pitchShift', 'doubleVoice', 'doubleVoiceLevel', 'doubleVoiceTimeShift', 'speed'] as const;
type Param = (typeof PARAMS)[number];

/** Controles: [mín, máx, paso]; en pitchShift/doubleVoice el mínimo del control (0.99) significa "apagado" (0) */
const CONTROLS: Record<Param, { label: string; min: number; max: number; step: number; off?: boolean }> = {
  pitchShift: { label: 'Tono (pitchShift)', min: 0.99, max: 2, step: 0.01, off: true },
  doubleVoice: { label: 'Doble voz (doubleVoice)', min: 0.99, max: 3, step: 0.01, off: true },
  doubleVoiceLevel: { label: 'Nivel doble voz', min: 0, max: 1, step: 0.01 },
  doubleVoiceTimeShift: { label: 'Retraso doble voz (s)', min: 0, max: 0.05, step: 0.001 },
  speed: { label: 'Velocidad (speed)', min: 50, max: 200, step: 1 },
};

const PRESETS: Record<string, Record<Param, number>> = {
  NAO: {
    pitchShift: NAO_VOICE_DEFAULTS.pitchShift,
    doubleVoice: NAO_VOICE_DEFAULTS.doubleVoice,
    doubleVoiceLevel: NAO_VOICE_DEFAULTS.doubleVoiceLevel,
    doubleVoiceTimeShift: NAO_VOICE_DEFAULTS.doubleVoiceTimeShift,
    speed: NAO_VOICE_DEFAULTS.speed,
  },
  Natural: { pitchShift: 0, doubleVoice: 0, doubleVoiceLevel: 0, doubleVoiceTimeShift: 0, speed: 100 },
  Robot: { pitchShift: 1.1, doubleVoice: 1.5, doubleVoiceLevel: 0.6, doubleVoiceTimeShift: 0.012, speed: 95 },
};

export interface VoicePanel {
  /** Estado de la descarga y del habla (de KokoroSpeech.onStatus) */
  setStatus(s: SpeechStatus): void;
}

export function createVoicePanel(host: HTMLElement, tts: ALTextToSpeech): VoicePanel {
  // Restaurar lo que el usuario ajustó
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null');
    if (saved) {
      if (saved.voice) tts.setVoice(saved.voice);
      for (const p of PARAMS) if (typeof saved[p] === 'number') tts.setParameter(p, saved[p]);
    }
  } catch {
    /* preferencias inválidas o sin almacenamiento: valores por defecto */
  }
  const save = () => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ voice: tts.getVoice(), ...Object.fromEntries(PARAMS.map((p) => [p, tts.getParameter(p)])) }));
    } catch {
      /* modo privado */
    }
  };

  const section = document.createElement('details');
  section.className = 'chain voice-panel';
  section.open = true;
  const summary = document.createElement('summary');
  summary.textContent = 'Voz · ALTextToSpeech';
  section.append(summary);

  const form = document.createElement('form');
  form.className = 'say';
  const input = document.createElement('input');
  input.type = 'text';
  input.placeholder = 'Escribe lo que dirá el NAO…';
  input.value = 'Hola, soy NAO. ¿En qué te puedo ayudar?';
  const sayBtn = document.createElement('button');
  sayBtn.type = 'submit';
  sayBtn.className = 'chip';
  sayBtn.textContent = 'Decir';
  const stopBtn = document.createElement('button');
  stopBtn.type = 'button';
  stopBtn.className = 'chip';
  stopBtn.textContent = 'Callar';
  form.append(input, sayBtn, stopBtn);
  const status = document.createElement('div');
  status.className = 'activity';
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const text = input.value.trim();
    if (!text) return;
    status.textContent = `▶ ALTextToSpeech.say("${text.length > 40 ? text.slice(0, 40) + '…' : text}")`;
    status.classList.remove('error');
    tts.say(text).catch((err: Error) => {
      status.textContent = err.message;
      status.classList.add('error');
    });
  });
  stopBtn.addEventListener('click', () => tts.stopAll());

  const voice = document.createElement('select');
  voice.setAttribute('aria-label', 'Voz');
  for (const v of tts.getAvailableVoices()) voice.append(new Option(v, v, false, v === tts.getVoice()));
  voice.addEventListener('change', () => {
    tts.setVoice(voice.value);
    save();
  });

  const sliders = new Map<Param, { input: HTMLInputElement; value: HTMLElement }>();
  const grid = document.createElement('div');
  grid.className = 'voice-params';
  const show = (p: Param) => {
    const v = tts.getParameter(p);
    const s = sliders.get(p)!;
    const c = CONTROLS[p];
    s.input.value = String(c.off && v === 0 ? c.min : v);
    s.value.textContent = c.off && v === 0 ? 'apagado' : String(v);
  };
  for (const p of PARAMS) {
    const c = CONTROLS[p];
    const row = document.createElement('label');
    row.className = 'joint';
    const name = document.createElement('span');
    name.className = 'joint-name';
    name.textContent = c.label;
    const value = document.createElement('span');
    value.className = 'joint-value';
    const range = document.createElement('input');
    range.type = 'range';
    range.min = String(c.min);
    range.max = String(c.max);
    range.step = String(c.step);
    range.addEventListener('input', () => {
      const v = Number(range.value);
      tts.setParameter(p, c.off && v < 1 ? 0 : v);
      show(p);
      save();
    });
    row.append(name, value, range);
    grid.append(row);
    sliders.set(p, { input: range, value });
    show(p);
  }

  const presets = document.createElement('div');
  presets.className = 'chips';
  for (const [name, values] of Object.entries(PRESETS)) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'chip';
    b.textContent = name;
    b.addEventListener('click', () => {
      for (const p of PARAMS) tts.setParameter(p, values[p]);
      PARAMS.forEach(show);
      save();
    });
    presets.append(b);
  }

  section.append(form, status, voice, presets, grid);
  host.append(section);

  return {
    setStatus({ loading, loaded, total, ready, speaking, engine }) {
      if (loading && total > 0) status.textContent = `Descargando la voz (una sola vez): ${(loaded / 1e6).toFixed(0)} / ${(total / 1e6).toFixed(0)} MB`;
      else if (loading) status.textContent = 'Preparando la voz…';
      else if (!speaking && ready) status.textContent = engine.startsWith('webgpu') ? 'Voz en la GPU' : 'Voz en la CPU (sin WebGPU: más lenta)';
    },
  };
}
