// Modelo 3D del NAO construido desde el URDF. La jerarquía (frames, orígenes, ejes, dedos mimic) es
// la oficial; la geometría que viste cada link es provisional (primitivas) hasta tener las piezas de
// Meshy (F7), que se colgarán de los mismos frames.

import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import type { BodySupport, RobotState, RootPose } from '../robot/state';
import type { UrdfJoint, UrdfRobot, Vec3 } from '../robot/urdf';
import { linkShapes, type Shape } from './shapes';

interface MovableJoint {
  joint: UrdfJoint;
  motion: THREE.Group;
  axis: THREE.Vector3;
}

const MAT = {
  shell: new THREE.MeshStandardMaterial({ color: 0xf2f3f5, roughness: 0.35, metalness: 0.05 }),
  joint: new THREE.MeshStandardMaterial({ color: 0x5d6675, roughness: 0.5, metalness: 0.25 }),
  dark: new THREE.MeshStandardMaterial({ color: 0x2b3038, roughness: 0.6 }),
  // Lente ahumada: la luz la ponen los LEDs (sim/ledsView.ts)
  eye: new THREE.MeshStandardMaterial({ color: 0x15181e, roughness: 0.25, metalness: 0.1 }),
  highlight: new THREE.MeshStandardMaterial({ color: 0xffb020, emissive: 0xff8a00, emissiveIntensity: 0.5, roughness: 0.4 }),
};

export class NaoModel {
  /** Nodo a añadir a la escena (Y arriba) */
  readonly root = new THREE.Group();
  /** base_link en convención URDF (Z arriba, X adelante) */
  private readonly base = new THREE.Group();
  /** Inclinación del torso respecto al suelo (ver BodySupport) */
  private readonly tilt = new THREE.Group();
  private readonly frames = new Map<string, THREE.Group>();
  private readonly movable: MovableJoint[] = [];
  private readonly highlightSets = new Map<string, THREE.Mesh[]>();
  /** Formas simples (sim/shapes.ts): se ocultan cuando hay mallas oficiales */
  private readonly primitives: THREE.Mesh[] = [];
  private readonly official: THREE.Object3D[] = [];
  /** Objetos propios ligados a la vista de formas simples (attach) */
  private readonly primitiveExtras: THREE.Object3D[] = [];
  private readonly soles: THREE.Object3D[] = [];
  private readonly probes: { frame: THREE.Object3D; point: THREE.Vector3; radius: number }[] = [];
  private readonly masses: { frame: THREE.Object3D; point: THREE.Vector3; mass: number }[] = [];
  private readonly totalMass: number;
  private appliedRevision = -1;
  private highlighted: string | null = null;

  constructor(urdf: UrdfRobot) {
    this.root.name = 'NAO';
    this.base.rotation.x = -Math.PI / 2;
    this.root.add(this.base);
    this.base.add(this.tilt);
    this.frames.set(urdf.root, this.tilt);

    // Árbol en anchura desde la raíz: el frame padre siempre existe antes que el hijo
    const byParent = new Map<string, UrdfJoint[]>();
    for (const j of urdf.joints) byParent.set(j.parent, [...(byParent.get(j.parent) ?? []), j]);
    const queue = [urdf.root];
    while (queue.length) {
      const link = queue.shift()!;
      for (const j of byParent.get(link) ?? []) {
        const origin = new THREE.Group();
        origin.name = j.name;
        origin.position.set(...j.xyz);
        origin.quaternion.copy(rpyQuaternion(j.rpy));
        const motion = new THREE.Group();
        motion.name = j.child;
        origin.add(motion);
        this.frames.get(link)!.add(origin);
        this.frames.set(j.child, motion);
        if (j.type !== 'fixed') this.movable.push({ joint: j, motion, axis: new THREE.Vector3(...j.axis) });
        queue.push(j.child);
      }
    }

    for (const [link, frame] of this.frames) {
      for (const shape of linkShapes(link)) {
        const m = shapeMesh(shape);
        this.primitives.push(m);
        frame.add(m);
      }
    }
    this.buildHighlightSets();

    for (const name of ['l_sole', 'r_sole']) {
      const sole = this.frames.get(name);
      if (sole) this.soles.push(sole);
    }
    for (const { name, mass, com } of urdf.links) {
      const frame = this.frames.get(name);
      if (frame && mass > 0) this.masses.push({ frame, point: new THREE.Vector3(...com), mass });
    }
    this.totalMass = this.masses.reduce((m, x) => m + x.mass, 0);
    for (const [link, point, radius] of CONTACT_PROBES) {
      const frame = this.frames.get(link);
      if (frame) this.probes.push({ frame, point: new THREE.Vector3(...point), radius });
    }
  }

  /** Cuelga las mallas oficiales de sus links y oculta las formas simples */
  setOfficialMeshes(meshes: ReadonlyMap<string, THREE.Object3D>): void {
    for (const [link, mesh] of meshes) {
      const frame = this.frames.get(link);
      if (!frame) continue;
      frame.add(mesh);
      this.official.push(mesh);
    }
    this.showPrimitives(false);
    this.buildHighlightSets();
  }

  /**
   * Cuelga un objeto propio de un link, ligado a una de las dos vistas: 'primitive' (formas simples)
   * u 'official' (mallas de Aldebaran). Se muestra y oculta junto con esa vista.
   */
  attach(link: string, obj: THREE.Object3D, layer: 'primitive' | 'official'): void {
    const frame = this.frames.get(link);
    if (!frame) throw new Error(`link desconocido: ${link}`);
    frame.add(obj);
    if (layer === 'official') this.official.push(obj);
    else this.primitiveExtras.push(obj);
    obj.visible = layer === 'official' ? this.official.some((o) => o !== obj && o.visible) : !this.hasOfficialMeshes;
  }

  /** Superficie de un link en una vista (para proyectar decals); sin los decals ya colocados */
  surfaces(link: string, layer: 'primitive' | 'official'): THREE.Object3D[] {
    const frame = this.frames.get(link);
    if (!frame) return [];
    if (layer === 'official') {
      const shell = frame.getObjectByName(`mesh:${link}`);
      return shell ? [shell] : [];
    }
    return this.primitives.filter((m) => m.parent === frame && !m.userData.decal);
  }

  get hasOfficialMeshes(): boolean {
    return this.official.length > 0;
  }

  /** true = formas simples (lo que usa la física para chocar); false = mallas oficiales */
  showPrimitives(show: boolean): void {
    const hasOfficial = this.official.length > 0;
    for (const m of this.primitives) m.visible = show || !hasOfficial;
    for (const o of this.primitiveExtras) o.visible = show || !hasOfficial;
    for (const o of this.official) o.visible = !show;
  }

  // Resaltar un joint = todo lo que se mueve con él (incluye joints mimic: dedos, RHipYawPitch)
  private buildHighlightSets(): void {
    this.highlight(null);
    for (const { joint, motion } of this.movable) {
      const meshes = collectMeshes(motion);
      for (const other of this.movable) {
        if (other.joint.mimic?.joint === joint.name) meshes.push(...collectMeshes(other.motion));
      }
      this.highlightSets.set(joint.name, [...new Set(meshes)]);
    }
  }

  /** Frame de un link del URDF (p. ej. CameraTop_frame para la cámara virtual) */
  frame(link: string): THREE.Object3D | undefined {
    return this.frames.get(link);
  }

  /** Copia los ángulos del estado a la escena. Devuelve false si no había cambios. */
  apply(state: RobotState): boolean {
    if (state.revision === this.appliedRevision) return false;
    this.appliedRevision = state.revision;
    for (const { joint, motion, axis } of this.movable) {
      const q = joint.mimic
        ? state.get(joint.mimic.joint) * joint.mimic.multiplier + joint.mimic.offset
        : state.get(joint.name);
      motion.quaternion.setFromAxisAngle(axis, q);
    }
    const root = state.root;
    if (root) {
      // Con física: la pose del torso es la de la simulación (coordenadas Z arriba, bajo `base`)
      const [w, x, y, z] = root.quaternion;
      this.root.position.y = 0;
      this.tilt.position.set(...root.position);
      this.tilt.quaternion.set(x, y, z, w);
    } else {
      this.tilt.position.set(0, 0, 0);
      this.orient(state.body);
      this.ground();
    }
    return true;
  }

  /** Pose del torso del modelo cinemático actual (Z arriba), para arrancar la física apoyado en el suelo */
  kinematicRootPose(): RootPose {
    const q = this.tilt.quaternion;
    return { position: [0, 0, this.root.position.y], quaternion: [q.w, q.x, q.y, q.z] };
  }

  highlight(jointName: string | null): void {
    if (jointName === this.highlighted) return;
    for (const m of this.highlightSets.get(this.highlighted ?? '') ?? []) m.material = m.userData.material;
    this.highlighted = jointName;
    for (const m of this.highlightSets.get(jointName ?? '') ?? []) m.material = MAT.highlight;
  }

  // APPROX (sin física): orientación del torso. Con footSupport = 1 el torso gira lo necesario para
  // que el pie de apoyo (el más bajo) quede plano; con 0 el cuerpo queda apoyado donde su centro de
  // masa es más bajo, buscando cerca de la inclinación `pitch` que sugiere la postura.
  private orient({ footSupport, pitch }: Readonly<BodySupport>): void {
    const flat = footSupport > 0 ? this.flatFootTilt() : null;
    const rest = footSupport < 1 ? new THREE.Quaternion().setFromAxisAngle(Y_AXIS, this.restingPitch(pitch)) : null;
    if (flat && rest) this.tilt.quaternion.slerpQuaternions(rest, flat, footSupport);
    else this.tilt.quaternion.copy((flat ?? rest)!);
  }

  private flatFootTilt(): THREE.Quaternion {
    this.tilt.quaternion.identity();
    this.base.updateMatrixWorld(true);
    const baseInv = this.base.getWorldQuaternion(new THREE.Quaternion()).invert();
    const p = new THREE.Vector3();
    // Pie de apoyo: el que queda más abajo en el frame del torso (Z del URDF)
    const support = this.soles.reduce((a, b) =>
      this.base.worldToLocal(a.getWorldPosition(p)).z <= this.base.worldToLocal(b.getWorldPosition(p.clone())).z ? a : b,
    );
    const foot = baseInv.multiply(support.getWorldQuaternion(new THREE.Quaternion()));
    const yaw = new THREE.Euler().setFromQuaternion(foot, 'ZYX').z;
    return new THREE.Quaternion().setFromEuler(new THREE.Euler(0, 0, yaw, 'ZYX')).multiply(foot.invert());
  }

  /** Inclinación (solo pitch) de mínima energía potencial en hint ± 0.8 rad */
  private restingPitch(hint: number): number {
    const height = (p: number) => {
      this.tilt.quaternion.setFromAxisAngle(Y_AXIS, p);
      return this.comHeight();
    };
    let best = hint;
    let bestH = height(hint);
    const scan = (from: number, to: number, step: number) => {
      for (let p = from; p <= to + 1e-9; p += step) {
        const h = height(p);
        if (h < bestH - 1e-6) [best, bestH] = [p, h];
      }
    };
    scan(hint - 0.8, hint + 0.8, 0.05);
    scan(best - 0.05, best + 0.05, 0.01);
    return best;
  }

  /** Altura del centro de masa sobre el punto de contacto más bajo, con la orientación actual */
  private comHeight(): number {
    this.root.position.y = 0;
    this.root.updateMatrixWorld(true);
    return this.centerOfMass().y - this.lowestPoint();
  }

  /** Centro de masa (frame de root) a partir de las masas del URDF */
  centerOfMass(): THREE.Vector3 {
    const sum = new THREE.Vector3();
    const p = new THREE.Vector3();
    for (const { frame, point, mass } of this.masses) {
      sum.addScaledVector(this.root.worldToLocal(frame.localToWorld(p.copy(point))), mass);
    }
    return sum.divideScalar(this.totalMass);
  }

  private lowestPoint(): number {
    const p = new THREE.Vector3();
    let minY = Infinity;
    for (const { frame, point, radius } of this.probes) {
      minY = Math.min(minY, this.root.worldToLocal(frame.localToWorld(p.copy(point))).y - radius);
    }
    return minY;
  }

  // APPROX: apoyo cinemático, el punto de contacto más bajo toca el suelo. Sin física ni equilibrio
  // todavía: el torso no se desplaza en X/Z y el robot no se cae.
  private ground(): void {
    this.root.position.y = 0;
    this.root.updateMatrixWorld(true);
    const minY = this.lowestPoint();
    if (Number.isFinite(minY)) this.root.position.y = -minY;
  }
}


const Y_AXIS = new THREE.Vector3(0, 1, 0);

/** rpy del URDF (R = Rz·Ry·Rx) como cuaternión de Three */
export function rpyQuaternion([r, p, y]: Vec3): THREE.Quaternion {
  return new THREE.Quaternion().setFromEuler(new THREE.Euler(r, p, y, 'ZYX'));
}

/**
 * Puntos que pueden tocar el suelo: [link, punto en su frame (m), radio]. Coinciden con la
 * geometría provisional de linkVisuals; con las piezas de Meshy se ajustarán.
 */
const CONTACT_PROBES: [string, Vec3, number][] = [
  ...(['l_ankle', 'r_ankle'] as const).flatMap((link) => {
    const y = link === 'l_ankle' ? 0.003 : -0.003;
    return [-0.055, 0.105].flatMap((x) => [y - 0.045, y + 0.045].map((yy): [string, Vec3, number] => [link, [x, yy, -0.04511], 0]));
  }),
  ...[-0.05, 0.05].flatMap((x) =>
    [-0.065, 0.065].flatMap((y) => [-0.095, 0.115].map((z): [string, Vec3, number] => ['torso', [x, y, z], 0])),
  ),
  ['Head', [0.0575, 0, 0.058], 0], ['Head', [-0.0575, 0, 0.058], 0], ['Head', [0, 0, 0.1155], 0],
  ['Head', [0, 0.065, 0.058], 0], ['Head', [0, -0.065, 0.058], 0],
  ...['L', 'R'].flatMap((s): [string, Vec3, number][] => [
    [`${s}Shoulder`, [0, 0, 0], 0.03],
    [`${s}Elbow`, [0, 0, 0], 0.021],
    [`${s.toLowerCase()}_wrist`, [0.05, 0, -0.006], 0.02],
    [`${s}Thigh`, [0, 0, -0.05], 0.031],
    [`${s}Tibia`, [0, 0, 0], 0.028],
    [`${s}Tibia`, [0, 0, -0.05], 0.027],
  ]),
];

function collectMeshes(obj: THREE.Object3D): THREE.Mesh[] {
  const out: THREE.Mesh[] = [];
  obj.traverse((o) => {
    if (o instanceof THREE.Mesh) out.push(o);
  });
  return out;
}

function mesh(geometry: THREE.BufferGeometry, material: THREE.MeshStandardMaterial): THREE.Mesh {
  const m = new THREE.Mesh(geometry, material);
  m.castShadow = true;
  m.receiveShadow = true;
  m.userData.material = material;
  return m;
}

function shapeMesh(shape: Shape): THREE.Mesh {
  const mat = MAT[shape.material];
  switch (shape.kind) {
    case 'capsule': {
      const A = new THREE.Vector3(...shape.from);
      const B = new THREE.Vector3(...shape.to);
      const m = mesh(new THREE.CapsuleGeometry(shape.radius, A.distanceTo(B), 6, 16), mat);
      m.position.copy(A).add(B).multiplyScalar(0.5);
      m.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), B.clone().sub(A).normalize());
      return m;
    }
    case 'sphere': {
      const m = mesh(new THREE.SphereGeometry(shape.radius, 20, 14), mat);
      m.position.set(...shape.center);
      return m;
    }
    case 'box': {
      const [x, y, z] = shape.size;
      const m = mesh(new RoundedBoxGeometry(x, y, z, 3, shape.round), mat);
      m.position.set(...shape.center);
      return m;
    }
    case 'disc': {
      const m = mesh(new THREE.CylinderGeometry(shape.radius, shape.radius, shape.thickness, 24), mat);
      m.position.set(...shape.center);
      if (shape.normal === 'x') m.rotation.z = Math.PI / 2;
      if (shape.normal === 'z') m.rotation.x = Math.PI / 2;
      return m;
    }
  }
}
