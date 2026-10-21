// Parser mínimo de URDF: lo que necesitan la cinemática (árbol de joints, orígenes, ejes, límites y
// mimic) y el centro de masa (<inertial>). Las geometrías <visual>/<collision> se ignoran: apuntan a
// las mallas oficiales (CC BY-NC-ND), que no usamos.

export type Vec3 = [number, number, number];

export type UrdfJointType = 'revolute' | 'continuous' | 'prismatic' | 'fixed' | 'floating' | 'planar';

export interface UrdfJoint {
  name: string;
  type: UrdfJointType;
  parent: string;
  child: string;
  /** Traslación del frame del joint respecto al link padre (m) */
  xyz: Vec3;
  /** Rotación fija roll-pitch-yaw (rad): R = Rz(yaw)·Ry(pitch)·Rx(roll) */
  rpy: Vec3;
  /** Eje de giro normalizado, en el frame del joint */
  axis: Vec3;
  limit?: { lower: number; upper: number; velocity: number; effort: number };
  mimic?: { joint: string; multiplier: number; offset: number };
}

export interface UrdfLink {
  name: string;
  /** kg (0 si el link no declara <inertial>) */
  mass: number;
  /** Centro de masa en el frame del link (m) */
  com: Vec3;
}

export interface UrdfRobot {
  name: string;
  /** Link que nunca es hijo de ningún joint (base_link en el NAO) */
  root: string;
  links: UrdfLink[];
  joints: UrdfJoint[];
}

function vec3(attr: string | null | undefined, fallback: Vec3): Vec3 {
  if (!attr) return fallback;
  const v = attr.trim().split(/\s+/).map(Number);
  return v.length === 3 && v.every(Number.isFinite) ? [v[0], v[1], v[2]] : fallback;
}

function normalize([x, y, z]: Vec3): Vec3 {
  const n = Math.hypot(x, y, z);
  return n > 0 ? [x / n, y / n, z / n] : [1, 0, 0];
}

function num(el: Element, attr: string, fallback: number): number {
  const v = el.getAttribute(attr);
  return v === null ? fallback : Number(v);
}

export function parseUrdf(xml: string): UrdfRobot {
  const doc = new DOMParser().parseFromString(xml, 'application/xml');
  const robot = doc.querySelector('robot');
  if (!robot || doc.querySelector('parsererror')) throw new Error('URDF inválido');

  // Solo hijos directos: <link>/<joint> también aparecen dentro de <gazebo> y <transmission>
  const direct = (tag: string) => Array.from(robot.children).filter((el) => el.tagName === tag);

  const links = direct('link').map((el): UrdfLink => {
    const inertial = el.querySelector(':scope > inertial');
    const mass = inertial?.querySelector(':scope > mass');
    return {
      name: el.getAttribute('name')!,
      mass: mass ? num(mass, 'value', 0) : 0,
      com: vec3(inertial?.querySelector(':scope > origin')?.getAttribute('xyz'), [0, 0, 0]),
    };
  });
  const joints = direct('joint').map((el): UrdfJoint => {
    const origin = el.querySelector(':scope > origin');
    const limit = el.querySelector(':scope > limit');
    const mimic = el.querySelector(':scope > mimic');
    return {
      name: el.getAttribute('name')!,
      type: el.getAttribute('type') as UrdfJointType,
      parent: el.querySelector(':scope > parent')!.getAttribute('link')!,
      child: el.querySelector(':scope > child')!.getAttribute('link')!,
      xyz: vec3(origin?.getAttribute('xyz'), [0, 0, 0]),
      rpy: vec3(origin?.getAttribute('rpy'), [0, 0, 0]),
      axis: normalize(vec3(el.querySelector(':scope > axis')?.getAttribute('xyz'), [1, 0, 0])),
      limit: limit
        ? {
            lower: num(limit, 'lower', 0),
            upper: num(limit, 'upper', 0),
            velocity: num(limit, 'velocity', 0),
            effort: num(limit, 'effort', 0),
          }
        : undefined,
      mimic: mimic
        ? {
            joint: mimic.getAttribute('joint')!,
            multiplier: num(mimic, 'multiplier', 1),
            offset: num(mimic, 'offset', 0),
          }
        : undefined,
    };
  });

  const children = new Set(joints.map((j) => j.child));
  const root = links.find((l) => !children.has(l.name))?.name;
  if (!root) throw new Error('URDF sin link raíz');

  return { name: robot.getAttribute('name') ?? '', root, links, joints };
}
