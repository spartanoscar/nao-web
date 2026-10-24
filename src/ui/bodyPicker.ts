// Mover una pieza del NAO a mano, sin interfaz (Oscar, 2026-10-24): con Shift sostenido la pieza bajo el cursor se pinta
// de amarillo; Shift + clic la elige (queda amarilla) y las flechas la mueven: ↑↓ el eje principal (p. ej. levantar el
// brazo, ShoulderPitch) y ←→ el otro (abrirlo, ShoulderRoll); Q/E la cadera girada (HipYawPitch). 5° por tecla, 1° con
// Alt. Esc la suelta. Mientras hay una pieza elegida, las flechas y Q/E no hacen caminar al robot. Todo pasa por
// ALMotion.setAngles (con física: el motor la lleva y la gravedad y los choques cuentan); apagado (ui/power.ts) no se mueve.

import * as THREE from 'three';
import type { Session } from '../naoqi/session';
import { JOINT_BY_NAME } from '../robot/naoV6';
import type { NaoModel } from '../sim/naoModel';
import type { World } from '../sim/world';
import type { Power } from './power';

/** Un eje de una pieza: el joint (sin L/R), su signo en el lado izquierdo para la flecha "positiva" (↑, →, E) */
interface Axis {
  joint: string;
  sign: number;
  /** El lado derecho es el espejo: roll y yaw cambian de signo */
  flip: boolean;
}

/** Piezas con sus ejes (las mismas del modo animador que se retiró) */
const PARTS: { joints: string[]; ud?: Axis; lr?: Axis; qe?: Axis }[] = [
  { joints: ['HeadYaw', 'HeadPitch'], ud: { joint: 'HeadPitch', sign: -1, flip: false }, lr: { joint: 'HeadYaw', sign: -1, flip: false } },
  // Brazo: ↑ levantar, → abrir
  { joints: ['ShoulderPitch', 'ShoulderRoll'], ud: { joint: 'ShoulderPitch', sign: -1, flip: false }, lr: { joint: 'ShoulderRoll', sign: 1, flip: true } },
  // Antebrazo: ↑ doblar el codo, → girar afuera
  { joints: ['ElbowYaw', 'ElbowRoll'], ud: { joint: 'ElbowRoll', sign: -1, flip: true }, lr: { joint: 'ElbowYaw', sign: -1, flip: true } },
  // Mano: ↑ abrir, → girar la muñeca afuera
  { joints: ['WristYaw', 'Hand'], ud: { joint: 'Hand', sign: 1, flip: false }, lr: { joint: 'WristYaw', sign: -1, flip: true } },
  // Muslo: ↑ adelante, → abrir, E girar la cadera
  {
    joints: ['HipYawPitch', 'HipRoll', 'HipPitch'],
    ud: { joint: 'HipPitch', sign: -1, flip: false },
    lr: { joint: 'HipRoll', sign: 1, flip: true },
    qe: { joint: 'HipYawPitch', sign: -1, flip: false },
  },
  // Pierna: ↑ doblar la rodilla
  { joints: ['KneePitch'], ud: { joint: 'KneePitch', sign: 1, flip: false } },
  // Pie: ↑ punta arriba, → hacia afuera
  { joints: ['AnklePitch', 'AnkleRoll'], ud: { joint: 'AnklePitch', sign: -1, flip: false }, lr: { joint: 'AnkleRoll', sign: 1, flip: true } },
];

const STEP = (5 * Math.PI) / 180;
const FINE = (1 * Math.PI) / 180;
/** Mano: 0 cerrada a 1 abierta */
const HAND_STEP = 0.1;
/** Fracción de la velocidad máxima con que el motor lleva la pieza a cada nuevo ángulo */
const SPEED = 0.3;
/** Toques seguidos (menos de esto entre uno y otro, s) suman sobre el último blanco, no sobre donde va la pieza */
const CHAIN_S = 1;

function partOf(joint: string) {
  const side = /^[LR](?=[A-Z])/.test(joint) ? joint[0] : '';
  const base = side ? joint.slice(1) : joint;
  const part = PARTS.find((p) => p.joints.includes(base));
  return part ? { part, side } : null;
}

/** HipYawPitch es un solo motor (RHipYawPitch lo sigue): siempre el izquierdo */
const jointName = (axis: Axis, side: string) => (axis.joint === 'HipYawPitch' ? 'LHipYawPitch' : side + axis.joint);

export function attachBodyPicker(world: World, model: NaoModel, session: Session, power: Pick<Power, 'ready'>): void {
  const motion = session.service('ALMotion');
  const canvas = world.renderer.domElement;
  const raycaster = new THREE.Raycaster();
  const pointer = new THREE.Vector2();

  let shift = false;
  let selected: string | null = null;
  let hovered: string | null = null;
  let last: { x: number; y: number } | null = null;
  /** Último blanco de cada joint y cuándo se pidió */
  const targets = new Map<string, { value: number; at: number }>();

  const paint = () => {
    model.highlight(hovered ?? selected);
    canvas.style.cursor = hovered ? 'pointer' : '';
    world.invalidate();
  };

  const pick = (x: number, y: number): string | null => {
    const r = canvas.getBoundingClientRect();
    pointer.set(((x - r.left) / r.width) * 2 - 1, -((y - r.top) / r.height) * 2 + 1);
    raycaster.setFromCamera(pointer, world.camera);
    for (const hit of raycaster.intersectObjects(model.pickables(), false)) {
      const joint = model.jointAt(hit.object);
      if (joint && partOf(joint)) return joint;
    }
    return null;
  };

  const hover = () => {
    const h = shift && last ? pick(last.x, last.y) : null;
    if (h === hovered) return;
    hovered = h;
    paint();
  };

  /** Mueve un eje de la pieza elegida: dir = +1 (↑, →, E) o −1 */
  const nudge = (axis: Axis | undefined, dir: number, fine: boolean) => {
    if (!axis || !selected || !power.ready()) return;
    const side = partOf(selected)!.side;
    const name = jointName(axis, side);
    const sign = axis.sign * (side === 'R' && axis.flip ? -1 : 1);
    const step = axis.joint === 'Hand' ? (fine ? HAND_STEP / 4 : HAND_STEP) : fine ? FINE : STEP;
    // Con el motor apagado la pieza no obedecería (stiffness 0 = libre): se enciende solo ese motor
    if (motion.getStiffnesses(name)[0] < 0.5) motion.setStiffnesses(name, 1);
    const now = performance.now() / 1000;
    const prev = targets.get(name);
    const base = prev && now - prev.at < CHAIN_S ? prev.value : motion.getAngles(name, false)[0];
    // Dentro de los límites del joint (si no, los toques de más habría que "devolverlos" antes de que se mueva)
    const { min, max } = JOINT_BY_NAME.get(name)!;
    const value = Math.min(Math.max(base + dir * sign * step, min), max);
    targets.set(name, { value, at: now });
    motion.setAngles(name, value, SPEED);
  };

  let hoverQueued = false;
  canvas.addEventListener('pointermove', (e) => {
    last = { x: e.clientX, y: e.clientY };
    shift = e.shiftKey;
    if (e.buttons || hoverQueued) return;
    hoverQueued = true;
    requestAnimationFrame(() => {
      hoverQueued = false;
      hover();
    });
  });
  // Shift + clic (sin arrastrar, para no confundirlo con mover la cámara) = elegir la pieza bajo el cursor
  let down: { x: number; y: number } | null = null;
  canvas.addEventListener('pointerdown', (e) => {
    down = e.shiftKey ? { x: e.clientX, y: e.clientY } : null;
  });
  canvas.addEventListener('pointerup', (e) => {
    if (!down || !e.shiftKey || Math.hypot(e.clientX - down.x, e.clientY - down.y) > 5) return;
    down = null;
    const joint = pick(e.clientX, e.clientY);
    if (joint) selected = joint;
    paint();
  });

  // En captura: antes que el teclado de caminar (ui/keyboard.ts)
  window.addEventListener(
    'keydown',
    (e) => {
      if (e.key === 'Shift') {
        shift = true;
        return hover();
      }
      const t = e.target as HTMLElement | null;
      if (t && (t.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName))) return;
      if (e.key === 'Escape' && selected) {
        selected = hovered = null;
        return paint();
      }
      if (!selected) return;
      const { part } = partOf(selected)!;
      const fine = e.altKey;
      const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
      const moves: Record<string, [Axis | undefined, number]> = {
        ArrowUp: [part.ud, 1], ArrowDown: [part.ud, -1], ArrowRight: [part.lr, 1], ArrowLeft: [part.lr, -1], e: [part.qe, 1], q: [part.qe, -1],
      };
      const move = moves[k];
      if (!move) return;
      e.preventDefault();
      e.stopImmediatePropagation(); // ni el teclado de caminar ni nadie más
      nudge(move[0], move[1], fine);
    },
    true,
  );
  window.addEventListener('keyup', (e) => {
    if (e.key !== 'Shift') return;
    shift = false;
    hover();
  });
  window.addEventListener('blur', () => {
    shift = false;
    hover();
  });
}
