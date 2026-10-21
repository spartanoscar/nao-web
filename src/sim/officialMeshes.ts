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
