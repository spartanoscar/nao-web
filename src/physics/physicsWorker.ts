// La física del mundo (MuJoCo, PhysicsSim) en un Web Worker: el hilo de la pantalla queda libre para dibujar y MuJoCo
// usa otro núcleo. Sigue el mismo paso a paso que antes en el hilo principal: el motor de NAOqi calcula los comandos de
// un ciclo allá (physicsClient.ts) y aquí se simula ese ciclo con ellos; el estado vuelve antes del ciclo siguiente.
// El URDF llega ya leído (en un worker no hay DOMParser). Aquí PhysicsSim recibe un RobotState propio (rigidez que manda el hilo principal; ángulos, torso y sonares que
// devuelve) y un "motor" que solo entrega los comandos recibidos.

import { RobotState, type RootPose } from '../robot/state';
import type { UrdfRobot } from '../robot/urdf';
import type { MotionEngine } from '../naoqi/engine';
import { PhysicsSim } from './physics';

export type PhysicsRequest =
  | { t: 'init'; urdf: UrdfRobot; root: RootPose; angles: Record<string, number>; hulls: [string, Float32Array][]; ghosts: number; objects: string[] }
  | { t: 'cycle'; epoch: number; dt: number; commands: Float64Array; stiffness: Float64Array; busy: boolean }
  | { t: 'reset'; root: RootPose; angles: Record<string, number> }
  | { t: 'ghost'; k: number; poses: Float64Array | null };

export type PhysicsResponse =
  | { t: 'ready'; joints: string[]; ghostLinks: string[] }
  | { t: 'error'; message: string }
  | {
      t: 'step';
      epoch: number;
      moved: boolean;
      root: RootPose | null;
      angles: Float64Array;
      sonar: [number, number] | null;
      echoes: [number, number][];
      /** 7 por objeto: x y z, qx qy qz qw (orden de three) */
      objects: Float64Array;
      impacts: ReturnType<PhysicsSim['takeImpacts']>;
      telemetry: ReturnType<PhysicsSim['telemetry']>;
      qpos: Float64Array;
      locked: boolean;
      objectsSleeping: boolean;
    };

let sim: PhysicsSim | null = null;
let state: RobotState;
let joints: string[] = [];
const commands = new Map<string, number>();
let busy = false;
let objectPoses = new Float64Array(0);

const post = (m: PhysicsResponse, transfer: Transferable[] = []) => (self as unknown as Worker).postMessage(m, transfer);

self.onmessage = async (e: MessageEvent<PhysicsRequest>) => {
  const m = e.data;
  try {
    if (m.t === 'init') {
      state = new RobotState(m.angles);
      const engine = { command: (name: string) => commands.get(name) ?? state.get(name), get busy() { return busy; } } as unknown as MotionEngine;
      objectPoses = new Float64Array(7 * m.objects.length);
      const targets = new Map(
        m.objects.map((name, i) => [
          name,
          {
            position: { set: (x: number, y: number, z: number) => objectPoses.set([x, y, z], 7 * i) },
            quaternion: { set: (x: number, y: number, z: number, w: number) => objectPoses.set([x, y, z, w], 7 * i + 3) },
          },
        ]),
      );
      sim = await PhysicsSim.create(m.urdf, state, engine, m.root, targets, { hulls: new Map(m.hulls), ghosts: m.ghosts });
      joints = sim.jointNames;
      post({ t: 'ready', joints, ghostLinks: [...sim.ghostLinks] });
    } else if (!sim) {
      return;
    } else if (m.t === 'cycle') {
      joints.forEach((name, i) => {
        commands.set(name, m.commands[i]);
        state.setStiffness(name, m.stiffness[i]);
      });
      busy = m.busy;
      const moved = sim.step(m.dt);
      const angles = Float64Array.from(joints, (n) => state.get(n));
      const qpos = Float64Array.from(sim.qpos());
      post(
        {
          t: 'step', epoch: m.epoch, moved, root: state.root, angles, sonar: state.sonar, echoes: state.sonarEchoes,
          objects: objectPoses.slice(), impacts: sim.takeImpacts(), telemetry: sim.telemetry(), qpos,
          locked: sim.isLocked, objectsSleeping: sim.objectsSleeping,
        },
        [angles.buffer, qpos.buffer],
      );
    } else if (m.t === 'reset') {
      sim.reset(m.root, m.angles);
    } else if (m.t === 'ghost') {
      const p = m.poses;
      sim.setGhost(m.k, p && ((link) => {
        const i = 7 * sim!.ghostLinks.indexOf(link);
        return { position: p.subarray(i, i + 3), quaternion: p.subarray(i + 3, i + 7) };
      }));
    }
  } catch (err) {
    post({ t: 'error', message: err instanceof Error ? err.message : String(err) });
  }
};
