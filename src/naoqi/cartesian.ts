// Control cartesiano de los brazos para ALMotion.setPositions/positionInterpolations (solo posición, axisMask 7).
// Doc: reference/naoqi-2.8-api/naoqi_motion_control-cartesian-api.md
// APPROX: el solver de NAOqi es cerrado. Aquí: cinemática inversa numérica (mínimos cuadrados amortiguados con
// jacobiano por diferencias) sobre ShoulderPitch, ShoulderRoll, ElbowYaw y ElbowRoll, dentro de los límites del URDF.
// WristYaw no mueve la mano más de ~1 cm y se deja como está. Si el punto no se alcanza, queda lo más cerca posible.

import { type Mat4, type Kinematics, multiply } from '../robot/kinematics';
import { JOINT_BY_NAME } from '../robot/naoV6';

const ARM_JOINTS = ['ShoulderPitch', 'ShoulderRoll', 'ElbowYaw', 'ElbowRoll'];
const ITERATIONS = 80;
const DAMPING = 0.01;
const STEP = 1e-4;
const TOLERANCE = 0.002; // m

export interface ArmSolution {
  /** Ángulos objetivo de los 4 joints del brazo */
  angles: Record<string, number>;
  /** Distancia que queda entre la mano y el punto pedido (m) */
  error: number;
}

/**
 * Ángulos para que la mano de `chain` llegue a `target` (en el frame cuyo `frameFromTorso` se da). `angle` da los
 * ángulos actuales (semilla y joints que no se tocan).
 */
export function solveArm(
  kin: Kinematics,
  chain: 'LArm' | 'RArm',
  frameFromTorso: Mat4,
  target: readonly number[],
  angle: (joint: string) => number,
): ArmSolution {
  const side = chain[0];
  const names = ARM_JOINTS.map((j) => side + j);
  const limits = names.map((n) => JOINT_BY_NAME.get(n)!);
  const effector = chain === 'LArm' ? 'l_gripper' : 'r_gripper';
  const hand = (q: number[]) => {
    const m = multiply(frameFromTorso, kin.linkInTorso(effector, (j) => {
      const i = names.indexOf(j);
      return i >= 0 ? q[i] : angle(j);
    }));
    return [m[3], m[7], m[11]];
  };
  const clamp = (q: number[]) => q.map((v, i) => Math.min(Math.max(v, limits[i].min), limits[i].max));
  const residual = (q: number[]) => hand(q).map((v, i) => target[i] - v);
  const norm = (v: number[]) => Math.hypot(...v);

  // Semillas: la pose actual y un brazo al frente con el codo casi recto (evita mínimos locales con el codo doblado)
  const mirror = side === 'R' ? -1 : 1;
  const seeds = [names.map((n) => angle(n)), clamp([0, 0.1 * mirror, -1.39 * mirror, -0.3 * mirror])];
  let best: { q: number[]; error: number } = { q: seeds[0], error: Infinity };
  for (const seed of seeds) {
    let q = clamp(seed);
    for (let it = 0; it < ITERATIONS; it++) {
      const r = residual(q);
      if (norm(r) < TOLERANCE) break;
      // Jacobiano 3×4 por diferencias
      const p0 = hand(q);
      const J = q.map((_, k) => {
        const dq = [...q];
        dq[k] += STEP;
        return hand(dq).map((v, i) => (v - p0[i]) / STEP);
      }); // J[k] = columna k
      // Δq = Jᵀ (J Jᵀ + λ²I)⁻¹ r
      const A = [0, 1, 2].map((i) => [0, 1, 2].map((j) => J.reduce((s, col) => s + col[i] * col[j], 0) + (i === j ? DAMPING ** 2 : 0)));
      const y = solve3(A, r);
      q = clamp(q.map((v, k) => v + J[k].reduce((s, c, i) => s + c * y[i], 0)));
    }
    const error = norm(residual(q));
    if (error < best.error) best = { q, error };
  }
  return { angles: Object.fromEntries(names.map((n, i) => [n, best.q[i]])), error: best.error };
}

/** Resuelve A·x = b (3×3) por Cramer */
function solve3(A: number[][], b: number[]): number[] {
  const det = (m: number[][]) =>
    m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1]) - m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0]) + m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0]);
  const d = det(A) || 1e-12;
  return [0, 1, 2].map((c) => det(A.map((row, i) => row.map((v, j) => (j === c ? b[i] : v)))) / d);
}
