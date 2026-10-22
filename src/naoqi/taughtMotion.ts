// Movimientos enseñados a mano con el grabador de poses (ui/poseRecorder.ts → "Copiar"), en ./taught/*.json:
// keyframes en grados (manos 0–1) con la duración para llegar a cada uno. Se reproducen con
// ALMotion.angleInterpolation, igual que el "Probar" del grabador con el que se validaron.

import type { ALMotion } from './ALMotion';

export interface TaughtMotion {
  name: string;
  author: string;
  notes?: string;
  joints: string[];
  keyframes: { duration: number; angles: number[] }[];
}

const DEG = Math.PI / 180;

const files = import.meta.glob<TaughtMotion>('./taught/*.json', { import: 'default', eager: true });

export const TAUGHT_MOTIONS: readonly TaughtMotion[] = Object.values(files);

export function playTaught(motion: ALMotion, m: TaughtMotion): Promise<void> {
  let t = 0;
  const times = m.keyframes.map((k) => (t += k.duration));
  const angles = m.joints.map((j, i) => m.keyframes.map((k) => (j.endsWith('Hand') ? k.angles[i] : k.angles[i] * DEG)));
  return motion.angleInterpolation(m.joints, angles, m.joints.map(() => times), true);
}
