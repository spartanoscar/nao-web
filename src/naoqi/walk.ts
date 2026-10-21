// Locomoción para ALMotion.moveToward / moveInit / stopMove.
// El walk engine de NAOqi (omnidireccional, modelo de péndulo invertido) es código cerrado.
// APPROX: se encadenan los pasos de marcha de Webots (reference/motions), validados en la física:
// Forwards +8.8 cm, Backwards −10.7 cm, TurnLeft/Right40 ±39°, SideStepLeft/Right ±6.6 cm, sin caídas.
// Cada paso empieza y termina en la misma pose de marcha, así que se repiten mientras la velocidad
// pedida no sea cero. Se ejecuta la componente dominante (x, y o theta), no una combinación.

import type { RobotState } from '../robot/state';
import type { ALMotion } from './ALMotion';
import { MOTIONS, type MotionClip, firstPose, playMotion } from './motionFile';

export interface Velocity {
  x: number;
  y: number;
  theta: number;
}

const clip = (name: string): MotionClip => {
  const c = MOTIONS.find((m) => m.name === name);
  if (!c) throw new Error(`falta reference/motions/${name}.motion`);
  return c;
};

const GAITS = {
  forward: clip('Forwards'),
  backward: clip('Backwards'),
  left: clip('SideStepLeft'),
  right: clip('SideStepRight'),
  turnLeft: clip('TurnLeft40'),
  turnRight: clip('TurnRight40'),
};

/** Pose de marcha: la primera pose común a todos los pasos */
export const WALK_POSE = firstPose(GAITS.forward);

/** Por debajo de este valor una componente de velocidad cuenta como cero */
const DEADZONE = 0.1;
/** Más inclinado que esto (rad) = se cayó: se detiene la marcha */
const FALLEN_TILT = 0.8;

function pick({ x, y, theta }: Velocity): MotionClip | null {
  const [ax, ay, at] = [Math.abs(x), Math.abs(y), Math.abs(theta)];
  if (Math.max(ax, ay, at) < DEADZONE) return null;
  if (at >= ax && at >= ay) return theta > 0 ? GAITS.turnLeft : GAITS.turnRight;
  if (ay > ax) return y > 0 ? GAITS.left : GAITS.right;
  return x > 0 ? GAITS.forward : GAITS.backward;
}

export class Gait {
  private velocity: Velocity = { x: 0, y: 0, theta: 0 };
  private loop: Promise<void> | null = null;

  constructor(
    private readonly motion: ALMotion,
    private readonly state: RobotState,
  ) {}

  get active(): boolean {
    return this.loop !== null;
  }

  /** Velocidad normalizada [-1, 1] en FRAME_ROBOT (x adelante, y izquierda, theta antihorario) */
  setVelocity(v: Velocity): void {
    const c = (n: number) => (Number.isFinite(n) ? Math.min(Math.max(n, -1), 1) : 0);
    this.velocity = { x: c(v.x), y: c(v.y), theta: c(v.theta) };
    if (!this.loop && pick(this.velocity)) this.loop = this.run().finally(() => (this.loop = null));
  }

  /** Termina el paso en curso y se detiene */
  async stop(): Promise<void> {
    this.velocity = { x: 0, y: 0, theta: 0 };
    await this.loop;
  }

  finished(): Promise<void> {
    return this.loop ?? Promise.resolve();
  }

  private async run(): Promise<void> {
    let previous: MotionClip | null = null;
    for (let gait = pick(this.velocity); gait; gait = pick(this.velocity)) {
      if (this.fallen()) return;
      // Encadenado con el mismo paso: ya está en la pose inicial; si no, entrada normal
      await playMotion(this.motion, gait, previous ? { leadIn: 0.25 } : {});
      previous = gait;
    }
  }

  private fallen(): boolean {
    const root = this.state.root;
    if (!root) return false;
    const [, x, y] = root.quaternion;
    return Math.acos(Math.min(1, 1 - 2 * (x * x + y * y))) > FALLEN_TILT;
  }
}
