// Posturas predefinidas del NAO. Valores articulares de qiBullet (SoftBank Robotics, Apache-2.0),
// extraídos con scripts/extract-postures.py → reference/qibullet/nao_postures.json: poses de partida (arranque en
// Crouch, bancos) y familia de postura por la IMU. goToPosture recorre el grafo real de NAOqi (naoqiPostureGraph.ts).
// Lista y familias: reference/naoqi-2.8-api/naoqi_motion_alrobotposture.md

import postureData from '../../reference/qibullet/nao_postures.json';
import { CHAINS, JOINTS } from '../robot/naoV6';
import type { RobotState } from '../robot/state';

export type PostureName = keyof typeof postureData;

const POSTURES: Readonly<Record<PostureName, Readonly<Record<string, number>>>> = postureData;

export const POSTURE_NAMES = Object.keys(POSTURES) as PostureName[];

const FAMILY: Record<PostureName, string> = {
  Stand: 'Standing',
  StandInit: 'Standing',
  StandZero: 'Standing',
  Crouch: 'Crouching',
  Sit: 'Sitting',
  SitRelax: 'Sitting',
  LyingBelly: 'LyingBelly',
  LyingBack: 'LyingBack',
};

/** Acostado de lado: familias de la doc sin postura predefinida (solo se sale de ellas rodando) */
export type SideFamily = 'LyingLeft' | 'LyingRight';
export type LyingFamily = 'LyingBelly' | 'LyingBack' | SideFamily;

export const POSTURE_FAMILIES = [...new Set(Object.values(FAMILY)), 'LyingLeft', 'LyingRight'];

/** Por debajo de este error (rad) se considera que el robot está en la postura. APPROX. */
export const IN_POSTURE = 0.1;
/** Por debajo de este error se considera de la misma familia. APPROX. */
export const IN_FAMILY = 0.5;
/** Más inclinado que esto respecto a la vertical, el torso está acostado. APPROX. */
const LYING_TILT = (60 * Math.PI) / 180;

/** Inclinación del torso (rad, + adelante) en cada postura. APPROX: con física de pie se inclina lo justo para que los
 * pies queden planos y sentado se reclina; solo distingue de pie / sentado / acostado. */
const PITCH: Record<PostureName, number> = {
  Stand: 0,
  StandInit: 0,
  StandZero: 0,
  Crouch: 0,
  Sit: 0,
  SitRelax: -0.4,
  LyingBelly: Math.PI / 2,
  LyingBack: -Math.PI / 2,
};

/** Nombre canónico (acepta mayúsculas/minúsculas distintas, como qiBullet) */
export function findPosture(name: string): PostureName | undefined {
  return POSTURE_NAMES.find((p) => p.toLowerCase() === String(name).toLowerCase());
}

export function postureJoints(name: PostureName): Readonly<Record<string, number>> {
  return POSTURES[name];
}

/** Joints que definen la familia (doc alrobotposture: apoyo del peso, torso y piernas; brazos y cabeza no cuentan) */
const FAMILY_JOINTS = new Set([...CHAINS.LLeg, ...CHAINS.RLeg]);

/**
 * Postura más cercana al estado actual. APPROX: ALRobotPosture usa joints + sensor inercial; aquí el error máximo
 * articular (sin manos) y la orientación del cuerpo. `legsOnly`: compara solo las piernas (para la familia: con los
 * brazos al frente sigue "Standing").
 */
export function nearestPosture(state: RobotState, legsOnly = false): { name: PostureName; error: number } {
  let best: { name: PostureName; error: number } = { name: 'Crouch', error: Infinity };
  const g = gravityInTorso(state);
  for (const name of POSTURE_NAMES) {
    // Error = ángulo entre la gravedad medida y la esperada (inclinación hacia delante, sin alabeo): de lado no se
    // parece a ninguna postura aunque las articulaciones coincidan
    const p = PITCH[name];
    const tilt = g ? Math.acos(Math.min(1, Math.max(-1, g[0] * Math.sin(p) - g[2] * Math.cos(p)))) : 0;
    let error = Math.max(0, tilt - (familyOf(name) === 'Sitting' ? 0.8 : 0.4));
    for (const { name: joint } of JOINTS) {
      if (joint.endsWith('Hand') || (legsOnly && !FAMILY_JOINTS.has(joint))) continue;
      error = Math.max(error, Math.abs(state.get(joint) - POSTURES[name][joint]));
    }
    if (error < best.error) best = { name, error };
  }
  return best;
}

export function familyOf(name: PostureName): string {
  return FAMILY[name];
}

/**
 * Gravedad en el marco del torso, como la mide la IMU (vector unitario; X adelante, Y izquierda, Z arriba):
 * no depende de hacia dónde mire el robot. null antes de que arranque la física.
 */
export function gravityInTorso(state: RobotState): [number, number, number] | null {
  const root = state.root;
  if (!root) return null;
  const [w, x, y, z] = root.quaternion;
  // Rᵀ·(0,0,−1) = −(tercera fila de R)
  return [2 * (w * y - x * z), -2 * (y * z + w * x), -(1 - 2 * (x * x + y * y))];
}

/**
 * Acostado según la IMU (torso a más de 60° de la vertical): la cara del torso que mira al suelo da la
 * familia de la doc. LyingLeft = apoyado en su costado izquierdo ("facing to its right side").
 */
export function lyingFamily(state: RobotState): LyingFamily | null {
  const g = gravityInTorso(state);
  if (!g || -g[2] > Math.cos(LYING_TILT)) return null;
  if (Math.abs(g[0]) >= Math.abs(g[1])) return g[0] > 0 ? 'LyingBelly' : 'LyingBack';
  return g[1] > 0 ? 'LyingLeft' : 'LyingRight';
}

/**
 * Familia actual: acostado por la IMU; si no, la de la postura más cercana por las piernas y el torso, o "Unknown".
 * Doc: "Standing: the weight is supported by the feet, the torso is upright and the legs are straight" (los brazos
 * pueden estar en cualquier pose).
 */
export function postureFamily(state: RobotState): string {
  const lying = lyingFamily(state);
  if (lying) return lying;
  const { name, error } = nearestPosture(state, true);
  return error < IN_FAMILY ? familyOf(name) : 'Unknown';
}
