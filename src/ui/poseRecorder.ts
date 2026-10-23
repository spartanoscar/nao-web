// Grabador de poses: para enseñarle al robot un movimiento a mano (p. ej. levantarse de espaldas o desde sentado). Se mueven
// las articulaciones con los sliders (la física responde en vivo), se guarda cada pose como keyframe con su
// duración y se prueba la secuencia completa con ALMotion.angleInterpolation, como un timeline de Choregraphe.
// Se guarda solo en este navegador; "Copiar" la exporta en JSON (grados) para incorporarla al proyecto.

import type { ALMotion } from '../naoqi/ALMotion';
import type { MotionEngine } from '../naoqi/engine';
import { COUPLED, JOINTS } from '../robot/naoV6';

const STORAGE_KEY = 'nao.poseRecorder';
const DEG = Math.PI / 180;
/** Todas las articulaciones menos RHipYawPitch (es el mismo motor que LHipYawPitch) */
const NAMES = JOINTS.map((j) => j.name).filter((n) => !(n in COUPLED));

/** Desde dónde se enseña: "Probar" reinicia ahí y "Copiar" nombra el movimiento según eso */
export type PoseOrigin = 'back' | 'sit' | 'stand';

/** Lo que el modo animador (ui/animator.ts) usa del grabador: mismas poses, mismo formato */
export interface PoseRecorder {
  start(origin: PoseOrigin): Promise<boolean>;
  readonly origin: PoseOrigin;
  /** Guarda la pose actual (comandos); devuelve cuántas hay */
  add(): number;
  /** Borra la última; devuelve cuántas quedan */
  removeLast(): number;
  /** Reinicia en el origen y reproduce todo; devuelve la duración o null si no hay poses */
  play(): Promise<number | null>;
  copy(): Promise<boolean>;
  count(): number;
  duration(): number;
  /** Reemplaza las poses (p. ej. un movimiento encontrado por el laboratorio) y fija desde dónde se prueba */
  load(frames: Keyframe[], origin: PoseOrigin): void;
  /** Lo pone app.ts: abre el modo animador (botón del grabador) */
  openAnimator?: () => void;
}

export interface Keyframe {
  /** Segundos para llegar a esta pose desde la anterior */
  duration: number;
  /** Ángulo comandado por joint (rad; manos 0–1) */
  angles: Record<string, number>;
}

export function attachPoseRecorder(
  host: HTMLElement,
  motion: ALMotion,
  engine: MotionEngine,
  starts: Record<PoseOrigin, () => Promise<boolean>>,
): PoseRecorder {
  let frames: Keyframe[] = [];
  let origin: PoseOrigin = 'back';
  try {
    const o = localStorage.getItem(`${STORAGE_KEY}.origin`);
    if (o === 'sit' || o === 'stand') origin = o;
  } catch {
    /* sin almacenamiento */
  }
  const startAt = (o: PoseOrigin) => {
    origin = o;
    try {
      localStorage.setItem(`${STORAGE_KEY}.origin`, o);
    } catch {
      /* sin almacenamiento */
    }
    return starts[o]();
  };
  try {
    frames = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '[]');
  } catch {
    /* sin almacenamiento */
  }
  const save = () => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(frames));
    } catch {
      /* modo privado */
    }
  };

  const section = document.createElement('details');
  section.className = 'chain pose-recorder';
  const summary = document.createElement('summary');
  summary.textContent = 'Grabador de poses';
  const help = document.createElement('p');
  help.className = 'joint-note';
  help.textContent =
    'Mueve las articulaciones con los sliders de abajo (o con el modo animador: toca la pieza y usa las flechas) y guarda cada pose. "Probar" reinicia donde empezaste y reproduce todo.';
  const status = document.createElement('div');
  status.className = 'activity';
  const list = document.createElement('ol');
  list.className = 'keyframes';

  // Comando de cada joint (lo que pidió el slider), no el sensor: con carga el sensor se queda corto
  const current = (): Record<string, number> => Object.fromEntries(NAMES.map((n) => [n, engine.command(n)]));
  const say = (text: string, error = false) => {
    status.textContent = text;
    status.classList.toggle('error', error);
  };
  const goTo = (k: Keyframe, seconds: number) =>
    motion.angleInterpolation(NAMES, NAMES.map((n) => k.angles[n]), NAMES.map(() => seconds), true);

  const render = () => {
    list.replaceChildren(
      ...frames.map((k, i) => {
        const row = document.createElement('li');
        const duration = document.createElement('input');
        duration.type = 'number';
        duration.min = '0.1';
        duration.max = '10';
        duration.step = '0.1';
        duration.value = String(k.duration);
        duration.title = 'Segundos para llegar a esta pose desde la anterior';
        duration.addEventListener('change', () => {
          k.duration = Math.min(Math.max(Number(duration.value) || 0.8, 0.1), 10);
          duration.value = String(k.duration);
          save();
        });
        const unit = document.createElement('span');
        unit.textContent = 's';
        row.append(
          duration,
          unit,
          chip('Ir', 'Mover el robot a esta pose (1 s)', () => void goTo(k, 1)),
          chip('Reemplazar', 'Guardar aquí la pose actual', () => {
            k.angles = current();
            save();
            say(`Pose ${i + 1} reemplazada`);
          }),
          chip('×', 'Borrar esta pose', () => {
            frames.splice(i, 1);
            save();
            render();
          }),
        );
        return row;
      }),
    );
  };

  const buttons = document.createElement('div');
  buttons.className = 'chips';
  buttons.append(
    chip('Modo animador', 'Toca la pieza del robot y muévela con las flechas (sin sliders)', () => api.openAnimator?.()),
    chip('Empezar boca arriba', 'Acuesta al robot de espaldas, con los motores encendidos', async () => {
      say((await startAt('back')) ? 'Boca arriba, motores encendidos' : 'Hace falta la física (MuJoCo)', false);
    }),
    chip('Empezar sentado', 'Sienta al robot (postura Sit), con los motores encendidos', async () => {
      say((await startAt('sit')) ? 'Sentado, motores encendidos' : 'Hace falta la física (MuJoCo)', false);
    }),
    chip('Empezar de pie', 'Pone al robot en StandInit, con los motores encendidos', async () => {
      say((await startAt('stand')) ? 'De pie, motores encendidos' : 'Hace falta la física (MuJoCo)', false);
    }),
    chip('Guardar pose', 'Añade la pose actual como keyframe', () => {
      say(`Pose ${api.add()} guardada`);
    }),
    chip('Probar', 'Reinicia donde empezaste (boca arriba, sentado o de pie) y reproduce toda la secuencia', async () => {
      if (!frames.length) return say('Primero guarda alguna pose', true);
      say('▶ angleInterpolation…');
      const t = await api.play();
      say(t === null ? 'Hace falta la física (MuJoCo)' : `Listo (${t.toFixed(1)} s)`, t === null);
    }),
    chip('Copiar', 'Copia la secuencia en JSON (grados) para pegarla en el chat', async () => {
      say((await api.copy()) ? `Copiado: ${frames.length} poses` : 'No pude usar el portapapeles', !frames.length);
    }),
    chip('Borrar todo', 'Borra todas las poses guardadas', () => {
      if (!frames.length || !confirm(`¿Borrar las ${frames.length} poses?`)) return;
      frames = [];
      save();
      render();
    }),
  );

  const api: PoseRecorder = {
    start: startAt,
    get origin() {
      return origin;
    },
    add() {
      frames.push({ duration: frames.length ? 0.8 : 1, angles: current() });
      save();
      render();
      return frames.length;
    },
    removeLast() {
      frames.pop();
      save();
      render();
      return frames.length;
    },
    async play() {
      if (!frames.length || !(await startAt(origin))) return null;
      let t = 0;
      const times = frames.map((k) => (t += k.duration));
      await motion.angleInterpolation(NAMES, NAMES.map((n) => frames.map((k) => k.angles[n])), NAMES.map(() => times), true);
      return t;
    },
    async copy() {
      if (!frames.length) return false;
      const json = JSON.stringify({
        name: origin === 'sit' ? 'StandUpFromSit' : origin === 'back' ? 'StandUpFromBack' : 'TaughtMotion',
        joints: NAMES,
        keyframes: frames.map((k) => ({
          duration: k.duration,
          angles: NAMES.map((n) => (n.endsWith('Hand') ? +k.angles[n].toFixed(2) : +(k.angles[n] / DEG).toFixed(1))),
        })),
      });
      try {
        await navigator.clipboard.writeText(json);
        return true;
      } catch {
        return false;
      }
    },
    load(next, o) {
      frames = next.map((k) => ({ duration: k.duration, angles: Object.fromEntries(NAMES.map((n) => [n, k.angles[n] ?? 0])) }));
      origin = o;
      try {
        localStorage.setItem(`${STORAGE_KEY}.origin`, o);
      } catch {
        /* sin almacenamiento */
      }
      save();
      render();
    },
    count: () => frames.length,
    duration: () => frames.reduce((t, k) => t + k.duration, 0),
  };

  section.append(summary, help, buttons, status, list);
  host.append(section);
  render();
  return api;
}

function chip(label: string, title: string, onClick: () => void): HTMLButtonElement {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'chip';
  b.textContent = label;
  b.title = title;
  b.addEventListener('click', onClick);
  return b;
}
