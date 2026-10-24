// Logo de la Fundación Universitaria Los Libertadores sobre el botón del pecho (el de encendido en
// el NAO real). Es una pieza propia, aparte: las mallas de Aldebaran no se modifican (CC BY-NC-ND).
// Se apoya en la superficie del pecho lanzando un rayo hacia el ChestButton_frame del URDF, y se
// orienta con la normal de la carcasa en ese punto, como una calcomanía.

import * as THREE from 'three';
import type { NaoModel } from './naoModel';

const LOGO_URL = '/brand/logo-libertadores.png';
/** Centro del botón del pecho en el frame del torso: ChestBoard/Button_sensor_fixedjoint del URDF */
const CHEST_BUTTON = new THREE.Vector3(0.049871, 0.001588, 0.055163);
/** APPROX: radio del botón del pecho del NAO (~3 cm de diámetro) */
const RADIUS = 0.0145;
/** Separación de la superficie para que no parpadee con la carcasa */
const LIFT = 0.0006;

let texture: THREE.Texture | null = null;

function logoMesh(onLoad: () => void): THREE.Mesh {
  if (!texture) {
    texture = new THREE.TextureLoader().load(LOGO_URL, onLoad);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.anisotropy = 8;
  }
  const mat = new THREE.MeshStandardMaterial({
    map: texture,
    transparent: true,
    roughness: 0.45,
    polygonOffset: true,
    polygonOffsetFactor: -2,
  });
  const mesh = new THREE.Mesh(new THREE.CircleGeometry(RADIUS, 64), mat);
  mesh.name = 'chest-logo';
  mesh.receiveShadow = true;
  mesh.userData.material = mat;
  mesh.userData.decal = true;
  return mesh;
}

/**
 * Orienta el disco (que mira a +Z) para que mire hacia `normal` con la parte de arriba del logo
 * hacia la cabeza (+Z del torso) y su derecha hacia la izquierda del robot (+Y): así se lee de frente.
 */
function orient(mesh: THREE.Mesh, point: THREE.Vector3, normal: THREE.Vector3) {
  const n = normal.clone().normalize();
  const right = new THREE.Vector3(0, 0, 1).cross(n).normalize();
  const up = n.clone().cross(right);
  mesh.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(right, up, n));
  mesh.position.copy(point).addScaledVector(n, LIFT);
}

/** Logo sobre el pecho de la malla oficial: rayo desde delante hacia el botón */
export function addChestLogo(nao: NaoModel, onLoad: () => void): boolean {
  const torso = nao.frame('torso');
  const shell = torso?.getObjectByName('mesh:torso');
  if (!torso || !shell) return false;
  nao.root.updateMatrixWorld(true);

  const origin = torso.localToWorld(CHEST_BUTTON.clone().setX(0.2));
  const target = torso.localToWorld(CHEST_BUTTON.clone());
  const ray = new THREE.Raycaster(origin, target.sub(origin).normalize());
  const hit = ray.intersectObject(shell, true)[0];
  if (!hit?.face) return false;

  const point = torso.worldToLocal(hit.point.clone());
  const normalMatrix = new THREE.Matrix3().getNormalMatrix(
    new THREE.Matrix4().copy(torso.matrixWorld).invert().multiply(hit.object.matrixWorld),
  );
  const normal = hit.face.normal.clone().applyMatrix3(normalMatrix).normalize();
  if (normal.x < 0) normal.negate(); // la cara puede venir invertida: el logo mira hacia delante

  const mesh = logoMesh(onLoad);
  orient(mesh, point, normal);
  nao.attach('torso', mesh);
  return true;
}
