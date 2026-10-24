// Mallas 3D oficiales del NAO V4 (© Aldebaran / SoftBank Robotics, CC BY-NC-ND 4.0), servidas sin
// modificar desde public/models/nao_meshes/ (scripts/fetch-nao-meshes.sh). Cada link del URDF
// declara su malla en <visual> (escala 0.1, origen en el frame del link), así que encajan tal cual
// en los frames de NaoModel. La física colisiona con su envolvente convexa (collisionHulls).
//
// Condición de Aldebaran: "can be redistributed, but in their installer form" (el usuario acepta la
// licencia con un clic antes de recibirlas) → la UI pide aceptar antes de llamar a loadOfficialMeshes.

import * as THREE from 'three';
import { ColladaLoader } from 'three/addons/loaders/ColladaLoader.js';
import { ConvexHull } from 'three/addons/math/ConvexHull.js';
import type { UrdfRobot } from '../robot/urdf';
import { rpyQuaternion } from './naoModel';

export const MESHES_BASE = '/models/nao_meshes/';
export const MESHES_LICENSE_URL = `${MESHES_BASE}LICENSE.txt`;
export const MESHES_ATTRIBUTION = 'Modelo 3D del NAO © Aldebaran / SoftBank Robotics · CC BY-NC-ND 4.0';

/** package://nao_meshes/meshes/V40/X.dae → /models/nao_meshes/meshes/V40/X.dae */
const meshUrl = (pkg: string) => MESHES_BASE + pkg.replace(/^package:\/\/nao_meshes\//, '');

/** link → malla lista para colgar de su frame (ya escalada y orientada según el URDF) */
export async function loadOfficialMeshes(
  urdf: UrdfRobot,
  onProgress: (loaded: number, total: number) => void,
): Promise<Map<string, THREE.Object3D>> {
  const links = urdf.links.filter((l) => l.visual);
  const loader = new ColladaLoader();
  const result = new Map<string, THREE.Object3D>();
  let loaded = 0;

  // ColladaLoader avisa en cada archivo Z_UP que lo rota a Y arriba; aquí se deshace esa rotación
  // (los frames del NaoModel ya son Z arriba), así que el aviso no aplica.
  const warn = console.warn;
  console.warn = (...args: unknown[]) => {
    if (typeof args[0] === 'string' && args[0].includes('Z-UP')) return;
    warn(...args);
  };
  try {
    await Promise.all(
      links.map(async (link) => {
        const url = meshUrl(link.visual!.mesh);
        const collada = await loader.loadAsync(url);
        if (!collada) throw new Error(`malla inválida: ${url}`);
        const scene = collada.scene;
        scene.rotation.set(0, 0, 0);
        scene.scale.set(1, 1, 1);
        const holder = new THREE.Group();
        holder.name = `mesh:${link.name}`;
        holder.position.set(...link.visual!.xyz);
        holder.quaternion.copy(rpyQuaternion(link.visual!.rpy));
        holder.scale.set(...link.visual!.scale);
        holder.add(scene);
        holder.traverse((o) => {
          if (o instanceof THREE.Mesh) {
            o.castShadow = true;
            o.receiveShadow = true;
            o.userData.material = o.material;
          }
        });
        result.set(link.name, holder);
        onProgress(++loaded, links.length);
      }),
    );
  } finally {
    console.warn = warn;
  }
  return result;
}

/**
 * Copia de las mallas para otro NAO (mundo compartido, sim/remoteNao.ts): comparte la geometría y lleva materiales
 * propios, para que su color de carcasa no cambie el del NAO del jugador. Copiar antes de pintar (setShellColor).
 */
export function cloneOfficialMeshes(meshes: ReadonlyMap<string, THREE.Object3D>): Map<string, THREE.Object3D> {
  const out = new Map<string, THREE.Object3D>();
  for (const [link, holder] of meshes) {
    // clone() copia userData con JSON: sin el material guardado ahí (no se serializa)
    const stash = new Map<THREE.Object3D, unknown>();
    holder.traverse((o) => {
      stash.set(o, o.userData.material);
      delete o.userData.material;
    });
    const copy = holder.clone(true);
    for (const [o, m] of stash) if (m) o.userData.material = m;
    copy.traverse((o) => {
      if (!(o instanceof THREE.Mesh)) return;
      o.material = Array.isArray(o.material) ? o.material.map((m) => m.clone()) : o.material.clone();
      o.userData = { ...o.userData, material: o.material };
    });
    out.set(link, copy);
  }
  return out;
}

/** Los dedos no tienen cuerpo en la física (siguen a LHand/RHand): su forma va con la muñeca */
/** Dedos (sin masa en el URDF, siguen a LHand/RHand): van con la muñeca */
const isFingerLink = (link: string) => /Finger\d\d_link$|Thumb\d_link$/.test(link);
const handBody = (link: string) => (isFingerLink(link) ? (link.startsWith('L') ? 'l_wrist' : 'r_wrist') : link);

/**
 * Envolvente convexa de la malla oficial de cada cuerpo físico, en el frame de su link (m): la forma de colisión fiel
 * del NAO real para la física (physics/mjcf.ts). Las mallas tienen que estar colgadas de NaoModel (setOfficialMeshes).
 * `bodyOf` junta links sin cuerpo propio en su cuerpo: los dedos van con la muñeca, en la apertura de la mano del
 * momento (APPROX: en la física la mano no cambia de forma al abrirse). Se calcula en memoria desde las mallas
 * cargadas tal cual; no se guarda ni se redistribuye nada derivado de ellas.
 */
export function collisionHulls(
  meshes: ReadonlyMap<string, THREE.Object3D>,
  bodyOf: (link: string) => string = handBody,
): Map<string, Float32Array> {
  const clouds = new Map<string, THREE.Vector3[]>();
  const toBody = new THREE.Matrix4();
  const p = new THREE.Vector3();
  for (const [link, holder] of meshes) {
    const body = bodyOf(link);
    // Frame del cuerpo: los frames de NaoModel se llaman como su link
    let frame = holder.parent;
    while (frame && frame.name !== body) frame = frame.parent;
    if (!frame) continue;
    frame.updateWorldMatrix(true, false);
    holder.updateWorldMatrix(false, true);
    const inv = frame.matrixWorld.clone().invert();
    const points = clouds.get(body) ?? [];
    clouds.set(body, points);
    holder.traverse((o) => {
      if (!(o instanceof THREE.Mesh)) return;
      toBody.multiplyMatrices(inv, o.matrixWorld);
      const pos = o.geometry.attributes.position;
      for (let i = 0; i < pos.count; i++) points.push(p.fromBufferAttribute(pos, i).applyMatrix4(toBody).clone());
    });
  }
  const out = new Map<string, Float32Array>();
  for (const [link, points] of clouds) {
    if (points.length < 4) continue;
    // Solo los vértices de las caras (hull.vertices trae todos los puntos de entrada)
    const hull = new ConvexHull().setFromPoints(points);
    const corners = new Set<THREE.Vector3>();
    for (const face of hull.faces) {
      let edge = face.edge;
      do {
        corners.add(edge.head().point);
        edge = edge.next;
      } while (edge !== face.edge);
    }
    out.set(link, Float32Array.from([...corners].flatMap((v) => [v.x, v.y, v.z])));
  }
  return out;
}

// ─── Color de la carcasa y lente de los ojos ──────────────────────────────────
// La textura oficial es un atlas con zonas rotuladas por Aldebaran ("Structure", "Main Skin",
// "Inside", "Eyes", "Colored part"). Se dibuja en memoria una copia (el archivo no se modifica):
// - "Colored part" del color de carcasa elegido (null = el azul original);
// - "Eyes" como lente ahumada: en la textura los ojos son azul fijo y cualquier LED encima se teñía
//   de azul; en el robot real el ojo es una lente oscura con los LEDs detrás.

/** "Colored part" en textureNAO.png (640×400): medido, un rectángulo exacto de #0826e0 */
const COLORED_PART = { x: 465, y: 0, w: 129, h: 167 };
/** "Eyes" en textureNAO.png: medido (343–634, 247–394) */
const EYES = { x: 343, y: 247, w: 292, h: 148 };
/** APPROX: lente ahumada del ojo apagado */
const EYE_LENS = '#15181e';
const TEXTURE_URL = `${MESHES_BASE}texture/textureNAO.png`;

const originals = new WeakMap<THREE.Material, THREE.Texture>();
const tinted = new Map<number | null, Promise<HTMLCanvasElement>>();

function tintedAtlas(hex: number | null): Promise<HTMLCanvasElement> {
  let p = tinted.get(hex);
  if (!p) {
    p = new THREE.ImageLoader().loadAsync(TEXTURE_URL).then((img) => {
      const canvas = document.createElement('canvas');
      canvas.width = img.width;
      canvas.height = img.height;
      const g = canvas.getContext('2d')!;
      g.drawImage(img, 0, 0);
      if (hex !== null) {
        g.fillStyle = `#${hex.toString(16).padStart(6, '0')}`;
        g.fillRect(COLORED_PART.x, COLORED_PART.y, COLORED_PART.w, COLORED_PART.h);
      }
      g.fillStyle = EYE_LENS;
      g.fillRect(EYES.x, EYES.y, EYES.w, EYES.h);
      return canvas;
    });
    tinted.set(hex, p);
  }
  return p;
}

/** Pinta las mallas oficiales con el color de carcasa dado (null = el de fábrica) y la lente de los ojos */
export async function setShellColor(meshes: Iterable<THREE.Object3D>, hex: number | null): Promise<void> {
  const atlas = await tintedAtlas(hex);
  let texture: THREE.CanvasTexture | null = null;
  for (const root of meshes) {
    root.traverse((o) => {
      if (!(o instanceof THREE.Mesh)) return;
      for (const m of Array.isArray(o.material) ? o.material : [o.material]) {
        const map = (m as THREE.MeshPhongMaterial).map;
        if (!map && !originals.has(m)) continue;
        if (!originals.has(m)) {
          const src = String((map!.image as { src?: string } | undefined)?.src ?? '');
          if (!src.includes('textureNAO')) continue;
          originals.set(m, map!);
        }
        const original = originals.get(m)!;
        if (!texture) {
          texture = new THREE.CanvasTexture(atlas);
          texture.flipY = original.flipY;
          texture.wrapS = original.wrapS;
          texture.wrapT = original.wrapT;
          texture.colorSpace = original.colorSpace;
          texture.anisotropy = original.anisotropy;
        }
        (m as THREE.MeshPhongMaterial).map = texture;
      }
    });
  }
}
