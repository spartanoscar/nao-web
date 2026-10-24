// Objetos del entorno, como datos compartidos entre el render y la física. Coordenadas Z arriba
// (las del URDF y MuJoCo; X adelante del robot), metros, kg.

import type { Vec3 } from '../robot/urdf';
import { PROPS } from './props';
import { ROOMS, WALL_THICKNESS, wallPieces } from './rooms';

export interface EnvObject {
  name: string;
  /** Tamaño completo de la caja */
  size: Vec3;
  /** Centro inicial */
  pos: Vec3;
  /** Giro alrededor de Z (rad) */
  yaw: number;
  color: number;
  /** kg. APPROX: masas plausibles para cubos de juguete y cajas de cartón vacías. */
  mass: number;
}

const CARDBOARD = 0xb08a5a;

/** Pieza fija del mundo: no se mueve (como atornillada a la pared). Mismas coordenadas que EnvObject. */
export interface FixedObject {
  name: string;
  /** Tamaño completo (x = grosor). Cilindro: [diámetro, diámetro, alto], con el eje vertical */
  size: Vec3;
  pos: Vec3;
  yaw: number;
  /** Inclinación alrededor del eje Y propio (rad): rampas */
  pitch?: number;
  kind?: 'box' | 'cylinder';
  /**
   * Fricción propia (azulejo, tapete, charco). MuJoCo usa la mayor de las dos piezas que se tocan: con prioridad, la de
   * esta pieza manda (si no, la suela del NAO, μ = 1, siempre ganaría)
   */
  friction?: number;
}

/**
 * Espejo de cuerpo entero para la *prueba del espejo* (docs/PLAN.md F13), en su cuarto (rooms.ts): contra la pared sur,
 * mirando hacia la puerta (+Y), apoyado en el piso. 1.0 × 1.1 m con marco de 4 cm: desde ~0.6 m el NAO (57 cm) se ve
 * entero. El NAO aparece ahí a 1.5 m, mirándolo.
 */
export const MIRROR: FixedObject = {
  name: 'mirror',
  size: [0.05, 1.0, 1.1],
  pos: [ROOMS.espejo.spawn.x, ROOMS.espejo.y[0] + WALL_THICKNESS / 2 + 0.03, 0.55],
  yaw: Math.PI / 2,
};
export const MIRROR_FRAME = 0.04;

/** Piezas fijas para la física: el espejo y las paredes de los cuartos (los sonares las ven: son objetos sólidos) */
export const ENV_FIXED: readonly FixedObject[] = [
  MIRROR,
  ...wallPieces().map((w, i): FixedObject => ({ name: `wall_${i}`, size: w.size, pos: w.center, yaw: 0 })),
  // Objetos de los cuartos con física (sim/props.ts): rampa, escalones, escalera, lavamanos, inodoro, tapetes, piso del baño
  ...PROPS.filter((p) => p.physics && p.kind !== 'ellipse').map((p): FixedObject => ({
    name: p.name, size: p.size, pos: p.pos, yaw: p.yaw ?? 0, pitch: p.pitch, kind: p.kind === 'cylinder' ? 'cylinder' : 'box', friction: p.friction,
  })),
];

// Los cubos y cajas están en el laboratorio (rooms.ts), alrededor de donde aparece el NAO ahí, igual que estaban
// alrededor del origen antes de los cuartos (mismas posiciones relativas: el banco del cerebro y las tareas no cambian)
const LAB = ROOMS.laboratorio.spawn;
const inLab = (x: number, y: number, z: number): Vec3 => [LAB.x + x, LAB.y + y, z];

export const ENV_OBJECTS: readonly EnvObject[] = [
  // Cubos de 6 cm: tamaño que la mano del NAO podría agarrar
  { name: 'cube_red', size: [0.06, 0.06, 0.06], pos: inLab(0.32, -0.18, 0.03), yaw: 0.4, color: 0xe5484d, mass: 0.05 },
  { name: 'cube_blue', size: [0.06, 0.06, 0.06], pos: inLab(0.36, 0.05, 0.03), yaw: 1.1, color: 0x3aa0ff, mass: 0.05 },
  { name: 'cube_yellow', size: [0.06, 0.06, 0.06], pos: inLab(0.28, 0.24, 0.03), yaw: 2.3, color: 0xf5a524, mass: 0.05 },
  // Cajas de cartón
  { name: 'box_a', size: [0.3, 0.3, 0.22], pos: inLab(-0.5, -0.55, 0.11), yaw: 0.3, color: CARDBOARD, mass: 0.4 },
  { name: 'box_b', size: [0.22, 0.22, 0.16], pos: inLab(-0.48, -0.53, 0.30), yaw: 0.6, color: CARDBOARD, mass: 0.25 },
  { name: 'box_c', size: [0.4, 0.3, 0.3], pos: inLab(0.2, 0.9, 0.15), yaw: -0.2, color: CARDBOARD, mass: 0.5 },
  { name: 'box_d', size: [0.25, 0.25, 0.25], pos: inLab(-0.9, 0.4, 0.125), yaw: 0.8, color: 0x7c8696, mass: 0.6 },
];
