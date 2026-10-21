// Geometría provisional del NAO por link, como datos: la usan el render (NaoModel → mallas Three) y
// la física (mjcf → geoms de MuJoCo), así lo que se ve es lo que choca. Coordenadas en el frame
// del link del URDF (metros). Las medidas buscan parecerse al NAO pero son aproximadas; la
// cinemática la fijan los orígenes de los joints. Se reemplazará por piezas de Meshy o las mallas
// oficiales (F7), conservando estas formas como colisión.

import type { Vec3 } from '../robot/urdf';

export type ShapeMaterial = 'shell' | 'joint' | 'dark' | 'eye';

interface Base {
  material: ShapeMaterial;
  /** false = solo decorativo (ojos, botones…): no participa en la física */
  collide: boolean;
}

export type Shape = Base &
  (
    | { kind: 'capsule'; from: Vec3; to: Vec3; radius: number }
    | { kind: 'sphere'; center: Vec3; radius: number }
    /** Caja de tamaño completo `size`; `round` solo afecta al render (esquinas redondeadas) */
    | { kind: 'box'; center: Vec3; size: Vec3; round: number }
    /** Cilindro corto cuya cara mira hacia `normal` */
    | { kind: 'disc'; center: Vec3; radius: number; thickness: number; normal: 'x' | 'y' | 'z' }
  );

const capsule = (from: Vec3, to: Vec3, radius: number, material: ShapeMaterial, collide = true): Shape => ({
  kind: 'capsule', from, to, radius, material, collide,
});
const sphere = (center: Vec3, radius: number, material: ShapeMaterial, collide = true): Shape => ({
  kind: 'sphere', center, radius, material, collide,
});
const box = (center: Vec3, size: Vec3, round: number, material: ShapeMaterial, collide = true): Shape => ({
  kind: 'box', center, size, round, material, collide,
});
const disc = (center: Vec3, radius: number, thickness: number, normal: 'x' | 'y' | 'z', material: ShapeMaterial): Shape => ({
  kind: 'disc', center, radius, thickness, normal, material, collide: false,
});

export const isFingerLink = (link: string) => /Finger\d\d_link$|Thumb\d_link$/.test(link);

export function linkShapes(link: string): Shape[] {
  // Dedos: sin masa en el URDF y sin física (siguen a LHand/RHand de forma cinemática)
  if (isFingerLink(link)) return [capsule([0, 0, 0], [0.0144, 0, 0], 0.005, 'dark', false)];

  const s = /^(L|l_)/.test(link) ? 1 : -1; // espejo izquierda/derecha
  switch (link.replace(/^(L|R|l_|r_)(?=[A-Za-z])/, '')) {
    case 'torso':
      return [
        box([0, 0, 0.03], [0.1, 0.13, 0.17], 0.03, 'shell'),
        box([-0.005, 0, -0.072], [0.075, 0.13, 0.045], 0.015, 'joint'),
        disc([0.05, 0, 0.0552], 0.012, 0.004, 'x', 'dark'), // botón del pecho
      ];
    case 'Neck':
      return [disc([0, 0, -0.005], 0.018, 0.03, 'z', 'joint')];
    case 'Head':
      return [
        box([0, 0, 0.058], [0.115, 0.13, 0.115], 0.045, 'shell'),
        disc([0.056, 0.027, 0.048], 0.013, 0.004, 'x', 'eye'),
        disc([0.056, -0.027, 0.048], 0.013, 0.004, 'x', 'eye'),
        disc([-0.005, 0.066, 0.055], 0.026, 0.012, 'y', 'joint'), // orejas (parlantes)
        disc([-0.005, -0.066, 0.055], 0.026, 0.012, 'y', 'joint'),
        disc([0.058, 0, 0.0636], 0.005, 0.004, 'x', 'dark'), // CameraTop
        disc([0.057, 0, 0.0177], 0.005, 0.004, 'x', 'dark'), // CameraBottom
      ];
    case 'Shoulder':
      return [sphere([0, 0, 0], 0.03, 'joint')];
    case 'Bicep':
      return [capsule([0.012, 0, 0], [0.098, 0.015 * s, 0], 0.026, 'shell')];
    case 'Elbow':
      return [sphere([0, 0, 0], 0.021, 'joint')];
    case 'ForeArm':
      return [capsule([0.008, 0, 0], [0.05, 0, 0], 0.021, 'shell')];
    case 'wrist':
      return [box([0.028, 0, -0.006], [0.045, 0.042, 0.03], 0.01, 'shell')];
    case 'Pelvis':
      return [sphere([0, 0, 0], 0.022, 'joint')];
    case 'Thigh':
      return [capsule([0, 0, -0.008], [0, 0, -0.092], 0.031, 'shell')];
    case 'Tibia':
      return [sphere([0, 0, 0], 0.028, 'joint'), capsule([0, 0, -0.01], [0, 0, -0.093], 0.027, 'shell')];
    case 'AnklePitch':
      return [sphere([0, 0, 0], 0.02, 'joint')];
    case 'ankle':
      return [
        // El pie completo (con la suela) es la caja de colisión: su base está en z = -0.04511 (l_sole)
        box([0.025, 0.003 * s, -0.0341], [0.16, 0.088, 0.022], 0.008, 'shell'),
        box([0.025, 0.003 * s, -0.0436], [0.162, 0.09, 0.003], 0.001, 'dark', false), // suela
      ];
    default:
      return [];
  }
}
