// Sesión estilo qi (NAOqi 2.x): `session.service("ALMotion")` devuelve el servicio.
// Es el punto de entrada que usarán la consola, los scripts Python (F4) y la IA (F6).

import { LedState } from '../robot/leds';
import type { RobotState } from '../robot/state';
import { ALLeds } from './ALLeds';
import { ALMotion } from './ALMotion';
import { ALRobotPosture } from './ALRobotPosture';
import { ALTextToSpeech } from './ALTextToSpeech';
import { ALVideoDevice } from './ALVideoDevice';
import { MotionEngine } from './engine';

export class Session {
  readonly engine: MotionEngine;
  /** Intensidad de los 89 canales de LED (la lee la escena) */
  readonly leds = new LedState();
  private readonly ledService: ALLeds;
  private readonly services: Record<string, object>;

  constructor(state: RobotState) {
    this.engine = new MotionEngine(state);
    const motion = new ALMotion(this.engine, state);
    const posture = new ALRobotPosture(this.engine, state, motion);
    motion.goToPosture = (name, speed) => posture.goToPosture(name, speed);
    this.ledService = new ALLeds(this.leds);
    this.services = {
      ALMotion: motion, ALRobotPosture: posture, ALLeds: this.ledService, ALTextToSpeech: new ALTextToSpeech(),
      ALVideoDevice: new ALVideoDevice(),
    };
  }

  service(name: 'ALMotion'): ALMotion;
  service(name: 'ALRobotPosture'): ALRobotPosture;
  service(name: 'ALLeds'): ALLeds;
  service(name: 'ALTextToSpeech'): ALTextToSpeech;
  service(name: 'ALVideoDevice'): ALVideoDevice;
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
    this.ledService.update(dt);
  }
}
