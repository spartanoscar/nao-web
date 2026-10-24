// La física del mundo vista desde el hilo de la pantalla: corre en physicsWorker.ts (MuJoCo en otro núcleo) y aquí se
// le pasa, ciclo a ciclo, lo que decide el motor de NAOqi (comandos y rigidez de cada joint); cuando el worker devuelve el
// estado (torso, ángulos, sonares, objetos, golpes, telemetría de los motores), se escribe en RobotState y empieza el
// ciclo siguiente. Mismo paso a paso que cuando todo corría en el hilo principal (app.ts simulaba motor + física
// intercalados), así que los bancos y la marcha dan lo mismo; la diferencia es que dibujar ya no espera a MuJoCo.
//
// Tiene lo que el resto usaba de PhysicsSim: reset, qpos (bancos), telemetry y takeImpacts (sonido), setGhost y
// ghostLinks (mundo compartido). El laboratorio de los bancos sigue usando PhysicsSim directo (labSim.ts).

import type { MotionEngine } from '../naoqi/engine';
import type { RobotState, RootPose } from '../robot/state';
import type { UrdfRobot } from '../robot/urdf';
import type { Impact, MotorTelemetry } from './physics';
import type { CollisionHulls } from './mjcf';
import type { PhysicsRequest, PhysicsResponse } from './physicsWorker';

type StepReply = Extract<PhysicsResponse, { t: 'step' }>;

interface ObjectTarget {
  position: { set(x: number, y: number, z: number): void };
  quaternion: { set(x: number, y: number, z: number, w: number): void };
}

export class PhysicsClient {
  ghostLinks: readonly string[] = [];
  private joints: string[] = [];
  private epoch = 0;
  private pending: ((r: StepReply) => void) | null = null;
  private lastQpos: Float64Array = new Float64Array(0);
  private lastTelemetry: MotorTelemetry[] = [];
  private readonly impacts: Impact[] = [];
  private locked = false;
  private sleeping = false;

  private constructor(
    private readonly worker: Worker,
    private readonly state: RobotState,
    private readonly engine: MotionEngine,
    private readonly objects: [string, ObjectTarget][],
    private readonly ghosts: number,
  ) {}

  static async create(
    urdf: UrdfRobot,
    state: RobotState,
    engine: MotionEngine,
    root: RootPose,
    objectMeshes: ReadonlyMap<string, ObjectTarget>,
    collision: { hulls: CollisionHulls; ghosts?: number },
  ): Promise<PhysicsClient> {
    const worker = new Worker(new URL('./physicsWorker.ts', import.meta.url), { type: 'module', name: 'física' });
    const client = new PhysicsClient(worker, state, engine, [...objectMeshes], collision.ghosts ?? 0);
    const ready = new Promise<void>((resolve, reject) => {
      worker.onerror = (e) => reject(new Error(`la física no arrancó: ${e.message}`));
      worker.onmessage = (e: MessageEvent<PhysicsResponse>) => {
        const m = e.data;
        if (m.t === 'ready') {
          client.joints = m.joints;
          client.ghostLinks = m.ghostLinks;
          resolve();
        } else if (m.t === 'error') reject(new Error(m.message));
      };
    });
    const hulls = [...collision.hulls].map(([name, v]): [string, Float32Array] => [name, Float32Array.from(v)]);
    client.send({ t: 'init', urdf, root, angles: state.snapshot(), hulls, ghosts: client.ghosts, objects: client.objects.map(([n]) => n) });
    await ready;
    worker.onmessage = (e: MessageEvent<PhysicsResponse>) => client.receive(e.data);
    return client;
  }

  /** Lugares para otros NAO */
  get ghostCount(): number {
    return this.ghosts;
  }

  /** Bloqueada en reposo (motores apagados y quieto) */
  get isLocked(): boolean {
    return this.locked;
  }

  /** Cubos y cajas fuera de la física (ningún NAO cerca) */
  get objectsSleeping(): boolean {
    return this.sleeping;
  }

  /**
   * Simula `dt` segundos con lo que el motor de NAOqi decidió para este ciclo (llamar después de session.update).
   * Devuelve si algo se movió (hay que redibujar). Un ciclo a la vez.
   */
  cycle(dt: number): Promise<boolean> {
    const commands = Float64Array.from(this.joints, (n) => this.engine.command(n));
    const stiffness = Float64Array.from(this.joints, (n) => this.state.getStiffness(n));
    const epoch = this.epoch;
    const reply = new Promise<StepReply>((resolve) => (this.pending = resolve));
    this.send({ t: 'cycle', epoch, dt, commands, stiffness, busy: this.engine.busy }, [commands.buffer, stiffness.buffer]);
    return reply.then((r) => {
      // Un reset mientras este ciclo estaba en camino: su estado ya no vale
      if (r.epoch !== this.epoch) return false;
      this.apply(r);
      return r.moved;
    });
  }

  /** Vuelve a la pose dada (torso + ángulos) en reposo; se ve ya, sin esperar al worker */
  reset(root: RootPose, angles: Readonly<Record<string, number>>): void {
    this.epoch++;
    this.send({ t: 'reset', root, angles: { ...angles } });
    this.state.setFromPhysics({ position: [...root.position], quaternion: [...root.quaternion] }, angles);
    this.impacts.length = 0;
    this.locked = false;
  }

  /** El NAO de otra persona: pose de cada link de `ghostLinks` (Z arriba, cuaternión w x y z); null = lo guarda */
  setGhost(k: number, pose: ((link: string) => { position: ArrayLike<number>; quaternion: ArrayLike<number> }) | null): void {
    let poses: Float64Array | null = null;
    if (pose) {
      poses = new Float64Array(7 * this.ghostLinks.length);
      this.ghostLinks.forEach((l, i) => {
        const p = pose(l);
        poses!.set(p.position, 7 * i);
        poses!.set(p.quaternion, 7 * i + 3);
      });
    }
    this.send({ t: 'ghost', k, poses }, poses ? [poses.buffer] : []);
  }

  /** Posición generalizada de MuJoCo del último ciclo (medidor de penetración de los bancos) */
  qpos(): Float64Array {
    return this.lastQpos;
  }

  /** Velocidad y torque de cada motor en el último ciclo (sonido) */
  telemetry(): MotorTelemetry[] {
    return this.lastTelemetry;
  }

  /** Golpes desde la última llamada (sonido) */
  takeImpacts(): Impact[] {
    return this.impacts.splice(0);
  }

  dispose(): void {
    this.worker.terminate();
  }

  private send(m: PhysicsRequest, transfer: Transferable[] = []): void {
    this.worker.postMessage(m, transfer);
  }

  private receive(m: PhysicsResponse): void {
    if (m.t === 'step') {
      const done = this.pending;
      this.pending = null;
      done?.(m);
    } else if (m.t === 'error') console.error('Física:', m.message);
  }

  private apply(r: StepReply): void {
    this.lastQpos = r.qpos;
    this.lastTelemetry = r.telemetry;
    this.impacts.push(...r.impacts);
    this.locked = r.locked;
    this.sleeping = r.objectsSleeping;
    this.state.sonar = r.sonar;
    this.state.sonarEchoes = r.echoes;
    if (!r.moved || !r.root) return;
    const angles: Record<string, number> = {};
    this.joints.forEach((n, i) => (angles[n] = r.angles[i]));
    this.state.setFromPhysics(r.root, angles);
    this.objects.forEach(([, target], i) => {
      const o = r.objects;
      target.position.set(o[7 * i], o[7 * i + 1], o[7 * i + 2]);
      target.quaternion.set(o[7 * i + 3], o[7 * i + 4], o[7 * i + 5], o[7 * i + 6]);
    });
  }
}
