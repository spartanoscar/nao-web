// ALRobotPosture: posturas predefinidas. Misma firma que NAOqi 2.8.
// Docs: reference/naoqi-2.8-api/naoqi_motion_alrobotposture-api.md

import type { RobotState } from '../robot/state';
import type { MotionEngine, MotionTask } from './engine';
import type { ALMotion } from './ALMotion';
import { POSTURE_FAMILIES, POSTURE_NAMES, familyOf, findPosture, moveToPosture, nearestPosture } from './postures';

/** Por debajo de este error (rad) se considera que el robot está en la postura. APPROX. */
const IN_POSTURE = 0.1;
/** Por debajo de este error se considera de la misma familia. APPROX. */
const IN_FAMILY = 0.5;

export class ALRobotPosture {
  private current: MotionTask | null = null;

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
   * APPROX: sin planificador de caminos (p. ej. levantarse del suelo) — interpola directo.
   */
  async goToPosture(postureName: string, speed: number): Promise<boolean> {
    const name = findPosture(postureName);
    if (!name) return false;
    // APPROX: en el robot real una postura con los motores apagados no se ejecuta; aquí se encienden
    if (!this.motion.robotIsWakeUp()) await this.motion.setStiffnesses('Body', 1);
    this.current?.cancel();
    const task = moveToPosture(this.engine, name, speed);
    this.current = task;
    await task.done;
    if (this.current !== task) return false; // lo interrumpió stopMove u otra postura
    this.current = null;
    return nearestPosture(this.state).name === name;
  }

  /** "A shortcut to reach the posture quickly when manipulating the robot". Igual que goToPosture aquí. */
  applyPosture(postureName: string, speed: number): Promise<boolean> {
    return this.goToPosture(postureName, speed);
  }

  stopMove(): void {
    const task = this.current;
    this.current = null;
    task?.cancel();
  }

  /** Sin efecto en el simulador: no hay reintentos porque la postura no puede fallar */
  setMaxTryNumber(maxTryNumber: number): void {
    void maxTryNumber;
  }
}
