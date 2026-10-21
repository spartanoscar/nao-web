// Sesión estilo qi (NAOqi 2.x): `session.service("ALMotion")` devuelve el servicio.
// Es el punto de entrada que usarán la consola, los scripts Python (F4) y la IA (F6).

import type { RobotState } from '../robot/state';
import { ALMotion } from './ALMotion';
import { ALRobotPosture } from './ALRobotPosture';
import { MotionEngine } from './engine';

export class Session {
  readonly engine: MotionEngine;
  private readonly services: Record<string, object>;

  constructor(state: RobotState) {
    this.engine = new MotionEngine(state);
    const motion = new ALMotion(this.engine, state);
    const posture = new ALRobotPosture(this.engine, state, motion);
    motion.goToPosture = (name, speed) => posture.goToPosture(name, speed);
    this.services = { ALMotion: motion, ALRobotPosture: posture };
  }

  service(name: 'ALMotion'): ALMotion;
  service(name: 'ALRobotPosture'): ALRobotPosture;
  service(name: string): object;
  service(name: string): object {
    const s = this.services[name];
    if (!s) throw new Error(`Cannot find service '${name}' in index`);
    return s;
  }

  services_list(): string[] {
    return Object.keys(this.services);
  }

  /** Avanza el motor de movimiento: llamar en cada frame */
  update(dt: number): void {
    this.engine.update(dt);
  }
}
