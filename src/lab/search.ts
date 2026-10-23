// Búsqueda de un movimiento: CMA-ES (cmaes.ts) sobre las poses clave de una tarea (tasks.ts), evaluando cada candidato
// en el simulador del laboratorio (labSim.ts) desde la misma foto del estado inicial. Cede el control a la página
// entre episodios para que la interfaz no se congele.

import type { UrdfRobot } from '../robot/urdf';
import type { RootPose } from '../robot/state';
import { postureJoints } from '../naoqi/postures';
import { SepCMA } from './cmaes';
import { LabSim } from './labSim';
import { type Keyframe, type Metrics, type Task, decode, encode, evaluate } from './tasks';

export interface Progress {
  generation: number;
  episodes: number;
  /** Mejor costo de la generación y el mejor de toda la búsqueda */
  generationBest: number;
  best: number;
  bestMetrics: Metrics;
  /** Costo y medidas de la semilla (punto de partida), para comparar */
  seed: { cost: number; metrics: Metrics };
  sigma: number;
  seconds: number;
}

export interface Result {
  task: Task['id'];
  frames: Keyframe[];
  cost: number;
  metrics: Metrics;
  progress: Progress;
}

export async function searchMotion(
  urdf: UrdfRobot,
  root: RootPose,
  task: Task,
  { generations = 200, seed = 1, onProgress, cancelled }: { generations?: number; seed?: number; onProgress?: (p: Progress) => void; cancelled?: () => boolean } = {},
): Promise<Result> {
  const crouch = postureJoints('Crouch');
  const lab = await LabSim.create(urdf, root, crouch);
  await task.prepare(lab);
  const start = lab.snapshot();
  const startAngles = Object.fromEntries(lab.session.service('ALMotion').getBodyNames('Body').map((n) => [n, lab.state.get(n)]));

  const t0 = performance.now();
  const run = async (x: number[]) => {
    lab.restore(start);
    const frames = decode(task, x, startAngles);
    const metrics = await evaluate(lab, frames);
    return { frames, metrics, cost: task.score(metrics) + (task.prior?.(x) ?? 0) };
  };

  const x0 = encode(task);
  const seedRun = await run(x0);
  let best = { ...seedRun, x: x0 };
  const es = new SepCMA(x0, task.sigma, { seed });
  let episodes = 1;
  let progress: Progress | null = null;
  for (let g = 0; g < generations && !cancelled?.(); g++) {
    const xs = es.ask();
    const costs: number[] = [];
    let generationBest = Infinity;
    for (const x of xs) {
      if (cancelled?.()) break;
      const r = await run(x);
      episodes++;
      costs.push(r.cost);
      generationBest = Math.min(generationBest, r.cost);
      if (r.cost < best.cost) best = { ...r, x };
      await new Promise((res) => setTimeout(res, 0)); // que la página respire
    }
    if (costs.length < xs.length) break;
    es.tell(costs);
    progress = {
      generation: es.generation,
      episodes,
      generationBest,
      best: best.cost,
      bestMetrics: best.metrics,
      seed: { cost: seedRun.cost, metrics: seedRun.metrics },
      sigma: es.sigma,
      seconds: (performance.now() - t0) / 1000,
    };
    onProgress?.(progress);
  }
  return {
    task: task.id,
    frames: best.frames,
    cost: best.cost,
    metrics: best.metrics,
    progress: progress ?? {
      generation: 0, episodes, generationBest: seedRun.cost, best: best.cost, bestMetrics: best.metrics,
      seed: { cost: seedRun.cost, metrics: seedRun.metrics }, sigma: task.sigma, seconds: (performance.now() - t0) / 1000,
    },
  };
}
