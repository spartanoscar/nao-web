// Motor de movimiento: el equivalente al bucle interno de ALMotion. Avanza en ciclos fijos de 20 ms,
// interpola las trayectorias activas y escribe en RobotState. Los servicios NAOqi (ALMotion,
// ALRobotPosture…) solo traducen su API a llamadas de este motor. El motor genera los comandos; los ángulos medidos
// los escribe la física (physics.ts). Las manos siguen siendo cinemáticas.

import { JOINT_BY_NAME, JOINTS } from '../robot/naoV6';
import type { RobotState } from '../robot/state';

/** Ciclo de ALMotion: 20 ms */
export const MOTION_CYCLE = 0.02;

interface Channel {
  get(): number;
  maxVelocity: number;
  /** Los joints con stiffness 0 no obedecen */
  enabled(): boolean;
}

/** Trayectoria por keyframes (tiempos absolutos desde el inicio, en s) */
interface CurveTrack {
  kind: 'curve';
  t: number;
  times: number[];
  values: number[];
  slopes: number[];
}

/** Seguimiento reactivo de un objetivo (setAngles): velocidad continua, aceleración limitada */
interface FollowTrack {
  kind: 'follow';
  target: number;
  vmax: number;
}

type Track = (CurveTrack | FollowTrack) & { task: Task; pos: number; vel: number };

export interface MotionTask {
  /** Se resuelve cuando todos sus canales terminan (o los reemplaza otro comando) */
  done: Promise<void>;
  cancel(): void;
}

class Task implements MotionTask {
  remaining = 0;
  readonly done: Promise<void>;
  private resolve!: () => void;

  constructor(private readonly engine: MotionEngine) {
    this.done = new Promise((r) => (this.resolve = r));
  }

  release() {
    if (--this.remaining <= 0) this.resolve();
  }

  cancel() {
    this.engine.cancelTask(this);
  }
}

export class MotionEngine {
  private readonly channels = new Map<string, Channel>();
  private readonly tracks = new Map<string, Track>();
  /** Posición comandada (getAngles(useSensors=false)); difiere del sensor con stiffness 0 */
  private readonly commanded = new Map<string, number>();
  private readonly stiffTracks = new Map<string, { t: number; times: number[]; values: number[]; task: Task }>();
  private readonly agenda: { at: number; fn: () => void }[] = [];
  /** Tiempo de movimiento transcurrido (s); avanza con update() */
  time = 0;

  constructor(private readonly state: RobotState) {
    for (const spec of JOINTS) {
      this.channels.set(spec.name, {
        get: () => state.get(spec.name),
        maxVelocity: spec.maxVelocity,
        enabled: () => state.getStiffness(spec.name) > 0,
      });
    }
  }

  /**
   * Llamar en cada frame con el tiempo real transcurrido. Avanza exactamente `dt`, en subpasos de
   * hasta un ciclo de ALMotion. (Con pasos fijos de 20 ms la pose solo cambiaba a 50 Hz: en pantallas
   * de 60/120 Hz se repetía en frames irregulares y el robot parecía vibrar.)
   */
  update(dt: number): void {
    let remaining = Math.min(dt, 5 * MOTION_CYCLE); // pestaña congelada: no recuperar el tiempo perdido
    while (remaining > 1e-6) {
      const h = Math.min(remaining, MOTION_CYCLE);
      this.step(h);
      this.time += h;
      remaining -= h;
      this.runAgenda();
    }
  }

  /** Ejecuta `fn` cuando el reloj de movimiento llegue a `at` (s). Para cambios en límites de ciclo. */
  schedule(at: number, fn: () => void): void {
    this.agenda.push({ at, fn });
    this.agenda.sort((a, b) => a.at - b.at);
  }

  private runAgenda(): void {
    while (this.agenda.length && this.agenda[0].at <= this.time + 1e-9) this.agenda.shift()!.fn();
  }

  maxVelocity(name: string): number {
    return this.channel(name).maxVelocity;
  }

  /** Ángulo comandado. Sin trayectoria activa y con el motor apagado, sigue al sensor. */
  command(name: string): number {
    const tr = this.tracks.get(name);
    if (tr) return tr.pos;
    const ch = this.channel(name);
    if (!ch.enabled()) {
      // Motor apagado: el comando sigue al sensor, así al encenderlo el joint se queda donde está
      // (si no, volvería de golpe al último ángulo comandado)
      const v = ch.get();
      this.commanded.set(name, v);
      return v;
    }
    return this.commanded.get(name) ?? ch.get();
  }

  /**
   * Trayectorias por keyframes, todas en paralelo. Tiempos en segundos desde ahora (estrictamente
   * crecientes, > 0); valores absolutos. Reemplaza cualquier comando previo sobre esos canales.
   */
  interpolate(
    trajectories: Readonly<Record<string, { times: number[]; values: number[] }>>,
    { continuous = false }: { continuous?: boolean } = {},
  ): MotionTask {
    const task = new Task(this);
    for (const [name, { times, values }] of Object.entries(trajectories)) {
      const start = this.command(name);
      const ts = [0, ...times];
      const vs = [start, ...values.map((v) => this.clampValue(name, v))];
      const slopes = monotoneSlopes(ts, vs);
      // Encadenado: la curva nueva arranca con la velocidad que llevaba el joint (sin frenar en la unión)
      if (continuous) slopes[0] = this.tracks.get(name)?.vel ?? 0;
      this.startTrack(name, { kind: 'curve', t: 0, times: ts, values: vs, slopes }, task, start);
    }
    if (task.remaining === 0) task.release();
    return task;
  }

  /**
   * Movimiento sincronizado a objetivos usando una fracción de la velocidad máxima: el canal que
   * más tarda marca la duración y todos llegan a la vez.
   */
  interpolateWithSpeed(targets: Readonly<Record<string, number>>, fraction: number, minDuration = MOTION_CYCLE): MotionTask {
    const f = Math.min(Math.max(fraction, 0.01), 1);
    let duration = minDuration;
    for (const [name, target] of Object.entries(targets)) {
      const delta = Math.abs(this.clampValue(name, target) - this.command(name));
      // Una curva con velocidad final nula tiene pico de 1.5·Δ/T: T = 1.5·Δ / v
      duration = Math.max(duration, (1.5 * delta) / (f * this.channel(name).maxVelocity));
    }
    return this.interpolate(
      Object.fromEntries(Object.entries(targets).map(([n, v]) => [n, { times: [duration], values: [v] }])),
    );
  }

  /** Control reactivo (setAngles/changeAngles): no bloquea; un nuevo objetivo conserva la velocidad. */
  follow(targets: Readonly<Record<string, number>>, fraction: number): void {
    const task = new Task(this);
    for (const [name, target] of Object.entries(targets)) {
      const vmax = Math.min(Math.max(fraction, 0.01), 1) * this.channel(name).maxVelocity;
      this.startTrack(name, { kind: 'follow', target: this.clampValue(name, target), vmax }, task, this.command(name));
    }
    if (task.remaining === 0) task.release();
  }

  stopChannels(names: readonly string[]): void {
    for (const n of names) {
      const tr = this.tracks.get(n);
      if (!tr) continue;
      this.commanded.set(n, tr.pos);
      this.tracks.delete(n);
      tr.task.release();
    }
  }

  stopAll(): void {
    this.stopChannels([...this.tracks.keys()]);
  }

  cancelTask(task: MotionTask): void {
    this.stopChannels([...this.tracks].filter(([, tr]) => tr.task === task).map(([n]) => n));
  }

  /** Stiffness por keyframes (lineal), en paralelo. Tiempos en s desde ahora. */
  interpolateStiffness(trajectories: Readonly<Record<string, { times: number[]; values: number[] }>>): MotionTask {
    const task = new Task(this);
    for (const [name, { times, values }] of Object.entries(trajectories)) {
      const prev = this.stiffTracks.get(name);
      if (prev) prev.task.release();
      this.stiffTracks.set(name, {
        t: 0,
        times: [0, ...times],
        values: [this.state.getStiffness(name), ...values.map((v) => Math.min(Math.max(v, 0), 1))],
        task,
      });
      task.remaining++;
    }
    if (task.remaining === 0) task.release();
    return task;
  }

  setStiffness(name: string, value: number): void {
    const prev = this.stiffTracks.get(name);
    if (prev) {
      this.stiffTracks.delete(name);
      prev.task.release();
    }
    this.state.setStiffness(name, value);
  }

  /**
   * Qué comanda ahora un joint: una curva (angleInterpolation, posturas, animaciones), un seguimiento (setAngles) hacia
   * `target`, o nada. ALBasicAwareness lo usa para pausarse cuando otra actividad usa los motores de la cabeza.
   */
  activity(name: string): { kind: 'curve' } | { kind: 'follow'; target: number } | null {
    const tr = this.tracks.get(name);
    if (!tr) return null;
    return tr.kind === 'follow' ? { kind: 'follow', target: tr.target } : { kind: 'curve' };
  }

  /** ¿Hay trayectorias activas? */
  get busy(): boolean {
    return this.tracks.size > 0;
  }

  private channel(name: string): Channel {
    const ch = this.channels.get(name);
    if (!ch) throw new Error(`canal desconocido: ${name}`);
    return ch;
  }

  private clampValue(name: string, v: number): number {
    if (!Number.isFinite(v)) throw new Error(`valor inválido para ${name}: ${v}`);
    if (name === 'HeadPitch') return v; // su rango depende de HeadYaw: lo recorta RobotState
    const spec = JOINT_BY_NAME.get(name);
    return spec ? Math.min(Math.max(v, spec.min), spec.max) : v;
  }

  private startTrack(name: string, track: CurveTrack | FollowTrack, task: Task, start: number) {
    const prev = this.tracks.get(name);
    if (prev) prev.task.release();
    this.tracks.set(name, { ...track, task, pos: prev?.pos ?? start, vel: prev?.vel ?? 0 });
    task.remaining++;
  }

  private step(h: number): void {
    const writes: Record<string, number> = {};

    for (const [name, tr] of this.tracks) {
      const ch = this.channel(name);
      let p: number;
      let finished: boolean;

      if (tr.kind === 'curve') {
        tr.t += h;
        const end = tr.values[tr.values.length - 1];
        // El motor real no supera su velocidad máxima: si la trayectoria pide más, va con retraso
        const maxStep = ch.maxVelocity * h;
        p = tr.pos + clamp(evalCurve(tr, tr.t) - tr.pos, -maxStep, maxStep);
        finished = tr.t >= tr.times[tr.times.length - 1] && Math.abs(p - end) < 1e-4;
        if (finished) p = end;
      } else {
        // Perfil trapezoidal: acelera hasta vmax y frena a tiempo. APPROX: aceleración = vmax / 0.1 s
        const a = Math.max(tr.vmax / 0.1, 1);
        const err = tr.target - tr.pos;
        const vDesired = Math.sign(err) * Math.min(tr.vmax, Math.sqrt(2 * a * Math.abs(err)));
        const v = tr.vel + clamp(vDesired - tr.vel, -a * h, a * h);
        p = tr.pos + v * h;
        finished = Math.abs(tr.target - p) < 1e-4 || Math.sign(tr.target - p) !== Math.sign(err);
        if (finished) p = tr.target;
      }

      tr.vel = (p - tr.pos) / h;
      tr.pos = p;
      // Los joints los mueve la simulación; las manos (sin física) se escriben aquí
      if (ch.enabled() && name.endsWith('Hand')) writes[name] = p;
      if (finished) {
        this.commanded.set(name, p);
        this.tracks.delete(name);
        tr.task.release();
      }
    }

    for (const [name, st] of this.stiffTracks) {
      st.t += h;
      const last = st.times[st.times.length - 1];
      this.state.setStiffness(name, evalLinear(st.times, st.values, Math.min(st.t, last)));
      if (st.t >= last) {
        this.stiffTracks.delete(name);
        st.task.release();
      }
    }

    if (Object.keys(writes).length) this.state.setMany(writes);
  }
}

const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi);

function segment(times: number[], t: number): number {
  let i = 0;
  while (i < times.length - 2 && t > times[i + 1]) i++;
  return i;
}

function evalLinear(times: number[], values: number[], t: number): number {
  const i = segment(times, t);
  const s = clamp((t - times[i]) / (times[i + 1] - times[i]), 0, 1);
  return values[i] + (values[i + 1] - values[i]) * s;
}

/**
 * Pendientes de una spline de Hermite monótona (Fritsch–Butland): no se pasa de los keyframes y
 * empieza/termina con velocidad nula. APPROX: ALMotion no documenta su interpolador exacto.
 */
function monotoneSlopes(times: number[], values: number[]): number[] {
  const n = times.length;
  const d = Array.from({ length: n - 1 }, (_, i) => (values[i + 1] - values[i]) / (times[i + 1] - times[i]));
  return Array.from({ length: n }, (_, i) => {
    if (i === 0 || i === n - 1) return 0;
    if (d[i - 1] * d[i] <= 0) return 0;
    return 2 / (1 / d[i - 1] + 1 / d[i]);
  });
}

function evalCurve({ times, values, slopes }: CurveTrack, t: number): number {
  if (t >= times[times.length - 1]) return values[values.length - 1];
  const i = segment(times, t);
  const dt = times[i + 1] - times[i];
  const s = clamp((t - times[i]) / dt, 0, 1);
  const s2 = s * s;
  const s3 = s2 * s;
  return (
    (2 * s3 - 3 * s2 + 1) * values[i] +
    (s3 - 2 * s2 + s) * dt * slopes[i] +
    (-2 * s3 + 3 * s2) * values[i + 1] +
    (s3 - s2) * dt * slopes[i + 1]
  );
}
