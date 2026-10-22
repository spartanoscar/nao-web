// Voz del teléfono para la transcripción en el servidor (server/transcribe.go, patrón de Juntox).
// El micrófono pasa por un AudioWorklet que lo baja a PCM16 de 16 kHz mono en tramos de 20 ms; un detector de voz
// por energía decide qué se envía: solo se manda (y se paga) lo que se habla. Como en Juntox: 0.4 s de audio previo
// para no cortar la primera sílaba y 0.6 s de silencio para cerrar la frase.
// Mensajes binarios: [1] inicio de voz · [2]+PCM16 (100 ms) · [3] fin de voz.
// APPROX: Juntox usa Silero VAD en el servidor (una sala con varias personas); aquí hay un solo micrófono cercano y
// basta un umbral de energía sobre el piso de ruido.

const TARGET_RATE = 16000;
const FRAME = 320; // 20 ms a 16 kHz
const PREROLL_FRAMES = 20; // 0.4 s
const START_FRAMES = 3; // 60 ms seguidos sobre el umbral para empezar
const HANGOVER_FRAMES = 30; // 0.6 s de silencio para terminar
const SEND_FRAMES = 5; // se agrupan en mensajes de 100 ms
const MIN_THRESHOLD = 0.012;
const NOISE_FACTOR = 3.5;

// Remuestreo lineal a 16 kHz y tramos de 20 ms con su energía (RMS)
const WORKLET = `
class Pcm16 extends AudioWorkletProcessor {
  constructor() { super(); this.ratio = sampleRate / ${TARGET_RATE}; this.pos = 0; this.buf = new Int16Array(${FRAME}); this.n = 0; this.sum = 0; this.prev = 0; }
  process(inputs) {
    const ch = inputs[0][0];
    if (!ch) return true;
    for (let i = 0; i < ch.length; i++) {
      const cur = ch[i];
      while (this.pos <= 1) {
        const v = this.prev + (cur - this.prev) * this.pos;
        const s = Math.max(-1, Math.min(1, v));
        this.buf[this.n++] = s * 32767;
        this.sum += s * s;
        if (this.n === ${FRAME}) {
          this.port.postMessage({ pcm: this.buf, rms: Math.sqrt(this.sum / ${FRAME}) }, [this.buf.buffer]);
          this.buf = new Int16Array(${FRAME}); this.n = 0; this.sum = 0;
        }
        this.pos += this.ratio;
      }
      this.pos -= 1;
      this.prev = cur;
    }
    return true;
  }
}
registerProcessor('pcm16', Pcm16);`;

export interface VoiceSender {
  /** Encender o pausar el envío (el micrófono sigue abierto para el medidor) */
  setEnabled(on: boolean): void;
  /** Nivel 0–1 y si está hablando, para el medidor */
  onLevel: (level: number, speaking: boolean) => void;
}

export async function startVoice(stream: MediaStream, send: (data: Uint8Array<ArrayBuffer>) => void): Promise<VoiceSender> {
  const ctx = new AudioContext();
  await ctx.audioWorklet.addModule(URL.createObjectURL(new Blob([WORKLET], { type: 'text/javascript' })));
  const node = new AudioWorkletNode(ctx, 'pcm16');
  ctx.createMediaStreamSource(stream).connect(node);
  // El nodo tiene que llegar al destino para que el navegador lo procese; sin volumen, para no oírse
  const mute = ctx.createGain();
  mute.gain.value = 0;
  node.connect(mute).connect(ctx.destination);

  let enabled = true;
  let speaking = false;
  let above = 0;
  let below = 0;
  let noise = 0.01;
  const preroll: Int16Array[] = [];
  let pending: Int16Array[] = [];

  const packet = (kind: number, frames: Int16Array[] = []) => {
    const bytes = new Uint8Array(new ArrayBuffer(1 + frames.length * FRAME * 2));
    bytes[0] = kind;
    frames.forEach((f, i) => bytes.set(new Uint8Array(f.buffer, f.byteOffset, f.byteLength), 1 + i * FRAME * 2));
    send(bytes);
  };
  const flush = () => {
    if (pending.length) packet(2, pending);
    pending = [];
  };

  const sender: VoiceSender = {
    setEnabled(on) {
      enabled = on;
      if (!on && speaking) {
        flush();
        packet(3);
        speaking = false;
      }
    },
    onLevel: () => undefined,
  };

  node.port.onmessage = (e: MessageEvent<{ pcm: Int16Array; rms: number }>) => {
    const { pcm, rms } = e.data;
    const threshold = Math.max(MIN_THRESHOLD, noise * NOISE_FACTOR);
    if (!speaking) {
      // Piso de ruido: baja rápido y sube despacio (no se lo lleva la propia voz)
      noise = rms < noise ? noise * 0.9 + rms * 0.1 : noise * 0.995 + rms * 0.005;
      preroll.push(pcm);
      if (preroll.length > PREROLL_FRAMES) preroll.shift();
      above = rms > threshold ? above + 1 : 0;
      if (enabled && above >= START_FRAMES) {
        speaking = true;
        below = 0;
        packet(1);
        pending = preroll.splice(0);
        flush();
      }
    } else {
      pending.push(pcm);
      if (pending.length >= SEND_FRAMES) flush();
      below = rms > threshold ? 0 : below + 1;
      if (below >= HANGOVER_FRAMES) {
        flush();
        packet(3);
        speaking = false;
        above = 0;
      }
    }
    sender.onLevel(Math.min(1, rms * 8), speaking);
  };
  return sender;
}
