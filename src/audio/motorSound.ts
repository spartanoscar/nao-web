// Sonido de los motores sintetizado en vivo (WebAudio, sin archivos), alimentado por la física.
// Por cada motor: un zumbido cuyo tono sale de la velocidad del ROTOR (velocidad del joint × reducción:
// es la caja de engranajes la que "silba") y un ruido de engranajes. El volumen sale de la velocidad
// y del torque (la corriente del motor): quieto y en reposo, silencio; de pie, el zumbido leve de los
// motores sosteniendo el peso; al caminar, las piernas al ritmo de los pasos.
// APPROX: timbres y ganancias elegidos de oído; la física (velocidad, torque, reducción) es la real.

import type { Impact, MotorTelemetry } from '../physics/physics';

/**
 * Golpe de plástico (carcasa de ABS): "clac" de ruido filtrado + golpe hueco con caída de tono.
 * Torso y cabeza más graves; brazos/piernas más agudos; los pasos suaves. APPROX: de oído.
 */
const IMPACT_SOUND: Record<Impact['kind'], { clack: number; knock: number; decay: number; fullSpeed: number; level: number }> = {
  heavy: { clack: 1700, knock: 165, decay: 0.13, fullSpeed: 1.3, level: 1 },
  limb: { clack: 2600, knock: 290, decay: 0.08, fullSpeed: 1.2, level: 0.7 },
  foot: { clack: 3200, knock: 380, decay: 0.05, fullSpeed: 0.45, level: 0.28 },
};

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

/** Bajo esta velocidad del rotor (rad/s) no suena: las micro-vibraciones de la física no son ruido real */
const ROTOR_DEADZONE = 30;

/**
 * Tono y volumen de un motor (pura: se prueba sin audio). `distance`: cámara → robot (m).
 * - Silbido tonal solo cuando el motor EMPUJA (torque y velocidad en el mismo sentido: trabajo
 *   positivo). Si la gravedad lo arrastra (caída), solo suena el roce de los engranajes, sin tono:
 *   si no, el tono subía y bajaba como un silbato de émbolo.
 * - Sosteniendo peso sin moverse casi no suena (un NAO de pie es silencioso).
 */
export function motorTone(m: MotorTelemetry, distance: number): { freq: number; gain: number; grind: number } {
  const rotor = Math.abs(m.rotorSpeed);
  const freq = Math.min((BASE_HZ[m.motor] ?? 140) + rotor * MESH_HZ_PER_RAD, MAX_HZ);
  const load = Math.min(Math.abs(m.torque) / m.stallTorque, 1);
  const motion = Math.min(Math.max(rotor - ROTOR_DEADZONE, 0) / 570, 1);
  const driving = m.torque * m.speed > 0 ? 1 : 0;
  const att = 1 / (1 + Math.max(distance - 0.6, 0) * 1.4);
  const hum = load * 0.04; // sosteniendo peso: apenas audible
  const whine = Math.pow(motion, 0.7) * (0.55 + 0.45 * load) * driving;
  const gain = VOICE_GAIN * att * Math.min(hum + whine, 1);
  // Roce de engranajes: con cualquier movimiento (también arrastrado), sin tono
  const grind = VOICE_GAIN * att * Math.pow(motion, 0.8) * (driving ? 0.35 : 0.6);
  return { freq, gain, grind };
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

  /** Golpe contra el suelo (de PhysicsSim.takeImpacts) */
  impact({ kind, speed }: Impact, distance: number): void {
    const ctx = this.ctx;
    if (!ctx || !this.enabled || ctx.state !== 'running' || !this.master || !this.noise) return;
    const cfg = IMPACT_SOUND[kind];
    const att = 1 / (1 + Math.max(distance - 0.6, 0) * 1.4);
    const strength = Math.min(Math.pow(speed / cfg.fullSpeed, 1.1), 1) * cfg.level * att;
    if (strength < 0.02) return;
    const now = ctx.currentTime;
    const vary = 0.9 + Math.random() * 0.2; // ningún golpe suena idéntico

    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    const band = ctx.createBiquadFilter();
    band.type = 'bandpass';
    band.frequency.value = cfg.clack * vary;
    band.Q.value = 0.9;
    const clack = ctx.createGain();
    clack.gain.setValueAtTime(0, now);
    clack.gain.linearRampToValueAtTime(0.55 * strength, now + 0.002);
    clack.gain.exponentialRampToValueAtTime(0.0001, now + 0.05);
    src.connect(band).connect(clack).connect(this.master);
    src.start(now, Math.random() * 1.5);
    src.stop(now + 0.08);

    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(cfg.knock * 1.5 * vary, now);
    osc.frequency.exponentialRampToValueAtTime(cfg.knock * vary, now + 0.03);
    const knock = ctx.createGain();
    knock.gain.setValueAtTime(0, now);
    knock.gain.linearRampToValueAtTime(0.5 * strength, now + 0.004);
    knock.gain.exponentialRampToValueAtTime(0.0001, now + cfg.decay);
    osc.connect(knock).connect(this.master);
    osc.start(now);
    osc.stop(now + cfg.decay + 0.02);
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
