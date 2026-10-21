// Escena 3D: render, cámara orbital, luces y el entorno (suelo, cubos y cajas).
// Unidades en metros (como el URDF). Three.js usa Y arriba; el robot mira hacia +X.

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';

export interface World {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  controls: OrbitControls;
  /** Registra una función que corre en cada frame (dt en segundos) */
  onFrame(cb: (dt: number) => void): void;
}

const BG = 0x0e1116;
const BASE_FOV = 40;

export function createWorld(container: HTMLElement): World {
  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;
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

  addLights(scene);
  addEnvironment(scene);

  const resize = () => {
    const { clientWidth: w, clientHeight: h } = container;
    renderer.setSize(w, h);
    camera.aspect = w / h;
    // En pantallas verticales (móvil) se abre el FOV para conservar el encuadre horizontal
    const halfH = Math.tan(THREE.MathUtils.degToRad(BASE_FOV / 2));
    camera.fov = camera.aspect < 1 ? Math.min(75, THREE.MathUtils.radToDeg(2 * Math.atan(halfH / camera.aspect))) : BASE_FOV;
    camera.updateProjectionMatrix();
  };
  new ResizeObserver(resize).observe(container);
  resize();

  const callbacks: ((dt: number) => void)[] = [];
  const timer = new THREE.Timer();
  renderer.setAnimationLoop((time) => {
    timer.update(time);
    const dt = Math.min(timer.getDelta(), 0.1);
    for (const cb of callbacks) cb(dt);
    controls.update();
    renderer.render(scene, camera);
  });

  return { renderer, scene, camera, controls, onFrame: (cb) => void callbacks.push(cb) };
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

function addEnvironment(scene: THREE.Scene) {
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

  // Cubos de 6 cm: tamaño que la mano del NAO podría agarrar más adelante
  const cubes: [number, number, number, number][] = [
    [0.32, 0.18, 0xe5484d, 0.4],
    [0.36, -0.05, 0x3aa0ff, 1.1],
    [0.28, -0.24, 0xf5a524, 2.3],
  ];
  for (const [x, z, color, yaw] of cubes) {
    addBox(scene, [0.06, 0.06, 0.06], [x, 0.03, z], color, yaw);
  }

  // Cajas de cartón
  const cardboard = 0xb08a5a;
  addBox(scene, [0.3, 0.22, 0.3], [-0.5, 0.11, 0.55], cardboard, 0.3);
  addBox(scene, [0.22, 0.16, 0.22], [-0.48, 0.3, 0.53], cardboard, 0.6);
  addBox(scene, [0.4, 0.3, 0.3], [0.2, 0.15, -0.9], cardboard, -0.2);
  addBox(scene, [0.25, 0.25, 0.25], [-0.9, 0.125, -0.4], 0x7c8696, 0.8);
}

function addBox(
  scene: THREE.Scene,
  [w, h, d]: [number, number, number],
  [x, y, z]: [number, number, number],
  color: number,
  yaw: number,
) {
  const box = new THREE.Mesh(
    new RoundedBoxGeometry(w, h, d, 2, Math.min(w, h, d) * 0.06),
    new THREE.MeshStandardMaterial({ color, roughness: 0.8 }),
  );
  box.position.set(x, y, z);
  box.rotation.y = yaw;
  box.castShadow = true;
  box.receiveShadow = true;
  scene.add(box);
}
