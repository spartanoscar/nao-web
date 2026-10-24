// El grafo de posturas real de NAOqi 2.8 (ALRobotPosture en el NAO V6): share/naoqi/robot_posture/postures_naoh25.xml de
// Choregraphe 2.8.7.4 (© Aldebaran), convertido a JSON por scripts/fetch-naoqi-postures.sh en public/motions/naoqi28/
// (fuera de git). 168 posturas: cada una con sus 26 ángulos, la inclinación del torso que midió la IMU del robot real
// (AngleX/AngleY), su familia y sus vecinas con costo y coeficiente de velocidad. Las 8 predefinidas son nodos con nombre
// (StandInit y StandZero idénticas a qiBullet). Doc alrobotposture: "The robot detects in which posture it is, computes
// a path from its current posture to its target posture, and applies it" → nodo más cercano, camino más barato con los
// costos del archivo y reproducción nodo a nodo con angleInterpolation. Ahí están las rutas que ninguna fuente abierta
// traía: levantarse desde sentado apoyando la mano derecha (familia "Right") e incorporarse desde boca arriba.
// Verificado (scripts/bench/naoqi28.js): la inclinación del torso sigue la del real nodo a nodo
// (sentado −22° contra −17°, apoyado en la mano −24° contra −20°, de pie 0° contra 2°).

import { JOINT_BY_NAME } from '../robot/naoV6';
import type { RobotState } from '../robot/state';
import type { ALMotion } from './ALMotion';
import { gravityInTorso } from './postures';

const URL = '/motions/naoqi28/postures-h25.json';

/**
 * APPROX: NAOqi no publica cuánto tarda cada tramo. Aquí el motor más exigido va a esta fracción de su velocidad
 * máxima (URDF) por la `speed` de goToPosture y el speedCoefficient del tramo. Calibrado con un video de un NAO real
 * levantándose de espaldas (youtube.com/watch?v=JZV9lItJGUo, 0–9 s): se incorpora a los ~3.0 s, queda sentado derecho a
 * los ~3.5 s y de pie hacia los 8–9 s; este modelo a 0.45 da 2.8, 3.8 y 6.7 s (se supone speed 1). Las rutinas 1.x de
 * Choregraphe (otra generación) iban más lentas (≈ 0.22 a speed 0.8).
 */
export const GRAPH_SPEED = 0.45;
/** Tramo mínimo (s) */
const MIN_STEP = 0.05;

/**
 * Duración (s) de los tramos para incorporarse desde boca arriba hasta quedar sentado (2000 → 1005, el comienzo de
 * LyingBack → StandInit), buscada en el laboratorio (scripts/bench/naoqi28-times.js: CMA-ES sobre los tiempos con las
 * posturas de NAOqi fijas; μ de la carcasa 0.4). Con el modelo de arriba se incorporaba pero se iba atrás al soltar los
 * brazos (solo salía en el filo de la velocidad): es un movimiento balístico (NAOqi marca esa cadena, 2002 → 2006, con
 * enableAntiCollision 0) y el real lo hace en ~0.5 s (video). Del nodo 1005 en adelante (la ruta de Sit → Stand) sigue
 * el modelo. Validado (2026-10-24) en 6 partidas (caídas de espaldas recta, en diagonal y de 40°, desde sentado,
 * colocado flojo) × tiempos ×0.9–×1.1: 18 de 18. Ritmo fijo, sin escalar por `speed` (como las líneas de tiempo de las
 * cajas originales): más lento no se incorpora. APPROX; sensible a la fricción (con μ 0.45 casi nunca sale).
 */
const TUNED_STEPS: Readonly<Record<string, number>> = {
  '2000>2001': 0.445, '2001>2002': 0.289, '2002>2003': 0.839, '2003>2005': 0.166, '2005>20053': 0.352,
  '20053>20054': 0.519, '20054>2006': 0.172, '2006>1005': 0.28,
};

interface GraphPosture {
  name: string;
  family: string;
  angles: number[];
  /** [AngleX, AngleY] (rad): alabeo y cabeceo del torso medidos en el robot real */
  inertial: [number, number];
  /** [vecina, costo, enableAntiCollision, speedCoefficient] */
  neighbours: [number, number, number, number][];
}

interface Graph {
  joints: string[];
  postures: Record<string, GraphPosture>;
}

/** Un nodo del camino; `speed` es el speedCoefficient del tramo que llega a él */
export interface GraphStep {
  id: string;
  speed: number;
}

let graph: Graph | null = null;

export function hasPostureGraph(): boolean {
  return graph !== null;
}

/** Descarga el grafo; false si falta (entonces goToPosture usa los tramos validados de postures.ts) */
export async function loadPostureGraph(): Promise<boolean> {
  try {
    const res = await fetch(URL);
    if (res.ok) graph = (await res.json()) as Graph;
  } catch {
    /* sin el grafo */
  }
  return graph !== null;
}

/** Gravedad que mediría la IMU con esos AngleX/AngleY (X adelante, Y izquierda, Z arriba; mismo signo que la doc) */
function expectedGravity([ax, ay]: [number, number]): [number, number, number] {
  return [Math.sin(ay), -Math.sin(ax) * Math.cos(ay), -Math.cos(ax) * Math.cos(ay)];
}

/** Margen (rad) sobre la orientación más parecida para que un nodo cuente como candidato. APPROX. */
const ORIENTATION_MARGIN = 0.35;

/** Ángulo (rad) entre la gravedad medida y la que tendría el robot en el nodo */
function tiltError(g: [number, number, number], p: GraphPosture): number {
  const e = expectedGravity(p.inertial);
  return Math.acos(Math.min(1, Math.max(-1, g[0] * e[0] + g[1] * e[1] + g[2] * e[2])));
}

/** Peor error articular (sin manos) entre el robot y el nodo */
function jointError(state: RobotState, p: GraphPosture): number {
  let error = 0;
  graph!.joints.forEach((joint, i) => {
    if (!joint.endsWith('Hand') && joint !== 'RHipYawPitch') error = Math.max(error, Math.abs(state.get(joint) - p.angles[i]));
  });
  return error;
}

/**
 * Nodo del grafo más parecido al robot ahora, entre `ids`. APPROX: ALRobotPosture compara la "signature" (ángulos + IMU)
 * con una métrica cerrada. Aquí manda la IMU, como en la doc (acostado se decide por la orientación del torso):
 * candidatos = los nodos con la orientación más parecida (hasta 20° más que el mejor) y, entre ellos, el de menor error
 * articular. Medido: tras caer de frente con los brazos y piernas aún de pie, sin el filtro ganaba un nodo "Standing"
 * (85° de diferencia de inclinación).
 */
function nearestAmong(state: RobotState, ids: readonly string[]): { id: string; error: number } | null {
  if (!graph || !ids.length) return null;
  const g = gravityInTorso(state);
  const tilt = (id: string) => (g ? tiltError(g, graph!.postures[id]) : 0);
  const tilts = new Map(ids.map((id) => [id, tilt(id)]));
  // El margen se cuenta desde la mejor orientación de todo el grafo: un nodo de entrada boca arriba no sirve de
  // partida a un robot de costado solo por ser la entrada menos mala
  const limit = Math.min(...Object.keys(graph.postures).map(tilt)) + ORIENTATION_MARGIN;
  let best: { id: string; error: number } | null = null;
  for (const id of ids) {
    if (tilts.get(id)! > limit) continue;
    const error = jointError(state, graph.postures[id]);
    if (!best || error < best.error) best = { id, error };
  }
  return best;
}

export function nearestGraphPosture(state: RobotState): { id: string; error: number } | null {
  return graph ? nearestAmong(state, Object.keys(graph.postures)) : null;
}

/** Más lejos que esto (rad) de todo nodo, el robot no está en ninguna postura conocida. APPROX (IN_FAMILY de postures.ts). */
const LOST = 0.5;

/** Nodos de entrada: ningún tramo llega a ellos (54 de 168), solo sirven para empezar desde poses raras */
let entryIds: string[] | null = null;
function entries(): string[] {
  if (!entryIds && graph) {
    const reached = new Set(Object.values(graph.postures).flatMap((p) => p.neighbours.map(([n]) => String(n))));
    entryIds = Object.keys(graph.postures).filter((id) => !reached.has(id));
  }
  return entryIds ?? [];
}

/**
 * Nodo de partida de goToPosture: el más cercano o, si el robot no se parece a ninguno (p. ej. tras una caída queda con
 * los brazos como estaban de pie: medido, a más de 90° de todos), el nodo de entrada con su misma orientación. APPROX:
 * así parece usarlos NAOqi; p. ej. 30012 (boca abajo) acomoda brazos y piernas y sigue por LyingBelly. Medido tras caer
 * de frente: por la postura LyingBelly rodaba de costado y quedaba boca arriba, por 30012 se levanta (3 de 3). De
 * costado no hay entradas: sigue el más cercano (5007 / 1005007), que lo lleva boca abajo.
 */
export function startingGraphPosture(state: RobotState): { id: string; error: number } | null {
  const near = nearestGraphPosture(state);
  if (!near || near.error <= LOST) return near;
  return nearestAmong(state, entries()) ?? near;
}

/**
 * Postura predefinida más cercana según los valores de NAOqi (los nodos con nombre; qiBullet se aparta hasta 11.6° en
 * Crouch). Error = peor articulación (sin manos), o la inclinación si se aparta más de 0.4 rad de la del nodo (APPROX,
 * como postures.ts nearestPosture: con física el torso no queda exactamente igual).
 */
export function nearestNamedPosture(state: RobotState): { name: string; error: number } | null {
  if (!graph) return null;
  const g = gravityInTorso(state);
  let best: { name: string; error: number } | null = null;
  for (const p of Object.values(graph.postures)) {
    if (!p.name) continue;
    const error = Math.max(g ? tiltError(g, p) - 0.4 : 0, jointError(state, p));
    if (!best || error < best.error) best = { name: p.name, error };
  }
  return best;
}

/** Camino más barato (Dijkstra con los costos del archivo) del nodo `from` a la postura predefinida `target` */
export function planGraphRoute(from: string, target: string): GraphStep[] | null {
  if (!graph) return null;
  const postures = graph.postures;
  const goal = Object.keys(postures).find((id) => postures[id].name === target);
  if (!goal || !postures[from]) return null;
  const dist = new Map<string, number>([[from, 0]]);
  const prev = new Map<string, [string, number]>();
  const open = new Set([from]);
  while (open.size) {
    let u = '';
    for (const v of open) if (!u || dist.get(v)! < dist.get(u)!) u = v;
    open.delete(u);
    if (u === goal) break;
    for (const [next, cost, , speed] of postures[u].neighbours) {
      const v = String(next);
      const d = dist.get(u)! + cost;
      if (postures[v] && d < (dist.get(v) ?? Infinity)) {
        dist.set(v, d);
        prev.set(v, [u, speed]);
        open.add(v);
      }
    }
  }
  if (!dist.has(goal)) return null;
  const route: GraphStep[] = [];
  for (let u = goal; u !== from; ) {
    const [p, speed] = prev.get(u)!;
    route.unshift({ id: u, speed });
    u = p;
  }
  route.unshift({ id: from, speed: 1 });
  return route;
}

/**
 * Recorre el camino con angleInterpolation: un keyframe por nodo (el primero, el nodo de partida, desde la pose actual).
 * APPROX: el interpolador entre nodos de NAOqi es cerrado; aquí la curva monótona de angleInterpolation.
 */
export function playGraphRoute(motion: ALMotion, state: RobotState, route: readonly GraphStep[], speed: number): Promise<void> {
  if (!graph) return Promise.reject(new Error('falta el grafo de posturas de NAOqi'));
  const { joints, postures } = graph;
  const used = joints.map((j, i) => [j, i] as const).filter(([j]) => j !== 'RHipYawPitch');
  const fraction = GRAPH_SPEED * Math.min(Math.max(speed, 0.05), 1);
  const angles: number[][] = used.map(() => []);
  const times: number[][] = used.map(() => []);
  let prev = used.map(([j]) => state.get(j));
  let t = 0;
  route.forEach((step, n) => {
    const pose = used.map(([, i]) => postures[step.id].angles[i]);
    const tuned = n > 0 ? TUNED_STEPS[`${route[n - 1].id}>${step.id}`] : undefined;
    let need = 0;
    used.forEach(([j], k) => (need = Math.max(need, Math.abs(pose[k] - prev[k]) / JOINT_BY_NAME.get(j)!.maxVelocity)));
    t += tuned ?? Math.max(need / (fraction * step.speed), MIN_STEP);
    pose.forEach((a, k) => {
      angles[k].push(a);
      times[k].push(t);
    });
    prev = pose;
  });
  return motion.angleInterpolation(
    used.map(([j]) => j),
    angles,
    times,
    true,
  );
}
