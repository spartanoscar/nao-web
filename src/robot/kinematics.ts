// Cinemática directa del NAO desde el URDF oficial (sin three: la usa la capa NAOqi). Pose de cualquier link respecto
// al torso para unos ángulos de joints dados. Base de ALMotion.getPosition/getTransform.
//
// Efectores como en NAOqi (doc family_nao_technical_links_naov6): el de un brazo es la mano, a HandOffsetX = 57.75 mm y
// −HandOffsetZ = 12.31 mm de la muñeca; en el URDF es exactamente el link l_gripper/r_gripper. El de una pierna es la
// planta del pie (l_sole/r_sole) y el de la cabeza, el link Head.

import urdfXml from '../../reference/urdf/naoV50.urdf?raw';
import { type UrdfJoint, type UrdfRobot, type Vec3, parseUrdf } from './urdf';

/** Matriz homogénea 4×4 por filas: [r00 r01 r02 tx, r10 r11 r12 ty, r20 r21 r22 tz, 0 0 0 1] */
export type Mat4 = number[];

export const IDENTITY: Mat4 = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

export function multiply(a: Mat4, b: Mat4): Mat4 {
  const out = new Array<number>(16).fill(0);
  for (let r = 0; r < 4; r++) {
    for (let c = 0; c < 4; c++) {
      let s = 0;
      for (let k = 0; k < 4; k++) s += a[r * 4 + k] * b[k * 4 + c];
      out[r * 4 + c] = s;
    }
  }
  return out;
}

/** Inversa de una transformación rígida: [Rᵀ, −Rᵀ·t] */
export function invertRigid(m: Mat4): Mat4 {
  const r = [m[0], m[4], m[8], m[1], m[5], m[9], m[2], m[6], m[10]];
  const t = [m[3], m[7], m[11]];
  return [
    r[0], r[1], r[2], -(r[0] * t[0] + r[1] * t[1] + r[2] * t[2]),
    r[3], r[4], r[5], -(r[3] * t[0] + r[4] * t[1] + r[5] * t[2]),
    r[6], r[7], r[8], -(r[6] * t[0] + r[7] * t[1] + r[8] * t[2]),
    0, 0, 0, 1,
  ];
}

/** R = Rz(yaw)·Ry(pitch)·Rx(roll) con traslación (convención del URDF) */
export function fromRpy([x, y, z]: Vec3, [roll, pitch, yaw]: Vec3): Mat4 {
  const [cr, sr, cp, sp, cy, sy] = [Math.cos(roll), Math.sin(roll), Math.cos(pitch), Math.sin(pitch), Math.cos(yaw), Math.sin(yaw)];
  return [
    cy * cp, cy * sp * sr - sy * cr, cy * sp * cr + sy * sr, x,
    sy * cp, sy * sp * sr + cy * cr, sy * sp * cr - cy * sr, y,
    -sp, cp * sr, cp * cr, z,
    0, 0, 0, 1,
  ];
}

/** Giro de `angle` alrededor de un eje unitario (Rodrigues) */
function axisAngle([x, y, z]: Vec3, angle: number): Mat4 {
  const [c, s] = [Math.cos(angle), Math.sin(angle)];
  const t = 1 - c;
  return [
    t * x * x + c, t * x * y - s * z, t * x * z + s * y, 0,
    t * x * y + s * z, t * y * y + c, t * y * z - s * x, 0,
    t * x * z - s * y, t * y * z + s * x, t * z * z + c, 0,
    0, 0, 0, 1,
  ];
}

/** Matriz de cuaternión [w, x, y, z] con traslación */
export function fromQuaternion([w, x, y, z]: readonly number[], [tx, ty, tz]: readonly number[]): Mat4 {
  return [
    1 - 2 * (y * y + z * z), 2 * (x * y - w * z), 2 * (x * z + w * y), tx,
    2 * (x * y + w * z), 1 - 2 * (x * x + z * z), 2 * (y * z - w * x), ty,
    2 * (x * z - w * y), 2 * (y * z + w * x), 1 - 2 * (x * x + y * y), tz,
    0, 0, 0, 1,
  ];
}

/** Position6D de NAOqi: [x, y, z, wx, wy, wz] con R = Rz(wz)·Ry(wy)·Rx(wx) */
export function toPosition6D(m: Mat4): number[] {
  const wy = Math.asin(Math.max(-1, Math.min(1, -m[8])));
  const wx = Math.atan2(m[9], m[10]);
  const wz = Math.atan2(m[4], m[0]);
  return [m[3], m[7], m[11], wx, wy, wz];
}

export class Kinematics {
  /** Joint que lleva a cada link (link hijo → joint) */
  private readonly byChild = new Map<string, UrdfJoint>();
  private readonly byName = new Map<string, UrdfJoint>();

  constructor(robot: UrdfRobot) {
    for (const j of robot.joints) {
      this.byChild.set(j.child, j);
      this.byName.set(j.name, j);
    }
  }

  hasLink(link: string): boolean {
    return link === 'torso' || this.byChild.has(link);
  }

  /** Link hijo de un joint (p. ej. "LWristYaw" → "l_wrist"), o undefined */
  childOf(joint: string): string | undefined {
    return this.byName.get(joint)?.child;
  }

  /** Pose del link en el frame del torso con los ángulos dados (rad; los joints sin valor van a 0) */
  linkInTorso(link: string, angle: (joint: string) => number): Mat4 {
    const chain: UrdfJoint[] = [];
    for (let l = link; l !== 'torso'; ) {
      const j = this.byChild.get(l);
      if (!j) throw new Error(`el URDF no lleva del torso a ${link}`);
      chain.push(j);
      l = j.parent;
    }
    let m = IDENTITY;
    for (const j of chain.reverse()) {
      m = multiply(m, fromRpy(j.xyz, j.rpy));
      if (j.type === 'revolute' || j.type === 'continuous') {
        const a = j.mimic ? angle(j.mimic.joint) * j.mimic.multiplier + j.mimic.offset : angle(j.name);
        m = multiply(m, axisAngle(j.axis, a));
      }
    }
    return m;
  }
}

let shared: Kinematics | null = null;

/** Cinemática del NAO V6 (URDF de reference/, se arma una vez) */
export function naoKinematics(): Kinematics {
  shared ??= new Kinematics(parseUrdf(urdfXml));
  return shared;
}
