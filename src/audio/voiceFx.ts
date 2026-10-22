// Efectos de voz de ALTextToSpeech.setParameter (doc naoqi_audio_altexttospeech-api.md): según la
// doc, la voz oficial del NAO en cada idioma es la voz base del motor + estos parámetros.
//   pitchShift            [1–4], 0 = apagado: sube el tono sin cambiar la duración (2.0 = una octava)
//   doubleVoice           [1–4], 0 = apagado: segunda voz, relación de su tono con la primera
//   doubleVoiceLevel      [0–4], 0 = apagado: ganancia de la segunda voz
//   doubleVoiceTimeShift  [0–0.5] s: retraso de la segunda voz
// Procesamiento sobre el audio completo de cada frase (offline): remuestreo + estiramiento WSOLA.

export interface VoiceFx {
  pitchShift: number;
  doubleVoice: number;
  doubleVoiceLevel: number;
  doubleVoiceTimeShift: number;
}

export function applyVoiceFx(x: Float32Array, sampleRate: number, fx: VoiceFx): Float32Array {
  const shift = fx.pitchShift >= 1 ? fx.pitchShift : 1;
  const main = shift === 1 ? x : pitchShift(x, shift, sampleRate);
  if (!(fx.doubleVoice >= 1 && fx.doubleVoiceLevel > 0)) return normalize(main);
  const second = pitchShift(x, shift * fx.doubleVoice, sampleRate);
  const delay = Math.round(Math.min(Math.max(fx.doubleVoiceTimeShift, 0), 0.5) * sampleRate);
  const out = new Float32Array(Math.max(main.length, second.length + delay));
  out.set(main);
  const level = Math.min(fx.doubleVoiceLevel, 4);
  for (let i = 0; i < second.length; i++) out[i + delay] += level * second[i];
  return normalize(out);
}

/** Sube el tono `ratio` veces conservando la duración */
export function pitchShift(x: Float32Array, ratio: number, sampleRate: number): Float32Array {
  return timeStretch(resample(x, ratio), ratio, sampleRate, x.length);
}

/** Lee x a `ratio` muestras por muestra: más agudo y más corto */
function resample(x: Float32Array, ratio: number): Float32Array {
  const n = Math.floor(x.length / ratio);
  const y = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const p = i * ratio;
    const k = Math.floor(p);
    const t = p - k;
    y[i] = x[k] * (1 - t) + (x[k + 1] ?? 0) * t;
  }
  return y;
}

/**
 * WSOLA: alarga x `factor` veces sin cambiar el tono. Cada grano se busca alrededor de su posición
 * nominal (±10 ms) donde mejor continúa al anterior, para que no suene "a lata".
 */
function timeStretch(x: Float32Array, factor: number, sampleRate: number, outLength: number): Float32Array {
  const grain = Math.round(0.04 * sampleRate);
  const hopOut = Math.round(grain / 4);
  const hopIn = hopOut / factor;
  const tol = Math.round(0.01 * sampleRate);
  const win = new Float32Array(grain);
  for (let i = 0; i < grain; i++) win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (grain - 1));
  const out = new Float32Array(outLength + grain);
  const norm = new Float32Array(outLength + grain);
  let prev = 0;
  for (let o = 0, k = 0; o < outLength; o += hopOut, k++) {
    const nominal = Math.round(k * hopIn);
    let pos = nominal;
    if (k > 0) {
      // La continuación natural del grano anterior es x[prev + hopOut …]: buscar el más parecido
      const ref = prev + hopOut;
      let best = -Infinity;
      for (let d = -tol; d <= tol; d += 2) {
        const c = nominal + d;
        if (c < 0 || c + grain >= x.length) continue;
        let corr = 0;
        for (let i = 0; i < grain / 2; i += 3) corr += x[c + i] * (x[ref + i] ?? 0);
        if (corr > best) [best, pos] = [corr, c];
      }
    }
    if (pos + grain >= x.length) pos = Math.max(0, x.length - grain - 1);
    for (let i = 0; i < grain; i++) {
      out[o + i] += x[pos + i] * win[i];
      norm[o + i] += win[i];
    }
    prev = pos;
  }
  const y = new Float32Array(outLength);
  for (let i = 0; i < outLength; i++) y[i] = norm[i] > 1e-3 ? out[i] / norm[i] : 0;
  return y;
}

function normalize(x: Float32Array): Float32Array {
  let peak = 0;
  for (let i = 0; i < x.length; i++) peak = Math.max(peak, Math.abs(x[i]));
  if (peak > 0.95) for (let i = 0; i < x.length; i++) x[i] *= 0.95 / peak;
  return x;
}
