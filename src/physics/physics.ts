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
import postureData from '../../reference/qibullet/nao_postures.json';
import { type CollisionOptions, PHYSICS_TIMESTEP, buildMjcf } from './mjcf';

/**
 * Pares de piezas que se tocan en las 8 posturas oficiales (qiBullet) con el robot en el aire: el NAO real las hace, así
 * que ahí un choque es un artefacto de la forma de colisión (una envolvente convexa rellena los huecos de la carcasa) y
 * ese par no debe chocar. El resto sí choca, como el plástico del robot.
 */
function selfCollisionExcludes(mj: MainModule, urdf: UrdfRobot, collision: CollisionOptions): [string, string][] {
  const air = { position: [0, 0, 1] as [number, number, number], quaternion: [1, 0, 0, 0] as [number, number, number, number] };
  const { xml } = buildMjcf(urdf, air, { ...collision, exclude: [] });
  const model = mj.MjModel.from_xml_string(xml);
  const data = new mj.MjData(model);
  const name = (body: number) => {
    const b = model.body(body);
    const n = b.name;
    b.delete();
    return n;
  };
  const robot = new Set(urdf.links.map((l) => l.name));
  const pairs = new Map<string, [string, string]>();
  for (const pose of Object.values(postureData as Record<string, Record<string, number>>)) {
    for (const [joint, value] of Object.entries({ ...pose, RHipYawPitch: pose.LHipYawPitch })) {
      if (value === undefined) continue;
      try {
        const j = model.jnt(joint);
        data.qpos[j.qposadr[0] ?? j.qposadr] = value;
        j.delete();
      } catch {
        /* manos y dedos: sin joint físico */
      }
    }
    mj.mj_forward(model, data);
    // data.contact es una copia nueva en cada lectura (embind): se lee una vez y se libera
    const contacts = data.contact;
    for (let i = 0; i < data.ncon; i++) {
      const c = contacts.get(i);
      if (!c) continue;
      const [a, b] = [name(model.geom_bodyid[c.geom1]), name(model.geom_bodyid[c.geom2])];
      c.delete();
      if (robot.has(a) && robot.has(b)) pairs.set([a, b].sort().join('|'), [a, b]);
    }
    contacts.delete();
  }
  data.delete();
  model.delete();
  return [...pairs.values()];
}

interface JointSlot {
  name: string;
  qpos: number;
  dof: number;
  /** índice del actuador, -1 si no tiene (RHipYawPitch) */
  actuator: number;
  stallTorque: number;
  noLoadSpeed: number;
  ratio: number;
  motor: string;
}

/** Lo que "se escucha" de un motor en este instante (para el sonido) */
export interface MotorTelemetry {
  name: string;
  /** Modelo de motor oficial (5 tipos en el NAO V6) */
  motor: string;
  /** Velocidad del joint (rad/s) y del rotor (rad/s, × reducción) */
  speed: number;
  rotorSpeed: number;
  /** Torque que está haciendo (N·m) y torque de bloqueo de ese motor */
  torque: number;
  stallTorque: number;
}

interface ObjectSlot {
  body: number;
  target: { position: { set(x: number, y: number, z: number): void }; quaternion: { set(x: number, y: number, z: number, w: number): void } };
}

/** Golpe contra el suelo detectado en la física (para el sonido) */
export interface Impact {
  body: string;
  /** Velocidad vertical justo antes del golpe (m/s) */
  speed: number;
  /** heavy = torso/cabeza (graves), limb = brazos/piernas, foot = pasos */
  kind: 'heavy' | 'limb' | 'foot';
}

interface Watched extends Impact {
  id: number;
  prevZ: number;
  prevVz: number;
  cooldown: number;
}

/**
 * Partes que suenan al golpear el suelo: [body, tipo]. Umbral de velocidad (m/s) y altura máxima del
 * origen del body (m) para contar como golpe contra el suelo. APPROX: elegidos midiendo caídas y pasos.
 */
const IMPACT_BODIES: [string, Impact['kind']][] = [
  ['torso', 'heavy'], ['Head', 'heavy'],
  ['LTibia', 'limb'], ['RTibia', 'limb'], ['LThigh', 'limb'], ['RThigh', 'limb'],
  ['l_wrist', 'limb'], ['r_wrist', 'limb'], ['LForeArm', 'limb'], ['RForeArm', 'limb'],
  ['l_ankle', 'foot'], ['r_ankle', 'foot'],
];
const IMPACT_RULE: Record<Impact['kind'], { minSpeed: number; maxZ: number }> = {
  heavy: { minSpeed: 0.25, maxZ: 0.13 },
  limb: { minSpeed: 0.3, maxZ: 0.1 },
  foot: { minSpeed: 0.04, maxZ: 0.06 },
};
/** Paso: el tobillo cruza hacia abajo esta altura (apoyado queda a 44.4 mm) mientras baja */
const FOOT_TOUCH_Z = 0.0465;

/** Cambio mínimo para considerar que algo se movió (evita redibujar cuando todo está en reposo) */
const EPS = 1e-5;

/** APPROX: eficiencia de las reductoras de engranajes rectos del NAO (no documentada) */
const GEAR_EFFICIENCY = 0.8;

/** Reposo: velocidad máxima (rad/s, m/s) y tiempo quieto para bloquear la simulación */
const REST_SPEED = 1e-3;
const REST_TIME = 1;

export class PhysicsSim {
  private acc = 0;
  private readonly lastQpos: Float64Array;
  /**
   * Bloqueo de reposo: con todos los motores apagados y el robot quieto, la simulación se detiene.
   * La fricción de MuJoCo es una restricción blanda y dejaba "escurrir" al robot ~0.01°/s; una
   * reductora real no se desliza. También ahorra CPU cuando nada se mueve.
   */
  private stillFor = 0;
  private locked = false;
  private readonly watched: Watched[] = [];
  private readonly impacts: Impact[] = [];

  private constructor(
    private readonly mj: MainModule,
    private readonly model: MjModel,
    private readonly data: MjData,
    private readonly joints: JointSlot[],
    private readonly objects: ObjectSlot[],
    private state: RobotState,
    private engine: MotionEngine,
  ) {
    this.lastQpos = new Float64Array(model.nq);
    for (const [name, kind] of IMPACT_BODIES) {
      const b = model.body(name);
      this.watched.push({ body: name, kind, id: b.id, prevZ: 0, prevVz: 0, speed: 0, cooldown: 0 });
      b.delete();
    }
    this.resetImpacts();
    this.syncState(true);
  }

  static async create(
    urdf: UrdfRobot,
    state: RobotState,
    engine: MotionEngine,
    root: RootPose,
    objectMeshes: ReadonlyMap<string, ObjectSlot['target']>,
    collision: CollisionOptions = {},
  ): Promise<PhysicsSim> {
    const mj = await loadMujoco({ locateFile: (path: string) => (path.endsWith('.wasm') ? wasmUrl : path) });
    if (collision.selfCollision && !collision.exclude) collision = { ...collision, exclude: selfCollisionExcludes(mj, urdf, collision) };
    const { xml, joints } = buildMjcf(urdf, root, collision);
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
        ratio: motor.ratio,
        motor: motor.model,
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
    if (this.locked) {
      if (!this.canRest()) this.locked = false;
      else return false;
    }
    this.acc = Math.min(this.acc + dt, 0.1); // pestaña congelada: no recuperar el tiempo perdido
    let stepped = false;
    while (this.acc >= PHYSICS_TIMESTEP) {
      this.applyMotors();
      this.mj.mj_step(this.model, this.data);
      this.acc -= PHYSICS_TIMESTEP;
      stepped = true;
    }
    this.updateRest(dt);
    if (stepped) this.detectImpacts(dt);
    return stepped && this.syncState(false);
  }

  /** Golpes detectados desde la última llamada */
  takeImpacts(): Impact[] {
    return this.impacts.splice(0);
  }

  // Golpe = el body venía bajando rápido cerca del suelo y se frenó de golpe en este frame
  private detectImpacts(dt: number): void {
    const xpos = this.data.xpos;
    for (const w of this.watched) {
      const z = xpos[3 * w.id + 2];
      const vz = (z - w.prevZ) / Math.max(dt, 1e-3);
      w.cooldown = Math.max(w.cooldown - dt, 0);
      const rule = IMPACT_RULE[w.kind];
      // Pies: contacto (cruce de la altura de apoyo; la marcha frena el pie en varios frames).
      // Resto: frenazo brusco cerca del suelo.
      const hit =
        w.kind === 'foot'
          ? w.prevZ > FOOT_TOUCH_Z && z <= FOOT_TOUCH_Z && w.prevVz < -rule.minSpeed
          : w.prevVz < -rule.minSpeed && vz > w.prevVz * 0.35 && z < rule.maxZ;
      if (w.cooldown === 0 && hit) {
        this.impacts.push({ body: w.body, kind: w.kind, speed: -w.prevVz });
        w.cooldown = 0.12;
      }
      w.prevZ = z;
      w.prevVz = vz;
    }
  }

  /** Tras teletransportar (reset / mover a mano) no hay "caída" que sonar */
  private resetImpacts(): void {
    const xpos = this.data.xpos;
    for (const w of this.watched) {
      w.prevZ = xpos[3 * w.id + 2];
      w.prevVz = 0;
    }
    this.impacts.length = 0;
  }

  /** ¿Se puede bloquear? Motores apagados y sin comandos en curso */
  private canRest(): boolean {
    return !this.engine.busy && this.joints.every((s) => this.state.getStiffness(s.name) === 0);
  }

  private updateRest(dt: number): void {
    const qvel = this.data.qvel;
    let still = this.canRest();
    for (let i = 0; i < qvel.length && still; i++) if (Math.abs(qvel[i]) > REST_SPEED) still = false;
    this.stillFor = still ? this.stillFor + dt : 0;
    if (this.stillFor >= REST_TIME) {
      this.locked = true;
      this.stillFor = 0;
    }
  }

  /** Mover un joint "a mano" con el motor apagado: se coloca directamente (como con la mano) */
  placeJoint(name: string, value: number): void {
    const s = this.joints.find((j) => j.name === name);
    if (!s) return;
    this.locked = false;
    this.data.qpos[s.qpos] = value;
    this.data.qvel[s.dof] = 0;
    this.mj.mj_forward(this.model, this.data);
    this.resetImpacts();
    this.syncState(true);
  }

  /** Vuelve a la pose dada (torso + ángulos) en reposo; los objetos vuelven a su sitio */
  reset(root: RootPose, angles: Readonly<Record<string, number>>): void {
    this.locked = false;
    this.stillFor = 0;
    this.mj.mj_resetData(this.model, this.data);
    const q = this.data.qpos;
    [q[0], q[1], q[2]] = root.position;
    [q[3], q[4], q[5], q[6]] = root.quaternion;
    for (const s of this.joints) q[s.qpos] = angles[s.name] ?? 0;
    this.mj.mj_forward(this.model, this.data);
    this.acc = 0;
    this.resetImpacts();
    this.syncState(true);
  }

  /**
   * Estado físico exacto (posiciones, velocidades y el arranque en caliente del solver de contactos de MuJoCo), para
   * repetir un episodio desde el mismo punto con el mismo resultado
   */
  snapshot(): { qpos: Float64Array; qvel: Float64Array; warm: Float64Array } {
    return { qpos: Float64Array.from(this.data.qpos), qvel: Float64Array.from(this.data.qvel), warm: Float64Array.from(this.data.qacc_warmstart) };
  }

  /** Cambia el robot y el motor de NAOqi que usa (laboratorio: una sesión nueva por episodio) */
  rebind(state: RobotState, engine: MotionEngine): void {
    this.state = state;
    this.engine = engine;
  }

  restore(s: { qpos: Float64Array; qvel: Float64Array; warm: Float64Array }): void {
    this.locked = false;
    this.stillFor = 0;
    this.data.qpos.set(s.qpos);
    this.data.qvel.set(s.qvel);
    this.data.qacc_warmstart.set(s.warm);
    this.mj.mj_forward(this.model, this.data);
    this.acc = 0;
    this.resetImpacts();
    this.syncState(true);
  }

  /** Posición generalizada de MuJoCo (raíz + joints + objetos), para el medidor de penetración */
  qpos(): Float64Array {
    return this.data.qpos;
  }

  /** Velocidad y torque actuales de cada motor con actuador (los 24 que no son RHipYawPitch) */
  telemetry(): MotorTelemetry[] {
    const qvel = this.data.qvel;
    const force = this.data.actuator_force;
    const out: MotorTelemetry[] = [];
    for (const s of this.joints) {
      if (s.actuator < 0) continue;
      const speed = this.locked ? 0 : qvel[s.dof];
      out.push({
        name: s.name,
        motor: s.motor,
        speed,
        rotorSpeed: speed * s.ratio,
        torque: this.locked ? 0 : force[s.actuator],
        stallTorque: s.stallTorque,
      });
    }
    return out;
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

export interface Penetration {
  /** Lo más que se hunde la forma real del robot en el suelo (m, ≥ 0) y qué pieza */
  floor: number;
  floorBody: string;
  /** Lo más que se mete una pieza del robot en otra (m, ≥ 0) y qué par */
  self: number;
  selfPair: string;
}

/**
 * Medidor de penetración para los bancos: una física aparte con la colisión fiel (envolventes de las mallas oficiales y
 * choque consigo mismo) que no simula. En cada medición copia la pose de otra simulación y le pregunta a MuJoCo cuánto
 * se hunde la forma real del NAO en el suelo y en su propio cuerpo. Sirve con cualquier física, porque mide con la forma
 * real y no con la colisión que se esté usando.
 */
export class PenetrationProbe {
  private constructor(
    private readonly mj: MainModule,
    private readonly model: MjModel,
    private readonly data: MjData,
    private readonly names: string[],
    private readonly robot: Set<number>,
    private readonly floor: number,
  ) {}

  static async create(urdf: UrdfRobot, root: RootPose, hulls: NonNullable<CollisionOptions['hulls']>): Promise<PenetrationProbe> {
    const mj = await loadMujoco({ locateFile: (path: string) => (path.endsWith('.wasm') ? wasmUrl : path) });
    const collision: CollisionOptions = { hulls, selfCollision: true };
    const { xml } = buildMjcf(urdf, root, { ...collision, exclude: selfCollisionExcludes(mj, urdf, collision) });
    const model = mj.MjModel.from_xml_string(xml);
    const data = new mj.MjData(model);
    const names: string[] = [];
    for (let i = 0; i < model.nbody; i++) {
      const b = model.body(i);
      names.push(b.name);
      b.delete();
    }
    const links = new Set(urdf.links.map((l) => l.name));
    const robot = new Set(names.flatMap((n, i) => (links.has(n) ? [i] : [])));
    const g = model.geom('floor');
    const floor = g.id;
    g.delete();
    return new PenetrationProbe(mj, model, data, names, robot, floor);
  }

  measure(qpos: ArrayLike<number>): Penetration {
    const { model, data } = this;
    data.qpos.set(qpos);
    this.mj.mj_forward(model, data);
    const out: Penetration = { floor: 0, floorBody: '', self: 0, selfPair: '' };
    // data.contact es una copia nueva en cada lectura (embind): se lee una vez y se libera
    const contacts = data.contact;
    for (let i = 0; i < data.ncon; i++) {
      const c = contacts.get(i);
      if (!c) continue;
      const depth = -c.dist;
      const [g1, g2] = [c.geom1, c.geom2];
      c.delete();
      if (depth <= 0) continue;
      const [b1, b2] = [model.geom_bodyid[g1], model.geom_bodyid[g2]];
      const [r1, r2] = [this.robot.has(b1), this.robot.has(b2)];
      if ((g1 === this.floor || g2 === this.floor) && (r1 || r2)) {
        if (depth > out.floor) Object.assign(out, { floor: depth, floorBody: this.names[r1 ? b1 : b2] });
      } else if (r1 && r2 && depth > out.self) {
        Object.assign(out, { self: depth, selfPair: `${this.names[b1]}–${this.names[b2]}` });
      }
    }
    contacts.delete();
    return out;
  }

  dispose(): void {
    this.data.delete();
    this.model.delete();
  }
}
