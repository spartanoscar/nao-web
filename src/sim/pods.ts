// Cápsulas de salida del mundo compartido (docs/PLAN.md F16; Oscar, 2026-10-24: "algo así como Halo"): 8 nichos contra la
// pared este de la sala de pruebas, donde estaban los escalones de 1, 2 y 4 cm. Cada persona que entra al mundo toma la
// primera libre (la asigna nao-api) y su NAO aparece ahí, agachado sobre la plataforma, y sale por una rampita.
// Estética de hangar de ciencia ficción, diseño propio: metal oscuro, panel de fondo con rejilla hexagonal, aro de
// aparición en el piso, franjas de luz y una placa con el número y el nombre del dueño; con dueño, todo con el color de
// su NAO, libre en gris azulado apagado.
//
// Las medidas cuidan la marcha segura (walk.ts checkSafety): los sonares (pecho, ~0.38 m) solo ven lo que queda en su
// camino a menos de medio ancho del robot + 0.1 m; por eso no hay paredes a los lados de la plataforma, solo pilares
// detrás del torso y un dintel por encima de la cabeza: al salir nada se le cruza.

import * as THREE from 'three';
import type { PropPart } from './props';

/** Cápsulas: una por persona en el mundo (nao-api reparte la primera libre) */
export const POD_COUNT = 8;
/** Cara de adentro de la pared este de la sala de pruebas (rooms.ts: pared en x = 2.25, 10 cm) */
const WALL_X = 2.2;
const [Y0, Y1] = [-1.95, 1.95];
/**
 * Cápsulas de 45 cm (lo justo: agachado el NAO mide ~30 cm de ancho y los pilares quedan a 20 cm de su centro), juntas
 * en el medio de la pared: las de las puntas quedan a 37.5 cm de las paredes norte y sur. Medido (2026-10-24): a 24 cm la
 * pared caía en la zona de la marcha segura (medio ancho 0.16 + 0.1 m) y a 30 cm también, porque la marcha se desvía
 * ~17° en los primeros pasos (MoveFailed Safety)
 */
const PITCH = 0.45;
const END = (Y1 - Y0 - POD_COUNT * PITCH) / 2;
/** Plataforma: 1.5 cm de alto, de x = 1.85 a la pared; rampa de 25 cm (3.4°, como la rampa grande, 3.3°) */
const PAD = { x0: 1.85, h: 0.015 };
const RAMP_X0 = 1.6;
const WIDTH = 0.4;
/** Pilares entre cápsulas: detrás del torso del NAO (aparece en x = 2.0), hasta el dintel */
const PILLAR = { x0: 2.04, w: 0.04, h: 1.0 };
const HEADER = { x0: 2.02, z0: 1.0, h: 0.12 };
/** Donde aparece el torso (Crouch), mirando hacia afuera (−x): a 20 cm de la pared (app.ts revisa ese margen) */
const SPAWN_X = 2.0;

/**
 * Cápsulas con un NAO quieto que no es de nadie (Oscar, 2026-10-24: "al menos 2 NAO que están ahí quietos"): la 1 y la 7,
 * justo las dos de las que no se sale caminando derecho (la marcha ve la pared sur; la plataforma de la rampa grande queda
 * delante). Las personas usan las otras 6 (server/world.go podOrder). Color de carcasa de cada uno y de las luces de su
 * cápsula (las del negro, en negro, no se veían).
 */
export const PARKED: ReadonlyMap<number, { shell: string; light: string }> = new Map([
  [0, { shell: '#262628', light: '#c7ced8' }],
  [6, { shell: '#f0701a', light: '#f0701a' }],
]);

export const podCenter = (i: number) => Y0 + END + PITCH * (i + 0.5);

/** Punto de aparición de la cápsula i (0–7): sobre la plataforma (z = su alto) */
export function podSpot(i: number): { label: string; x: number; y: number; z: number; yaw: number; camera: [number, number, number] } {
  // Cámara: delante y un poco a su derecha, para ver la cápsula entera y la sala detrás del NAO
  return { label: `CÁPSULA ${i + 1}`, x: SPAWN_X, y: podCenter(i), z: PAD.h, yaw: Math.PI, camera: [1.05, 0.3, 0.55] };
}

/** Piezas con física (y las que solo se ven y no cambian de color): props.ts las suma a la sala de pruebas */
export function podParts(): PropPart[] {
  const out: PropPart[] = [];
  const room = 'pruebas' as const;
  const depth = WALL_X - PAD.x0;
  for (let i = 0; i < POD_COUNT; i++) {
    const y = podCenter(i);
    out.push({ name: `pod_${i}_pad`, room, kind: 'box', size: [depth, WIDTH, PAD.h], pos: [PAD.x0 + depth / 2, y, PAD.h / 2], look: 'metal', color: 0x59626e, physics: true });
    // Rampa: la cara de arriba pasa por (RAMP_X0, 0) y (PAD.x0, PAD.h), como la rampa grande de la sala
    const t = 0.02;
    const run = PAD.x0 - RAMP_X0;
    const pitch = -Math.atan2(PAD.h, run);
    out.push({
      name: `pod_${i}_ramp`, room, kind: 'box', size: [Math.hypot(run, PAD.h), WIDTH, t], pitch, look: 'metal', color: 0x4a525d, physics: true,
      pos: [(RAMP_X0 + PAD.x0) / 2 - Math.sin(pitch) * (t / 2), y, PAD.h / 2 - Math.cos(pitch) * (t / 2)],
    });
  }
  for (let k = 0; k <= POD_COUNT; k++) {
    const y = Y0 + END + PITCH * k;
    const depth = WALL_X - PILLAR.x0;
    out.push({ name: `pod_pillar_${k}`, room, kind: 'box', size: [depth, PILLAR.w, PILLAR.h], pos: [PILLAR.x0 + depth / 2, y, PILLAR.h / 2], look: 'metal', physics: true });
  }
  const headerDepth = WALL_X - HEADER.x0;
  out.push({ name: 'pod_header', room, kind: 'box', size: [headerDepth, Y1 - Y0, HEADER.h], pos: [HEADER.x0 + headerDepth / 2, 0, HEADER.z0 + HEADER.h / 2], look: 'metal', physics: false });
  return out;
}

export interface PodLook {
  /** Color del NAO del dueño (#rrggbb) */
  color: string;
  /** Nombre del NAO y de su dueño */
  title: string;
  owner: string;
  /** La del jugador: la placa lo dice */
  mine?: boolean;
}

export interface Pods {
  /** Cápsula ocupada (con el color y los nombres) o libre (null) */
  set(i: number, look: PodLook | null): void;
}

const FREE = new THREE.Color(0x2b3a4a);

/** Rejilla hexagonal del panel de fondo (blanca sobre negro: el color lo pone el material) */
function hexTexture(): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 256;
  c.height = 512;
  const g = c.getContext('2d')!;
  g.fillStyle = '#000';
  g.fillRect(0, 0, c.width, c.height);
  g.strokeStyle = 'rgba(255,255,255,0.55)';
  g.lineWidth = 3;
  const r = 22;
  const [dx, dy] = [r * 1.5, r * Math.sqrt(3)];
  for (let col = -1; col * dx < c.width + r; col++) {
    for (let row = -1; row * dy < c.height + r; row++) {
      const cx = col * dx;
      const cy = row * dy + (col % 2 ? dy / 2 : 0);
      g.beginPath();
      for (let k = 0; k <= 6; k++) {
        const a = (Math.PI / 3) * k;
        g[k ? 'lineTo' : 'moveTo'](cx + r * Math.cos(a), cy + r * Math.sin(a));
      }
      g.stroke();
    }
  }
  // Más luz abajo (como si la cápsula se encendiera desde la plataforma)
  const fade = g.createLinearGradient(0, 0, 0, c.height);
  fade.addColorStop(0, 'rgba(0,0,0,0.65)');
  fade.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = fade;
  g.fillRect(0, 0, c.width, c.height);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/** Placa del dintel: número grande y, con dueño, el nombre del NAO y el de su dueño */
function drawPlate(canvas: HTMLCanvasElement, i: number, look: PodLook | null): void {
  const g = canvas.getContext('2d')!;
  const { width: w, height: h } = canvas;
  g.clearRect(0, 0, w, h);
  g.fillStyle = '#0b0f14';
  g.fillRect(0, 0, w, h);
  const accent = look ? look.color : '#4a5a6c';
  g.fillStyle = accent;
  g.fillRect(0, h - 10, w, 10);
  // Corte en diagonal a la izquierda, con el número
  g.beginPath();
  g.moveTo(0, 0);
  g.lineTo(150, 0);
  g.lineTo(120, h - 10);
  g.lineTo(0, h - 10);
  g.closePath();
  g.fill();
  g.fillStyle = '#0b0f14';
  g.font = '800 72px system-ui, -apple-system, "Segoe UI", sans-serif';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText(String(i + 1).padStart(2, '0'), 66, (h - 10) / 2 + 4);
  g.textAlign = 'left';
  if (!look) {
    g.fillStyle = '#6b7a8c';
    g.font = '700 30px system-ui, -apple-system, "Segoe UI", sans-serif';
    g.fillText('LIBRE', 170, (h - 10) / 2 + 2);
    return;
  }
  const fit = (text: string, size: number, max: number) => {
    let s = size;
    do g.font = `800 ${s--}px system-ui, -apple-system, "Segoe UI", sans-serif`;
    while (g.measureText(text).width > max && s > 14);
  };
  g.fillStyle = '#ffffff';
  fit(look.title.toUpperCase(), 40, w - 190);
  g.fillText(look.title.toUpperCase(), 170, 40);
  g.fillStyle = look.color;
  fit(look.mine ? `${look.owner} · TÚ` : look.owner, 26, w - 190);
  g.fillText(look.mine ? `${look.owner} · TÚ` : look.owner, 170, 84);
}

/** Lo que cambia de color con el dueño (luces, panel, aro, placa). `place` pone cada pieza en la capa de la sala */
export function addPods(zUp: THREE.Group, place: (obj: THREE.Object3D) => void, invalidate: () => void): Pods {
  const hex = hexTexture();
  const bays: { light: THREE.MeshStandardMaterial; panel: THREE.MeshStandardMaterial; canvas: HTMLCanvasElement; plate: THREE.CanvasTexture; look: string }[] = [];
  const add = (mesh: THREE.Mesh, x: number, y: number, z: number) => {
    mesh.position.set(x, y, z);
    place(mesh);
    zUp.add(mesh);
    return mesh;
  };
  /** Plano vertical que mira hacia la sala (−x) */
  const facingRoom = (geometry: THREE.PlaneGeometry) => geometry.rotateX(Math.PI / 2).rotateZ(-Math.PI / 2);
  for (let i = 0; i < POD_COUNT; i++) {
    const y = podCenter(i);
    // Franjas de luz: borde de la plataforma, bajo el dintel y el aro de aparición (toneMapped false: color exacto)
    const light = new THREE.MeshStandardMaterial({ color: 0x000000, emissive: FREE, emissiveIntensity: 1.6, toneMapped: false });
    add(new THREE.Mesh(new THREE.BoxGeometry(0.012, WIDTH, 0.004), light), PAD.x0 + 0.006, y, PAD.h + 0.001);
    for (const side of [-1, 1]) add(new THREE.Mesh(new THREE.BoxGeometry(WALL_X - PAD.x0, 0.008, 0.004), light), (PAD.x0 + WALL_X) / 2, y + side * (WIDTH / 2 - 0.004), PAD.h + 0.001);
    add(new THREE.Mesh(new THREE.BoxGeometry(0.02, PITCH - PILLAR.w - 0.02, 0.012), light), HEADER.x0 - 0.008, y, HEADER.z0 - 0.004);
    const ring = add(new THREE.Mesh(new THREE.RingGeometry(0.115, 0.13, 48), light), SPAWN_X - 0.02, y, PAD.h + 0.0008);
    ring.receiveShadow = true;
    // Panel del fondo con la rejilla, encendido tenue del mismo color
    const panel = new THREE.MeshStandardMaterial({ color: 0x0a0d12, emissive: FREE, emissiveMap: hex, emissiveIntensity: 0.6, roughness: 0.6, metalness: 0.3 });
    add(new THREE.Mesh(facingRoom(new THREE.PlaneGeometry(PITCH - PILLAR.w - 0.01, PILLAR.h - 0.06)), panel), WALL_X - 0.002, y, (PILLAR.h - 0.06) / 2 + 0.02);
    // Placa del dintel
    const canvas = document.createElement('canvas');
    canvas.width = 512;
    canvas.height = 112;
    const plate = new THREE.CanvasTexture(canvas);
    plate.colorSpace = THREE.SRGBColorSpace;
    plate.anisotropy = 4;
    const plateMat = new THREE.MeshStandardMaterial({ map: plate, emissive: 0xffffff, emissiveMap: plate, emissiveIntensity: 0.9, roughness: 0.4 });
    add(new THREE.Mesh(facingRoom(new THREE.PlaneGeometry(PITCH - PILLAR.w - 0.02, HEADER.h - 0.02)), plateMat), HEADER.x0 - 0.002, y, HEADER.z0 + HEADER.h / 2);
    bays.push({ light, panel, canvas, plate, look: '' });
  }
  const pods: Pods = {
    set(i, look) {
      const bay = bays[i];
      if (!bay) return;
      const key = JSON.stringify(look);
      if (key === bay.look) return;
      bay.look = key;
      const color = look ? new THREE.Color(look.color) : FREE;
      bay.light.emissive.copy(color);
      bay.panel.emissive.copy(color);
      bay.panel.emissiveIntensity = look ? 0.9 : 0.5;
      drawPlate(bay.canvas, i, look);
      bay.plate.needsUpdate = true;
      invalidate();
    },
  };
  for (let i = 0; i < POD_COUNT; i++) pods.set(i, null);
  return pods;
}
