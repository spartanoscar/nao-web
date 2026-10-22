// Motion nets de NaoTH (reference/naoth/, Berlin United, Apache-2.0): rutinas probadas en NAO V6 reales para
// levantarse (de espaldas, boca abajo, de lado). Formato .mef:
//   cabecera "nao", nombres de 24 joints ("HeadYaw;"…), keyframe;id;x;y;<24 ángulos en grados>,
//   transition;desde;hasta;duración_ms;condición
// Se reproducen como su KeyFrameMotion.cpp: a la primera pose a π/2 rad/s (según el joint más lejano), tramos
// lineales entre keyframes y rigidez uniforme 0.75 (KeyFrameMotionParameters.cfg).

import { COUPLED } from '../robot/naoV6';
import type { ALMotion } from './ALMotion';
import type { MotionEngine } from './engine';

export interface MotionNet {
  name: string;
  names: string[];
  /** Keyframes en orden de reproducción (rad, en el orden de `names`) */
  frames: number[][];
  /** Duración (s) de la transición que llega a cada keyframe; la del primero se calcula al reproducir */
  durations: number[];
}

/** Velocidad para llegar a la primera pose (NaoTH: Math::pi_2 rad/s) */
const LEAD_SPEED = Math.PI / 2;
/** Rigidez durante la rutina (reference/naoth/KeyFrameMotionParameters.cfg) */
const NET_STIFFNESS = 0.75;

export function parseMotionNet(name: string, text: string): MotionNet {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (lines[0] !== 'nao') throw new Error(`${name}: no es un motion net de NaoTH`);
  const names = lines.filter((l) => /^[A-Z][A-Za-z]+;$/.test(l)).map((l) => l.slice(0, -1));
  const keyframes = new Map<number, number[]>();
  const next = new Map<number, { to: number; ms: number }>();
  for (const line of lines) {
    const f = line.split(';');
    if (f[0] === 'keyframe') keyframes.set(Number(f[1]), f.slice(4, 4 + names.length).map((d) => (Number(d) * Math.PI) / 180));
    // Condición "*": la cadena que se reproduce de principio a fin (las demás condiciones son de su máquina de estados)
    if (f[0] === 'transition' && f[4] === '*') next.set(Number(f[1]), { to: Number(f[2]), ms: Number(f[3]) });
  }
  if (!keyframes.has(0)) throw new Error(`${name}: falta el keyframe 0`);
  const frames = [keyframes.get(0)!];
  const durations = [0];
  const seen = new Set([0]);
  for (let id = 0, step = next.get(0); step && !seen.has(step.to); step = next.get(id)) {
    id = step.to;
    seen.add(id);
    frames.push(keyframes.get(id)!);
    durations.push(step.ms / 1000);
  }
  return { name, names, frames, durations };
}

const files = import.meta.glob<string>('../../reference/naoth/*.mef', { query: '?raw', import: 'default', eager: true });

export const MOTION_NETS: readonly MotionNet[] = Object.entries(files)
  .map(([path, text]) => parseMotionNet(path.split('/').pop()!.replace('.mef', ''), text))
  .sort((a, b) => a.name.localeCompare(b.name));

/** Los primeros `frames` keyframes de la rutina (p. ej. solo la vuelta de stand_up_from_side) */
export function sliceMotionNet(net: MotionNet, frames: number): MotionNet {
  return { ...net, name: `${net.name}[0..${frames - 1}]`, frames: net.frames.slice(0, frames), durations: net.durations.slice(0, frames) };
}

/** Bloqueante: sube la rigidez a 0.75, reproduce la rutina y la deja en 1 (como queda el NAO despierto) */
export async function playMotionNet(engine: MotionEngine, motion: ALMotion, net: MotionNet, stiffness = NET_STIFFNESS): Promise<void> {
  // RHipYawPitch es el mismo motor que LHipYawPitch: se comanda solo el izquierdo
  const columns = net.names.map((n, i) => [n, i] as const).filter(([n]) => !(n in COUPLED));
  const joints = columns.map(([n]) => n);
  // NaoTH sube la rigidez a 5/s antes de empezar
  const from = Math.min(...motion.getStiffnesses(joints));
  await motion.stiffnessInterpolation(joints, stiffness, Math.max(Math.abs(stiffness - from) / 5, 0.02));

  const current = motion.getAngles(joints, true);
  const lead = Math.max(...columns.map(([, i], k) => Math.abs(current[k] - net.frames[0][i]))) / LEAD_SPEED;
  const times: number[] = [];
  let t = Math.max(lead, 0.02);
  net.frames.forEach((_, f) => times.push((t += f === 0 ? 0 : net.durations[f])));
  const trajectories = Object.fromEntries(columns.map(([n, i]) => [n, { times, values: net.frames.map((fr) => fr[i]) }]));
  await engine.interpolate(trajectories, { linear: true }).done;

  await motion.stiffnessInterpolation(joints, 1, 0.2);
}
