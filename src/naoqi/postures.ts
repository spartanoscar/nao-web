// Posturas predefinidas del NAO. Valores articulares de qiBullet (SoftBank Robotics, Apache-2.0),
// extraídos con scripts/extract-postures.py → reference/qibullet/nao_postures.json.
// Lista y familias: reference/naoqi-2.8-api/naoqi_motion_alrobotposture.md

import postureData from '../../reference/qibullet/nao_postures.json';
import { CHAINS, COUPLED, JOINTS } from '../robot/naoV6';
import type { BodySupport, RobotState } from '../robot/state';
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

export const POSTURE_FAMILIES = [...new Set(Object.values(FAMILY))];

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
export function nearestPosture(state: RobotState): { name: PostureName; error: number } {
  let best: { name: PostureName; error: number } = { name: 'Crouch', error: Infinity };
  const pitch = torsoPitch(state);
  for (const name of POSTURE_NAMES) {
    // Con física la inclinación real no es la sugerida: de pie el torso se inclina lo justo para
    // que los pies queden planos, y sentado se reclina. Solo distingue de pie / sentado / acostado.
    const pitchError = Math.abs(pitch - SUPPORT[name].pitch);
    const tolerance = state.root ? (familyOf(name) === 'Sitting' ? 0.8 : 0.4) : 0;
    let error = Math.max(0, pitchError - tolerance);
    for (const { name: joint } of JOINTS) {
      if (joint.endsWith('Hand')) continue;
      error = Math.max(error, Math.abs(state.get(joint) - POSTURES[name][joint]));
    }
    if (error < best.error) best = { name, error };
  }
  return best;
}

export function familyOf(name: PostureName): string {
  return FAMILY[name];
}

/** Inclinación del torso (rad, + hacia delante): de la física (IMU) o del apoyo cinemático */
function torsoPitch(state: RobotState): number {
  const root = state.root;
  if (!root) return state.body.pitch;
  const [w, x, y, z] = root.quaternion;
  // Eje Z del torso en el mundo: R·(0,0,1)
  const zx = 2 * (x * z + w * y);
  const zz = 1 - 2 * (x * x + y * y);
  return Math.atan2(zx, zz);
}

// ─── Camino entre posturas (con física) ─────────────────────────────────────────
// "The robot detects in which posture it is, computes a path from its current posture to its target
// posture, and applies it." El planificador real es código cerrado. APPROX: grafo de tramos
// validados uno a uno en la simulación física (el robot llega sin caerse); se recorre el camino
// más corto. Si no hay camino, goToPosture devuelve false (como NAOqi cuando no logra la postura).

export type RouteStep = { posture: PostureName; part: BodyPart } | { animation: string };

const all = (posture: PostureName): RouteStep => ({ posture, part: 'all' });

const EDGES: [PostureName, PostureName, RouteStep[]][] = [
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
  ['SitRelax', 'Sit', [all('Sit')]],
  ['Sit', 'SitRelax', [all('SitRelax')]],
  ['SitRelax', 'LyingBack', [all('LyingBack')]],
  // Levantarse boca abajo: animación de Webots (reference/motions, diseñada para física)
  ['LyingBelly', 'StandInit', [{ animation: 'StandUpFromFront' }, all('StandInit')]],
];

/** Camino más corto (BFS) como lista de pasos, o null si no hay tramos validados que lleguen */
export function planRoute(from: PostureName, to: PostureName): RouteStep[] | null {
  if (from === to) return [all(to)];
  const prev = new Map<PostureName, [PostureName, RouteStep[]]>();
  const queue: PostureName[] = [from];
  while (queue.length) {
    const node = queue.shift()!;
    for (const [a, b, steps] of EDGES) {
      if (a !== node || b === from || prev.has(b)) continue;
      prev.set(b, [a, steps]);
      if (b === to) {
        const route: RouteStep[] = [];
        for (let n: PostureName = to; n !== from; n = prev.get(n)![0]) route.unshift(...prev.get(n)![1]);
        return route;
      }
      queue.push(b);
    }
  }
  return null;
}

/**
 * Postura de partida según el sensor inercial: acostado se decide por la orientación del torso
 * (boca arriba / boca abajo) aunque los brazos y piernas estén en cualquier posición.
 */
export function startingPosture(state: RobotState): PostureName {
  const pitch = torsoPitch(state);
  if (state.root && pitch < -1) return 'LyingBack';
  if (state.root && pitch > 1) return 'LyingBelly';
  return nearestPosture(state).name;
}
