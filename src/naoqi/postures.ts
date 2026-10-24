// Posturas predefinidas del NAO. Valores articulares de qiBullet (SoftBank Robotics, Apache-2.0),
// extraídos con scripts/extract-postures.py → reference/qibullet/nao_postures.json.
// Lista y familias: reference/naoqi-2.8-api/naoqi_motion_alrobotposture.md

import postureData from '../../reference/qibullet/nao_postures.json';
import { CHAINS, COUPLED, JOINTS } from '../robot/naoV6';
import type { BodySupport, RobotState } from '../robot/state';
import { hasAldebaranMotion } from './aldebaranMotions';
import { BODY_FOOT_SUPPORT, BODY_PITCH, type MotionEngine, type MotionTask } from './engine';

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

// APPROX: en el robot real la orientación del torso sale de la gravedad. De pie y agachado manda el
// pie plano en el suelo; sentado y acostado, el cuerpo reposa donde su centro de masa es más bajo
// cerca de esta inclinación sugerida (la calcula NaoModel con las masas del URDF).
const SUPPORT: Record<PostureName, BodySupport> = {
  Stand: { footSupport: 1, pitch: 0 },
  StandInit: { footSupport: 1, pitch: 0 },
  StandZero: { footSupport: 1, pitch: 0 },
  Crouch: { footSupport: 1, pitch: 0 },
  Sit: { footSupport: 0, pitch: 0 },
  SitRelax: { footSupport: 0, pitch: -0.4 },
  LyingBelly: { footSupport: 0, pitch: Math.PI / 2 },
  LyingBack: { footSupport: 0, pitch: -Math.PI / 2 },
};

/** Nombre canónico (acepta mayúsculas/minúsculas distintas, como qiBullet) */
export function findPosture(name: string): PostureName | undefined {
  return POSTURE_NAMES.find((p) => p.toLowerCase() === String(name).toLowerCase());
}

export function postureJoints(name: PostureName): Readonly<Record<string, number>> {
  return POSTURES[name];
}

export type BodyPart = 'all' | 'arms' | 'legs';

const PART_JOINTS: Record<BodyPart, ReadonlySet<string>> = {
  all: new Set(JOINTS.map((j) => j.name)),
  arms: new Set([...CHAINS.Head, ...CHAINS.LArm, ...CHAINS.RArm]),
  legs: new Set([...CHAINS.LLeg, ...CHAINS.RLeg]),
};

/**
 * Mueve el cuerpo (o solo brazos/piernas) a la postura, sincronizado, a una fracción de la
 * velocidad máxima.
 */
export function moveToPosture(engine: MotionEngine, name: PostureName, speed: number, part: BodyPart = 'all'): MotionTask {
  const support = SUPPORT[name];
  // RHipYawPitch es el mismo motor que LHipYawPitch: se comanda solo el izquierdo
  const joints = Object.fromEntries(
    Object.entries(POSTURES[name]).filter(([j]) => !(j in COUPLED) && PART_JOINTS[part].has(j)),
  );
  if (part !== 'all') return engine.interpolateWithSpeed(joints, speed, 1 / Math.min(Math.max(speed, 0.1), 1));
  // APPROX: las velocidades máximas del URDF son sin carga; el NAO real cambia de postura mucho más
  // despacio (~2 s de Crouch a StandInit a velocidad 0.5). Duración mínima = 1 s / speed.
  return engine.interpolateWithSpeed(
    { ...joints, [BODY_FOOT_SUPPORT]: support.footSupport, [BODY_PITCH]: support.pitch },
    speed,
    1 / Math.min(Math.max(speed, 0.1), 1),
  );
}

/**
 * Postura más cercana al estado actual. APPROX: ALRobotPosture usa joints + sensor inercial; aquí
 * el error máximo articular (sin manos) y la orientación del cuerpo.
 */
/** Joints que definen la familia (doc alrobotposture: apoyo del peso, torso y piernas; brazos y cabeza no cuentan) */
const FAMILY_JOINTS = new Set([...CHAINS.LLeg, ...CHAINS.RLeg]);

/** `legsOnly`: compara solo las piernas (para la familia: con los brazos al frente sigue "Standing") */
export function nearestPosture(state: RobotState, legsOnly = false): { name: PostureName; error: number } {
  let best: { name: PostureName; error: number } = { name: 'Crouch', error: Infinity };
  const g = gravityInTorso(state);
  for (const name of POSTURE_NAMES) {
    // Con física la inclinación real no es la sugerida: de pie el torso se inclina lo justo para
    // que los pies queden planos, y sentado se reclina. Solo distingue de pie / sentado / acostado.
    // Error = ángulo entre la gravedad medida y la esperada (inclinación hacia delante, sin alabeo):
    // de lado no se parece a ninguna postura aunque las articulaciones coincidan.
    const p = SUPPORT[name].pitch;
    const tilt = g ? Math.acos(Math.min(1, Math.max(-1, g[0] * Math.sin(p) - g[2] * Math.cos(p)))) : Math.abs(state.body.pitch - p);
    const tolerance = g ? (familyOf(name) === 'Sitting' ? 0.8 : 0.4) : 0;
    let error = Math.max(0, tilt - tolerance);
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
 * no depende de hacia dónde mire el robot. null sin física.
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

// ─── Camino entre posturas (con física) ─────────────────────────────────────────
// "The robot detects in which posture it is, computes a path from its current posture to its target
// posture, and applies it." El planificador real es código cerrado. APPROX: grafo de tramos
// validados uno a uno en la simulación física (el robot llega sin caerse); se recorre el camino
// más corto. Si no hay camino, goToPosture devuelve false (como NAOqi cuando no logra la postura).

export type RouteStep =
  | { posture: PostureName; part: BodyPart }
  | { animation: string }
  /** Motion net de NaoTH; `frames`: solo los primeros keyframes */
  | { net: string; frames?: number }
  /** Movimiento enseñado a mano con el grabador de poses (naoqi/taught/) */
  | { taught: string }
  /** Rutina original de Aldebaran (Choregraphe 1.x, naoqi/aldebaranMotions.ts); el tramo solo existe si se descargó */
  | { aldebaran: string }
  /** Pausa (s) para que el cuerpo se asiente antes del siguiente tramo */
  | { wait: number };
/** Nodos del grafo: las posturas predefinidas y los costados (de los que solo se sale rodando) */
export type RouteNode = PostureName | SideFamily;

const all = (posture: PostureName): RouteStep => ({ posture, part: 'all' });

const EDGES: [RouteNode, RouteNode, RouteStep[]][] = [
  ['Stand', 'StandInit', [all('StandInit')]],
  ['StandInit', 'Stand', [all('Stand')]],
  ['StandInit', 'StandZero', [all('StandZero')]],
  ['StandZero', 'StandInit', [all('StandInit')]],
  ['Stand', 'StandZero', [all('StandZero')]],
  ['StandZero', 'Stand', [all('Stand')]],
  ['StandInit', 'Crouch', [all('Crouch')]],
  ['Crouch', 'StandInit', [all('StandInit')]],
  // Sentarse: brazos atrás para apoyarse y luego dejarse caer sobre el trasero (como una persona)
  ['Crouch', 'SitRelax', [{ posture: 'SitRelax', part: 'arms' }, all('SitRelax')]],
  // Sentarse como el NAO real: la rutina original de Aldebaran (bajada del torso 0.13 m/s; el camino Crouch → SitRelax
  // → Sit "caía sentado" a 1.14 m/s y lo que encontró el laboratorio quedó en 0.53)
  ['Crouch', 'Sit', [{ aldebaran: 'CrouchToSitDown' }, { wait: 0.5 }]],
  ['SitRelax', 'Sit', [all('Sit')]],
  ['Sit', 'SitRelax', [all('SitRelax')]],
  ['SitRelax', 'LyingBack', [all('LyingBack')]],
  // Levantarse boca abajo: animación de Webots (reference/motions, diseñada para física)
  ['LyingBelly', 'StandInit', [{ animation: 'StandUpFromFront' }, all('StandInit')]],
  // De lado: la vuelta de la rutina de NaoTH (reference/naoth, sus 3 primeros keyframes) lo deja boca abajo
  // desde cualquiera de los dos costados; tras 1 s quieto sigue el levantamiento boca abajo, que ya funciona
  ['LyingLeft', 'LyingBelly', [{ net: 'stand_up_from_side', frames: 3 }, { wait: 1 }]],
  ['LyingRight', 'LyingBelly', [{ net: 'stand_up_from_side', frames: 3 }, { wait: 1 }]],
  // Boca arriba: vuelta hasta quedar boca abajo, enseñada a mano por Oscar con el grabador de poses
  // (naoqi/taught/RollBackToBelly.json); las rutinas de espaldas de NaoTH/rUNSWift no levantan el torso aquí
  ['LyingBack', 'LyingBelly', [{ taught: 'RollBackToBelly' }, { wait: 1 }]],
];

/** Camino más corto (BFS) como lista de pasos, o null si no hay tramos validados que lleguen */
export function planRoute(from: RouteNode, to: PostureName): RouteStep[] | null {
  if (from === to) return [all(to)];
  const prev = new Map<RouteNode, [RouteNode, RouteStep[]]>();
  const queue: RouteNode[] = [from];
  while (queue.length) {
    const node = queue.shift()!;
    for (const [a, b, steps] of EDGES) {
      if (a !== node || b === from || prev.has(b)) continue;
      if (steps.some((st) => 'aldebaran' in st && !hasAldebaranMotion(st.aldebaran))) continue;
      prev.set(b, [a, steps]);
      if (b === to) {
        const route: RouteStep[] = [];
        for (let n: RouteNode = to; n !== from; n = prev.get(n)![0]) route.unshift(...prev.get(n)![1]);
        return route;
      }
      queue.push(b);
    }
  }
  return null;
}

/**
 * Postura de partida según el sensor inercial: acostado se decide por la orientación del torso
 * (boca arriba, boca abajo o de lado) aunque los brazos y piernas estén en cualquier posición.
 */
export function startingPosture(state: RobotState): RouteNode {
  return lyingFamily(state) ?? nearestPosture(state).name;
}
