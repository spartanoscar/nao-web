// Escena 3D: render, cámara orbital, luces y el entorno (suelo, cubos y cajas).
// Unidades en metros (como el URDF). Three.js usa Y arriba; el robot mira hacia +X.

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { ENV_OBJECTS, MIRROR, MIRROR_FRAME } from './environment';
import { Reflector } from 'three/addons/objects/Reflector.js';
import { DOOR_WIDTH, ROOMS, type RoomId, WALLS, WALL_THICKNESS, roomAt, wallPieces } from './rooms';

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
  /**
   * Cuarto donde está el NAO (rooms.ts): la cámara del mundo solo ve ese cuarto y el pasillo (desde el pasillo, todos),
   * y la sombra se centra en él. Las cámaras del NAO y el espejo ven todo lo que hay (capas de three.js).
   */
  setRoom(id: RoomId | null): void;
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

  const sun = addLights(scene);
  const zUp = new THREE.Group();
  zUp.rotation.x = -Math.PI / 2;
  scene.add(zUp);
  addFloor(scene, zUp);
  addRooms(zUp);
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

  const setRoom = (id: RoomId | null) => {
    camera.layers.set(0);
    const all = !id || id === 'pasillo';
    for (const r of Object.values(ROOMS)) if (all || r.id === id || r.id === 'pasillo') camera.layers.enable(r.layer);
    // La sombra cubre el cuarto (el pasillo entero desde el pasillo); la luz llega siempre desde el mismo ángulo
    const r = ROOMS[id ?? 'pasillo'];
    const [cx, cy] = [(r.x[0] + r.x[1]) / 2, (r.y[0] + r.y[1]) / 2];
    const reach = Math.hypot(r.x[1] - r.x[0], r.y[1] - r.y[0]) / 2 + 0.3;
    sun.target.position.set(cx, 0, -cy);
    sun.position.set(cx + SUN_OFFSET.x, SUN_OFFSET.y, -cy + SUN_OFFSET.z);
    Object.assign(sun.shadow.camera, { left: -reach, right: reach, top: reach, bottom: -reach });
    sun.shadow.camera.updateProjectionMatrix();
    invalidate(true);
  };
  setRoom(roomAt(0, 0));

  return {
    renderer, scene, camera, controls, zUp, objects, invalidate, renderNow, setRoom,
    onFrame: (cb) => void callbacks.push(cb),
    onAfterRender: (cb) => void afterRender.push(cb),
  };
}

/** Pone un objeto (y todo lo que cuelga de él) en las capas de esos cuartos: lo ve la cámara del mundo desde ahí */
function inRooms(obj: THREE.Object3D, rooms: readonly RoomId[]): void {
  obj.traverse((o) => {
    o.layers.set(ROOMS[rooms[0]].layer);
    for (const r of rooms.slice(1)) o.layers.enable(ROOMS[r].layer);
  });
}

/** Colores de acento de los letreros por cuarto (estilo juego: vidrio oscuro con borde de color) */
const SIGN_ACCENT: Record<RoomId, string> = {
  pruebas: '#f5a524', laboratorio: '#3aa0ff', bano: '#5fd3c4', pasillo: '#9aa4b2', espejo: '#b58cff', casa: '#4ade80',
};

function signTexture(text: string, accent: string): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 512;
  c.height = 160;
  const g = c.getContext('2d')!;
  g.fillStyle = '#10151c';
  g.fillRect(0, 0, c.width, c.height);
  g.strokeStyle = accent;
  g.lineWidth = 10;
  g.strokeRect(5, 5, c.width - 10, c.height - 10);
  g.fillStyle = accent;
  g.fillRect(22, 28, 14, c.height - 56);
  g.fillStyle = '#eef2f7';
  const size = text.length > 12 ? 50 : 66;
  g.font = `800 ${size}px system-ui, -apple-system, "Segoe UI", sans-serif`;
  g.textBaseline = 'middle';
  if ('letterSpacing' in g) (g as CanvasRenderingContext2D & { letterSpacing: string }).letterSpacing = '4px';
  g.fillText(text, 58, c.height / 2 + 2, c.width - 80);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

/**
 * Cuartos (rooms.ts): piso de color por cuarto, paredes macizas (las mismas piezas fijas que la física) y un letrero
 * junto a cada puerta, del lado del pasillo, a la altura de la cámara del NAO (lo lee al pasar).
 */
function addRooms(zUp: THREE.Group) {
  for (const r of Object.values(ROOMS)) {
    const [w, d] = [r.x[1] - r.x[0], r.y[1] - r.y[0]];
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(w, d), new THREE.MeshStandardMaterial({ color: r.floor, roughness: 0.92 }));
    floor.position.set((r.x[0] + r.x[1]) / 2, (r.y[0] + r.y[1]) / 2, 0.002);
    floor.receiveShadow = true;
    inRooms(floor, [r.id]);
    zUp.add(floor);
  }
  const wallMat = new THREE.MeshStandardMaterial({ color: 0x3b4451, roughness: 0.85 });
  for (const p of wallPieces()) {
    const wall = new THREE.Mesh(new THREE.BoxGeometry(...p.size), wallMat);
    wall.position.set(...p.center);
    wall.castShadow = true;
    wall.receiveShadow = true;
    inRooms(wall, p.rooms);
    zUp.add(wall);
  }
  for (const w of WALLS) {
    const alongX = w.from[1] === w.to[1];
    for (const door of w.doors ?? []) {
      const room = ROOMS[door.sign];
      const sign = new THREE.Mesh(
        new THREE.PlaneGeometry(0.42, 0.13),
        new THREE.MeshStandardMaterial({ map: signTexture(room.label, SIGN_ACCENT[room.id]), roughness: 0.5, emissive: 0xffffff, emissiveIntensity: 0.25 }),
      );
      sign.material.emissiveMap = sign.material.map;
      const normal = alongX ? new THREE.Vector3(0, door.side, 0) : new THREE.Vector3(door.side, 0, 0);
      const up = new THREE.Vector3(0, 0, 1);
      sign.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(up.clone().cross(normal), up, normal));
      const along = door.at + DOOR_WIDTH / 2 + 0.3;
      const off = door.side * (WALL_THICKNESS / 2 + 0.003);
      sign.position.set(alongX ? along : w.from[0] + off, alongX ? w.from[1] + off : along, 0.5);
      inRooms(sign, ['pasillo']);
      zUp.add(sign);
    }
  }
}

/** Desde dónde llega el sol respecto al cuarto que se mira (three: Y arriba) */
const SUN_OFFSET = { x: 2, y: 3.5, z: 1.5 };

function addLights(scene: THREE.Scene): THREE.DirectionalLight {
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
  scene.add(sun.target);

  const rim = new THREE.DirectionalLight(0x6fa8ff, 0.6);
  rim.position.set(-2, 1.5, -2);
  scene.add(rim);
  return sun;
}

function addFloor(scene: THREE.Scene, zUp: THREE.Group) {
  // Afuera de los cuartos: piso oscuro (lo ve todo, capa 0); cada cuarto pone su piso encima (addRooms)
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(30, 24), new THREE.MeshStandardMaterial({ color: 0x14181f, roughness: 0.95 }));
  floor.position.set(-3, -2, 0);
  floor.receiveShadow = true;
  zUp.add(floor);

  // Cuadrícula de 10 cm en la sala de pruebas: escala de referencia para el robot (57 cm de alto)
  const grid = new THREE.GridHelper(4, 40, 0x3a4352, 0x262d39);
  grid.position.y = 0.003;
  inRooms(grid, ['pruebas']);
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
  inRooms(holder, ['espejo']);
  // El Reflector clona la cámara una sola vez (con sus capas de ese momento): antes de cada reflejo copia las capas
  // actuales, para que el espejo vea lo mismo que la cámara que lo mira (la del mundo cambia de capas por cuarto)
  const reflect = glass.onBeforeRender.bind(glass);
  const mirror = glass as unknown as { getReflectionCamera(c: THREE.Camera): THREE.Camera };
  glass.onBeforeRender = (renderer, scene, camera, geometry, material, group) => {
    mirror.getReflectionCamera(camera).layers.mask = camera.layers.mask;
    reflect(renderer, scene, camera, geometry, material, group);
  };
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
    const room = roomAt(pos[0], pos[1]);
    if (room) inRooms(box, [room]);
    zUp.add(box);
    meshes.set(name, box);
  }
  return meshes;
}
