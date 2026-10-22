// Síntesis de voz con Kokoro-82M (Apache-2.0) en un hilo aparte: el modelo se baja una vez del
// Hugging Face Hub y queda en la caché del navegador. Motor (medido en M-series, frase de 2 s / 5 s):
// - WebGPU fp32 (326 MB): 0.42 s / 0.92 s (RTF ~0.2). El que se usa si hay GPU.
// - WASM q8 (92 MB, 4 hilos): 2.0 s / 4.1 s (RTF ~0.85–1). Sin GPU o si la GPU falla al cargar.
// Descartados: WebGPU fp16 (degrada la voz: envolvente con correlación 0.39 frente a fp32, el doble
// de ruido agudo) y WebGPU q8 (igual de lento que WASM). WASM q8 ≈ fp32 (correlación 0.999).
// kokoro-js 1.2.1 solo acepta voces en inglés y fonemiza siempre en en-us; el modelo trae voces en
// español (ef_dora, em_alex, em_santa), así que aquí se fonemiza aparte y se llama a
// generate_from_ids, que no restringe la voz. Español: spanishG2P (reglas, 98% igual a espeak es-419;
// el paquete phonemizer solo trae inglés). Inglés: phonemizer (espeak-ng).

import { env } from '@huggingface/transformers';
import { KokoroTTS } from 'kokoro-js';
import { phonemize } from 'phonemizer';
import { spanishToIpa } from './spanishG2P';
import { type VoiceFx, applyVoiceFx } from './voiceFx';

const MODEL = 'onnx-community/Kokoro-82M-v1.0-ONNX';

// Hilos de WebAssembly (requiere aislamiento COOP/COEP): por defecto onnxruntime usa la mitad de los
// núcleos; se deja uno libre para la página (física y render)
const cores = self.navigator?.hardwareConcurrency ?? 4;
// Medido (M-series, 8 núcleos, frase de 5 s): 1 hilo RTF 1.73, 4 hilos 0.85, 7 hilos 0.92. Más hilos
// no ayudan: entran los núcleos de eficiencia y cada paso espera al más lento.
const forced = Number(/threads=(\d+)/.exec(self.name)?.[1]); // pruebas: new Worker(url, { name: 'threads=4' })
if (env.backends.onnx.wasm) env.backends.onnx.wasm.numThreads = forced || Math.max(1, Math.min(cores - 1, 4));

export type TtsRequest =
  | { type: 'load'; voice?: string }
  | { type: 'speak'; id: number; text: string; voice: string; lang: 'es' | 'en-us'; speed: number; fx: VoiceFx };

export type TtsResponse =
  | { type: 'progress'; loaded: number; total: number }
  | { type: 'ready'; engine: string }
  | { type: 'chunk'; id: number; text: string; audio: Float32Array; sampleRate: number; last: boolean }
  | { type: 'error'; id?: number; message: string };

type Engine = { device: 'webgpu' | 'wasm'; dtype: 'fp32' | 'q8' };
const WASM: Engine = { device: 'wasm', dtype: 'q8' };

/** WebGPU si el navegador lo trae y hay adaptador. Pruebas: new Worker(url, { name: 'device=wasm dtype=q8' }) */
async function pickEngine(): Promise<Engine> {
  const device = /device=(\w+)/.exec(self.name)?.[1];
  if (device) return { device, dtype: /dtype=(\w+)/.exec(self.name)?.[1] ?? 'q8' } as Engine;
  const gpu = (self.navigator as Navigator & { gpu?: { requestAdapter(): Promise<unknown> } }).gpu;
  try {
    if (gpu && (await gpu.requestAdapter())) return { device: 'webgpu', dtype: 'fp32' };
  } catch {
    /* sin adaptador */
  }
  return WASM;
}

let model: Promise<KokoroTTS> | null = null;
const post = (m: TtsResponse, transfer: Transferable[] = []) => (self as unknown as Worker).postMessage(m, transfer);

function load(): Promise<KokoroTTS> {
  model ??= pickEngine().then(async (engine) => {
    try {
      const tts = await loadWith(engine);
      post({ type: 'ready', engine: `${engine.device} ${engine.dtype}` });
      return tts;
    } catch (err) {
      if (engine.device === 'wasm') throw err;
      console.warn('Voz: WebGPU falló, se usa WASM:', err);
      const tts = await loadWith(WASM);
      post({ type: 'ready', engine: `${WASM.device} ${WASM.dtype}` });
      return tts;
    }
  });
  return model;
}

function loadWith({ device, dtype }: Engine): Promise<KokoroTTS> {
  const files = new Map<string, [number, number]>();
  return KokoroTTS.from_pretrained(MODEL, {
    dtype,
    device,
    progress_callback: (p: { status: string; file?: string; loaded?: number; total?: number }) => {
      if (p.status !== 'progress' || !p.file) return;
      files.set(p.file, [p.loaded ?? 0, p.total ?? 0]);
      let loaded = 0;
      let total = 0;
      for (const [l, t] of files.values()) {
        loaded += l;
        total += t;
      }
      post({ type: 'progress', loaded, total });
    },
  });
}

/** Palabras por trozo antes de cortar en una coma: el primer audio sale antes (cada trozo se genera entero) */
const CLAUSE_WORDS = 8;

/** Oraciones y, si son largas, cláusulas: la primera suena sin esperar el resto */
function sentences(text: string): string[] {
  const parts = text.match(/[^.!?¡¿…\n]+[.!?…]*|[¡¿][^.!?…\n]+[.!?…]*/g) ?? [text];
  const out: string[] = [];
  for (const sentence of parts.map((s) => s.trim()).filter(Boolean)) {
    let chunk = '';
    for (const clause of sentence.split(/(?<=[,;:])\s+/)) {
      chunk = chunk ? `${chunk} ${clause}` : clause;
      if (chunk.split(/\s+/).length >= CLAUSE_WORDS && /[,;:]$/.test(chunk)) {
        out.push(chunk);
        chunk = '';
      }
    }
    if (chunk) out.push(chunk);
  }
  return out;
}

self.onmessage = async (e: MessageEvent<TtsRequest>) => {
  const msg = e.data;
  try {
    if (msg.type === 'load') {
      // Precarga en segundo plano: además de bajar el modelo, una frase corta sin reproducir compila los
      // programas de la GPU (la primera generación real tardaba ~1.7 s; luego ~0.5 s)
      const tts = await load();
      const { input_ids } = tts.tokenizer(spanishToIpa('Hola.'), { truncation: true });
      await tts.generate_from_ids(input_ids, { voice: (msg.voice ?? 'ef_dora') as never, speed: 1 });
      return;
    }
    const tts = await load();
    const list = sentences(msg.text);
    for (let i = 0; i < list.length; i++) {
      const phonemes = msg.lang === 'es' ? spanishToIpa(list[i]) : (await phonemize(list[i], msg.lang)).join(' ');
      const { input_ids } = tts.tokenizer(phonemes, { truncation: true });
      const raw = await tts.generate_from_ids(input_ids, { voice: msg.voice as never, speed: msg.speed });
      // Copia (no transferir memoria del motor de inferencia) + efectos de voz del NAO
      const audio = applyVoiceFx(new Float32Array(raw.audio as Float32Array), raw.sampling_rate, msg.fx);
      post({ type: 'chunk', id: msg.id, text: list[i], audio, sampleRate: raw.sampling_rate, last: i === list.length - 1 }, [audio.buffer]);
    }
  } catch (err) {
    post({ type: 'error', id: msg.type === 'speak' ? msg.id : undefined, message: (err as Error).message });
  }
};
