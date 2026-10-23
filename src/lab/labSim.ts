// Simulador de episodios del laboratorio: una física MuJoCo propia (la misma del mundo, sin dibujar) con su propia
// sesión NAOqi, para probar miles de movimientos lejos de la escena. Cada episodio parte de una foto exacta del estado
// físico y el movimiento se reproduce con ALMotion.angleInterpolation, igual que en el robot real. Corre ~14 veces más
// rápido que el tiempo real (medido: 6 s simulados en 0.43 s).

import { Session } from '../naoqi/session';
import type { PhysicsSim } from '../physics/physics';
import { RobotState, type RootPose } from '../robot/state';
import type { UrdfRobot } from '../robot/urdf';

/** Ciclo del motor de NAOqi (20 ms), el mismo paso del mundo */
export const LAB_DT = 0.02;

export type Snapshot = { qpos: Float64Array; qvel: Float64Array; warm: Float64Array; angles: Record<string, number> };

/** Lo que se mide en cada ciclo de 20 ms */
export interface Sample {
  t: number;
  /** Altura del torso (m) */
  z: number;
  /** Ángulo del torso respecto a la vertical (rad) y su inclinación adelante (+) / atrás (−) y de lado */
  tilt: number;
  pitch: number;
  roll: number;
}

export class LabSim {
  private constructor(
    public session: Session,
    public state: RobotState,
    readonly physics: PhysicsSim,
  ) {}

  static async create(urdf: UrdfRobot, root: RootPose, joints: Readonly<Record<string, number>>): Promise<LabSim> {
    const { PhysicsSim } = await import('../physics/physics');
    const state = new RobotState(joints);
    const session = new Session(state);
    const physics = await PhysicsSim.create(urdf, state, session.engine, root, new Map());
    session.engine.physical = true;
    physics.reset(root, joints);
    return new LabSim(session, state, physics);
  }

  /** Un ciclo de 20 ms: motor de NAOqi + física (500 Hz) */
  tick(): Sample {
    this.session.update(LAB_DT);
    this.physics.step(LAB_DT);
    return this.measure();
  }

  measure(): Sample {
    const root = this.state.root!;
    const [w, x, y, z] = root.quaternion;
    // Eje vertical del torso en el mundo: tercera columna de R
    const zx = 2 * (x * z + w * y);
    const zy = 2 * (y * z - w * x);
    const zz = 1 - 2 * (x * x + y * y);
    return { t: this.session.engine.time, z: root.position[2], tilt: Math.acos(Math.min(1, zz)), pitch: Math.atan2(zx, zz), roll: Math.atan2(-zy, zz) };
  }

  /**
   * Avanza la simulación mientras corre `task` (una orden de NAOqi que devuelve Promise), como máximo `seconds`.
   * Las promesas del motor se resuelven en microtareas: se cede una por ciclo.
   */
  async drive(task: Promise<unknown>, seconds: number, onSample?: (s: Sample) => void): Promise<boolean> {
    let done = false;
    void task.then(
      () => (done = true),
      () => (done = true),
    );
    // Tope en ciclos (no en el reloj del motor): un episodio nunca puede quedar en un bucle sin fin
    const ticks = Math.ceil(seconds / LAB_DT);
    for (let i = 0; i < ticks && !done; i++) {
      const sample = this.tick(); // fuera de onSample?.(…): sin callback no se evaluaría el argumento
      onSample?.(sample);
      await this.breathe(i);
    }
    return done;
  }

  /** Solo avanza el tiempo (sostener la pose y ver si se mantiene) */
  async hold(seconds: number, onSample?: (s: Sample) => void): Promise<void> {
    const ticks = Math.ceil(seconds / LAB_DT);
    for (let i = 0; i < ticks; i++) {
      const sample = this.tick(); // fuera de onSample?.(…): sin callback no se evaluaría el argumento
      onSample?.(sample);
      await this.breathe(i);
    }
  }

  /**
   * Cede una microtarea en cada ciclo (para que avancen las promesas de NAOqi) y, cada 25 ciclos, el turno al
   * navegador: con solo microtareas la página se congela mientras corre la búsqueda (medido).
   */
  private breathe(i: number): Promise<void> {
    return i % 25 === 24 ? new Promise((r) => setTimeout(r, 0)) : Promise.resolve();
  }

  snapshot(): Snapshot {
    const names = this.session.service('ALMotion').getBodyNames('Body');
    return { ...this.physics.snapshot(), angles: Object.fromEntries(names.map((n) => [n, this.state.get(n)])) };
  }

  /**
   * Vuelve exactamente a esa foto con una sesión de NAOqi nueva (motor sin comandos ni velocidades del episodio
   * anterior: sostiene la pose medida) y los motores encendidos. Así el mismo movimiento da siempre el mismo resultado.
   */
  restore(s: Snapshot): void {
    this.state = new RobotState(s.angles);
    this.session = new Session(this.state);
    this.session.engine.physical = true;
    this.physics.rebind(this.state, this.session.engine);
    this.physics.restore(s);
    this.session.service('ALMotion').setStiffnesses('Body', 1);
  }
}
