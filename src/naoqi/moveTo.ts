// ALMotion.moveTo: ir a una pose del plano del suelo, relativa a FRAME_ROBOT (bloqueante).
// Doc: reference/naoqi-2.8-api/naoqi_motion_control-walk-api.md
// APPROX: el walk engine real planea una trayectoria omnidireccional. Aquí la marcha solo ejecuta una componente
// a la vez (walk.ts), así que se navega en lazo cerrado sobre la pose medida del torso (odometría por sensores):
// girar hacia el punto → avanzar corrigiendo el rumbo → girar al ángulo final. Distancias cortas de lado o hacia
// atrás se hacen sin girar. Cada decisión de la marcha se aplica en el siguiente paso (medio ciclo), por eso las
// tolerancias: ≤ 8 cm de posición y ≲ 11° de ángulo (medido con scripts/bench/walk.js; 1 m en ~14 s).
// Cambiar de tipo de paso en plena marcha lo tumba: entre uno y otro se detiene en la pose de marcha.

import type { RobotState } from '../robot/state';
import type { MotionEngine } from './engine';
import type { Velocity } from './walk';

export interface Pose2D {
  x: number;
  y: number;
  theta: number;
}

/** Cada cuánto se revisa la pose (s de reloj del motor) */
const TICK = 0.1;
/** Se deja de avanzar a esta distancia: el paso en curso y el frenado recorren ~4 cm más */
const STOP_DISTANCE = 0.07;
/** Tolerancia de los pasos lentos (lateral, atrás) */
const FINE_DISTANCE = 0.03;
/** Se deja de girar a este error: medio ciclo de giro son ~14° */
const STOP_ANGLE = 0.16;
/** Avanzando, se corrige el rumbo si se desvía más que esto (histéresis con STOP_ANGLE) */
const STEER_ANGLE = 0.35;
/** Avanzando, se tolera pasar a esta distancia lateral de la meta sin girar (m) */
const MISS_DISTANCE = 0.1;
/** Metas cercanas de lado (m): paso lateral en vez de girar */
const SIDESTEP_RANGE = 0.25;
/** Metas cercanas detrás (m): marcha atrás en vez de dar media vuelta */
const BACKWARD_RANGE = 0.35;
const FALLEN_TILT = 0.8;

export const wrapAngle = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));

/** Pose del robot en el suelo desde la pose del torso de la física ([x, y, rumbo]) */
export function robotPose(state: RobotState): Pose2D | null {
  const root = state.root;
  if (!root) return null;
  const [w, x, y, z] = root.quaternion;
  return { x: root.position[0], y: root.position[1], theta: Math.atan2(2 * (w * z + x * y), 1 - 2 * (y * y + z * z)) };
}

interface GaitControl {
  setVelocity(v: Velocity): void;
  stop(): Promise<void>;
}

/**
 * Lleva al robot a (x, y, theta) relativo a su pose actual. Devuelve false si se interrumpe (`cancelled`), si se
 * cae o si no llega a tiempo; true al terminar.
 */
export async function moveToPose(
  engine: MotionEngine,
  state: RobotState,
  gait: GaitControl,
  x: number,
  y: number,
  theta: number,
  cancelled: () => boolean,
): Promise<boolean> {
  const start = robotPose(state);
  if (!start) return false;
  const [c, s] = [Math.cos(start.theta), Math.sin(start.theta)];
  const target = { x: start.x + c * x - s * y, y: start.y + s * x + c * y };
  const heading = start.theta + theta;
  // Holgado: ~5 cm/s avanzando, ~15°/s girando, más entrar y frenar
  const deadline = engine.time + 8 + Math.hypot(x, y) / 0.04 + (Math.abs(theta) + Math.PI) / 0.2;
  const tick = () => new Promise<void>((r) => engine.schedule(engine.time + TICK, r));
  const fallen = () => {
    const [, qx, qy] = state.root!.quaternion;
    return Math.acos(Math.min(1, 1 - 2 * (qx * qx + qy * qy))) > FALLEN_TILT;
  };
  const abort = async () => {
    if (!cancelled()) await gait.stop();
    return false;
  };

  // Cambiar de tipo de paso (o de sentido) en plena marcha lo tumba (medido): antes se detiene en la pose de marcha
  let current = '';
  const drive = async (v: Velocity) => {
    const key = `${v.x},${v.y},${v.theta}`;
    if (current && key !== current) await gait.stop();
    current = key;
    if (!cancelled()) gait.setVelocity(v);
  };

  // 1. Hasta el punto
  let mode: 'forward' | 'turn' | 'side' | 'back' | null = null;
  for (;;) {
    if (cancelled() || fallen() || engine.time > deadline) return abort();
    const p = robotPose(state)!;
    const [dx, dy] = [target.x - p.x, target.y - p.y];
    const dist = Math.hypot(dx, dy);
    // De lado y hacia atrás va lento y sin pasarse: tolerancia más fina
    if (dist < (mode === 'side' || mode === 'back' ? FINE_DISTANCE : STOP_DISTANCE)) break;
    const bearing = wrapAngle(Math.atan2(dy, dx) - p.theta);
    const [ahead, side] = [Math.cos(bearing) * dist, Math.sin(bearing) * dist];
    // Atrás o de lado solo para metas cercanas y si aún no empezó a girar o avanzar
    const near = mode !== 'forward' && mode !== 'turn';
    if (near && dist < BACKWARD_RANGE && ahead < -Math.abs(side)) mode = 'back';
    else if (near && dist < SIDESTEP_RANGE && Math.abs(side) > Math.abs(ahead)) mode = 'side';
    else if (mode === 'forward') {
      // Avanzando, el torso se balancea ±3 cm por paso: solo se corrige si de verdad pasaría lejos de la meta
      if (ahead <= 0 && dist < STOP_DISTANCE * 2) break; // se pasó por poco: ya llegó
      if (ahead <= 0 || (Math.abs(bearing) > STEER_ANGLE && Math.abs(side) > MISS_DISTANCE)) mode = 'turn';
    } else mode = Math.abs(bearing) > STOP_ANGLE ? 'turn' : 'forward';
    await drive(
      mode === 'forward' ? { x: 1, y: 0, theta: 0 }
        : mode === 'back' ? { x: -1, y: 0, theta: 0 }
          : mode === 'side' ? { x: 0, y: Math.sign(side), theta: 0 }
            : { x: 0, y: 0, theta: Math.sign(bearing) },
    );
    await tick();
  }

  // 2. Al ángulo final
  for (;;) {
    if (cancelled() || fallen() || engine.time > deadline) return abort();
    const error = wrapAngle(heading - robotPose(state)!.theta);
    if (Math.abs(error) < STOP_ANGLE) break;
    await drive({ x: 0, y: 0, theta: Math.sign(error) });
    await tick();
  }
  await gait.stop();
  return !cancelled() && !fallen();
}
