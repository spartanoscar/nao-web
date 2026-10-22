// Sonido de los motores sintetizado en vivo (WebAudio, sin archivos), alimentado por la física.
// Por cada motor: un zumbido cuyo tono sale de la velocidad del ROTOR (velocidad del joint × reducción:
// es la caja de engranajes la que "silba") y un ruido de engranajes. El volumen sale de la velocidad
// y del torque (la corriente del motor): quieto y en reposo, silencio; de pie, el zumbido leve de los
// motores sosteniendo el peso; al caminar, las piernas al ritmo de los pasos.
// APPROX: timbres y ganancias elegidos de oído; la física (velocidad, torque, reducción) es la real.

import type { MotorTelemetry } from '../physics/physics';

/** Tono base por modelo de motor (doc motors_naov6): los grandes de las piernas suenan más graves */
const BASE_HZ: Record<string, number> = {
  '22NT Z20': 95, // HipPitch, KneePitch, AnklePitch
  '22NT Z13': 110, // HipYawPitch, HipRoll, AnkleRoll
  '16GT': 170, // HeadYaw, ElbowYaw, HeadPitch, ShoulderRoll, ElbowRoll
  'DCX 16S': 150, // ShoulderPitch
  '17N': 230, // WristYaw
};
/** Hz por rad/s del rotor: frecuencia de engrane aproximada (≈ 12 dientes por vuelta / 2π) */
const MESH_HZ_PER_RAD = 1.9;
const MAX_HZ = 2400;
/** Ganancia máxima de un motor (24 suenan a la vez) */
const VOICE_GAIN = 0.06;
const SMOOTH = 0.035; // s: suavizado de los cambios de tono y volumen

/** Tono y volumen de un motor (puro: se puede probar sin audio). `distance`: cámara → robot (m). */
export function motorTone(m: MotorTelemetry, distance: number): { freq: number; gain: number; grind: number } {
  const rotor = Math.abs(m.rotorSpeed);
  const freq = Math.min((BASE_HZ[m.motor] ?? 140) + rotor * MESH_HZ_PER_RAD, MAX_HZ);
  // Carga: fracción del torque de bloqueo (la corriente); movimiento: velocidad relativa del rotor
  const load = Math.min(Math.abs(m.torque) / m.stallTorque, 1);
  const motion = Math.min(rotor / 600, 1);
  const hum = Math.min(Math.pow(load * 2.5, 1.2), 1) * 0.35; // sostener peso: zumbido leve
  const whine = Math.sqrt(motion) * (0.55 + 0.45 * load); // moverse: silbido de la reductora
  const att = 1 / (1 + Math.max(distance - 0.6, 0) * 1.4);
  const gain = VOICE_GAIN * att * Math.min(hum + whine, 1);
  return { freq, gain, grind: gain * (0.25 + 0.75 * motion) * 0.6 };
}

interface Voice {
  osc: OscillatorNode;
  tone: BiquadFilterNode;
  grind: BiquadFilterNode;
  oscGain: GainNode;
  noiseGain: GainNode;
}

export class MotorSound {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private noise: AudioBuffer | null = null;
  private readonly voices = new Map<string, Voice>();
  private volume = 0.7;
  private enabled = true;

  /** Los navegadores solo dejan sonar audio después de un gesto del usuario: llamar en el primer clic/tecla */
  start(): void {
    if (this.ctx) {
      void this.ctx.resume();
      return;
    }
    const ctx = new AudioContext();
    this.ctx = ctx;
    const compressor = ctx.createDynamicsCompressor();
    compressor.threshold.value = -18;
    compressor.ratio.value = 4;
    this.master = ctx.createGain();
    this.master.gain.value = this.enabled ? this.volume : 0;
    this.master.connect(compressor).connect(ctx.destination);
    // Ruido blanco compartido (2 s en bucle) para el roce de los engranajes
    this.noise = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
    const d = this.noise.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  }

  setEnabled(on: boolean): void {
    this.enabled = on;
    this.applyMaster();
  }

  setVolume(v: number): void {
    this.volume = Math.min(Math.max(v, 0), 1);
    this.applyMaster();
  }

  /**
   * Actualiza tono y volumen de cada motor. `distance`: metros de la cámara al robot (más lejos, más
   * bajo), como un oído en la escena.
   */
  update(motors: readonly MotorTelemetry[], distance: number): void {
    const ctx = this.ctx;
    if (!ctx || !this.enabled || ctx.state !== 'running') return;
    const now = ctx.currentTime;
    for (const m of motors) {
      const v = this.voice(m);
      const { freq, gain, grind } = motorTone(m, distance);
      v.osc.frequency.setTargetAtTime(freq, now, SMOOTH);
      v.tone.frequency.setTargetAtTime(freq * 2, now, SMOOTH);
      v.grind.frequency.setTargetAtTime(Math.min(freq * 3.1, 9000), now, SMOOTH);
      v.oscGain.gain.setTargetAtTime(gain, now, SMOOTH);
      v.noiseGain.gain.setTargetAtTime(grind, now, SMOOTH);
    }
  }

  private applyMaster(): void {
    if (!this.ctx || !this.master) return;
    this.master.gain.setTargetAtTime(this.enabled ? this.volume : 0, this.ctx.currentTime, 0.05);
  }

  private voice(m: MotorTelemetry): Voice {
    let v = this.voices.get(m.name);
    if (v) return v;
    const ctx = this.ctx!;
    const osc = ctx.createOscillator();
    osc.type = 'sawtooth';
    const tone = ctx.createBiquadFilter();
    tone.type = 'bandpass';
    tone.Q.value = 3;
    const oscGain = ctx.createGain();
    oscGain.gain.value = 0;
    osc.connect(tone).connect(oscGain).connect(this.master!);

    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    src.loop = true;
    src.loopStart = Math.random(); // cada motor con su propia parte del ruido
    const grind = ctx.createBiquadFilter();
    grind.type = 'bandpass';
    grind.Q.value = 8;
    const noiseGain = ctx.createGain();
    noiseGain.gain.value = 0;
    src.connect(grind).connect(noiseGain).connect(this.master!);

    osc.start();
    src.start(0, Math.random() * 1.5);
    v = { osc, tone, grind, oscGain, noiseGain };
    this.voices.set(m.name, v);
    return v;
  }
}
