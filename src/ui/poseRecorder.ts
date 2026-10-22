// Grabador de poses: para enseñarle al robot un movimiento a mano (p. ej. levantarse de espaldas). Se mueven
// las articulaciones con los sliders (la física responde en vivo), se guarda cada pose como keyframe con su
// duración y se prueba la secuencia completa con ALMotion.angleInterpolation, como un timeline de Choregraphe.
// Se guarda solo en este navegador; "Copiar" la exporta en JSON (grados) para incorporarla al proyecto.

import type { ALMotion } from '../naoqi/ALMotion';
import type { MotionEngine } from '../naoqi/engine';
import { COUPLED, JOINTS } from '../robot/naoV6';

const STORAGE_KEY = 'nao.poseRecorder';
const BOOT_KEY = 'nao.bootLyingBack';

/** ¿Arrancar boca arriba al abrir la página? (opción del grabador, recordada en este navegador) */
export function bootsLyingBack(): boolean {
  try {
    return localStorage.getItem(BOOT_KEY) === '1';
  } catch {
    return false;
  }
}
const DEG = Math.PI / 180;
/** Todas las articulaciones menos RHipYawPitch (es el mismo motor que LHipYawPitch) */
const NAMES = JOINTS.map((j) => j.name).filter((n) => !(n in COUPLED));

interface Keyframe {
  /** Segundos para llegar a esta pose desde la anterior */
  duration: number;
  /** Ángulo comandado por joint (rad; manos 0–1) */
  angles: Record<string, number>;
}

export function attachPoseRecorder(
  host: HTMLElement,
  motion: ALMotion,
  engine: MotionEngine,
  { startLyingBack }: { startLyingBack(): Promise<boolean> },
): void {
  let frames: Keyframe[] = [];
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
    'Mueve las articulaciones con los sliders de abajo y guarda cada pose. "Probar" reinicia boca arriba y reproduce todo.';
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
    chip('Empezar boca arriba', 'Acuesta al robot de espaldas, con los motores encendidos', async () => {
      say((await startLyingBack()) ? 'Boca arriba, motores encendidos' : 'Hace falta la física (MuJoCo)', false);
    }),
    chip('Guardar pose', 'Añade la pose actual como keyframe', () => {
      frames.push({ duration: frames.length ? 0.8 : 1, angles: current() });
      save();
      render();
      say(`Pose ${frames.length} guardada`);
    }),
    chip('Probar', 'Reinicia boca arriba y reproduce toda la secuencia', async () => {
      if (!frames.length) return say('Primero guarda alguna pose', true);
      if (!(await startLyingBack())) return say('Hace falta la física (MuJoCo)', true);
      say('▶ angleInterpolation…');
      let t = 0;
      const times = frames.map((k) => (t += k.duration));
      await motion.angleInterpolation(NAMES, NAMES.map((n) => frames.map((k) => k.angles[n])), NAMES.map(() => times), true);
      say(`Listo (${t.toFixed(1)} s)`);
    }),
    chip('Copiar', 'Copia la secuencia en JSON (grados) para pegarla en el chat', async () => {
      const json = JSON.stringify({
        name: 'StandUpFromBack',
        joints: NAMES,
        keyframes: frames.map((k) => ({
          duration: k.duration,
          angles: NAMES.map((n) => (n.endsWith('Hand') ? +k.angles[n].toFixed(2) : +(k.angles[n] / DEG).toFixed(1))),
        })),
      });
      try {
        await navigator.clipboard.writeText(json);
        say(`Copiado: ${frames.length} poses`);
      } catch {
        say('No pude usar el portapapeles', true);
      }
    }),
    chip('Borrar todo', 'Borra todas las poses guardadas', () => {
      if (!frames.length || !confirm(`¿Borrar las ${frames.length} poses?`)) return;
      frames = [];
      save();
      render();
    }),
  );

  const boot = document.createElement('label');
  boot.className = 'boot-option';
  const check = document.createElement('input');
  check.type = 'checkbox';
  check.checked = bootsLyingBack();
  check.addEventListener('change', () => {
    try {
      localStorage.setItem(BOOT_KEY, check.checked ? '1' : '0');
    } catch {
      /* modo privado */
    }
  });
  boot.append(check, ' Arrancar boca arriba al abrir la página');

  section.append(summary, help, boot, buttons, status, list);
  host.append(section);
  render();
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
