// Animaciones por keyframes en formato Webots .motion (reference/motions/, Apache-2.0):
//   #WEBOTS_MOTION,V1.0,Joint1,Joint2,…
//   MM:SS:mmm,PoseN,valor1,valor2,…     ("*" = este joint no tiene keyframe en esta pose)
// Se reproducen con ALMotion.angleInterpolation, igual que Choregraphe ejecuta sus timelines.

import { JOINT_BY_NAME } from '../robot/naoV6';
import type { ALMotion } from './ALMotion';

export interface MotionClip {
  name: string;
  /** Duración total (s) */
  duration: number;
  names: string[];
  angleLists: number[][];
  timeLists: number[][];
}

/** Tiempo para llegar a la primera pose si la animación empieza en t=0 */
const LEAD_IN = 0.8;

export function parseMotion(name: string, text: string): MotionClip {
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  const header = lines[0].split(',');
  if (header[0] !== '#WEBOTS_MOTION') throw new Error(`${name}: no es un archivo .motion`);
  const columns = header.slice(2);

  const rows = lines.slice(1).map((line) => {
    const [time, , ...values] = line.split(',');
    const [mm, ss, ms] = time.split(':').map(Number);
    return { t: mm * 60 + ss + ms / 1000, values };
  });
  const lead = rows[0].t < 0.2 ? LEAD_IN - rows[0].t : 0;

  const names: string[] = [];
  const angleLists: number[][] = [];
  const timeLists: number[][] = [];
  columns.forEach((joint, c) => {
    // APPROX: Webots modela cada falange (LPhalanx1…8); NAOqi solo tiene LHand/RHand. Se ignoran.
    if (!JOINT_BY_NAME.has(joint)) return;
    const angles: number[] = [];
    const times: number[] = [];
    for (const row of rows) {
      const v = row.values[c];
      if (v === undefined || v.trim() === '*') continue;
      angles.push(Number(v));
      times.push(row.t + lead);
    }
    if (angles.length) {
      names.push(joint);
      angleLists.push(angles);
      timeLists.push(times);
    }
  });

  return { name, duration: rows[rows.length - 1].t + lead, names, angleLists, timeLists };
}

const files = import.meta.glob<string>('../../reference/motions/*.motion', { query: '?raw', import: 'default', eager: true });

export const MOTIONS: readonly MotionClip[] = Object.entries(files)
  .map(([path, text]) => parseMotion(path.split('/').pop()!.replace('.motion', ''), text))
  .sort((a, b) => a.name.localeCompare(b.name));

export function playMotion(motion: ALMotion, clip: MotionClip): Promise<void> {
  return motion.angleInterpolation(clip.names, clip.angleLists, clip.timeLists, true);
}
