// Objetos del entorno, como datos compartidos entre el render y la física. Coordenadas Z arriba
// (las del URDF y MuJoCo; X adelante del robot), metros, kg.

import type { Vec3 } from '../robot/urdf';

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

export const ENV_OBJECTS: readonly EnvObject[] = [
  // Cubos de 6 cm: tamaño que la mano del NAO podría agarrar
  { name: 'cube_red', size: [0.06, 0.06, 0.06], pos: [0.32, -0.18, 0.03], yaw: 0.4, color: 0xe5484d, mass: 0.05 },
  { name: 'cube_blue', size: [0.06, 0.06, 0.06], pos: [0.36, 0.05, 0.03], yaw: 1.1, color: 0x3aa0ff, mass: 0.05 },
  { name: 'cube_yellow', size: [0.06, 0.06, 0.06], pos: [0.28, 0.24, 0.03], yaw: 2.3, color: 0xf5a524, mass: 0.05 },
  // Cajas de cartón
  { name: 'box_a', size: [0.3, 0.3, 0.22], pos: [-0.5, -0.55, 0.11], yaw: 0.3, color: CARDBOARD, mass: 0.4 },
  { name: 'box_b', size: [0.22, 0.22, 0.16], pos: [-0.48, -0.53, 0.30], yaw: 0.6, color: CARDBOARD, mass: 0.25 },
  { name: 'box_c', size: [0.4, 0.3, 0.3], pos: [0.2, 0.9, 0.15], yaw: -0.2, color: CARDBOARD, mass: 0.5 },
  { name: 'box_d', size: [0.25, 0.25, 0.25], pos: [-0.9, 0.4, 0.125], yaw: 0.8, color: 0x7c8696, mass: 0.6 },
];
