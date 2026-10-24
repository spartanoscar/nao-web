// ALRobotPosture: posturas predefinidas. Misma firma que NAOqi 2.8.
// Docs: reference/naoqi-2.8-api/naoqi_motion_alrobotposture-api.md
// goToPosture recorre el grafo de posturas real de NAOqi 2.8 (naoqiPostureGraph.ts, scripts/fetch-naoqi-postures.sh).

import type { RobotState } from '../robot/state';
import type { ALMotion } from './ALMotion';
import { hasPostureGraph, nearestNamedPosture, planGraphRoute, playGraphRoute, startingGraphPosture } from './naoqiPostureGraph';
import { IN_FAMILY, IN_POSTURE, POSTURE_FAMILIES, POSTURE_NAMES, findPosture, nearestPosture, postureFamily } from './postures';

export class ALRobotPosture {
  /** La orden en curso: otra (o stopMove) la marca cancelada */
  private current: { cancelled: boolean } | null = null;
  /** Motivo del último goToPosture fallido (para la UI y la consola) */
  lastFailure = '';
  private maxTries = 3;

  constructor(
    private readonly state: RobotState,
    private readonly motion: ALMotion,
  ) {}

  getPostureList(): string[] {
    return [...POSTURE_NAMES];
  }

  /** Postura actual, o "Unknown" si el robot no está en ninguna predefinida */
  getPosture(): string {
    const { name, error } = this.nearest();
    return error < IN_POSTURE ? name : 'Unknown';
  }

  /** Postura predefinida más cercana, contra los valores de NAOqi (los de qiBullet hasta que carga el grafo) */
  private nearest(): { name: string; error: number } {
    return nearestNamedPosture(this.state) ?? nearestPosture(this.state);
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
   */
  async goToPosture(postureName: string, speed: number): Promise<boolean> {
    const name = findPosture(postureName);
    this.lastFailure = '';
    if (!name) {
      this.lastFailure = `postura desconocida "${postureName}"`;
      return false;
    }
    if (!hasPostureGraph()) {
      this.lastFailure = 'falta el grafo de posturas de NAOqi (scripts/fetch-naoqi-postures.sh)';
      return false;
    }
    // APPROX: en el robot real una postura con los motores apagados no se ejecuta; aquí se encienden
    if (!this.motion.robotIsWakeUp()) this.motion.setStiffnesses('Body', 1);
    this.stopMove();
    const run = { cancelled: false };
    this.current = run;

    // "Sets the maximum number of tries performed by goToPosture before returning a fail": si la ruta deja al robot
    // en otra postura (p. ej. se cayó), se vuelve a detectar y a planear desde ahí
    for (let attempt = 0; attempt < this.maxTries; attempt++) {
      const from = startingGraphPosture(this.state)!;
      const route = planGraphRoute(from.id, name);
      if (!route) {
        this.lastFailure = `el grafo de NAOqi no tiene camino de la postura ${from.id} a ${name}`;
        break;
      }
      await playGraphRoute(this.motion, this.state, route, speed);
      if (run.cancelled) return false;
      const { name: nearest, error } = this.nearest();
      if (nearest === name && error < IN_FAMILY) {
        this.current = null;
        return true;
      }
      this.lastFailure = `terminó en ${this.getPosture()} (${postureFamily(this.state)}) en vez de ${name}`;
    }
    this.current = null;
    return false;
  }

  /** "A shortcut to reach the posture quickly when manipulating the robot". Igual que goToPosture aquí. */
  applyPosture(postureName: string, speed: number): Promise<boolean> {
    return this.goToPosture(postureName, speed);
  }

  stopMove(): void {
    if (this.current) this.current.cancelled = true;
    this.current = null;
  }

  /** "number of tries, default value: 3" */
  setMaxTryNumber(maxTryNumber: number): void {
    this.maxTries = Math.max(1, Math.floor(maxTryNumber));
  }
}
