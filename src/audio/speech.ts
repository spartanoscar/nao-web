// Voz del robot en el navegador: Kokoro en un Web Worker (tts.worker.ts) + reproducción con WebAudio.
// Las frases se generan una a una y se encadenan sin huecos: la primera suena sin esperar el resto.

import type { SpeechBackend, SpeechRequest } from '../naoqi/ALTextToSpeech';
import type { TtsRequest, TtsResponse } from './tts.worker';

export class KokoroSpeech implements SpeechBackend {
  private worker: Worker | null = null;
  private ctx: AudioContext | null = null;
  private gain: GainNode | null = null;
  /** Volumen general del robot (ALAudioDevice), después del volumen de la voz (ALTextToSpeech.setVolume) */
  private output: GainNode | null = null;
  private outputGain = 1;
  private nextId = 1;
  private current = 0;
  private playing = new Set<AudioBufferSourceNode>();
  private pending = new Map<number, { resolve: () => void; reject: (e: Error) => void; endAt: number; done: boolean }>();
  /** Motor de inferencia en uso ("webgpu fp32" / "wasm q8") */
  engine = '';

  /** Descarga el modelo y lo deja listo sin hablar (se llama al entrar al mundo, en segundo plano) */
  preload(voice?: string): void {
    this.ensureWorker().postMessage({ type: 'load', voice } satisfies TtsRequest);
  }

  async speak(req: SpeechRequest): Promise<void> {
    this.ensureAudio();
    const id = this.nextId++;
    this.current = id;
    const done = new Promise<void>((resolve, reject) => this.pending.set(id, { resolve, reject, endAt: 0, done: false }));
    this.ensureWorker().postMessage({
      type: 'speak', id, text: req.text, voice: req.voice, lang: req.lang, speed: req.speed,
      fx: { pitchShift: req.pitchShift, doubleVoice: req.doubleVoice, doubleVoiceLevel: req.doubleVoiceLevel, doubleVoiceTimeShift: req.doubleVoiceTimeShift },
    } satisfies TtsRequest);
    this.gain!.gain.value = req.volume;
    return done;
  }

  /** Ganancia general de salida (ALAudioDevice.outputGain) */
  setOutput(gain: number): void {
    this.outputGain = Math.min(Math.max(gain, 0), 1);
    if (this.ctx && this.output) this.output.gain.setTargetAtTime(this.outputGain, this.ctx.currentTime, 0.05);
  }

  stop(): void {
    this.current = 0;
    for (const s of this.playing) s.stop();
    this.playing.clear();
    for (const p of this.pending.values()) p.resolve();
    this.pending.clear();
  }

  private ensureAudio(): void {
    if (!this.ctx) {
      this.ctx = new AudioContext();
      this.gain = this.ctx.createGain();
      this.output = this.ctx.createGain();
      this.output.gain.value = this.outputGain;
      this.gain.connect(this.output).connect(this.ctx.destination);
    }
    void this.ctx.resume();
  }

  private ensureWorker(): Worker {
    if (this.worker) return this.worker;
    const w = new Worker(new URL('./tts.worker.ts', import.meta.url), { type: 'module' });
    w.onmessage = (e: MessageEvent<TtsResponse>) => this.onMessage(e.data);
    this.worker = w;
    return w;
  }

  private onMessage(m: TtsResponse): void {
    if (m.type === 'ready') {
      this.engine = m.engine;
      return;
    }
    if (m.type === 'error') {
      const p = m.id ? this.pending.get(m.id) : undefined;
      if (p) {
        this.pending.delete(m.id!);
        p.reject(new Error(m.message));
      } else console.warn('Voz:', m.message);
      return;
    }
    // chunk: encadenar detrás de lo que ya está sonando
    const p = this.pending.get(m.id);
    if (!p || m.id !== this.current || !this.ctx) return;
    const buf = this.ctx.createBuffer(1, m.audio.length, m.sampleRate);
    buf.copyToChannel(m.audio as Float32Array<ArrayBuffer>, 0);
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    src.connect(this.gain!);
    const start = Math.max(this.ctx.currentTime + 0.02, p.endAt);
    src.start(start);
    p.endAt = start + buf.duration;
    this.playing.add(src);
    src.onended = () => {
      this.playing.delete(src);
      if (p.done && this.ctx && this.ctx.currentTime >= p.endAt - 0.05) {
        this.pending.delete(m.id);
        p.resolve();
      }
    };
    if (m.last) p.done = true;
  }
}
