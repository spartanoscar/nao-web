// ALRobotPosture: posturas predefinidas. Misma firma que NAOqi 2.8.
// Docs: reference/naoqi-2.8-api/naoqi_motion_alrobotposture-api.md

import type { RobotState } from '../robot/state';
import type { MotionEngine, MotionTask } from './engine';
import type { ALMotion } from './ALMotion';
import { MOTIONS, playMotion } from './motionFile';
import {
  POSTURE_FAMILIES,
  POSTURE_NAMES,
  type RouteStep,
  familyOf,
  findPosture,
  moveToPosture,
  nearestPosture,
  planRoute,
  startingPosture,
} from './postures';

/** Por debajo de este error (rad) se considera que el robot está en la postura. APPROX. */
const IN_POSTURE = 0.1;
/** Por debajo de este error se considera de la misma familia. APPROX. */
const IN_FAMILY = 0.5;

interface Run {
  cancelled: boolean;
  task: MotionTask | null;
}

export class ALRobotPosture {
  private current: Run | null = null;
  /** Motivo del último goToPosture fallido (para la UI y la consola) */
  lastFailure = '';

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
    const { name, error } = nearestPosture(this.state);
    return error < IN_FAMILY ? familyOf(name) : 'Unknown';
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

    let route: RouteStep[] | null = [{ posture: name, part: 'all' }];
    if (this.engine.physical) {
      const from = startingPosture(this.state);
      route = planRoute(from, name);
      if (!route) {
        this.lastFailure = `sin camino validado de ${from} a ${name} (pendiente en el simulador)`;
        this.current = null;
        return false;
      }
    }

    for (const step of route) {
      if (run.cancelled) return false;
      if ('animation' in step) {
        const clip = MOTIONS.find((m) => m.name === step.animation);
        if (clip) await playMotion(this.motion, clip);
      } else {
        run.task = moveToPosture(this.engine, step.posture, speed, step.part);
        await run.task.done;
      }
    }
    if (run.cancelled) return false;
    this.current = null;
    const reached = nearestPosture(this.state).name === name;
    if (!reached) this.lastFailure = `terminó en ${this.getPosture()} en vez de ${name}`;
    return reached;
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

  /** Sin efecto en el simulador: no hay reintentos porque la postura no puede fallar */
  setMaxTryNumber(maxTryNumber: number): void {
    void maxTryNumber;
  }
}
