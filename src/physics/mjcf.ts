// Genera el modelo MuJoCo (MJCF) del NAO a partir del URDF oficial: cinemática, masas e inercias
// (reference/urdf), límites V6 (naoV6), colisión = la forma real de cada pieza (envolventes de las mallas oficiales) y
// los objetos del entorno. El motor sigue el modelo de qiBullet (SoftBank): control de posición
// con el torque máximo del URDF; la stiffness de NAOqi limita ese torque (ver physics.ts).

import { JOINT_BY_NAME } from '../robot/naoV6';
import type { UrdfJoint, UrdfLink, UrdfRobot, Vec3 } from '../robot/urdf';
import { ENV_FIXED, ENV_OBJECTS } from '../sim/environment';

/** 500 Hz: el DCM del NAO real corre a 100 Hz; la física necesita pasos más finos */
export const PHYSICS_TIMESTEP = 0.002;

/** Joints sin física: las manos (y sus dedos mimic) se mueven de forma cinemática */
const KINEMATIC = new Set(['LHand', 'RHand']);

/** Error angular (rad) con el que el motor ya entrega su torque máximo. APPROX. */
const SATURATION_ERROR = 0.04;

/**
 * Fricción de la reductora como fracción del torque máximo. APPROX: el NAO real con los motores
 * apagados se queda en Crouch (no se desploma) porque sus reductoras casi no son reversibles.
 */
export const GEAR_FRICTION = 0.12;

export interface PhysicalJoint {
  name: string;
  /** Torque del URDF (N·m, ~continuo). Fija la ganancia del control de posición y la fricción. */
  effort: number;
  /** false para RHipYawPitch: no tiene motor propio, una restricción lo iguala a LHipYawPitch */
  actuated: boolean;
}

const f = (n: number) => (Math.abs(n) < 1e-12 ? '0' : Number(n.toPrecision(7)).toString());
const v3 = (v: readonly number[]) => v.map(f).join(' ');

/** Cuaternión [w,x,y,z] de un rpy URDF (R = Rz·Ry·Rx) */
export function rpyToQuat([r, p, y]: Vec3): [number, number, number, number] {
  const [cr, sr, cp, sp, cy, sy] = [Math.cos(r / 2), Math.sin(r / 2), Math.cos(p / 2), Math.sin(p / 2), Math.cos(y / 2), Math.sin(y / 2)];
  return [cr * cp * cy + sr * sp * sy, sr * cp * cy - cr * sp * sy, cr * sp * cy + sr * cp * sy, cr * cp * sy - sr * sp * cy];
}

// Las piezas del robot chocan entre sí (salvo los pares de `exclude`), con el suelo y con los objetos.
// group 1 = el robot, 2 = el suelo, 0 = objetos y piezas fijas (lo único que ven los sonares, physics.ts SONAR_GROUPS)
const ROBOT_CONTACT = 'contype="1" conaffinity="1" group="1"';

/**
 * Los codos no tienen malla oficial propia (la carcasa del brazo va en el bíceps y el antebrazo): una esfera en la
 * articulación. APPROX: radio de la rótula del NAO (~2 cm).
 */
const ELBOW_RADIUS = 0.021;

function inertial(link: UrdfLink): string {
  const [ixx, iyy, izz, ixy, ixz, iyz] = link.inertia;
  return `<inertial pos="${v3(link.com)}" mass="${f(link.mass)}" fullinertia="${v3([ixx, iyy, izz, ixy, ixz, iyz])}"/>`;
}

/**
 * μ de la carcasa de plástico del NAO contra el suelo. APPROX: sin dato oficial; plástico sobre piso ~0.3–0.5.
 * Medido (2026-10-24, video de un NAO real levantándose de espaldas, youtube.com/watch?v=JZV9lItJGUo): con μ = 1 (goma,
 * como la suela) la cabeza se agarraba al suelo y formaba un arco, los codos no resbalaban bajo la espalda y al cerrar la
 * cadera subían las piernas en vez del torso; con 0.4 la cabeza resbala, el torso sube sobre los codos y se incorpora
 * como el real (−38° medido contra −37° del grafo de NAOqi).
 */
export const SHELL_FRICTION = 0.4;

/** Pies: caja con las medidas de su envolvente (ver collision en buildMjcf) */
const FLAT_SOLE = new Set(['l_ankle', 'r_ankle']);

/** Envolventes convexas de las mallas oficiales por cuerpo (sim/officialMeshes.ts collisionHulls), en m */
export type CollisionHulls = ReadonlyMap<string, ArrayLike<number>>;

/**
 * Colisión del robot: la forma real de cada pieza (envolventes de las mallas oficiales; los codos, sin malla propia,
 * una esfera) y choque consigo mismo, como el plástico del NAO real. `exclude` = pares
 * de cuerpos que no chocan entre sí (ver physics.ts selfCollisionExcludes).
 */
export interface CollisionOptions {
  hulls: CollisionHulls;
  exclude?: readonly (readonly [string, string])[];
  /**
   * μ de la carcasa (todo menos los pies) contra lo que toque (SHELL_FRICTION si no se da; otro valor solo para
   * bancos). Con `priority="1"` MuJoCo usa la fricción de la carcasa en vez de la mayor de las dos, así el suelo y la
   * suela no cambian.
   */
  shellFriction?: number;
}

/**
 * Pares que no chocan: cada cuerpo con su padre y su abuelo (se juntan en el eje de la articulación; el codo y la cadera
 * no tienen pieza propia entre medio) y los pares medidos aparte.
 */
function excludes(bodies: ReadonlyMap<string, string>, extra: readonly (readonly [string, string])[]): [string, string][] {
  const seen = new Set<string>();
  const out: [string, string][] = [];
  const add = (a: string, b: string) => {
    const key = [a, b].sort().join('|');
    if (a === b || seen.has(key)) return;
    seen.add(key);
    out.push([a, b]);
  };
  for (const [b, parent] of bodies) {
    add(b, parent);
    const grand = bodies.get(parent);
    if (grand) add(b, grand);
  }
  for (const [a, b] of extra) add(a, b);
  return out;
}

export function buildMjcf(
  urdf: UrdfRobot,
  root: { position: Vec3; quaternion: [number, number, number, number] },
  { hulls, exclude = [], shellFriction = SHELL_FRICTION }: CollisionOptions,
): { xml: string; joints: PhysicalJoint[]; bodies: Map<string, string> } {
  const links = new Map(urdf.links.map((l) => [l.name, l]));
  const byParent = new Map<string, UrdfJoint[]>();
  for (const j of urdf.joints) byParent.set(j.parent, [...(byParent.get(j.parent) ?? []), j]);

  const joints: PhysicalJoint[] = [];
  const isPhysical = (j: UrdfJoint) => j.type === 'revolute' && !KINEMATIC.has(j.name) && JOINT_BY_NAME.has(j.name);
  // Colisión: la envolvente de la malla oficial (la forma del NAO real)
  const assets: string[] = [];
  const shellContact = `${ROBOT_CONTACT} friction="${f(shellFriction)} 0.005 0.0001" priority="1"`;
  const collision = (link: string, pad: string): string[] => {
    const hull = hulls.get(link);
    const contact = FLAT_SOLE.has(link) ? ROBOT_CONTACT : shellContact;
    if (!hull) return link.endsWith('Elbow') ? [`${pad}<geom type="sphere" size="${f(ELBOW_RADIUS)}" ${contact}/>`] : [];
    if (FLAT_SOLE.has(link)) {
      // La suela es plana (medido: 34 vértices de la envolvente a < 1 mm del fondo, en toda la huella), pero MuJoCo
      // apoya una malla sobre el suelo en pocos puntos que saltan de vértice en vértice: de pie el robot temblaba
      // (0.47° de alabeo, 53 cambios de sentido en 4 s). Una caja con las medidas de la envolvente se apoya en sus
      // cuatro esquinas: quieto (0.01°).
      const lo = [Infinity, Infinity, Infinity];
      const hi = [-Infinity, -Infinity, -Infinity];
      for (let i = 0; i < hull.length; i++) {
        lo[i % 3] = Math.min(lo[i % 3], hull[i]);
        hi[i % 3] = Math.max(hi[i % 3], hull[i]);
      }
      const center = lo.map((v, k) => (v + hi[k]) / 2);
      const half = lo.map((v, k) => (hi[k] - v) / 2);
      return [`${pad}<geom type="box" pos="${v3(center)}" size="${v3(half)}" ${contact}/>`];
    }
    assets.push(`<mesh name="hull_${link}" vertex="${Array.from(hull, f).join(' ')}"/>`);
    return [`${pad}<geom type="mesh" mesh="hull_${link}" ${contact}/>`];
  };
  /** Cuerpo → su cuerpo padre (para las exclusiones por cercanía en el árbol) */
  const bodies = new Map<string, string>();

  const body = (j: UrdfJoint, depth: number): string => {
    const link = links.get(j.child)!;
    const spec = JOINT_BY_NAME.get(j.name)!;
    const pad = '  '.repeat(depth);
    joints.push({ name: j.name, effort: j.limit?.effort ?? 1, actuated: !j.mimic });
    bodies.set(link.name, j.parent);
    return [
      `${pad}<body name="${link.name}" pos="${v3(j.xyz)}" quat="${v3(rpyToQuat(j.rpy))}">`,
      `${pad}  <joint name="${j.name}" axis="${v3(j.axis)}" range="${f(spec.min)} ${f(spec.max)}" frictionloss="${f((j.limit?.effort ?? 1) * GEAR_FRICTION)}"/>`,
      `${pad}  ${inertial(link)}`,
      ...collision(link.name, `${pad}  `),
      ...(byParent.get(link.name) ?? []).filter(isPhysical).map((c) => body(c, depth + 1)),
      `${pad}</body>`,
    ].join('\n');
  };

  // El torso cuelga de base_link con un joint fijo: es el cuerpo raíz (flotante)
  const torso = links.get('torso')!;
  const robot = [
    `<body name="torso" pos="${v3(root.position)}" quat="${v3(root.quaternion)}">`,
    '  <freejoint name="root"/>',
    `  ${inertial(torso)}`,
    ...collision('torso', '  '),
    ...(byParent.get('torso') ?? []).filter(isPhysical).map((c) => body(c, 1)),
    '</body>',
  ].join('\n');

  const objects = ENV_OBJECTS.map(
    (o) =>
      `<body name="env_${o.name}" pos="${v3(o.pos)}" quat="${v3(rpyToQuat([0, 0, o.yaw]))}">` +
      `<freejoint/><geom type="box" size="${v3(o.size.map((s) => s / 2))}" mass="${f(o.mass)}" contype="1" conaffinity="1"/></body>`,
  );

  // Piezas fijas (el espejo): geoms del mundo, sin cuerpo propio
  const fixed = ENV_FIXED.map((o) => {
    const size = o.kind === 'cylinder' ? [o.size[0] / 2, o.size[2] / 2] : o.size.map((s) => s / 2);
    const friction = o.friction === undefined ? '' : ` friction="${f(o.friction)} 0.005 0.0001" priority="1"`;
    return (
      `<geom name="fixed_${o.name}" type="${o.kind ?? 'box'}" pos="${v3(o.pos)}" quat="${v3(rpyToQuat([0, o.pitch ?? 0, o.yaw]))}" ` +
      `size="${v3(size)}" contype="1" conaffinity="1"${friction}/>`
    );
  });

  const actuators = joints
    .filter((j) => j.actuated)
    .map((j) => {
      const kp = j.effort / SATURATION_ERROR;
      // APPROX: kv da un amortiguamiento cercano al crítico con la armadura elegida
      return `<position name="${j.name}" joint="${j.name}" kp="${f(kp)}" kv="${f(kp * 0.04)}" forcelimited="true" forcerange="${f(-j.effort)} ${f(j.effort)}"/>`;
    });

  const xml = `<mujoco model="nao_v6">
  <compiler angle="radian" autolimits="true"/>
  <option timestep="${PHYSICS_TIMESTEP}" integrator="implicitfast" gravity="0 0 -9.81"/>
  <default>
    <!-- APPROX: reductora del NAO (~1:130–1:200): inercia reflejada del rotor (armature) y fricción
         de la caja de engranajes; valores plausibles, no medidos. -->
    <!-- solreffriction: la fricción de MuJoCo es una restricción blanda y con el valor por defecto
         (0.02 s) el robot en reposo "se escurría" ~1.3°/s hasta caerse. Más rígida = sin deslizar. -->
    <joint armature="0.005" damping="0.02" solreffriction="0.004 1" solimpfriction="0.99 0.999 0.001"/>
    <geom friction="1 0.005 0.0001"/>
  </default>
  ${assets.length ? `<asset>\n${assets.map((a) => `    ${a}`).join('\n')}\n  </asset>` : ''}
  <worldbody>
    <light directional="true" pos="0 0 3" dir="0 0 -1"/>
    <geom name="floor" type="plane" size="0 0 0.05" contype="1" conaffinity="1" group="2"/>
${robot}
${objects.join('\n')}
${fixed.map((g) => `    ${g}`).join('\n')}
  </worldbody>
  <equality>
    <!-- "LHipYawPitch and RHipYawPitch are physically just one motor" -->
    <joint joint1="RHipYawPitch" joint2="LHipYawPitch" polycoef="0 1 0 0 0"/>
  </equality>
  <contact>
${excludes(bodies, exclude).map(([a, b]) => `    <exclude body1="${a}" body2="${b}"/>`).join('\n')}
  </contact>
  <actuator>
${actuators.join('\n')}
  </actuator>
</mujoco>`;
  return { xml, joints, bodies };
}
