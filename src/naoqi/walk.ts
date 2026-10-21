// Locomoción para ALMotion.moveToward / moveInit / stopMove.
// El walk engine de NAOqi (omnidireccional, péndulo invertido) es código cerrado.
// APPROX: se usan los ciclos de marcha continua que contienen las animaciones de Webots
// (reference/motions). En esos tramos la pose final coincide exactamente con la inicial (error 0),
// así que se repiten sin pausa. Validados en la física (4 ciclos, sin caídas):
//   avanzar  Forwards50 1.80–2.84 s (1.04 s/ciclo)   +8 cm/s
//   atrás    el mismo ciclo reproducido al revés      −8.6 cm/s
//   girar    TurnLeft60 / TurnRight60 1.04–2.72 s     ±29°/ciclo
//   lateral  SideStepLeft 1.36–3.24 / SideStepRight 2.28–4.16 s   ±3.5 cm/ciclo
// Máquina de estados: entrar al ciclo (0.4 s) → repetirlo mientras se pida velocidad → en cada
// paso (medio ciclo) se decide seguir, cambiar de dirección o frenar a la pose de marcha.
// Se ejecuta la componente dominante de (x, y, theta), no una combinación.

import type { RobotState } from '../robot/state';
import type { MotionEngine } from './engine';
import { MOTIONS, type MotionClip, firstPose } from './motionFile';

export interface Velocity {
  x: number;
  y: number;
  theta: number;
}

interface GaitCycle {
  name: string;
  /** Duración de un ciclo (s) */
  period: number;
  joints: string[];
  /** Muestras del ciclo cada SAMPLE s: times[k] ∈ (0, period], values[j][k] */
  times: number[];
  values: number[][];
  /** Pose al inicio del ciclo (= al final) */
  start: Record<string, number>;
}

const SAMPLE = 0.04; // la resolución de los .motion de Webots
const ENTRY = 0.4; // s para entrar al ciclo desde la pose actual
const EXIT = 0.5; // s para frenar a la pose de marcha
const RENEW = 6; // ciclos encolados por orden al motor
const DEADZONE = 0.1;
const FALLEN_TILT = 0.8; // rad

const clip = (name: string): MotionClip => {
  const c = MOTIONS.find((m) => m.name === name);
  if (!c) throw new Error(`falta reference/motions/${name}.motion`);
  return c;
};

/** Valor de un joint en el tiempo `t` del archivo, interpolando linealmente sus keyframes */
function valueAt(c: MotionClip, j: number, t: number): number {
  const ts = c.timeLists[j];
  const vs = c.angleLists[j];
  const tt = t + c.lead;
  if (tt <= ts[0]) return vs[0];
  for (let k = 1; k < ts.length; k++) {
    if (tt <= ts[k]) return vs[k - 1] + ((vs[k] - vs[k - 1]) * (tt - ts[k - 1])) / (ts[k] - ts[k - 1]);
  }
  return vs[vs.length - 1];
}

function cycle(name: string, file: string, from: number, to: number, reverse = false): GaitCycle {
  const c = clip(file);
  const period = to - from;
  const steps = Math.round(period / SAMPLE);
  const at = (j: number, s: number) => valueAt(c, j, reverse ? to - s : from + s);
  const times = Array.from({ length: steps }, (_, k) => +((k + 1) * SAMPLE).toFixed(4));
  return {
    name,
    period,
    joints: c.names,
    times,
    values: c.names.map((_, j) => times.map((t) => at(j, t))),
    start: Object.fromEntries(c.names.map((n, j) => [n, at(j, 0)])),
  };
}

const CYCLES = {
  forward: cycle('forward', 'Forwards50', 1.8, 2.84),
  backward: cycle('backward', 'Forwards50', 1.8, 2.84, true),
  turnLeft: cycle('turnLeft', 'TurnLeft60', 1.04, 2.72),
  turnRight: cycle('turnRight', 'TurnRight60', 1.04, 2.72),
  left: cycle('left', 'SideStepLeft', 1.36, 3.24),
  right: cycle('right', 'SideStepRight', 2.28, 4.16),
};

/** Pose de marcha: la primera pose común a los pasos de Webots (moveInit va aquí) */
export const WALK_POSE = firstPose(clip('Forwards'));

function pick({ x, y, theta }: Velocity): GaitCycle | null {
  const [ax, ay, at] = [Math.abs(x), Math.abs(y), Math.abs(theta)];
  if (Math.max(ax, ay, at) < DEADZONE) return null;
  if (at >= ax && at >= ay) return theta > 0 ? CYCLES.turnLeft : CYCLES.turnRight;
  if (ay > ax) return y > 0 ? CYCLES.left : CYCLES.right;
  return x > 0 ? CYCLES.forward : CYCLES.backward;
}

export class Gait {
  private velocity: Velocity = { x: 0, y: 0, theta: 0 };
  private current: GaitCycle | null = null;
  /** Reloj del motor en que empieza el primer ciclo encolado, y cuántos hay */
  private cycleStart = 0;
  private queued = 0;
  private generation = 0;
  /** Frenando hacia la pose de marcha (aún cuenta como marcha activa) */
  private exiting = false;
  private done: Promise<void> = Promise.resolve();
  private resolveDone: () => void = () => undefined;

  constructor(
    private readonly engine: MotionEngine,
    private readonly state: RobotState,
  ) {}

  get active(): boolean {
    return this.current !== null || this.exiting;
  }

  /** Velocidad normalizada [-1, 1] en FRAME_ROBOT (x adelante, y izquierda, theta antihorario) */
  setVelocity(v: Velocity): void {
    const c = (n: number) => (Number.isFinite(n) ? Math.min(Math.max(n, -1), 1) : 0);
    this.velocity = { x: c(v.x), y: c(v.y), theta: c(v.theta) };
    const wanted = pick(this.velocity);
    if (!this.current && wanted) {
      // Si estaba frenando, retoma la marcha sin terminarla; si estaba quieto, empieza una nueva
      if (!this.exiting) this.done = new Promise((r) => (this.resolveDone = r));
      this.exiting = false;
      this.enter(wanted);
    }
    // Andando: el cambio se aplica en el próximo paso (onStep)
  }

  async stop(): Promise<void> {
    this.velocity = { x: 0, y: 0, theta: 0 };
    await this.done;
  }

  finished(): Promise<void> {
    return this.done;
  }

  /** Corta en seco (killAll): sin pasar por la pose de marcha */
  abort(): void {
    this.velocity = { x: 0, y: 0, theta: 0 };
    this.finish();
  }

  /**
   * Entra al ciclo desde la pose actual en `entry` s y encola RENEW ciclos. Con entry = 0 (renovar
   * en un límite de ciclo, donde la pose ya es la inicial) continúa sin pausa.
   */
  private enter(gait: GaitCycle, entry = ENTRY): void {
    this.current = gait;
    const trajectories: Record<string, { times: number[]; values: number[] }> = {};
    gait.joints.forEach((name, j) => {
      const times = entry > 0 ? [entry] : [];
      const values = entry > 0 ? [gait.start[name]] : [];
      for (let c = 0; c < RENEW; c++) {
        for (let k = 0; k < gait.times.length; k++) {
          times.push(+(entry + c * gait.period + gait.times[k]).toFixed(4));
          values.push(gait.values[j][k]);
        }
      }
      trajectories[name] = { times, values };
    });
    this.engine.interpolate(trajectories, { continuous: true });
    this.cycleStart = this.engine.time + entry;
    this.queued = RENEW;
    this.scheduleStep(this.cycleStart + gait.period / 2);
  }

  private scheduleStep(at: number): void {
    const generation = ++this.generation;
    this.engine.schedule(at, () => {
      if (generation === this.generation) this.onStep(at);
    });
  }

  /** Cada paso (medio ciclo): seguir, cambiar de dirección o frenar */
  private onStep(at: number): void {
    const gait = this.current;
    if (!gait) return;
    if (this.fallen()) {
      this.engine.stopAll();
      return this.finish();
    }
    const wanted = pick(this.velocity);
    if (wanted === gait) {
      const elapsed = (at - this.cycleStart) / gait.period;
      // Quedan pocos ciclos encolados: se encolan más desde el inicio de un ciclo (misma pose)
      if (Number.isInteger(Math.round(elapsed * 2) / 2) && this.queued - elapsed <= 1.01) {
        this.enter(gait, 0);
        return;
      }
      return this.scheduleStep(at + gait.period / 2);
    }
    if (wanted) return this.enter(wanted);
    // Frenar: a la pose de marcha, con la velocidad que lleve
    const joints = Object.keys(WALK_POSE);
    const task = this.engine.interpolate(
      Object.fromEntries(joints.map((j) => [j, { times: [EXIT], values: [WALK_POSE[j]] }])),
      { continuous: true },
    );
    this.current = null;
    this.exiting = true;
    const generation = ++this.generation;
    // Si mientras frena se vuelve a pedir velocidad, enter() cambia la generación y esto no hace nada
    void task.done.then(() => {
      if (generation === this.generation) this.finish();
    });
  }

  private finish(): void {
    this.generation++;
    this.current = null;
    this.exiting = false;
    this.resolveDone();
  }

  private fallen(): boolean {
    const root = this.state.root;
    if (!root) return false;
    const [, x, y] = root.quaternion;
    return Math.acos(Math.min(1, 1 - 2 * (x * x + y * y))) > FALLEN_TILT;
  }
}
