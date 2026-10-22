// Modo animador: enseñar movimientos tocando el robot en vez de usar 25 sliders. El cursor elige la pieza (se pinta
// como con los sliders) y las flechas mueven sus ejes: ↑↓ el principal (p. ej. levantar el brazo, ShoulderPitch) y ←→
// el otro (abrirlo, ShoulderRoll); Q/E la cadera girada (HipYawPitch). Shift = ajuste fino. M = espejo (el otro lado
// copia el gesto). Las poses van al mismo grabador (ui/poseRecorder.ts): S guarda, B borra la última, R prueba desde
// la pose de partida, C copia el JSON. Esc sale. Mientras está activo, el teclado no hace caminar al robot.

import * as THREE from 'three';
import type { Session } from '../naoqi/session';
import type { NaoModel } from '../sim/naoModel';
import type { World } from '../sim/world';
import type { PoseOrigin, PoseRecorder } from './poseRecorder';

/** Un eje de una pieza: el joint (sin L/R), qué hace la flecha "positiva" y su signo en el lado izquierdo */
interface Axis {
  joint: string;
  /** [flecha negativa, flecha positiva] */
  words: [string, string];
  /** Signo del joint izquierdo para la flecha positiva (↑ o →) */
  sign: number;
  /** El lado derecho es el espejo: roll y yaw cambian de signo */
  flip: boolean;
}

interface Part {
  name: string;
  joints: string[];
  ud?: Axis;
  lr?: Axis;
  qe?: Axis;
}

const PARTS: Part[] = [
  {
    name: 'Cabeza',
    joints: ['HeadYaw', 'HeadPitch'],
    ud: { joint: 'HeadPitch', words: ['bajar', 'subir la mirada'], sign: -1, flip: false },
    lr: { joint: 'HeadYaw', words: ['a su izquierda', 'a su derecha'], sign: -1, flip: false },
  },
  {
    name: 'Brazo',
    joints: ['ShoulderPitch', 'ShoulderRoll'],
    ud: { joint: 'ShoulderPitch', words: ['bajar', 'levantar'], sign: -1, flip: false },
    lr: { joint: 'ShoulderRoll', words: ['cerrar', 'abrir'], sign: 1, flip: true },
  },
  {
    name: 'Antebrazo',
    joints: ['ElbowYaw', 'ElbowRoll'],
    ud: { joint: 'ElbowRoll', words: ['estirar', 'doblar el codo'], sign: -1, flip: true },
    lr: { joint: 'ElbowYaw', words: ['girar adentro', 'girar afuera'], sign: -1, flip: true },
  },
  {
    name: 'Mano',
    joints: ['WristYaw', 'Hand'],
    ud: { joint: 'Hand', words: ['cerrar', 'abrir'], sign: 1, flip: false },
    lr: { joint: 'WristYaw', words: ['girar adentro', 'girar afuera'], sign: -1, flip: true },
  },
  {
    name: 'Muslo',
    joints: ['HipYawPitch', 'HipRoll', 'HipPitch'],
    ud: { joint: 'HipPitch', words: ['atrás', 'adelante'], sign: -1, flip: false },
    lr: { joint: 'HipRoll', words: ['cerrar', 'abrir'], sign: 1, flip: true },
    qe: { joint: 'HipYawPitch', words: ['juntar', 'girar la cadera'], sign: -1, flip: false },
  },
  {
    name: 'Pierna',
    joints: ['KneePitch'],
    ud: { joint: 'KneePitch', words: ['estirar', 'doblar la rodilla'], sign: 1, flip: false },
  },
  {
    name: 'Pie',
    joints: ['AnklePitch', 'AnkleRoll'],
    ud: { joint: 'AnklePitch', words: ['punta abajo', 'punta arriba'], sign: -1, flip: false },
    lr: { joint: 'AnkleRoll', words: ['hacia adentro', 'hacia afuera'], sign: 1, flip: true },
  },
];

const STEP = (5 * Math.PI) / 180;
const FINE = (1 * Math.PI) / 180;
const HAND_STEP = 0.1;
const DEG = 180 / Math.PI;
const SIDES: Record<string, string> = { L: 'izquierdo', R: 'derecho' };
const STARTS: [PoseOrigin, string][] = [
  ['sit', 'Sentado'],
  ['back', 'Boca arriba'],
  ['stand', 'De pie'],
];

/** Pieza de un joint del robot ("LElbowRoll" → Antebrazo, lado L) */
function partOf(joint: string): { part: Part; side: 'L' | 'R' | '' } | null {
  const side = /^[LR](?=[A-Z])/.test(joint) ? (joint[0] as 'L' | 'R') : '';
  const base = side ? joint.slice(1) : joint;
  const part = PARTS.find((p) => p.joints.includes(base));
  return part ? { part, side } : null;
}

/** HipYawPitch es un solo motor (RHipYawPitch lo sigue): siempre el izquierdo */
const jointName = (axis: Axis, side: string) => (axis.joint === 'HipYawPitch' ? 'LHipYawPitch' : side + axis.joint);

export function attachAnimator(world: World, model: NaoModel, session: Session, recorder: PoseRecorder): { open(): void } {
  const motion = session.service('ALMotion');
  const engine = session.engine;
  const canvas = world.renderer.domElement;
  const raycaster = new THREE.Raycaster();
  const pointer = new THREE.Vector2();

  const bar = document.createElement('div');
  bar.id = 'animator';
  bar.hidden = true;
  bar.innerHTML = `
    <div class="an-row">
      <span class="an-title">Modo animador</span>
      <span class="an-part">Toca una pieza del robot</span>
      <span class="an-axes"></span>
      <button type="button" class="an-mirror" title="Espejo (M): el otro lado copia el gesto">Espejo</button>
    </div>
    <div class="an-row">
      <span class="an-starts"><span>Empezar</span></span>
      <span class="an-keys"><kbd>S</kbd> guardar <kbd>B</kbd> borrar última <kbd>R</kbd> probar <kbd>C</kbd> copiar <kbd>Shift</kbd> fino <kbd>Esc</kbd> salir</span>
      <span class="an-count"></span>
      <span class="an-msg" aria-live="polite"></span>
    </div>`;
  document.body.append(bar);
  const $ = <T extends HTMLElement>(sel: string) => bar.querySelector<T>(sel)!;
  const partLabel = $('.an-part');
  const axesLabel = $('.an-axes');
  const mirrorButton = $<HTMLButtonElement>('.an-mirror');
  const count = $('.an-count');
  const msg = $('.an-msg');
  for (const [origin, label] of STARTS) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'an-start';
    b.textContent = label;
    b.addEventListener('click', async () => {
      say(`${label}…`);
      say((await recorder.start(origin)) ? `${label}: listo` : 'Hace falta la física (MuJoCo)');
      refresh();
    });
    $('.an-starts').append(b);
  }

  let active = false;
  let mirror = false;
  let selected: { part: Part; side: 'L' | 'R' | '' } | null = null;
  let selectedJoint: string | null = null;
  let hovered: string | null = null;
  let msgTimer = 0;

  const say = (text: string) => {
    msg.textContent = text;
    clearTimeout(msgTimer);
    msgTimer = window.setTimeout(() => (msg.textContent = ''), 3000);
  };
  const paint = () => {
    model.highlight(selectedJoint ?? hovered);
    world.invalidate();
  };
  const refresh = () => {
    mirrorButton.setAttribute('aria-pressed', String(mirror));
    count.textContent = `${recorder.count()} poses · ${recorder.duration().toFixed(1)} s`;
    if (!selected) {
      partLabel.textContent = 'Toca una pieza del robot';
      axesLabel.textContent = '';
      return;
    }
    const { part, side } = selected;
    partLabel.textContent = side ? `${part.name} ${SIDES[side]}` : part.name;
    const show = (keys: string, axis?: Axis) => {
      if (!axis) return '';
      const name = jointName(axis, side);
      const v = engine.command(name);
      const value = name.endsWith('Hand') ? `${Math.round(v * 100)}%` : `${Math.round(v * DEG)}°`;
      return `<span><kbd>${keys}</kbd> ${axis.words[0]} / ${axis.words[1]} <b>${name} ${value}</b></span>`;
    };
    axesLabel.innerHTML = show('↑↓', selected.part.ud) + show('←→', selected.part.lr) + show('Q E', selected.part.qe);
  };

  /** Mueve un eje: dir = +1 (↑, →, E) o −1; con espejo, el mismo gesto en el otro lado */
  const nudge = (axis: Axis | undefined, dir: number, fine: boolean) => {
    if (!axis || !selected) return;
    const step = axis.joint === 'Hand' ? (fine ? HAND_STEP / 4 : HAND_STEP) : fine ? FINE : STEP;
    const sides = mirror && selected.side && axis.joint !== 'HipYawPitch' ? ['L', 'R'] : [selected.side];
    for (const side of sides) {
      const name = jointName(axis, side);
      const sign = axis.sign * (side === 'R' && axis.flip ? -1 : 1);
      engine.manual(name, engine.command(name) + dir * sign * step);
    }
    refresh();
  };

  const pick = (e: PointerEvent): string | null => {
    const r = canvas.getBoundingClientRect();
    pointer.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    raycaster.setFromCamera(pointer, world.camera);
    for (const hit of raycaster.intersectObjects(model.pickables(), false)) {
      const joint = model.jointAt(hit.object);
      if (joint && partOf(joint)) return joint;
    }
    return null;
  };

  // Clic (sin arrastrar, para no confundirlo con girar la cámara) = elegir pieza; clic al vacío = soltarla
  let down: { x: number; y: number } | null = null;
  canvas.addEventListener('pointerdown', (e) => {
    if (active) down = { x: e.clientX, y: e.clientY };
  });
  canvas.addEventListener('pointerup', (e) => {
    if (!active || !down || Math.hypot(e.clientX - down.x, e.clientY - down.y) > 5) return;
    down = null;
    selectedJoint = pick(e);
    selected = selectedJoint ? partOf(selectedJoint) : null;
    paint();
    refresh();
  });
  let hoverQueued = false;
  canvas.addEventListener('pointermove', (e) => {
    if (!active || e.buttons || hoverQueued) return;
    hoverQueued = true;
    requestAnimationFrame(() => {
      hoverQueued = false;
      const h = pick(e);
      if (h !== hovered) {
        hovered = h;
        canvas.style.cursor = h ? 'pointer' : '';
        paint();
      }
    });
  });

  // En captura: antes que el teclado de caminar y que el panel oculto
  window.addEventListener(
    'keydown',
    (e) => {
      if (!active) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName))) return;
      const fine = e.shiftKey;
      const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
      const part = selected?.part;
      const handled = (() => {
        switch (k) {
          case 'ArrowUp':
            return nudge(part?.ud, 1, fine), true;
          case 'ArrowDown':
            return nudge(part?.ud, -1, fine), true;
          case 'ArrowRight':
            return nudge(part?.lr, 1, fine), true;
          case 'ArrowLeft':
            return nudge(part?.lr, -1, fine), true;
          case 'e':
            return nudge(part?.qe, 1, fine), true;
          case 'q':
            return nudge(part?.qe, -1, fine), true;
          case 's':
            return say(`Pose ${recorder.add()} guardada`), refresh(), true;
          case 'b':
            return say(`Quedan ${recorder.removeLast()} poses`), refresh(), true;
          case 'r':
            say('▶ Probando desde la pose de partida…');
            void recorder.play().then((t) => say(t === null ? 'Guarda alguna pose primero' : `Listo (${t.toFixed(1)} s)`));
            return true;
          case 'c':
            void recorder.copy().then((ok) => say(ok ? 'JSON copiado: pégalo en el chat' : 'No hay poses o no pude copiar'));
            return true;
          case 'm':
            mirror = !mirror;
            say(mirror ? 'Espejo activado' : 'Espejo apagado');
            return refresh(), true;
          case 'Escape':
            return close(), true;
          default:
            return false;
        }
      })();
      if (handled) {
        e.preventDefault();
        e.stopPropagation();
      }
    },
    true,
  );
  window.addEventListener('keyup', (e) => active && e.key.startsWith('Arrow') && e.stopPropagation(), true);
  mirrorButton.addEventListener('click', () => {
    mirror = !mirror;
    refresh();
  });

  const close = () => {
    active = false;
    bar.hidden = true;
    document.body.classList.remove('animating');
    selected = null;
    selectedJoint = hovered = null;
    canvas.style.cursor = '';
    paint();
  };

  return {
    open() {
      active = true;
      bar.hidden = false;
      document.body.classList.add('animating');
      document.body.classList.remove('panel-visible'); // el robot a la vista
      // Motores encendidos sosteniendo la pose actual (con motores apagados la física lo dejaría caer)
      if (!motion.robotIsWakeUp()) {
        const names = motion.getBodyNames('Body').filter((j) => !j.endsWith('Hand') && j !== 'RHipYawPitch');
        void motion.angleInterpolationWithSpeed(names, motion.getAngles(names, true), 0.2);
        motion.setStiffnesses('Body', 1);
      }
      refresh();
      say('Toca una pieza y muévela con las flechas');
    },
  };
}
