// ALMotion: control articular y de stiffness. Misma firma que NAOqi 2.8.
// Docs: reference/naoqi-2.8-api/naoqi_motion_control-joint-api.md
//       reference/naoqi-2.8-api/naoqi_motion_control-stiffness-api.md
//
// Las llamadas "blocking" del robot devuelven una Promise que se resuelve al terminar el
// movimiento (en JS: `await motion.angleInterpolation(...)`).

import { type Mat4, fromQuaternion, invertRigid, multiply, naoKinematics, toPosition6D } from '../robot/kinematics';
import { ACTUATOR_COUNT, CHAINS, COUPLED, JOINTS } from '../robot/naoV6';
import type { RobotState } from '../robot/state';
import { type ALValue, NaoqiError, perJoint, resolveCoupled, toNames, trajectories } from './args';
import type { MotionEngine } from './engine';
import { moveToPose, robotPose } from './moveTo';
import { moveToPosture, nearestPosture, postureFamily } from './postures';
import { Gait, WALK_POSE } from './walk';

const SERVICE = 'ALMotion';

export class ALMotion {
  /** La pone Session: wakeUp/rest usan ALRobotPosture (y su camino entre posturas) */
  goToPosture: ((name: string, speed: number) => Promise<boolean>) | null = null;
  private readonly gait: Gait;
  /** Cambia con cada orden de marcha: un moveTo en curso ve que lo interrumpieron */
  private moveRun = 0;

  constructor(
    private readonly engine: MotionEngine,
    private readonly state: RobotState,
  ) {
    this.gait = new Gait(engine, state);
  }

  // ─── Stiffness ──────────────────────────────────────────────────────────────

  /**
   * "The robot wakes up: sets Motor on and, if needed, goes to initial position. If the robot is
   * already stiffened, the call returns True immediately."
   * APPROX: "initial position" = StandInit (la postura que usan los ejemplos oficiales tras wakeUp).
   */
  async wakeUp(): Promise<boolean> {
    if (this.robotIsWakeUp()) return true;
    await this.engine.interpolateStiffness(this.stiffnessTargets(1, 0.5)).done;
    if (postureFamily(this.state) !== 'Standing' || nearestPosture(this.state).error > 0.1) {
      if (this.goToPosture) await this.goToPosture('StandInit', 0.5);
      else await moveToPosture(this.engine, 'StandInit', 0.5).done;
    }
    return true;
  }

  /** "The robot rests: goes to a relaxed and safe position and sets Motor off." H25 → Crouch. */
  async rest(): Promise<void> {
    // De pie va a Crouch; sentado o acostado ya está en una posición segura
    if (this.robotIsWakeUp() && postureFamily(this.state) === 'Standing') {
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

  // ─── Locomoción ─────────────────────────────────────────────────────────────
  // Docs: reference/naoqi-2.8-api/naoqi_motion_control-walk-api.md · implementación: walk.ts (APPROX)

  /** Blocking. "Initializes the move process. Checks the robot pose and takes a right posture." */
  async moveInit(): Promise<void> {
    if (!this.canWalk('moveInit')) return;
    const legs = Object.keys(WALK_POSE).filter((j) => this.gait.drives(j));
    await this.angleInterpolationWithSpeed(legs, legs.map((j) => WALK_POSE[j]), 0.3);
  }

  /**
   * Non-blocking. "Makes the robot move at the given normalized velocity, expressed in FRAME_ROBOT."
   * x, y, theta ∈ [-1, 1]; (0, 0, 0) termina el paso en curso y se detiene.
   */
  moveToward(x: number, y: number, theta: number): void {
    // Ya caminando no se revisa: a mitad de un paso la pose no parece "de pie"
    if ((x || y || theta) && !this.gait.active && !this.canWalk('moveToward')) return;
    this.moveRun++; // una orden de velocidad interrumpe un moveTo en curso
    this.gait.setVelocity({ x, y, theta });
  }

  /**
   * Blocking. "Makes the robot move to the given pose in the ground plane, relative to FRAME_ROBOT."
   * x, y en metros, theta en radianes. "True if the moveTo terminated successfully, False if it was interrupted."
   * APPROX: navegación en lazo cerrado con la marcha de Webots (moveTo.ts); necesita la física (odometría).
   */
  async moveTo(x: number, y: number, theta: number): Promise<boolean> {
    if (!this.canWalk('moveTo')) return false;
    if (!this.state.root) {
      console.warn('ALMotion::moveTo: sin física no hay odometría');
      return false;
    }
    const run = ++this.moveRun;
    return moveToPose(this.engine, this.state, this.gait, x, y, theta, () => run !== this.moveRun);
  }

  /**
   * "Gets the World Absolute Robot Position": [x (m), y (m), theta (rad, ]-π, π])]. Con y sin sensores se usa la
   * pose medida del torso (APPROX: el robot real distingue odometría comandada y medida).
   */
  getRobotPosition(_useSensors: boolean): number[] {
    const p = robotPose(this.state);
    return p ? [p.x, p.y, p.theta] : [0, 0, 0];
  }

  /**
   * "Sets if Arms Motions are enabled during the Move Process." true = la marcha mueve ese brazo (defecto); false = el
   * brazo queda libre para otras tareas mientras camina (p. ej. empujar con los brazos al frente).
   */
  setMoveArmsEnabled(leftArmEnable: boolean, rightArmEnable: boolean): void {
    this.gait.armsEnabled.LArm = Boolean(leftArmEnable);
    this.gait.armsEnabled.RArm = Boolean(rightArmEnable);
  }

  /** "LArm" / "RArm": si ese brazo lo mueve la marcha; "Arms": si los dos */
  getMoveArmsEnabled(chainName: string): boolean {
    const { LArm, RArm } = this.gait.armsEnabled;
    if (chainName === 'LArm') return LArm;
    if (chainName === 'RArm') return RArm;
    if (chainName === 'Arms') return LArm && RArm;
    throw new NaoqiError(SERVICE, 'getMoveArmsEnabled', `chainName debe ser "LArm", "RArm" o "Arms", no "${chainName}"`);
  }

  /** Blocking. Detiene la marcha al terminar el paso en curso. */
  async stopMove(): Promise<boolean> {
    this.moveRun++;
    await this.gait.stop();
    return true;
  }

  moveIsActive(): boolean {
    return this.gait.active;
  }

  /** Blocking. Espera a que termine la marcha. */
  async waitUntilMoveIsFinished(): Promise<void> {
    await this.gait.finished();
  }

  /** Como en el robot: caminar requiere motores encendidos y estar de pie */
  private canWalk(method: string): boolean {
    if (!this.robotIsWakeUp()) {
      console.warn(`ALMotion::${method}: el robot no está despierto (motion.wakeUp())`);
      return false;
    }
    if (postureFamily(this.state) !== 'Standing') {
      console.warn(`ALMotion::${method}: el robot no está de pie`);
      return false;
    }
    return true;
  }

  // ─── Cartesiano (lectura) ───────────────────────────────────────────────────
  // Docs: reference/naoqi-2.8-api/naoqi_motion_control-cartesian-api.md · cinemática: robot/kinematics.ts (URDF)

  /**
   * "Gets a Position relative to the FRAME": Position6D [x, y, z, wx, wy, wz] (m, rad). name = joint, cadena
   * ("Head", "LArm", "RArm", "LLeg", "RLeg", "Torso") o sensor con frame en el URDF ("CameraTop"…).
   * frame: FRAME_TORSO = 0, FRAME_WORLD = 1, FRAME_ROBOT = 2.
   */
  getPosition(name: string, frame: number, useSensorValues: boolean): number[] {
    return toPosition6D(this.transform('getPosition', name, frame, useSensorValues));
  }

  /** "Gets an Homogeneous Transform relative to the FRAME": 16 valores de la matriz, fila por fila */
  getTransform(name: string, frame: number, useSensorValues: boolean): number[] {
    return this.transform('getTransform', name, frame, useSensorValues);
  }

  private transform(method: string, name: string, frame: number, useSensors: boolean): Mat4 {
    const kin = naoKinematics();
    const link = this.effectorLink(name);
    if (!link) throw new NaoqiError(SERVICE, method, `no conozco "${name}" (joint, cadena o sensor)`);
    const angle = (j: string) => (useSensors ? this.state.get(j) : this.engine.command(COUPLED[j] ?? j));
    const inTorso = kin.linkInTorso(link, angle);
    if (frame === 0) return inTorso;
    if (frame !== 1 && frame !== 2) throw new NaoqiError(SERVICE, method, 'frame debe ser FRAME_TORSO (0), FRAME_WORLD (1) o FRAME_ROBOT (2)');
    // Sin física no hay pose del torso en el mundo: se toma el torso en el origen (APPROX)
    const root = this.state.root;
    const torso = root ? fromQuaternion(root.quaternion, root.position) : fromQuaternion([1, 0, 0, 0], [0, 0, 0]);
    const world = multiply(torso, inTorso);
    if (frame === 1) return world;
    // APPROX (definición de la página general de ALMotion, fuera de reference/): FRAME_ROBOT = promedio de los dos pies
    // proyectado en el suelo, girado solo alrededor de la vertical
    const [l, r] = ['l_sole', 'r_sole'].map((f) => multiply(torso, kin.linkInTorso(f, angle)));
    const yaw = Math.atan2(Math.sin(Math.atan2(l[4], l[0])) + Math.sin(Math.atan2(r[4], r[0])), Math.cos(Math.atan2(l[4], l[0])) + Math.cos(Math.atan2(r[4], r[0])));
    const [c, s] = [Math.cos(yaw), Math.sin(yaw)];
    const robot: Mat4 = [c, -s, 0, (l[3] + r[3]) / 2, s, c, 0, (l[7] + r[7]) / 2, 0, 0, 1, (l[11] + r[11]) / 2, 0, 0, 0, 1];
    return multiply(invertRigid(robot), world);
  }

  /** Link del URDF que representa un nombre de NAOqi */
  private effectorLink(name: string): string | undefined {
    const kin = naoKinematics();
    const chains: Record<string, string> = { Torso: 'torso', Head: 'Head', LArm: 'l_gripper', RArm: 'r_gripper', LLeg: 'l_sole', RLeg: 'r_sole' };
    if (chains[name]) return chains[name];
    const child = kin.childOf(name);
    if (child && JOINTS.some((j) => j.name === name)) return child;
    for (const candidate of [name, `${name}_frame`]) if (kin.hasLink(candidate)) return candidate;
    return undefined;
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
    this.moveRun++;
    this.gait.abort();
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
