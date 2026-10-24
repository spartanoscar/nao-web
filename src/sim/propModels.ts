// Modelos 3D de los muebles (Meshy u otros, docs/MESHY.md): reemplazan a su placeholder de formas simples (props.ts,
// mismo id). public/models/props/manifest.json lista los que hay; sin manifiesto se quedan los placeholders. Cada
// modelo se ajusta solo a la caja de su placeholder: de Y arriba (glTF) a Z arriba, el frente (+Z de glTF) hacia donde
// mira el mueble, escala uniforme para caber, centrado y apoyado en el piso. La física no cambia (las cajas del
// placeholder). Admite geometría comprimida con meshopt (juntox/site/tools/prep-hero.mjs) con el decodificador local.

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { PROPS, type PropPart } from './props';
import type { RoomId } from './rooms';

const BASE = '/models/props/';

/** Una entrada del manifiesto: el archivo y, si el modelo vino girado, cuántos grados corregir su frente */
interface ManifestEntry {
  file: string;
  turn?: number;
}

/** Caja (Z arriba) que ocupa el placeholder de un mueble, desde los datos de sus piezas */
function placeholderBox(parts: PropPart[]): THREE.Box3 {
  const box = new THREE.Box3();
  const corner = new THREE.Vector3();
  for (const p of parts) {
    const [sx, sy, sz] = p.size;
    const [c, s] = [Math.cos(p.yaw ?? 0), Math.sin(p.yaw ?? 0)];
    for (const dx of [-1, 1]) for (const dy of [-1, 1]) for (const dz of [-1, 1]) {
      const [lx, ly] = [(dx * sx) / 2, (dy * sy) / 2];
      box.expandByPoint(corner.set(p.pos[0] + c * lx - s * ly, p.pos[1] + s * lx + c * ly, p.pos[2] + (dz * sz) / 2));
    }
  }
  return box;
}

/** Orienta, escala y coloca el modelo dentro de la caja del placeholder; devuelve el contenedor listo para la escena */
export function fitModel(scene: THREE.Object3D, target: THREE.Box3, facing: number, turnDeg = 0): THREE.Group {
  const holder = new THREE.Group();
  const model = new THREE.Group();
  model.add(scene);
  model.rotation.x = Math.PI / 2; // glTF Y arriba → Z arriba; su frente (+Z) queda mirando a −Y
  holder.add(model);
  holder.rotation.z = facing + Math.PI / 2 + THREE.MathUtils.degToRad(turnDeg); // −Y → hacia donde mira el mueble
  holder.updateMatrixWorld(true);
  const size = new THREE.Box3().setFromObject(holder).getSize(new THREE.Vector3());
  const want = target.getSize(new THREE.Vector3());
  holder.scale.setScalar(Math.min(want.x / size.x, want.y / size.y, want.z / size.z));
  holder.updateMatrixWorld(true);
  const got = new THREE.Box3().setFromObject(holder);
  const [center, gotCenter] = [target.getCenter(new THREE.Vector3()), got.getCenter(new THREE.Vector3())];
  holder.position.set(center.x - gotCenter.x, center.y - gotCenter.y, target.min.z - got.min.z);
  return holder;
}

/**
 * Carga los modelos del manifiesto y reemplaza a sus placeholders (`meshes`: las mallas simples por id de mueble).
 * `inRoom` pone el modelo en la capa de su cuarto; `ready` avisa para redibujar.
 */
export async function loadPropModels(
  zUp: THREE.Group,
  meshes: ReadonlyMap<string, THREE.Object3D[]>,
  inRoom: (obj: THREE.Object3D, room: RoomId) => void,
  ready: () => void,
): Promise<string[]> {
  let manifest: Record<string, ManifestEntry>;
  try {
    const res = await fetch(`${BASE}manifest.json`);
    if (!res.ok) return [];
    manifest = await res.json();
  } catch {
    return [];
  }
  const loader = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);
  const loaded: string[] = [];
  await Promise.all(
    Object.entries(manifest).map(async ([id, entry]) => {
      const parts = PROPS.filter((p) => p.model === id);
      if (!parts.length) return console.warn(`Modelo ${id}: no hay un mueble con ese id en props.ts`);
      try {
        const gltf = await loader.loadAsync(BASE + entry.file);
        const facing = parts.find((p) => p.facing !== undefined)?.facing ?? 0;
        const holder = fitModel(gltf.scene, placeholderBox(parts), facing, entry.turn);
        holder.name = `model:${id}`;
        holder.traverse((o) => {
          if (o instanceof THREE.Mesh) {
            o.castShadow = true;
            o.receiveShadow = true;
          }
        });
        inRoom(holder, parts[0].room);
        zUp.add(holder);
        for (const m of meshes.get(id) ?? []) m.visible = false;
        loaded.push(id);
      } catch (e) {
        console.warn(`Modelo ${id} (${entry.file}) no cargó; queda el placeholder:`, e);
      }
    }),
  );
  if (loaded.length) ready();
  return loaded;
}

