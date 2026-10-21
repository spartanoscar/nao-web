// ALMotion: control articular y de stiffness. Misma firma que NAOqi 2.8.
// Docs: reference/naoqi-2.8-api/naoqi_motion_control-joint-api.md
//       reference/naoqi-2.8-api/naoqi_motion_control-stiffness-api.md
//
// Las llamadas "blocking" del robot devuelven una Promise que se resuelve al terminar el
// movimiento (en JS: `await motion.angleInterpolation(...)`).

import { ACTUATOR_COUNT, CHAINS, COUPLED, JOINTS } from '../robot/naoV6';
import type { RobotState } from '../robot/state';
import { type ALValue, NaoqiError, perJoint, resolveCoupled, toNames, trajectories } from './args';
import type { MotionEngine } from './engine';
import { familyOf, moveToPosture, nearestPosture } from './postures';

const SERVICE = 'ALMotion';

export class ALMotion {
  /** La pone Session: wakeUp/rest usan ALRobotPosture (y su camino entre posturas) */
  goToPosture: ((name: string, speed: number) => Promise<boolean>) | null = null;

  constructor(
    private readonly engine: MotionEngine,
    private readonly state: RobotState,
  ) {}

  // ─── Stiffness ──────────────────────────────────────────────────────────────

  /**
   * "The robot wakes up: sets Motor on and, if needed, goes to initial position. If the robot is
   * already stiffened, the call returns True immediately."
   * APPROX: "initial position" = StandInit (la postura que usan los ejemplos oficiales tras wakeUp).
   */
  async wakeUp(): Promise<boolean> {
    if (this.robotIsWakeUp()) return true;
    await this.engine.interpolateStiffness(this.stiffnessTargets(1, 0.5)).done;
    const posture = nearestPosture(this.state);
    if (familyOf(posture.name) !== 'Standing' || posture.error > 0.1) {
      if (this.goToPosture) await this.goToPosture('StandInit', 0.5);
      else await moveToPosture(this.engine, 'StandInit', 0.5).done;
    }
    return true;
  }

  /** "The robot rests: goes to a relaxed and safe position and sets Motor off." H25 → Crouch. */
  async rest(): Promise<void> {
    // De pie va a Crouch; sentado o acostado ya está en una posición segura
    if (this.robotIsWakeUp() && familyOf(nearestPosture(this.state).name) === 'Standing') {
      if (this.goToPosture) await this.goToPosture('Crouch', 0.5);
      else await moveToPosture(this.engine, 'Crouch', 0.5).done;
    }
    this.engine.stopAll();
    await this.engine.interpolateStiffness(this.stiffnessTargets(0, 0.3)).done;
  }

  /** APPROX: despierto = algún motor con stiffness > 0 */
  robotIsWakeUp(): boolean {
    return JOINTS.some((j) => this.state.getStiffness(j.name) > 0);
  }

  setStiffnesses(names: ALValue, stiffnesses: ALValue): void {
    const joints = toNames(SERVICE, 'setStiffnesses', names);
    const values = perJoint(SERVICE, 'setStiffnesses', 'stiffnesses', joints, stiffnesses);
    resolveCoupled(joints).forEach(({ joint, index }) => this.engine.setStiffness(joint, values[index]));
  }

  getStiffnesses(names: ALValue): number[] {
    return toNames(SERVICE, 'getStiffnesses', names).map((j) => this.state.getStiffness(j));
  }

  /** Blocking. Interpolación lineal de stiffness por keyframes. */
  async stiffnessInterpolation(names: ALValue, stiffnessLists: ALValue, timeLists: ALValue): Promise<void> {
    const joints = toNames(SERVICE, 'stiffnessInterpolation', names);
    const trajs = trajectories(SERVICE, 'stiffnessInterpolation', joints, stiffnessLists, timeLists);
    const plan = Object.fromEntries(resolveCoupled(joints).map(({ joint, index }) => [joint, trajs[index]]));
    await this.engine.interpolateStiffness(plan).done;
  }

  // ─── Control articular ──────────────────────────────────────────────────────

  /** Blocking. Trayectorias por keyframes; isAbsolute=false → relativo al ángulo actual. */
  async angleInterpolation(names: ALValue, angleLists: ALValue, timeLists: ALValue, isAbsolute: boolean): Promise<void> {
    const joints = toNames(SERVICE, 'angleInterpolation', names);
    const trajs = trajectories(SERVICE, 'angleInterpolation', joints, angleLists, timeLists);
    const plan = Object.fromEntries(
      resolveCoupled(joints).map(({ joint, index }) => {
        const base = isAbsolute ? 0 : this.engine.command(joint);
        return [joint, { times: trajs[index].times, values: trajs[index].values.map((a) => a + base) }];
      }),
    );
    await this.engine.interpolate(plan).done;
  }

  /** Blocking. Un objetivo por joint, a una fracción de la velocidad máxima. */
  async angleInterpolationWithSpeed(names: ALValue, targetAngles: ALValue, maxSpeedFraction: number): Promise<void> {
    const joints = toNames(SERVICE, 'angleInterpolationWithSpeed', names);
    const angles = perJoint(SERVICE, 'angleInterpolationWithSpeed', 'targetAngles', joints, targetAngles);
    const targets = Object.fromEntries(resolveCoupled(joints).map(({ joint, index }) => [joint, angles[index]]));
    await this.engine.interpolateWithSpeed(targets, maxSpeedFraction).done;
  }

  /** Non-blocking. Se puede llamar a menudo con órdenes contradictorias (control reactivo). */
  setAngles(names: ALValue, angles: ALValue, fractionMaxSpeed: ALValue): void {
    this.reactive('setAngles', names, angles, fractionMaxSpeed, false);
  }

  /** Non-blocking. Como setAngles pero relativo al ángulo comandado actual. */
  changeAngles(names: ALValue, changes: ALValue, fractionMaxSpeed: ALValue): void {
    this.reactive('changeAngles', names, changes, fractionMaxSpeed, true);
  }

  /** useSensors=true → ángulo medido; false → ángulo comandado */
  getAngles(names: ALValue, useSensors: boolean): number[] {
    return toNames(SERVICE, 'getAngles', names).map((j) =>
      useSensors ? this.state.get(j) : this.engine.command(COUPLED[j] ?? j),
    );
  }

  /** Blocking. "LHand" o "RHand". */
  async openHand(handName: string): Promise<void> {
    await this.angleInterpolationWithSpeed(this.hand('openHand', handName), 1, 0.25);
  }

  /** Blocking. APPROX: el robot real corta la corriente del motor al cerrar; aquí se mantiene. */
  async closeHand(handName: string): Promise<void> {
    await this.angleInterpolationWithSpeed(this.hand('closeHand', handName), 0, 0.25);
  }

  // ─── Herramientas generales ─────────────────────────────────────────────────

  /** Nombres de joints de un joint, cadena o grupo ("Body" → 26 nombres) */
  getBodyNames(name: string): string[] {
    return toNames(SERVICE, 'getBodyNames', name);
  }

  /** Alias histórico de getBodyNames */
  getJointNames(name: string): string[] {
    return this.getBodyNames(name);
  }

  /** Detiene todas las tareas de movimiento */
  killAll(): void {
    this.engine.stopAll();
  }

  getSummary(): string {
    const lines = [`ALMotion (simulador NAO V6) · ${ACTUATOR_COUNT} actuadores · ${this.robotIsWakeUp() ? 'despierto' : 'en reposo'}`];
    lines.push('Joint            Stiffness  Command   Sensor');
    for (const chain of Object.values(CHAINS)) {
      for (const j of chain) {
        lines.push(
          `${j.padEnd(16)} ${this.state.getStiffness(j).toFixed(2).padStart(9)}  ${this.engine
            .command(COUPLED[j] ?? j)
            .toFixed(3)
            .padStart(7)}  ${this.state.get(j).toFixed(3).padStart(7)}`,
        );
      }
    }
    return lines.join('\n');
  }

  // ─── Internos ───────────────────────────────────────────────────────────────

  private reactive(method: string, names: ALValue, values: ALValue, fraction: ALValue, relative: boolean) {
    const joints = toNames(SERVICE, method, names);
    const vals = perJoint(SERVICE, method, relative ? 'changes' : 'angles', joints, values);
    const fractions = perJoint(SERVICE, method, 'fractionMaxSpeed', joints, fraction);
    // Agrupa por fracción de velocidad: el motor recibe un objetivo y una velocidad por grupo
    const groups = new Map<number, Record<string, number>>();
    for (const { joint, index } of resolveCoupled(joints)) {
      const target = relative ? this.engine.command(joint) + vals[index] : vals[index];
      groups.set(fractions[index], { ...groups.get(fractions[index]), [joint]: target });
    }
    for (const [f, targets] of groups) this.engine.follow(targets, f);
  }

  private hand(method: string, handName: string): string {
    if (handName !== 'LHand' && handName !== 'RHand') {
      throw new NaoqiError(SERVICE, method, `handName debe ser "LHand" o "RHand", no "${handName}"`);
    }
    return handName;
  }

  private stiffnessTargets(value: number, duration: number) {
    return Object.fromEntries(
      JOINTS.filter((j) => !(j.name in COUPLED)).map((j) => [j.name, { times: [duration], values: [value] }]),
    );
  }
}
