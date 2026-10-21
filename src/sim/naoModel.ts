// Modelo 3D del NAO construido desde el URDF. La jerarquía (frames, orígenes, ejes, dedos mimic) es
// la oficial; la geometría que viste cada link es provisional (primitivas) hasta tener las piezas de
// Meshy (F7), que se colgarán de los mismos frames.

import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import type { RobotState } from '../robot/state';
import type { UrdfJoint, UrdfRobot, Vec3 } from '../robot/urdf';

interface MovableJoint {
  joint: UrdfJoint;
  motion: THREE.Group;
  axis: THREE.Vector3;
}

const MAT = {
  shell: new THREE.MeshStandardMaterial({ color: 0xf2f3f5, roughness: 0.35, metalness: 0.05 }),
  joint: new THREE.MeshStandardMaterial({ color: 0x5d6675, roughness: 0.5, metalness: 0.25 }),
  dark: new THREE.MeshStandardMaterial({ color: 0x2b3038, roughness: 0.6 }),
  eye: new THREE.MeshStandardMaterial({ color: 0x3aa0ff, emissive: 0x3aa0ff, emissiveIntensity: 1.6 }),
  highlight: new THREE.MeshStandardMaterial({ color: 0xffb020, emissive: 0xff8a00, emissiveIntensity: 0.5, roughness: 0.4 }),
};

export class NaoModel {
  /** Nodo a añadir a la escena (Y arriba) */
  readonly root = new THREE.Group();
  /** base_link en convención URDF (Z arriba, X adelante) */
  private readonly base = new THREE.Group();
  private readonly frames = new Map<string, THREE.Group>();
  private readonly movable: MovableJoint[] = [];
  private readonly highlightSets = new Map<string, THREE.Mesh[]>();
  private readonly soles: THREE.Object3D[] = [];
  private appliedRevision = -1;
  private highlighted: string | null = null;

  constructor(urdf: UrdfRobot) {
    this.root.name = 'NAO';
    this.base.rotation.x = -Math.PI / 2;
    this.root.add(this.base);
    this.frames.set(urdf.root, this.base);

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
        origin.rotation.set(j.rpy[0], j.rpy[1], j.rpy[2], 'ZYX'); // URDF: Rz·Ry·Rx
        const motion = new THREE.Group();
        motion.name = j.child;
        origin.add(motion);
        this.frames.get(link)!.add(origin);
        this.frames.set(j.child, motion);
        if (j.type !== 'fixed') this.movable.push({ joint: j, motion, axis: new THREE.Vector3(...j.axis) });
        queue.push(j.child);
      }
    }

    for (const [link, frame] of this.frames) for (const mesh of linkVisuals(link)) frame.add(mesh);

    // Resaltar un joint = todo lo que se mueve con él (incluye joints mimic: dedos, RHipYawPitch)
    for (const { joint, motion } of this.movable) {
      const meshes = collectMeshes(motion);
      for (const other of this.movable) {
        if (other.joint.mimic?.joint === joint.name) meshes.push(...collectMeshes(other.motion));
      }
      this.highlightSets.set(joint.name, [...new Set(meshes)]);
    }

    for (const name of ['l_sole', 'r_sole']) {
      const sole = this.frames.get(name);
      if (sole) this.soles.push(sole);
    }
  }

  /** Frame de un link del URDF (p. ej. CameraTop_frame para la cámara virtual) */
  frame(link: string): THREE.Object3D | undefined {
    return this.frames.get(link);
  }

  /** Copia los ángulos del estado a la escena (solo si el estado cambió) */
  apply(state: RobotState): void {
    if (state.revision === this.appliedRevision) return;
    this.appliedRevision = state.revision;
    for (const { joint, motion, axis } of this.movable) {
      const q = joint.mimic
        ? state.get(joint.mimic.joint) * joint.mimic.multiplier + joint.mimic.offset
        : state.get(joint.name);
      motion.quaternion.setFromAxisAngle(axis, q);
    }
    this.ground();
  }

  highlight(jointName: string | null): void {
    if (jointName === this.highlighted) return;
    for (const m of this.highlightSets.get(this.highlighted ?? '') ?? []) m.material = m.userData.material;
    this.highlighted = jointName;
    for (const m of this.highlightSets.get(jointName ?? '') ?? []) m.material = MAT.highlight;
  }

  // APPROX: apoyo cinemático, la planta más baja toca el suelo. Sin física ni equilibrio todavía:
  // el torso no se desplaza en X/Z y el robot no se cae.
  private ground(): void {
    this.root.position.y = 0;
    this.root.updateMatrixWorld(true);
    const p = new THREE.Vector3();
    let minY = Infinity;
    for (const sole of this.soles) minY = Math.min(minY, this.root.worldToLocal(sole.getWorldPosition(p)).y);
    if (Number.isFinite(minY)) this.root.position.y = -minY;
  }
}

function collectMeshes(obj: THREE.Object3D): THREE.Mesh[] {
  const out: THREE.Mesh[] = [];
  obj.traverse((o) => {
    if (o instanceof THREE.Mesh) out.push(o);
  });
  return out;
}

// ─── Geometría provisional por link ────────────────────────────────────────────
// Coordenadas en el frame del link (URDF, metros). Las medidas buscan parecerse al NAO, pero son
// solo visuales: la cinemática ya está fijada por los orígenes de los joints.

function mesh(geometry: THREE.BufferGeometry, material: THREE.MeshStandardMaterial): THREE.Mesh {
  const m = new THREE.Mesh(geometry, material);
  m.castShadow = true;
  m.receiveShadow = true;
  m.userData.material = material;
  return m;
}

function capsule(a: Vec3, b: Vec3, r: number, mat: THREE.MeshStandardMaterial): THREE.Mesh {
  const A = new THREE.Vector3(...a);
  const B = new THREE.Vector3(...b);
  const m = mesh(new THREE.CapsuleGeometry(r, A.distanceTo(B), 6, 16), mat);
  m.position.copy(A).add(B).multiplyScalar(0.5);
  m.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), B.clone().sub(A).normalize());
  return m;
}

function sphere(c: Vec3, r: number, mat: THREE.MeshStandardMaterial): THREE.Mesh {
  const m = mesh(new THREE.SphereGeometry(r, 20, 14), mat);
  m.position.set(...c);
  return m;
}

function rbox(c: Vec3, size: Vec3, radius: number, mat: THREE.MeshStandardMaterial): THREE.Mesh {
  const m = mesh(new RoundedBoxGeometry(size[0], size[1], size[2], 3, radius), mat);
  m.position.set(...c);
  return m;
}

/** Disco cuya cara mira hacia el eje dado */
function disc(c: Vec3, r: number, thickness: number, normal: 'x' | 'y' | 'z', mat: THREE.MeshStandardMaterial): THREE.Mesh {
  const m = mesh(new THREE.CylinderGeometry(r, r, thickness, 24), mat);
  m.position.set(...c);
  if (normal === 'x') m.rotation.z = Math.PI / 2;
  if (normal === 'z') m.rotation.x = Math.PI / 2;
  return m;
}

function linkVisuals(link: string): THREE.Mesh[] {
  if (/Finger\d\d_link$|Thumb\d_link$/.test(link)) return [capsule([0, 0, 0], [0.0144, 0, 0], 0.005, MAT.dark)];

  const s = /^(L|l_)/.test(link) ? 1 : -1; // espejo izquierda/derecha
  switch (link.replace(/^(L|R|l_|r_)(?=[A-Za-z])/, '')) {
    case 'torso':
      return [
        rbox([0, 0, 0.03], [0.1, 0.13, 0.17], 0.03, MAT.shell),
        rbox([-0.005, 0, -0.072], [0.075, 0.13, 0.045], 0.015, MAT.joint),
        disc([0.05, 0, 0.0552], 0.012, 0.004, 'x', MAT.dark), // botón del pecho
      ];
    case 'Neck':
      return [disc([0, 0, -0.005], 0.018, 0.03, 'z', MAT.joint)];
    case 'Head':
      return [
        rbox([0, 0, 0.058], [0.115, 0.13, 0.115], 0.045, MAT.shell),
        disc([0.056, 0.027, 0.048], 0.013, 0.004, 'x', MAT.eye),
        disc([0.056, -0.027, 0.048], 0.013, 0.004, 'x', MAT.eye),
        disc([-0.005, 0.066, 0.055], 0.026, 0.012, 'y', MAT.joint), // orejas (parlantes)
        disc([-0.005, -0.066, 0.055], 0.026, 0.012, 'y', MAT.joint),
        disc([0.058, 0, 0.0636], 0.005, 0.004, 'x', MAT.dark), // CameraTop
        disc([0.057, 0, 0.0177], 0.005, 0.004, 'x', MAT.dark), // CameraBottom
      ];
    case 'Shoulder':
      return [sphere([0, 0, 0], 0.03, MAT.joint)];
    case 'Bicep':
      return [capsule([0.012, 0, 0], [0.098, 0.015 * s, 0], 0.026, MAT.shell)];
    case 'Elbow':
      return [sphere([0, 0, 0], 0.021, MAT.joint)];
    case 'ForeArm':
      return [capsule([0.008, 0, 0], [0.05, 0, 0], 0.021, MAT.shell)];
    case 'wrist':
      return [rbox([0.028, 0, -0.006], [0.045, 0.042, 0.03], 0.01, MAT.shell)];
    case 'Pelvis':
      return [sphere([0, 0, 0], 0.022, MAT.joint)];
    case 'Thigh':
      return [capsule([0, 0, -0.008], [0, 0, -0.092], 0.031, MAT.shell)];
    case 'Tibia':
      return [sphere([0, 0, 0], 0.028, MAT.joint), capsule([0, 0, -0.01], [0, 0, -0.093], 0.027, MAT.shell)];
    case 'AnklePitch':
      return [sphere([0, 0, 0], 0.02, MAT.joint)];
    case 'ankle':
      return [
        rbox([0.025, 0.003 * s, -0.0321], [0.16, 0.088, 0.02], 0.008, MAT.shell),
        rbox([0.025, 0.003 * s, -0.0436], [0.162, 0.09, 0.003], 0.001, MAT.dark), // suela
      ];
    default:
      return [];
  }
}
