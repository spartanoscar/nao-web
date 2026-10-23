// Escena 3D: render, cámara orbital, luces y el entorno (suelo, cubos y cajas).
// Unidades en metros (como el URDF). Three.js usa Y arriba; el robot mira hacia +X.

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { ENV_OBJECTS, MIRROR, MIRROR_FRAME } from './environment';
import { Reflector } from 'three/addons/objects/Reflector.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { floorTexture, rugTexture, skyTexture, wallpaper } from './decor';
import { DOOR_HEIGHT, DOOR_WIDTH, ROOMS, type Room, type RoomId, type Side, WALLS, WALL_HEIGHT, WALL_THICKNESS, roomAt, visibleFrom, wallPieces } from './rooms';

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
  // Todo está bajo techo y entre paredes: sin niebla. Reflejos de ambiente de un cuarto genérico (la carcasa, el
  // azulejo y la madera reflejan algo en vez de negro)
  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  scene.environmentIntensity = 0.25;
  pmrem.dispose();

  const camera = new THREE.PerspectiveCamera(BASE_FOV, 1, 0.01, 50);
  camera.position.set(1.0, 0.55, 0.75);

  const controls = new OrbitControls(camera, renderer.domElement);
  controls.target.set(0, 0.28, 0);
  controls.enableDamping = true;
  controls.minDistance = 0.3;
  controls.maxDistance = 3;
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
    keepInside();
    if (!dirty) return;
    dirty = false;
    draw();
  });

  const renderNow = () => {
    controls.update();
    keepInside();
    draw();
  };

  // Cámara de juego: siempre dentro del cuarto donde está el NAO y bajo el techo (no atraviesa paredes)
  let bounds: { x: [number, number]; z: [number, number] } | null = null;
  const keepInside = () => {
    if (!bounds) return;
    const p = camera.position;
    const [x, y, z] = [
      Math.min(Math.max(p.x, bounds.x[0]), bounds.x[1]),
      Math.min(Math.max(p.y, 0.12), WALL_HEIGHT - 0.15),
      Math.min(Math.max(p.z, bounds.z[0]), bounds.z[1]),
    ];
    if (x !== p.x || y !== p.y || z !== p.z) p.set(x, y, z);
  };
  const setRoom = (id: RoomId | null) => {
    const inner = id ? ROOMS[id] : null;
    const m = WALL_THICKNESS / 2 + 0.12;
    bounds = inner ? { x: [inner.x[0] + m, inner.x[1] - m], z: [-inner.y[1] + m, -inner.y[0] - m] } : null;
    camera.layers.set(0);
    const all = !id || id === 'pasillo';
    const seen = id ? [id, ...visibleFrom(id)] : [];
    for (const r of Object.values(ROOMS)) if (all || seen.includes(r.id)) camera.layers.enable(r.layer);
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

/** Coordenadas de textura del mundo (m): el papel de colgar no se estira en las paredes largas (decor.ts: 1 m de ancho
 * × la altura de la pared) y el piso se repite cada 2 m */
function worldUV(geometry: THREE.BufferGeometry, center: readonly number[]): void {
  const pos = geometry.attributes.position;
  const nor = geometry.attributes.normal;
  const uv = geometry.attributes.uv;
  for (let i = 0; i < pos.count; i++) {
    const [x, y, z] = [pos.getX(i) + center[0], pos.getY(i) + center[1], pos.getZ(i) + center[2]];
    if (Math.abs(nor.getX(i)) > 0.5) uv.setXY(i, y, z / WALL_HEIGHT);
    else if (Math.abs(nor.getY(i)) > 0.5) uv.setXY(i, x, z / WALL_HEIGHT);
    else uv.setXY(i, x, y);
  }
  uv.needsUpdate = true;
}

/** Normal hacia el interior de una pared exterior del cuarto, y dónde queda esa pared */
function sideOf(r: Room, side: Side): { normal: [number, number]; at: [number, number] } {
  const [cx, cy] = [(r.x[0] + r.x[1]) / 2, (r.y[0] + r.y[1]) / 2];
  switch (side) {
    case 'south': return { normal: [0, 1], at: [cx, r.y[0]] };
    case 'north': return { normal: [0, -1], at: [cx, r.y[1]] };
    case 'west': return { normal: [1, 0], at: [r.x[0], cy] };
    case 'east': return { normal: [-1, 0], at: [r.x[1], cy] };
  }
}

/** Orientación de un plano (cara +Z de PlaneGeometry) que mira hacia `normal`, con su "arriba" en +Z del mundo */
function facing(obj: THREE.Object3D, normal: THREE.Vector3): void {
  const up = new THREE.Vector3(0, 0, 1);
  obj.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(up.clone().cross(normal), up, normal));
}

/**
 * Cuartos (rooms.ts) a escala de una casa real, con estética de juguete en una casa de verdad: cada cara de pared con el
 * papel de su cuarto (una pared compartida tiene una cara por lado), zócalo y moldura en la textura, marco y dintel en
 * cada puerta, piso con textura, alfombra, techo con lámpara (luz cálida del cuarto) y una ventana con cielo. Las
 * paredes son las mismas piezas fijas que la física. Letrero junto a cada puerta, del lado del pasillo, a la altura de
 * la cámara del NAO (lo lee al pasar).
 */
function addRooms(zUp: THREE.Group) {
  const papers = new Map<RoomId, THREE.MeshStandardMaterial>();
  Object.values(ROOMS).forEach((r, i) => {
    papers.set(r.id, new THREE.MeshStandardMaterial({ map: wallpaper(r.style.wall, r.style.paint, i + 1), roughness: 0.88 }));
    const [w, d] = [r.x[1] - r.x[0], r.y[1] - r.y[0]];
    const [cx, cy] = [(r.x[0] + r.x[1]) / 2, (r.y[0] + r.y[1]) / 2];
    const floorMap = floorTexture(r.style.floorStyle, i + 7);
    floorMap.repeat.set(w / 2, d / 2);
    const floor = new THREE.Mesh(
      new THREE.PlaneGeometry(w, d),
      new THREE.MeshStandardMaterial({ map: floorMap, roughness: r.style.floorStyle === 'tile' ? 0.35 : 0.7 }),
    );
    floor.position.set(cx, cy, 0.002);
    floor.receiveShadow = true;
    inRooms(floor, [r.id]);
    zUp.add(floor);

    if (r.style.rug === 'round') {
      const rug = new THREE.Mesh(new THREE.CircleGeometry(0.75, 48), new THREE.MeshStandardMaterial({ map: rugTexture('round'), roughness: 1 }));
      rug.position.set(cx, cy - 0.35, 0.004);
      rug.receiveShadow = true;
      inRooms(rug, [r.id]);
      zUp.add(rug);
    } else if (r.style.rug === 'runner') {
      const len = w - 1.2;
      const tex = rugTexture('runner');
      tex.repeat.set(1, len / 0.7);
      const rug = new THREE.Mesh(new THREE.PlaneGeometry(0.7, len), new THREE.MeshStandardMaterial({ map: tex, roughness: 1 }));
      rug.position.set(cx, cy, 0.004);
      rug.rotation.z = Math.PI / 2;
      rug.receiveShadow = true;
      inRooms(rug, [r.id]);
      zUp.add(rug);
    }

    // Techo (no da sombra: la luz principal entra desde arriba) y lámparas con luz cálida
    const ceiling = new THREE.Mesh(new THREE.PlaneGeometry(w, d), new THREE.MeshStandardMaterial({ color: 0xf5efe5, roughness: 1 }));
    ceiling.position.set(cx, cy, WALL_HEIGHT);
    ceiling.rotation.x = Math.PI;
    inRooms(ceiling, [r.id]);
    zUp.add(ceiling);
    const lamps = r.id === 'pasillo' ? [-0.25, 0.25].map((k) => [cx + k * w, cy]) : [[cx, cy]];
    for (const [lx, ly] of lamps) {
      const shade = new THREE.Mesh(
        new THREE.CylinderGeometry(0.2, 0.24, 0.06, 32),
        new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: r.style.lamp, emissiveIntensity: 2.2 }),
      );
      shade.rotation.x = Math.PI / 2;
      shade.position.set(lx, ly, WALL_HEIGHT - 0.03);
      inRooms(shade, [r.id]);
      zUp.add(shade);
      const light = new THREE.PointLight(r.style.lamp, LAMP_INTENSITY, 0, 2);
      light.position.set(lx, ly, WALL_HEIGHT - 0.35);
      inRooms(light, [r.id]);
      zUp.add(light);
    }

    // Ventana: cielo de día en un marco blanco con cruz y repisa (solo visual)
    if (r.style.window) {
      const { normal, at } = sideOf(r, r.style.window);
      const n = new THREE.Vector3(normal[0], normal[1], 0);
      const win = new THREE.Group();
      const span = r.id === 'pasillo' ? 0.8 : 1.0;
      const sky = new THREE.Mesh(new THREE.PlaneGeometry(span, 1.1), new THREE.MeshBasicMaterial({ map: skyTexture(), toneMapped: false }));
      win.add(sky);
      const trim = new THREE.MeshStandardMaterial({ color: 0xfbf7ef, roughness: 0.6 });
      const bar = (w: number, h: number, x: number, y: number, depth = 0.04) => {
        const b = new THREE.Mesh(new THREE.BoxGeometry(w, h, depth), trim);
        b.position.set(x, y, depth / 2);
        b.castShadow = true;
        win.add(b);
      };
      bar(span + 0.12, 0.06, 0, 0.58);
      bar(span + 0.12, 0.06, 0, -0.58);
      bar(0.06, 1.22, -span / 2 - 0.03, 0);
      bar(0.06, 1.22, span / 2 + 0.03, 0);
      bar(0.035, 1.1, 0, 0, 0.025);
      bar(span, 0.035, 0, 0.1, 0.025);
      bar(span + 0.24, 0.04, 0, -0.62, 0.12); // repisa
      facing(win, n);
      win.position.set(at[0] + normal[0] * (WALL_THICKNESS / 2 + 0.002), at[1] + normal[1] * (WALL_THICKNESS / 2 + 0.002), 1.5);
      inRooms(win, [r.id]);
      zUp.add(win);
    }
  });

  // Paredes: cada cara con el papel del cuarto al que mira (el canto y lo de afuera, neutro)
  const plain = new THREE.MeshStandardMaterial({ color: 0xece4d6, roughness: 0.9 });
  const t = WALL_THICKNESS;
  for (const p of wallPieces()) {
    const [cx, cy] = p.center;
    // El cuarto al que mira cada cara se busca justo afuera de esa cara (la mitad del tamaño de la pieza en ese eje): en
    // los cantos, medir desde el centro caía en el cuarto equivocado y el canto, en el mismo plano que la pared vecina,
    // peleaba con ella mostrando otro papel (z-fighting en la esquina pasillo/laboratorio/sala de pruebas)
    const face = (nx: number, ny: number) => {
      const reach = (nx ? p.size[0] : p.size[1]) / 2 + 0.05;
      const room = roomAt(cx + nx * reach, cy + ny * reach);
      return (room && papers.get(room)) || plain;
    };
    const geometry = new THREE.BoxGeometry(...p.size);
    worldUV(geometry, p.center);
    // Orden de caras de BoxGeometry: +x, −x, +y, −y, +z, −z
    const wall = new THREE.Mesh(geometry, [face(1, 0), face(-1, 0), face(0, 1), face(0, -1), plain, plain]);
    wall.position.set(...p.center);
    wall.castShadow = true;
    wall.receiveShadow = true;
    inRooms(wall, p.rooms);
    zUp.add(wall);
  }

  // Marcos de puerta y letreros
  const casing = new THREE.MeshStandardMaterial({ color: 0xfbf7ef, roughness: 0.55 });
  for (const w of WALLS) {
    const alongX = w.from[1] === w.to[1];
    for (const door of w.doors ?? []) {
      const place = (along: number, z: number, size: [number, number, number]) => {
        const b = new THREE.Mesh(new THREE.BoxGeometry(...(alongX ? size : [size[1], size[0], size[2]] as [number, number, number])), casing);
        b.position.set(alongX ? along : w.from[0], alongX ? w.from[1] : along, z);
        b.castShadow = true;
        inRooms(b, w.rooms);
        zUp.add(b);
      };
      // El marco sobresale 5 mm hacia el vano: si comparte el plano del canto de la pared, parpadea (z-fighting)
      const depth = t + 0.03;
      place(door.at - DOOR_WIDTH / 2 - 0.0275, DOOR_HEIGHT / 2, [0.065, depth, DOOR_HEIGHT]);
      place(door.at + DOOR_WIDTH / 2 + 0.0275, DOOR_HEIGHT / 2, [0.065, depth, DOOR_HEIGHT]);
      place(door.at, DOOR_HEIGHT + 0.04, [DOOR_WIDTH + 0.12, depth, 0.08]);

      const room = ROOMS[door.sign];
      const sign = new THREE.Mesh(
        new THREE.PlaneGeometry(0.42, 0.13),
        new THREE.MeshStandardMaterial({ map: signTexture(room.label, SIGN_ACCENT[room.id]), roughness: 0.5, emissive: 0xffffff, emissiveIntensity: 0.25 }),
      );
      sign.material.emissiveMap = sign.material.map;
      facing(sign, alongX ? new THREE.Vector3(0, door.side, 0) : new THREE.Vector3(door.side, 0, 0));
      const along = door.at + DOOR_WIDTH / 2 + 0.36;
      const off = door.side * (t / 2 + 0.003);
      sign.position.set(alongX ? along : w.from[0] + off, alongX ? w.from[1] + off : along, 0.5);
      inRooms(sign, ['pasillo']);
      zUp.add(sign);
    }
  }
}

/** Intensidad de cada lámpara del techo (candelas, decaimiento físico) */
const LAMP_INTENSITY = 5;

/** Desde dónde llega el sol respecto al cuarto que se mira (three: Y arriba) */
const SUN_OFFSET = { x: 0.8, y: 6, z: 0.6 };

function addLights(scene: THREE.Scene): THREE.DirectionalLight {
  // Luz de casa: cielo cálido arriba, rebote de madera abajo; el "sol" entra casi vertical (sombras cortas bajo el NAO
  // y los objetos; el techo no da sombra) y cada cuarto suma su lámpara cálida (addRooms)
  scene.add(new THREE.HemisphereLight(0xfff3e2, 0x6b5440, 0.55));

  const sun = new THREE.DirectionalLight(0xfff2dd, 1.5);
  sun.position.set(2, 3.5, 1.5);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.camera.left = -2;
  sun.shadow.camera.right = 2;
  sun.shadow.camera.top = 2;
  sun.shadow.camera.bottom = -2;
  sun.shadow.camera.near = 0.5;
  sun.shadow.camera.far = 10;
  sun.shadow.bias = -0.0005;
  scene.add(sun);
  scene.add(sun.target);

  return sun;
}

function addFloor(scene: THREE.Scene, zUp: THREE.Group) {
  // Afuera de los cuartos: piso oscuro (lo ve todo, capa 0); cada cuarto pone su piso encima (addRooms)
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(30, 24), new THREE.MeshStandardMaterial({ color: 0x14181f, roughness: 0.95 }));
  floor.position.set(-3, -2, 0);
  floor.receiveShadow = true;
  zUp.add(floor);

  // Cuadrícula de 10 cm en la sala de pruebas: escala de referencia para el robot (57 cm de alto)
  const grid = new THREE.GridHelper(4, 40, 0x6f767e, 0x858c94);
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
