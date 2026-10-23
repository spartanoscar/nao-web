// Escena 3D: render, cámara orbital, luces y el entorno (suelo, cubos y cajas).
// Unidades en metros (como el URDF). Three.js usa Y arriba; el robot mira hacia +X.

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { ENV_OBJECTS, MIRROR, MIRROR_FRAME } from './environment';
import { Reflector } from 'three/addons/objects/Reflector.js';

export interface World {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  controls: OrbitControls;
  /** Grupo con coordenadas Z arriba (URDF/MuJoCo): todo lo que mueve la física cuelga de aquí */
  zUp: THREE.Group;
  /** Mallas de los objetos del entorno por nombre (ver environment.ts) */
  objects: ReadonlyMap<string, THREE.Mesh>;
  /** Registra una función que corre en cada frame (dt en segundos) */
  onFrame(cb: (dt: number) => void): void;
  /**
   * Pide redibujar en el próximo frame. Se renderiza bajo demanda: con la escena quieta la GPU no
   * trabaja (dibujar sin parar a resolución retina saturaba la GPU y ralentizaba otras pestañas).
   * `shadows`: algo de la escena se movió y hay que recalcular el mapa de sombras.
   */
  invalidate(shadows?: boolean): void;
  /** Dibuja un cuadro ya (capturas, cámaras virtuales); el bucle normal sigue siendo bajo demanda */
  renderNow(): void;
  /** Corre justo después de cada cuadro dibujado (vistas extra en el mismo canvas, p. ej. las cámaras del NAO) */
  onAfterRender(cb: () => void): void;
}

const BG = 0x0e1116;
const BASE_FOV = 40;

export function createWorld(container: HTMLElement): World {
  const renderer = new THREE.WebGLRenderer({ antialias: true });
  // ×1.5 es casi indistinguible de ×2 y son ~44% menos píxeles por frame
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  // La luz es fija: la sombra solo cambia cuando algo se mueve, no al orbitar la cámara
  renderer.shadowMap.autoUpdate = false;
  renderer.shadowMap.needsUpdate = true;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  container.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(BG);
  scene.fog = new THREE.Fog(BG, 4, 9);

  const camera = new THREE.PerspectiveCamera(BASE_FOV, 1, 0.01, 50);
  camera.position.set(1.0, 0.55, 0.75);

  const controls = new OrbitControls(camera, renderer.domElement);
  controls.target.set(0, 0.28, 0);
  controls.enableDamping = true;
  controls.minDistance = 0.3;
  controls.maxDistance = 5;
  controls.maxPolarAngle = Math.PI / 2 - 0.02; // no atravesar el suelo
  controls.update();

  let dirty = true;
  const invalidate = (shadows = false) => {
    dirty = true;
    if (shadows) renderer.shadowMap.needsUpdate = true;
  };
  // También dispara durante la inercia (damping) mientras controls.update() siga moviendo la cámara
  controls.addEventListener('change', () => invalidate());

  addLights(scene);
  addFloor(scene);
  const zUp = new THREE.Group();
  zUp.rotation.x = -Math.PI / 2;
  scene.add(zUp);
  const objects = addObjects(zUp);
  addMirror(zUp);

  const resize = () => {
    const { clientWidth: w, clientHeight: h } = container;
    renderer.setSize(w, h);
    camera.aspect = w / h;
    // En pantallas verticales (móvil) se abre el FOV para conservar el encuadre horizontal
    const halfH = Math.tan(THREE.MathUtils.degToRad(BASE_FOV / 2));
    camera.fov = camera.aspect < 1 ? Math.min(75, THREE.MathUtils.radToDeg(2 * Math.atan(halfH / camera.aspect))) : BASE_FOV;
    camera.updateProjectionMatrix();
    invalidate();
  };
  new ResizeObserver(resize).observe(container);
  resize();

  const callbacks: ((dt: number) => void)[] = [];
  const afterRender: (() => void)[] = [];
  const draw = () => {
    renderer.render(scene, camera);
    for (const cb of afterRender) cb();
  };
  const timer = new THREE.Timer();
  renderer.setAnimationLoop((time) => {
    timer.update(time);
    const dt = Math.min(timer.getDelta(), 0.1);
    for (const cb of callbacks) cb(dt);
    controls.update();
    if (!dirty) return;
    dirty = false;
    draw();
  });

  const renderNow = () => {
    controls.update();
    draw();
  };

  return {
    renderer, scene, camera, controls, zUp, objects, invalidate, renderNow,
    onFrame: (cb) => void callbacks.push(cb),
    onAfterRender: (cb) => void afterRender.push(cb),
  };
}

function addLights(scene: THREE.Scene) {
  scene.add(new THREE.HemisphereLight(0xdde6ff, 0x1a1f28, 1.1));

  const sun = new THREE.DirectionalLight(0xffffff, 2.2);
  sun.position.set(2, 3.5, 1.5);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.camera.left = -2;
  sun.shadow.camera.right = 2;
  sun.shadow.camera.top = 2;
  sun.shadow.camera.bottom = -2;
  sun.shadow.camera.near = 0.5;
  sun.shadow.camera.far = 8;
  sun.shadow.bias = -0.0005;
  scene.add(sun);

  const rim = new THREE.DirectionalLight(0x6fa8ff, 0.6);
  rim.position.set(-2, 1.5, -2);
  scene.add(rim);
}

function addFloor(scene: THREE.Scene) {
  const floor = new THREE.Mesh(
    new THREE.CircleGeometry(8, 64),
    new THREE.MeshStandardMaterial({ color: 0x1b212b, roughness: 0.95 }),
  );
  floor.rotation.x = -Math.PI / 2;
  floor.receiveShadow = true;
  scene.add(floor);

  // Cuadrícula de 10 cm: escala de referencia para el robot (57 cm de alto)
  const grid = new THREE.GridHelper(6, 60, 0x3a4352, 0x262d39);
  grid.position.y = 0.0005;
  scene.add(grid);
}

/**
 * Espejo (environment.ts MIRROR): marco y vidrio. El vidrio es un Reflector de three: antes de dibujarse con cada cámara
 * (la del mundo, las del NAO y las capturas de ALVideoDevice) dibuja la escena reflejada desde esa cámara, así que el
 * NAO se ve a sí mismo. Solo cuesta cuando la escena se redibuja (render bajo demanda).
 */
function addMirror(zUp: THREE.Group) {
  const { pos, size, yaw } = MIRROR;
  const [t, w, h] = size;
  const holder = new THREE.Group();
  holder.name = MIRROR.name;
  holder.position.set(...pos);
  holder.rotation.z = yaw;
  zUp.add(holder);

  const frame = new THREE.Mesh(
    new RoundedBoxGeometry(t, w, h, 2, 0.008),
    new THREE.MeshStandardMaterial({ color: 0x2b2f36, roughness: 0.6, metalness: 0.2 }),
  );
  frame.castShadow = true;
  frame.receiveShadow = true;
  holder.add(frame);

  // APPROX: espejo de vidrio común (refleja ~90 %): un gris apenas más oscuro que el neutro (0x7f7f7f) del Reflector
  const glass = new Reflector(new THREE.PlaneGeometry(w - 2 * MIRROR_FRAME, h - 2 * MIRROR_FRAME), {
    color: 0x777777,
    textureWidth: 1024,
    textureHeight: 1024,
    clipBias: 0.003,
    multisample: 4,
  });
  glass.name = 'mirror_glass';
  // La cara del plano (+Z local) mira a +X y su "arriba" (+Y local) es +Z del mundo del robot
  glass.quaternion.setFromRotationMatrix(
    new THREE.Matrix4().makeBasis(new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, 0, 1), new THREE.Vector3(1, 0, 0)),
  );
  glass.position.x = t / 2 + 0.001;
  holder.add(glass);
}

function addObjects(zUp: THREE.Group): Map<string, THREE.Mesh> {
  const meshes = new Map<string, THREE.Mesh>();
  for (const { name, size, pos, yaw, color } of ENV_OBJECTS) {
    const [w, d, h] = size;
    const box = new THREE.Mesh(
      new RoundedBoxGeometry(w, d, h, 2, Math.min(w, d, h) * 0.06),
      new THREE.MeshStandardMaterial({ color, roughness: 0.8 }),
    );
    box.name = name;
    box.position.set(...pos);
    box.rotation.z = yaw;
    box.castShadow = true;
    box.receiveShadow = true;
    zUp.add(box);
    meshes.set(name, box);
  }
  return meshes;
}
