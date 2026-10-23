// Rutinas originales de Aldebaran para sentarse y levantarse: las cajas "Sit Down" y "Stand Up" de Choregraphe 1.x
// (© Aldebaran Robotics), descargadas sin modificar por scripts/fetch-aldebaran-motions.sh a public/motions/aldebaran/.
// Cada caja interna (CrouchToSitDown, SitToCrouch, CrouchToStand, BackToStand, BellyToStand…) es una línea de tiempo
// de Choregraphe: por articulación, keyframes (cuadro, grados; manos 0–1) a unos fps. Se reproducen con
// ALMotion.angleInterpolation, como un timeline de Choregraphe. Si no se pudieron descargar, el grafo de posturas usa
// sus otros caminos.

import type { ALMotion } from './ALMotion';
import { sampleMonotone } from './engine';

const BASE = '/motions/aldebaran/';
const FILES = ['SitDownX.xar', 'StandUpX.xar'];
const DEG = Math.PI / 180;

export interface AldebaranMotion {
  name: string;
  joints: string[];
  /** Por articulación: tiempos (s) y ángulos (rad; manos 0–1) */
  times: number[][];
  angles: number[][];
  duration: number;
}

const motions = new Map<string, AldebaranMotion>();

export function hasAldebaranMotion(name: string): boolean {
  return motions.has(name);
}

export function aldebaranMotions(): AldebaranMotion[] {
  return [...motions.values()];
}

/** Lee las líneas de tiempo de un .xar (XML de Choregraphe) */
export function parseXar(xml: string): AldebaranMotion[] {
  const doc = new DOMParser().parseFromString(xml, 'application/xml');
  const out: AldebaranMotion[] = [];
  for (const box of doc.getElementsByTagName('Box')) {
    const timeline = [...box.children].find((c) => c.tagName === 'Timeline');
    if (!timeline) continue;
    const fps = Number(timeline.getAttribute('fps')) || 25;
    const curves = [...timeline.getElementsByTagName('ActuatorCurve')].filter((c) => c.getAttribute('mute') !== '1');
    const names = curves.map((c) => c.getAttribute('actuator') ?? '');
    // Las cajas contenedoras repiten articulaciones (incluyen las de adentro): solo las de una línea de tiempo propia
    if (!curves.length || new Set(names).size !== names.length) continue;
    const joints: string[] = [];
    const times: number[][] = [];
    const angles: number[][] = [];
    for (const [i, c] of curves.entries()) {
      const keys = [...c.getElementsByTagName('Key')].map((k) => [Number(k.getAttribute('frame')) / fps, Number(k.getAttribute('value'))]);
      if (!keys.length) continue;
      joints.push(names[i]);
      times.push(keys.map(([t]) => t));
      angles.push(keys.map(([, v]) => (names[i].endsWith('Hand') ? v : v * DEG)));
    }
    out.push({ name: box.getAttribute('name') ?? '', joints, times, angles, duration: Math.max(...times.map((t) => t[t.length - 1])) });
  }
  return out;
}

/** Descarga y registra las rutinas; resuelve aunque falten (devuelve cuántas cargó) */
export async function loadAldebaranMotions(): Promise<number> {
  for (const file of FILES) {
    try {
      const res = await fetch(BASE + file);
      if (!res.ok) continue;
      for (const m of parseXar(await res.text())) if (!motions.has(m.name)) motions.set(m.name, m);
    } catch {
      /* sin las rutinas: el grafo usa otros caminos */
    }
  }
  return motions.size;
}

export function playAldebaranMotion(motion: ALMotion, name: string): Promise<void> {
  const m = motions.get(name);
  if (!m) return Promise.reject(new Error(`falta la rutina de Aldebaran ${name}`));
  return motion.angleInterpolation(m.joints, m.angles, m.times, true);
}

/** Lo más que la versión en poses se puede apartar de la curva original entre dos poses (rad) */
const KEYFRAME_TOLERANCE = 1 * DEG;

/**
 * La rutina como poses de cuerpo entero (las del grabador, ui/poseRecorder.ts) para repetirla y ajustarla a mano: una
 * pose en cada tiempo donde alguna articulación tiene keyframe, con cada joint sobre su misma curva (la de
 * angleInterpolation desde `start`, la pose de partida). Con más puntos la curva se recalcula y puede apartarse entre
 * ellos: donde algún joint se aparta más de 1° se agrega la pose intermedia (medido sin esto: hasta 5° en ElbowYaw).
 * Los joints que la rutina no mueve se quedan en `start`.
 */
export function toKeyframes(name: string, start: Readonly<Record<string, number>>): { duration: number; angles: Record<string, number> }[] {
  const m = motions.get(name);
  if (!m) return [];
  const curves = m.joints.map((j, i) =>
    m.times[i][0] > 0 ? { j, ts: [0, ...m.times[i]], vs: [start[j] ?? m.angles[i][0], ...m.angles[i]] } : { j, ts: m.times[i], vs: m.angles[i] },
  );
  const tol = (j: string) => (j.endsWith('Hand') ? 0.02 : KEYFRAME_TOLERANCE);
  let times = [...new Set(m.times.flat().map((t) => Math.round(t * 1000) / 1000))].sort((a, b) => a - b);
  for (let pass = 0; pass < 4; pass++) {
    const kt = [0, ...times];
    const resampled = curves.map((c) => [c.vs[0], ...times.map((t) => sampleMonotone(c.ts, c.vs, t))]);
    const extra: number[] = [];
    for (let k = 0; k < kt.length - 1; k++) {
      const [a, b] = [kt[k], kt[k + 1]];
      const off = curves.some((c, i) =>
        [0.25, 0.5, 0.75].some((u) => {
          const t = a + (b - a) * u;
          return Math.abs(sampleMonotone(c.ts, c.vs, t) - sampleMonotone(kt, resampled[i], t)) > tol(c.j);
        }),
      );
      if (off && b - a > 0.08) extra.push(Math.round(((a + b) / 2) * 1000) / 1000);
    }
    if (!extra.length) break;
    times = [...new Set([...times, ...extra])].sort((x, y) => x - y);
  }
  let prev = 0;
  return times.map((t) => {
    const angles: Record<string, number> = { ...start };
    for (const c of curves) angles[c.j] = sampleMonotone(c.ts, c.vs, t);
    const duration = Math.round((t - prev) * 1000) / 1000;
    prev = t;
    return { duration, angles };
  });
}
