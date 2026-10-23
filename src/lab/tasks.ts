// Tareas del laboratorio: qué movimiento se busca, desde dónde parte, cómo se codifica en números para el optimizador y
// cómo se puntúa (menos es mejor). Un movimiento = K poses clave intermedias + una pose final fija, cada una con su
// duración; se reproduce con ALMotion.angleInterpolation (como un timeline de Choregraphe), así que lo que se encuentra
// aquí corre igual en un NAO real.

import { JOINTS, JOINT_BY_NAME, COUPLED } from '../robot/naoV6';
import { nearestPosture, postureJoints } from '../naoqi/postures';
import { RobotState } from '../robot/state';
import type { LabSim, Sample } from './labSim';

/** Lo que decide el optimizador en cada pose (brazos para apoyarse y equilibrar, piernas completas; asimétrico) */
export const SEARCH_JOINTS = [
  'LShoulderPitch', 'LShoulderRoll', 'LElbowRoll', 'RShoulderPitch', 'RShoulderRoll', 'RElbowRoll',
  'LHipYawPitch', 'LHipRoll', 'LHipPitch', 'LKneePitch', 'LAnklePitch', 'LAnkleRoll',
  'RHipRoll', 'RHipPitch', 'RKneePitch', 'RAnklePitch', 'RAnkleRoll',
];
/** Todos los joints que se mandan (RHipYawPitch sigue a LHipYawPitch) */
const ALL = JOINTS.map((j) => j.name).filter((n) => !(n in COUPLED));
const DEG = Math.PI / 180;

export interface Keyframe {
  /** Segundos para llegar a esta pose desde la anterior */
  duration: number;
  angles: Record<string, number>;
}

export interface Metrics {
  ok: boolean;
  /** Se cayó (torso a más de 60° de la vertical en algún momento, sin contar lo que pide la tarea) */
  fell: boolean;
  /** Velocidad máxima de bajada del torso (m/s): un "golpe" contra el suelo */
  maxDrop: number;
  /** Velocidad angular máxima del torso (rad/s) */
  maxSpin: number;
  /** Ángulo máximo del torso respecto a la vertical (°) */
  maxTilt: number;
  /** Altura e inclinación al final (m, °): total respecto a la vertical, adelante (+) / atrás (−) y de costado */
  endZ: number;
  endTilt: number;
  endPitch: number;
  endRoll: number;
  duration: number;
  posture: string;
}

export interface Task {
  id: 'sit-down' | 'stand-up' | 'imitate';
  label: string;
  /** Deja la simulación en el punto de partida (luego se toma la foto) */
  prepare(lab: LabSim): Promise<void>;
  /** Pose final fija y poses intermedias de partida (semilla) */
  final: Record<string, number>;
  seed: Record<string, number>[];
  seedDurations: number[];
  finalDuration: number;
  /** Desviación inicial de la búsqueda (rad) */
  sigma: number;
  score(m: Metrics): number;
  /** Término que no necesita simular (p. ej. parecido a una referencia), sobre el vector del optimizador */
  prior?(x: number[]): number;
}

/** Mezcla de dos poses (t = 0 → a, 1 → b) */
const mix = (a: Record<string, number>, b: Record<string, number>, t: number) =>
  Object.fromEntries(Object.keys(a).map((k) => [k, a[k] + ((b[k] ?? a[k]) - a[k]) * t]));
const pick = (p: Record<string, number>) => Object.fromEntries(SEARCH_JOINTS.map((j) => [j, p[j]]));

const CROUCH = postureJoints('Crouch');
const SIT_RELAX = postureJoints('SitRelax');
const SIT = postureJoints('Sit');

/** Partir de pie (StandInit) con los motores encendidos, quieto */
async function fromStandInit(lab: LabSim): Promise<void> {
  const motion = lab.session.service('ALMotion');
  await lab.drive(motion.wakeUp(), 8);
  await lab.hold(1);
}

export const TASKS: Task[] = [
  {
    id: 'sit-down',
    label: 'Sentarse controlado (StandInit → Sit)',
    prepare: fromStandInit,
    final: SIT,
    // Semilla: el camino actual del grafo (agacharse, piernas adelante, sentarse), que llega pero "cae sentado"
    seed: [pick(CROUCH), pick(mix(CROUCH, SIT_RELAX, 0.5)), pick(SIT_RELAX)],
    seedDurations: [1.2, 1.0, 1.0],
    finalDuration: 1.0,
    sigma: 0.15,
    score(m) {
      let c = 0;
      if (m.fell) c += 60 + Math.max(0, m.maxTilt - 60) / 3;
      if (m.posture !== 'Sitting') c += 25;
      // Sit estable: torso ~36° hacia atrás y derecho de lado. Solo con la inclinación total se iba de costado
      // (−14° atrás, 33° de lado: cumplía los 36° ladeado)
      c += Math.abs(m.endPitch + 36) / 3 + Math.max(0, Math.abs(m.endRoll) - 8) / 2;
      c += 40 * Math.max(0, m.maxDrop - 0.2); // sin golpe al sentarse
      c += 4 * Math.max(0, m.maxSpin - 0.8); // sin giros bruscos del torso
      c += 0.5 * m.duration;
      return c;
    },
  },
  {
    id: 'stand-up',
    label: 'Levantarse desde sentado (Sit → Crouch)',
    async prepare(lab) {
      // El Sit al que se llega por el grafo (5 de 5): desde el Crouch del arranque
      const motion = lab.session.service('ALMotion');
      const names = ALL.filter((j) => !j.endsWith('Hand'));
      motion.setAngles(names, motion.getAngles(names, true), 0.2);
      motion.setStiffnesses('Body', 1);
      await lab.drive(lab.session.service('ALRobotPosture').goToPosture('Sit', 1), 10);
      await lab.hold(1.5);
    },
    final: CROUCH,
    // Semilla inspirada en el video del NAO real: recoger las piernas apoyando las manos atrás, pasar el peso adelante
    // con los brazos al frente, cuclillas abiertas
    seed: [
      pick({ ...mix(SIT, CROUCH, 0.4), LShoulderPitch: 1.9, RShoulderPitch: 1.9, LShoulderRoll: 0.3, RShoulderRoll: -0.3, LElbowRoll: -0.1, RElbowRoll: 0.1 }),
      pick({ ...mix(SIT, CROUCH, 0.8), LShoulderPitch: 0.6, RShoulderPitch: 0.6, LShoulderRoll: 0.2, RShoulderRoll: -0.2, LElbowRoll: -0.3, RElbowRoll: 0.3, LHipRoll: 0.3, RHipRoll: -0.3 }),
      pick({ ...CROUCH, LShoulderPitch: 0.4, RShoulderPitch: 0.4, LHipRoll: 0.2, RHipRoll: -0.2 }),
    ],
    seedDurations: [1.2, 1.0, 1.0],
    finalDuration: 1.0,
    sigma: 0.3,
    score(m) {
      let c = 0;
      // Llegar arriba (cuclillas ~0.23 m) y derecho es lo principal; el puntaje premia acercarse aunque falle
      c += 120 * Math.max(0, 0.22 - m.endZ);
      c += Math.max(0, m.endTilt - 12) / 2;
      if (m.posture !== 'Crouching' && m.posture !== 'Standing') c += 15;
      if (m.fell) c += 30;
      c += 20 * Math.max(0, m.maxDrop - 0.3);
      c += 2 * Math.max(0, m.maxSpin - 1.2);
      c += 0.5 * m.duration;
      return c;
    },
  },
];

/** Número de variables: K poses × (17 ángulos + 1 duración) + la duración final */
export const dimensions = (task: Task) => task.seed.length * (SEARCH_JOINTS.length + 1) + 1;

/** Vector de partida para el optimizador (duraciones en logaritmo: siempre positivas y con escala relativa) */
export function encode(task: Task): number[] {
  const x: number[] = [];
  task.seed.forEach((pose, k) => {
    for (const j of SEARCH_JOINTS) x.push(pose[j]);
    x.push(Math.log(task.seedDurations[k]));
  });
  x.push(Math.log(task.finalDuration));
  return x;
}

/** Vector → poses clave completas (dentro de los límites del URDF), desde la pose de partida `start` */
export function decode(task: Task, x: number[], start: Record<string, number>): Keyframe[] {
  const frames: Keyframe[] = [];
  const K = task.seed.length;
  let i = 0;
  for (let k = 0; k < K; k++) {
    // Lo que no decide el optimizador (cabeza, codo girado, muñecas, manos) va del inicio al final en línea recta
    const angles: Record<string, number> = mix(
      Object.fromEntries(ALL.map((j) => [j, start[j] ?? 0])),
      Object.fromEntries(ALL.map((j) => [j, task.final[j] ?? start[j] ?? 0])),
      (k + 1) / (K + 1),
    );
    for (const j of SEARCH_JOINTS) {
      const spec = JOINT_BY_NAME.get(j)!;
      angles[j] = Math.min(Math.max(x[i++], spec.min), spec.max);
    }
    frames.push({ duration: Math.min(Math.max(Math.exp(x[i++]), 0.25), 3), angles });
  }
  frames.push({
    duration: Math.min(Math.max(Math.exp(x[i++]), 0.25), 3),
    angles: Object.fromEntries(ALL.map((j) => [j, task.final[j] ?? start[j] ?? 0])),
  });
  return frames;
}

/** Reproduce las poses con angleInterpolation, sostiene `hold` s y mide */
export async function evaluate(lab: LabSim, frames: Keyframe[], hold = 1.5): Promise<Metrics> {
  const motion = lab.session.service('ALMotion');
  const names = ALL;
  let t = 0;
  const times = frames.map((f) => (t += f.duration));
  let prev: Sample | null = null;
  let maxDrop = 0;
  let maxSpin = 0;
  let maxTilt = 0;
  const watch = (s: Sample) => {
    if (prev) {
      const dt = s.t - prev.t || 0.02;
      maxDrop = Math.max(maxDrop, (prev.z - s.z) / dt);
      maxSpin = Math.max(maxSpin, Math.abs(s.tilt - prev.tilt) / dt);
    }
    maxTilt = Math.max(maxTilt, s.tilt / DEG);
    prev = s;
  };
  await lab.drive(
    motion.angleInterpolation(names, names.map((n) => frames.map((f) => f.angles[n])), names.map(() => times), true),
    t + 1,
    watch,
  );
  await lab.hold(hold, watch);
  const end = lab.measure();
  const posture = lab.session.service('ALRobotPosture').getPostureFamily();
  return {
    ok: true,
    fell: posture.startsWith('Lying'),
    maxDrop,
    maxSpin,
    maxTilt,
    endZ: end.z,
    endTilt: end.tilt / DEG,
    endPitch: end.pitch / DEG,
    endRoll: end.roll / DEG,
    duration: t,
    posture,
  };
}

/**
 * Imitar lo grabado: las poses del grabador (o del modo animador, aunque se hayan grabado sin física) son la referencia
 * y la semilla; el optimizador busca lo más parecido que se sostenga con física. Parecido = distancia (rad) de cada pose
 * candidata a la grabada; la meta = terminar estable en la familia de la última pose (de pie, en cuclillas o sentado).
 */
export function imitationTask(frames: { duration: number; angles: Record<string, number> }[], origin: 'back' | 'sit' | 'stand'): Task {
  const ref = frames.map((f) => f.angles);
  const final = { ...ref[ref.length - 1] };
  const target = (() => {
    const st = new RobotState(final);
    const { name } = nearestPosture(st, true);
    return name === 'Sit' || name === 'SitRelax' ? 'Sitting' : name === 'Crouch' ? 'Crouching' : name.startsWith('Lying') ? 'Lying' : 'Standing';
  })();
  const seedPoses = ref.slice(0, -1).map(pick);
  const task: Task = {
    id: 'imitate',
    label: `Imitar lo grabado (${frames.length} poses → ${target})`,
    async prepare(lab) {
      const motion = lab.session.service('ALMotion');
      if (origin === 'stand') return fromStandInit(lab);
      if (origin === 'sit') {
        const names = ALL.filter((j) => !j.endsWith('Hand'));
        motion.setAngles(names, motion.getAngles(names, true), 0.2);
        motion.setStiffnesses('Body', 1);
        await lab.drive(lab.session.service('ALRobotPosture').goToPosture('Sit', 1), 10);
        await lab.hold(1.5);
        return;
      }
      // Boca arriba: como "Empezar boca arriba" del grabador
      const lying = postureJoints('LyingBack');
      const c = Math.SQRT1_2;
      lab.physics.reset({ position: [0, 0, 0.08], quaternion: [c, 0, -c, 0] }, lying);
      await lab.hold(1.2);
      motion.setStiffnesses('Body', 1);
      await lab.hold(0.5);
    },
    final,
    seed: seedPoses.length ? seedPoses : [pick(final)],
    seedDurations: (seedPoses.length ? frames.slice(0, -1) : frames).map((f) => f.duration),
    finalDuration: frames[frames.length - 1].duration,
    sigma: 0.08,
    score(m) {
      let c = 0;
      if (target !== 'Lying' && m.fell) c += 60;
      if (target === 'Sitting') {
        if (m.posture !== 'Sitting') c += 25;
        c += Math.abs(m.endPitch + 36) / 3 + Math.max(0, Math.abs(m.endRoll) - 8) / 2;
      } else if (target === 'Standing' || target === 'Crouching') {
        c += 120 * Math.max(0, (target === 'Standing' ? 0.28 : 0.2) - m.endZ);
        c += Math.max(0, m.endTilt - 12) / 2;
      }
      c += 30 * Math.max(0, m.maxDrop - 0.35);
      c += 3 * Math.max(0, m.maxSpin - 1.5);
      return c;
    },
    prior(x) {
      // Distancia media (rad) de las poses candidatas a las grabadas, ×10: alejarse 0.1 rad en promedio cuesta 1
      let sum = 0;
      let n = 0;
      let i = 0;
      for (const pose of seedPoses) {
        for (const j of SEARCH_JOINTS) {
          sum += (x[i++] - pose[j]) ** 2;
          n++;
        }
        i++; // duración
      }
      return n ? 10 * Math.sqrt(sum / n) : 0;
    },
  };
  return task;
}
