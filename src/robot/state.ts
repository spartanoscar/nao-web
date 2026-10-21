// Estado articular del robot: la única verdad que comparten NAOqi (escribe) y la escena 3D (lee).
// Aplica las mismas restricciones que el robot real: límites V6, anti-colisión de la cabeza y el
// motor compartido HipYawPitch.

import { COUPLED, JOINT_BY_NAME, JOINTS, headPitchLimits } from './naoV6';

const MASTER_OF = new Map(Object.entries(COUPLED));

export class RobotState {
  private readonly values = new Map<string, number>(JOINTS.map((s) => [s.name, 0]));

  /** Se incrementa en cada cambio: los lectores (escena, UI) solo recalculan si cambió */
  revision = 0;

  constructor(initial: Readonly<Record<string, number>> = {}) {
    this.setMany(initial);
  }

  get(name: string): number {
    const v = this.values.get(name);
    if (v === undefined) throw new Error(`Joint desconocido: ${name}`);
    return v;
  }

  /** Rango válido ahora mismo (HeadPitch depende de HeadYaw) */
  limits(name: string): [number, number] {
    if (name === 'HeadPitch') return headPitchLimits(this.get('HeadYaw'));
    const spec = JOINT_BY_NAME.get(name);
    if (!spec) throw new Error(`Joint desconocido: ${name}`);
    return [spec.min, spec.max];
  }

  /** Fija un joint (con clamp). Devuelve el valor aplicado. */
  set(name: string, value: number): number {
    const applied = this.write(name, value);
    this.revision++;
    return applied;
  }

  /** Varios joints a la vez. LHipYawPitch gana sobre RHipYawPitch si llegan ambos. */
  setMany(pose: Readonly<Record<string, number>>): void {
    // HeadYaw primero: el rango de HeadPitch se calcula con el yaw nuevo, no con el anterior
    const names = Object.keys(pose).sort((a, b) => Number(b === 'HeadYaw') - Number(a === 'HeadYaw'));
    for (const name of names) {
      const master = MASTER_OF.get(name);
      if (master && master in pose) continue;
      this.write(name, pose[name]);
    }
    this.revision++;
  }

  snapshot(): Record<string, number> {
    return Object.fromEntries(this.values);
  }

  private write(name: string, value: number): number {
    if (!Number.isFinite(value)) throw new Error(`Ángulo inválido para ${name}: ${value}`);
    const master = MASTER_OF.get(name) ?? name;
    const [min, max] = this.limits(master);
    const v = Math.min(Math.max(value, min), max);
    this.values.set(master, v);
    for (const [slave, m] of MASTER_OF) if (m === master) this.values.set(slave, v);
    // Mover el yaw puede dejar el pitch fuera de su nuevo rango
    if (master === 'HeadYaw') {
      const [pmin, pmax] = headPitchLimits(v);
      const p = this.get('HeadPitch');
      this.values.set('HeadPitch', Math.min(Math.max(p, pmin), pmax));
    }
    return v;
  }
}
