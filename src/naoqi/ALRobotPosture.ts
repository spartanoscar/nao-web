// ALRobotPosture: posturas predefinidas. Misma firma que NAOqi 2.8.
// Docs: reference/naoqi-2.8-api/naoqi_motion_alrobotposture-api.md

import type { RobotState } from '../robot/state';
import type { MotionEngine, MotionTask } from './engine';
import type { ALMotion } from './ALMotion';
import { MOTIONS, playMotion } from './motionFile';
import { MOTION_NETS, playMotionNet, sliceMotionNet } from './motionNet';
import { TAUGHT_MOTIONS, playTaught } from './taughtMotion';
import {
  IN_FAMILY,
  IN_POSTURE,
  POSTURE_FAMILIES,
  POSTURE_NAMES,
  type RouteStep,
  findPosture,
  moveToPosture,
  nearestPosture,
  planRoute,
  postureFamily,
  startingPosture,
} from './postures';

interface Run {
  cancelled: boolean;
  task: MotionTask | null;
}

export class ALRobotPosture {
  private current: Run | null = null;
  /** Motivo del último goToPosture fallido (para la UI y la consola) */
  lastFailure = '';
  private maxTries = 3;

  constructor(
    private readonly engine: MotionEngine,
    private readonly state: RobotState,
    private readonly motion: ALMotion,
  ) {}

  getPostureList(): string[] {
    return [...POSTURE_NAMES];
  }

  /** Postura actual, o "Unknown" si el robot no está en ninguna predefinida */
  getPosture(): string {
    const { name, error } = nearestPosture(this.state);
    return error < IN_POSTURE ? name : 'Unknown';
  }

  getPostureFamily(): string {
    return postureFamily(this.state);
  }

  getPostureFamilyList(): string[] {
    return [...POSTURE_FAMILIES];
  }

  /**
   * Blocking. "The robot detects in which posture it is, computes a path from its current posture
   * to its target posture, and applies it." Devuelve true si la alcanzó.
   * Con física sigue el grafo de tramos validados (postures.ts); sin física interpola directo.
   */
  async goToPosture(postureName: string, speed: number): Promise<boolean> {
    const name = findPosture(postureName);
    this.lastFailure = '';
    if (!name) {
      this.lastFailure = `postura desconocida "${postureName}"`;
      return false;
    }
    // APPROX: en el robot real una postura con los motores apagados no se ejecuta; aquí se encienden
    if (!this.motion.robotIsWakeUp()) this.motion.setStiffnesses('Body', 1);
    this.stopMove();
    const run: Run = { cancelled: false, task: null };
    this.current = run;

    // "Sets the maximum number of tries performed by goToPosture before returning a fail": si una rutina
    // deja al robot en otra postura (p. ej. rodó boca abajo), se vuelve a detectar y a planear desde ahí
    for (let attempt = 0; attempt < this.maxTries; attempt++) {
      let route: RouteStep[] | null = [{ posture: name, part: 'all' }];
      if (this.engine.physical) {
        const from = startingPosture(this.state);
        route = planRoute(from, name);
        if (!route) {
          this.lastFailure = `sin camino validado de ${from} a ${name} (pendiente en el simulador)`;
          break;
        }
      }
      for (const step of route) {
        if (run.cancelled) return false;
        await this.runStep(step, speed, run);
      }
      if (run.cancelled) return false;
      const { name: nearest, error } = nearestPosture(this.state);
      if (nearest === name && error < IN_FAMILY) {
        this.current = null;
        this.lastFailure = '';
        return true;
      }
      this.lastFailure = `terminó en ${this.getPosture()} (${postureFamily(this.state)}) en vez de ${name}`;
      if (!this.engine.physical) break;
    }
    this.current = null;
    return false;
  }

  private async runStep(step: RouteStep, speed: number, run: Run): Promise<void> {
    if ('animation' in step) {
      const clip = MOTIONS.find((m) => m.name === step.animation);
      if (clip) await playMotion(this.motion, clip);
    } else if ('net' in step) {
      const net = MOTION_NETS.find((m) => m.name === step.net);
      if (net) await playMotionNet(this.engine, this.motion, step.frames ? sliceMotionNet(net, step.frames) : net);
    } else if ('taught' in step) {
      const taught = TAUGHT_MOTIONS.find((m) => m.name === step.taught);
      if (taught) await playTaught(this.motion, taught);
    } else if ('wait' in step) {
      // En el reloj del motor (el de la simulación), no en el de la pestaña
      await new Promise<void>((resolve) => this.engine.schedule(this.engine.time + step.wait, resolve));
    } else {
      run.task = moveToPosture(this.engine, step.posture, speed, step.part);
      await run.task.done;
    }
  }

  /** "A shortcut to reach the posture quickly when manipulating the robot". Igual que goToPosture aquí. */
  applyPosture(postureName: string, speed: number): Promise<boolean> {
    return this.goToPosture(postureName, speed);
  }

  stopMove(): void {
    const run = this.current;
    this.current = null;
    if (!run) return;
    run.cancelled = true;
    run.task?.cancel();
  }

  /** "number of tries, default value: 3" */
  setMaxTryNumber(maxTryNumber: number): void {
    this.maxTries = Math.max(1, Math.floor(maxTryNumber));
  }
}
