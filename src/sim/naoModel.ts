// Modelo 3D del NAO construido desde el URDF. La jerarquía (frames, orígenes, ejes, dedos mimic) es
// la oficial; cada link lleva su malla oficial de Aldebaran (sim/officialMeshes.ts). La pose del torso la da la física.

import * as THREE from 'three';
import type { RobotState, RootPose } from '../robot/state';
import type { UrdfJoint, UrdfRobot, Vec3 } from '../robot/urdf';

/** Pieza resaltada (la que se elige para moverla, ui/bodyPicker.ts) */
const HIGHLIGHT = new THREE.MeshStandardMaterial({ color: 0xffb020, emissive: 0xff8a00, emissiveIntensity: 0.5, roughness: 0.4 });

interface MovableJoint {
  joint: UrdfJoint;
  motion: THREE.Group;
  axis: THREE.Vector3;
}

export class NaoModel {
  /** Nodo a añadir a la escena (Y arriba) */
  readonly root = new THREE.Group();
  /** base_link en convención URDF (Z arriba, X adelante) */
  private readonly base = new THREE.Group();
  /** Pose del torso (la de la física) */
  private readonly tilt = new THREE.Group();
  private readonly frames = new Map<string, THREE.Group>();
  private readonly movable: MovableJoint[] = [];
  private readonly soles: THREE.Object3D[] = [];
  private appliedRevision = -1;
  /** Mallas pintadas de amarillo ahora */
  private highlighted: THREE.Mesh[] = [];

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
    for (const name of ['l_sole', 'r_sole']) {
      const sole = this.frames.get(name);
      if (sole) this.soles.push(sole);
    }
  }

  /** Cuelga las mallas oficiales de sus links */
  setOfficialMeshes(meshes: ReadonlyMap<string, THREE.Object3D>): void {
    for (const [link, mesh] of meshes) this.frames.get(link)?.add(mesh);
  }

  /** Cuelga un objeto propio de un link (logo del pecho, LEDs) */
  attach(link: string, obj: THREE.Object3D): void {
    const frame = this.frames.get(link);
    if (!frame) throw new Error(`link desconocido: ${link}`);
    frame.add(obj);
  }

  /** Malla oficial de un link (para proyectar decals); sin los decals ya colocados */
  surfaces(link: string): THREE.Object3D[] {
    const shell = this.frames.get(link)?.getObjectByName(`mesh:${link}`);
    return shell ? [shell] : [];
  }

  /** Mallas de la carcasa del robot (para apuntarles con el cursor) */
  pickables(): THREE.Object3D[] {
    const out: THREE.Object3D[] = [];
    this.root.traverseVisible((o) => {
      if (o instanceof THREE.Mesh && !o.userData.decal) out.push(o);
    });
    return out;
  }

  /**
   * Articulación que mueve la pieza `object` (una malla del robot): la primera articulación móvil subiendo por el árbol.
   * Los dedos (mimic de LHand/RHand) cuentan como la mano. null si es el torso o algo que no es del robot.
   */
  jointAt(object: THREE.Object3D): string | null {
    for (let o: THREE.Object3D | null = object; o && o !== this.root; o = o.parent) {
      const m = this.movable.find((j) => j.motion === o);
      if (m) return m.joint.mimic?.joint ?? m.joint.name;
    }
    return null;
  }

  /** Pinta de amarillo lo que se mueve con una articulación (la pieza y lo que cuelga de ella; null = nada) */
  highlight(joint: string | null): void {
    for (const m of this.highlighted) m.material = m.userData.material;
    this.highlighted = [];
    if (!joint) return;
    for (const { joint: j, motion } of this.movable) {
      if (j.name !== joint && j.mimic?.joint !== joint) continue;
      motion.traverse((o) => {
        if (o instanceof THREE.Mesh && o.userData.material && !o.userData.decal) this.highlighted.push(o);
      });
    }
    for (const m of this.highlighted) m.material = HIGHLIGHT;
  }

  /**
   * Pose de un link en el mundo, Z arriba (la de la física): posición y cuaternión [w, x, y, z]. El NAO de otra persona
   * (sim/remoteNao.ts) pone así sus piezas en la física local. Antes, `root.updateMatrixWorld(true)`.
   */
  linkPose(link: string): { position: number[]; quaternion: number[] } {
    const m = new THREE.Matrix4().copy(this.base.matrixWorld).invert().multiply(this.frames.get(link)!.matrixWorld);
    const p = new THREE.Vector3();
    const q = new THREE.Quaternion();
    m.decompose(p, q, new THREE.Vector3());
    return { position: [p.x, p.y, p.z], quaternion: [q.w, q.x, q.y, q.z] };
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
    // Antes de que arranque la física (detrás de la pantalla de entrada): apoyado sobre los pies en el origen
    const root = state.root ?? this.groundedRootPose();
    const [w, x, y, z] = root.quaternion;
    this.root.position.y = 0;
    this.tilt.position.set(...root.position);
    this.tilt.quaternion.set(x, y, z, w);
    return true;
  }

  /**
   * Pose del torso (Z arriba) con los ángulos actuales apoyado en el suelo sobre el pie más bajo, plano, en el origen:
   * de donde arranca la física (el NAO se enciende en Crouch).
   */
  groundedRootPose(): RootPose {
    this.tilt.position.set(0, 0, 0);
    this.tilt.quaternion.copy(this.flatFootTilt());
    this.root.position.y = 0;
    this.root.updateMatrixWorld(true);
    const p = new THREE.Vector3();
    const lowest = Math.min(...this.soles.map((s) => this.root.worldToLocal(s.getWorldPosition(p)).y));
    const q = this.tilt.quaternion;
    return { position: [0, 0, -lowest], quaternion: [q.w, q.x, q.y, q.z] };
  }

  /** Orientación del torso con la que el pie de apoyo (el más bajo en el frame del torso) queda plano */
  private flatFootTilt(): THREE.Quaternion {
    this.tilt.quaternion.identity();
    this.base.updateMatrixWorld(true);
    const baseInv = this.base.getWorldQuaternion(new THREE.Quaternion()).invert();
    const p = new THREE.Vector3();
    const support = this.soles.reduce((a, b) =>
      this.base.worldToLocal(a.getWorldPosition(p)).z <= this.base.worldToLocal(b.getWorldPosition(p.clone())).z ? a : b,
    );
    const foot = baseInv.multiply(support.getWorldQuaternion(new THREE.Quaternion()));
    const yaw = new THREE.Euler().setFromQuaternion(foot, 'ZYX').z;
    return new THREE.Quaternion().setFromEuler(new THREE.Euler(0, 0, yaw, 'ZYX')).multiply(foot.invert());
  }
}

/** rpy del URDF (R = Rz·Ry·Rx) como cuaternión de Three */
export function rpyQuaternion([r, p, y]: Vec3): THREE.Quaternion {
  return new THREE.Quaternion().setFromEuler(new THREE.Euler(r, p, y, 'ZYX'));
}
