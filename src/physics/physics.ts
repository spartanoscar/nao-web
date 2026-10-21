// Simulación física con MuJoCo (Google DeepMind, Apache-2.0, WebAssembly). Reproduce la cadena del
// robot real:  ALMotion (MotionEngine) → comandos de ángulo → motores con control de posición y
// torque limitado → física (gravedad, contactos) → sensores (RobotState).
//
// Torque disponible: curva de un motor DC con los datos oficiales de cada motor (naoV6.motorOf):
//   τ_max(ω) = τ_stall · (1 − |ω|/ω₀) · eficiencia de la reductora
// Stiffness (doc NAOqi, control-stiffness): "The Stiffness of the joint is equivalent to a torque
// limitation into the motors. If the joint stiffness is set to 0.0, the joint controller does
// nothing and the joint is free."  →  forcerange = ±τ_max(ω) · stiffness.

import loadMujoco, { type MainModule, type MjData, type MjModel } from '@mujoco/mujoco';
import wasmUrl from '@mujoco/mujoco/mujoco.wasm?url';
import type { MotionEngine } from '../naoqi/engine';
import { headPitchLimits, motorOf } from '../robot/naoV6';
import type { RobotState, RootPose } from '../robot/state';
import type { UrdfRobot } from '../robot/urdf';
import { ENV_OBJECTS } from '../sim/environment';
import { PHYSICS_TIMESTEP, buildMjcf } from './mjcf';

interface JointSlot {
  name: string;
  qpos: number;
  dof: number;
  /** índice del actuador, -1 si no tiene (RHipYawPitch) */
  actuator: number;
  stallTorque: number;
  noLoadSpeed: number;
}

interface ObjectSlot {
  body: number;
  target: { position: { set(x: number, y: number, z: number): void }; quaternion: { set(x: number, y: number, z: number, w: number): void } };
}

/** Cambio mínimo para considerar que algo se movió (evita redibujar cuando todo está en reposo) */
const EPS = 1e-5;

/** APPROX: eficiencia de las reductoras de engranajes rectos del NAO (no documentada) */
const GEAR_EFFICIENCY = 0.8;

export class PhysicsSim {
  private acc = 0;
  private readonly lastQpos: Float64Array;

  private constructor(
    private readonly mj: MainModule,
    private readonly model: MjModel,
    private readonly data: MjData,
    private readonly joints: JointSlot[],
    private readonly objects: ObjectSlot[],
    private readonly state: RobotState,
    private readonly engine: MotionEngine,
  ) {
    this.lastQpos = new Float64Array(model.nq);
    this.syncState(true);
  }

  static async create(
    urdf: UrdfRobot,
    state: RobotState,
    engine: MotionEngine,
    root: RootPose,
    objectMeshes: ReadonlyMap<string, ObjectSlot['target']>,
  ): Promise<PhysicsSim> {
    const mj = await loadMujoco({ locateFile: (path: string) => (path.endsWith('.wasm') ? wasmUrl : path) });
    const { xml, joints } = buildMjcf(urdf, root);
    const model = mj.MjModel.from_xml_string(xml);
    const data = new mj.MjData(model);

    const slots = joints.map((j): JointSlot => {
      const mjJoint = model.jnt(j.name);
      const motor = motorOf(j.name);
      const slot = {
        name: j.name,
        qpos: mjJoint.qposadr[0] ?? mjJoint.qposadr,
        dof: mjJoint.dofadr[0] ?? mjJoint.dofadr,
        actuator: -1,
        stallTorque: motor.stallTorque * GEAR_EFFICIENCY,
        noLoadSpeed: motor.noLoadSpeed,
      };
      mjJoint.delete();
      if (j.actuated) {
        const act = model.actuator(j.name);
        slot.actuator = act.id;
        act.delete();
      }
      return slot;
    });

    // Pose inicial: los ángulos actuales del estado (el robot arranca en Crouch)
    for (const s of slots) data.qpos[s.qpos] = state.get(s.name);
    mj.mj_forward(model, data);

    const objects = ENV_OBJECTS.flatMap((o) => {
      const target = objectMeshes.get(o.name);
      if (!target) return [];
      const b = model.body(`env_${o.name}`);
      const slot = { body: b.id, target };
      b.delete();
      return [slot];
    });

    return new PhysicsSim(mj, model, data, slots, objects, state, engine);
  }

  /** Avanza la física `dt` segundos. Devuelve true si algo se movió (hay que redibujar). */
  step(dt: number): boolean {
    this.acc = Math.min(this.acc + dt, 0.1); // pestaña congelada: no recuperar el tiempo perdido
    let stepped = false;
    while (this.acc >= PHYSICS_TIMESTEP) {
      this.applyMotors();
      this.mj.mj_step(this.model, this.data);
      this.acc -= PHYSICS_TIMESTEP;
      stepped = true;
    }
    return stepped && this.syncState(false);
  }

  /** Mover un joint "a mano" con el motor apagado: se coloca directamente (como con la mano) */
  placeJoint(name: string, value: number): void {
    const s = this.joints.find((j) => j.name === name);
    if (!s) return;
    this.data.qpos[s.qpos] = value;
    this.data.qvel[s.dof] = 0;
    this.mj.mj_forward(this.model, this.data);
    this.syncState(true);
  }

  /** Vuelve a la pose dada (torso + ángulos) en reposo; los objetos vuelven a su sitio */
  reset(root: RootPose, angles: Readonly<Record<string, number>>): void {
    this.mj.mj_resetData(this.model, this.data);
    const q = this.data.qpos;
    [q[0], q[1], q[2]] = root.position;
    [q[3], q[4], q[5], q[6]] = root.quaternion;
    for (const s of this.joints) q[s.qpos] = angles[s.name] ?? 0;
    this.mj.mj_forward(this.model, this.data);
    this.acc = 0;
    this.syncState(true);
  }

  dispose(): void {
    this.data.delete();
    this.model.delete();
  }

  private applyMotors(): void {
    const ctrl = this.data.ctrl;
    const qvel = this.data.qvel;
    const forcerange = this.model.actuator_forcerange;
    const headYaw = this.engine.command('HeadYaw');
    for (const s of this.joints) {
      if (s.actuator < 0) continue;
      let target = this.engine.command(s.name);
      if (s.name === 'HeadPitch') {
        const [lo, hi] = headPitchLimits(headYaw); // anti-colisión de la cabeza (límite dinámico)
        target = Math.min(Math.max(target, lo), hi);
      }
      ctrl[s.actuator] = target;
      const speedFactor = Math.max(0, 1 - Math.abs(qvel[s.dof]) / s.noLoadSpeed);
      const limit = s.stallTorque * speedFactor * this.state.getStiffness(s.name);
      forcerange[2 * s.actuator] = -limit;
      forcerange[2 * s.actuator + 1] = limit;
    }
  }

  /** Copia la simulación a RobotState y a las mallas de los objetos. Devuelve si hubo cambios. */
  private syncState(force: boolean): boolean {
    const q = this.data.qpos;
    let changed = force;
    for (let i = 0; i < q.length && !changed; i++) if (Math.abs(q[i] - this.lastQpos[i]) > EPS) changed = true;
    if (!changed) return false;
    this.lastQpos.set(q);

    const root: RootPose = { position: [q[0], q[1], q[2]], quaternion: [q[3], q[4], q[5], q[6]] };
    const angles: Record<string, number> = {};
    for (const s of this.joints) angles[s.name] = q[s.qpos];
    this.state.setFromPhysics(root, angles);

    const xpos = this.data.xpos;
    const xquat = this.data.xquat;
    for (const { body, target } of this.objects) {
      target.position.set(xpos[3 * body], xpos[3 * body + 1], xpos[3 * body + 2]);
      target.quaternion.set(xquat[4 * body + 1], xquat[4 * body + 2], xquat[4 * body + 3], xquat[4 * body]);
    }
    return true;
  }
}
