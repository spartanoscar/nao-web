// Estado del robot: la única verdad que comparten NAOqi (escribe) y la escena 3D (lee).
// Aplica las mismas restricciones que el robot real: límites V6, anti-colisión de la cabeza y el
// motor compartido HipYawPitch.

import { COUPLED, JOINT_BY_NAME, JOINTS, headPitchLimits } from './naoV6';

const MASTER_OF = new Map(Object.entries(COUPLED));

/**
 * Orientación del cuerpo respecto al suelo. En el robot real la decide la gravedad (y la mide la
 * IMU); sin física la fija quien mueve el robot. APPROX hasta tener simulación física.
 */
export interface BodySupport {
  /** 1 = el torso se orienta para que el pie de apoyo quede plano; 0 = se usa `pitch` */
  footSupport: number;
  /** Inclinación fija del torso (rad, + hacia delante). LyingBack = -π/2, LyingBelly = +π/2 */
  pitch: number;
}

/** Pose del torso en el mundo (Z arriba, como el URDF). La escribe la simulación física. */
export interface RootPose {
  position: [number, number, number];
  /** [w, x, y, z] */
  quaternion: [number, number, number, number];
}

export class RobotState {
  private readonly values = new Map<string, number>(JOINTS.map((s) => [s.name, 0]));
  private readonly stiffness = new Map<string, number>(JOINTS.map((s) => [s.name, 0]));
  private readonly support: BodySupport = { footSupport: 1, pitch: 0 };
  private rootPose: RootPose | null = null;

  /** Se incrementa en cada cambio: los lectores (escena, UI) solo recalculan si cambió */
  revision = 0;

  /**
   * Sonares del pecho [izquierdo, derecho]: distancia al obstáculo más cercano en su haz (m). La escribe la física cada
   * 100 ms (physics.ts); null sin física. No cuenta como cambio de la escena (no toca `revision`).
   */
  sonar: [number, number] | null = null;

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

  /** 0 = motor apagado (el joint no obedece comandos), 1 = rígido */
  getStiffness(name: string): number {
    const v = this.stiffness.get(MASTER_OF.get(name) ?? name);
    if (v === undefined) throw new Error(`Joint desconocido: ${name}`);
    return v;
  }

  setStiffness(name: string, value: number): void {
    const master = MASTER_OF.get(name) ?? name;
    if (!this.stiffness.has(master)) throw new Error(`Joint desconocido: ${name}`);
    const v = Math.min(Math.max(value, 0), 1);
    this.stiffness.set(master, v);
    for (const [slave, m] of MASTER_OF) if (m === master) this.stiffness.set(slave, v);
    this.revision++;
  }

  get body(): Readonly<BodySupport> {
    return this.support;
  }

  setBody(patch: Partial<BodySupport>): void {
    if (patch.footSupport !== undefined) this.support.footSupport = Math.min(Math.max(patch.footSupport, 0), 1);
    if (patch.pitch !== undefined) this.support.pitch = patch.pitch;
    this.revision++;
  }

  /** null = sin física: la escena calcula el apoyo de forma cinemática (BodySupport) */
  get root(): Readonly<RootPose> | null {
    return this.rootPose;
  }

  /** Sin física (se apagó): la escena vuelve a calcular el apoyo de forma cinemática */
  clearRoot(): void {
    this.rootPose = null;
    this.revision++;
  }

  /** Lectura de la simulación: pose del torso + ángulos medidos, en una sola revisión */
  setFromPhysics(root: RootPose, joints: Readonly<Record<string, number>>): void {
    this.rootPose = root;
    for (const [name, v] of Object.entries(joints)) {
      // Sin clamp ni acoplamiento: es la medida del sensor (la física ya respeta los límites)
      if (this.values.has(name)) this.values.set(name, v);
    }
    this.revision++;
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
