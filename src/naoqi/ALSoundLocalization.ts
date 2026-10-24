// ALSoundLocalization (doc reference/naoqi-2.8-api/naoqi_audio_alsoundlocalization.md y -api.md): de dónde viene un
// sonido, con los 4 micrófonos de la cabeza (diferencias de tiempo de llegada). Publica ALSoundLocalization/SoundLocated:
//   [[time(sec), time(usec)], [azimuth(rad), elevation(rad), confidence, energy], headPosition (FRAME_TORSO), (FRAME_ROBOT)]
// mientras haya alguien suscrito. "The maximum theoretical accuracy is about 10 degrees for Nao"; "not robust if person
// behind the robot (more than 120° from the front)"; no sabe si el sonido es de una persona ni quién lo hizo.
//
// En el simulador los sonidos llegan del mundo (app.ts: lo que dice el NAO de otra persona cerca, en el mismo cuarto)
// con la posición de la fuente; aquí se pasa al marco de la cabeza. APPROX: error gaussiano de 5° (≈ los 10° de la doc
// como máximo típico), confianza 0.9 al frente y 0.3 detrás de 120°, energía por distancia; sin eco ni ruido de fondo.

import type { RobotState } from '../robot/state';

export interface SoundLocated {
  azimuth: number;
  elevation: number;
  confidence: number;
  energy: number;
}

/** Altura de los micrófonos sobre el centro del torso (cabeza del NAO, APPROX) */
const HEAD_ABOVE_TORSO = 0.17;
const ERROR_SD = (5 * Math.PI) / 180;

const gauss = () => Math.sqrt(-2 * Math.log(1 - Math.random())) * Math.cos(2 * Math.PI * Math.random());

export class ALSoundLocalization {
  private readonly subscribers = new Set<string>();
  private readonly params: Record<string, number> = { Sensitivity: 0.9 };
  private readonly listeners = new Set<(s: SoundLocated) => void>();
  /** ALMemory ALSoundLocalization/SoundLocated */
  last: unknown = null;

  constructor(private readonly state: RobotState) {}

  /** Doc: "Subscribes to ALSoundLocalization. This causes the module to start raising the SoundLocated event" */
  subscribe(name: string): void {
    this.subscribers.add(String(name));
  }

  unsubscribe(name: string): void {
    this.subscribers.delete(String(name));
  }

  getSubscribersInfo(): string[] {
    return [...this.subscribers];
  }

  /** Doc: parámetro "Sensitivity" (0–1): con menos, solo sonidos más fuertes */
  setParameter(name: string, value: number): void {
    if (name !== 'Sensitivity') throw new Error(`ALSoundLocalization::setParameter: parámetro desconocido "${name}"`);
    this.params.Sensitivity = Math.min(Math.max(Number(value), 0), 1);
  }

  getParameter(name: string): number {
    if (!(name in this.params)) throw new Error(`ALSoundLocalization::getParameter: parámetro desconocido "${name}"`);
    return this.params[name];
  }

  /** Extensión propia: escuchar SoundLocated (falta el sistema de eventos de ALMemory) */
  onSoundLocated(fn: (s: SoundLocated) => void): () => void {
    this.listeners.add(fn);
    return () => void this.listeners.delete(fn);
  }

  /**
   * Del simulador: un sonido en `source` (mundo, Z arriba, m) con `level` (0–1 en la fuente). Devuelve lo localizado
   * (null si nadie está suscrito, si es muy débil para la sensibilidad o si aún no hay pose del robot).
   */
  hear(source: [number, number, number], level: number, time: number): SoundLocated | null {
    const root = this.state.root;
    if (!this.subscribers.size || !root) return null;
    const [w, x, y, z] = root.quaternion;
    const bodyYaw = Math.atan2(2 * (w * z + x * y), 1 - 2 * (y * y + z * z));
    const head = [root.position[0], root.position[1], root.position[2] + HEAD_ABOVE_TORSO];
    const d = [source[0] - head[0], source[1] - head[1], source[2] - head[2]];
    const flat = Math.hypot(d[0], d[1]);
    const distance = Math.hypot(flat, d[2]);
    const energy = level / (1 + distance * distance);
    if (energy < 0.05 * (1 - this.params.Sensitivity)) return null;
    const headYaw = bodyYaw + this.state.get('HeadYaw');
    let azimuth = Math.atan2(d[1], d[0]) - headYaw;
    azimuth = Math.atan2(Math.sin(azimuth), Math.cos(azimuth));
    const behind = Math.abs(azimuth) > (120 * Math.PI) / 180;
    const sound: SoundLocated = {
      azimuth: azimuth + gauss() * ERROR_SD * (behind ? 3 : 1),
      elevation: Math.atan2(d[2], flat) + this.state.get('HeadPitch') + gauss() * ERROR_SD,
      confidence: behind ? 0.3 : 0.9,
      energy,
    };
    this.last = [[Math.floor(time), Math.round((time % 1) * 1e6)], [sound.azimuth, sound.elevation, sound.confidence, sound.energy], [], []];
    for (const fn of this.listeners) fn(sound);
    return sound;
  }
}
