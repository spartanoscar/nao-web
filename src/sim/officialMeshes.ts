// Mallas 3D oficiales del NAO V4 (© Aldebaran / SoftBank Robotics, CC BY-NC-ND 4.0), servidas sin
// modificar desde public/models/nao_meshes/ (scripts/fetch-nao-meshes.sh). Cada link del URDF
// declara su malla en <visual> (escala 0.1, origen en el frame del link), así que encajan tal cual
// en los frames de NaoModel. La física no las usa: colisiona con sim/shapes.ts.
//
// Condición de Aldebaran: "can be redistributed, but in their installer form" (el usuario acepta la
// licencia con un clic antes de recibirlas) → la UI pide aceptar antes de llamar a loadOfficialMeshes.

import * as THREE from 'three';
import { ColladaLoader } from 'three/addons/loaders/ColladaLoader.js';
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

// ─── Color de la carcasa ──────────────────────────────────────────────────────
// La textura oficial es un atlas con zonas rotuladas por Aldebaran ("Structure", "Main Skin",
// "Inside", "Eyes", "Colored part"). Las piezas de color usan el rectángulo "Colored part": para las
// variantes de color se dibuja en memoria una copia de la textura con ese rectángulo de otro color.
// El archivo no se modifica y el azul usa la textura original tal cual.

export interface ShellColor {
  id: string;
  label: string;
  /** null = textura original (azul) */
  hex: number | null;
}

/** Variantes de color del NAO V4. APPROX: Aldebaran no publica los códigos; tonos aproximados. */
export const SHELL_COLORS: readonly ShellColor[] = [
  { id: 'blue', label: 'Azul', hex: null },
  { id: 'red', label: 'Rojo', hex: 0xcc1f2a },
  { id: 'orange', label: 'Naranja', hex: 0xf0701a },
  { id: 'black', label: 'Negro', hex: 0x262628 },
];

/** "Colored part" en textureNAO.png (640×400): medido, un rectángulo exacto de #0826e0 */
const COLORED_PART = { x: 465, y: 0, w: 129, h: 167 };
const TEXTURE_URL = `${MESHES_BASE}texture/textureNAO.png`;

const originals = new WeakMap<THREE.Material, THREE.Texture>();
const tinted = new Map<number, Promise<HTMLCanvasElement>>();

function tintedAtlas(hex: number): Promise<HTMLCanvasElement> {
  let p = tinted.get(hex);
  if (!p) {
    p = new THREE.ImageLoader().loadAsync(TEXTURE_URL).then((img) => {
      const canvas = document.createElement('canvas');
      canvas.width = img.width;
      canvas.height = img.height;
      const g = canvas.getContext('2d')!;
      g.drawImage(img, 0, 0);
      g.fillStyle = `#${hex.toString(16).padStart(6, '0')}`;
      g.fillRect(COLORED_PART.x, COLORED_PART.y, COLORED_PART.w, COLORED_PART.h);
      return canvas;
    });
    tinted.set(hex, p);
  }
  return p;
}

/** Cambia el color de las piezas de color de todas las mallas oficiales dadas */
export async function setShellColor(meshes: Iterable<THREE.Object3D>, color: ShellColor): Promise<void> {
  const atlas = color.hex === null ? null : await tintedAtlas(color.hex);
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
        if (!atlas) {
          (m as THREE.MeshPhongMaterial).map = original;
          continue;
        }
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
