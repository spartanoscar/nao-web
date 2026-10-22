// LEDs visibles del NAO: ojos, orejas, cabeza, botón del pecho y pies. Son piezas propias (las
// mallas de Aldebaran no se modifican) que se "pegan" a la carcasa: la forma se dibuja en un plano y
// cada vértice se proyecta con un rayo sobre la superficie real, así sigue su curvatura.
// El color sale de los canales de RobotState/LedState (lo que escribe ALLeds).

import * as THREE from 'three';
import { BRAIN, type LedState } from '../robot/leds';
import type { Vec3 } from '../robot/urdf';
import type { NaoModel } from './naoModel';

type Layer = 'official' | 'primitive';

interface RingSpec {
  link: string;
  center: Vec3;
  normal: Vec3;
  /** Dirección "arriba" del plano (ángulo 0 de los LEDs) */
  up: Vec3;
  /** Dirección de ángulos crecientes (90°) */
  side: Vec3;
  r0: number;
  r1: number;
}

/**
 * Ubicaciones por vista (frame del link, metros). Oficial: medido sobre las mallas de Aldebaran —
 * ojos = caras de la malla con UV en la zona "Eyes" del atlas; orejas = borde realzado alrededor del
 * parlante (vértices con |y| > 65.5 mm: centro x 0.5 mm, z 55 mm, radio 28.6–33.1 mm); cabeza y pies
 * con rayos.
 * Ángulos (doc leds_naov6): ojos 0° arriba y crecen hacia fuera (APPROX: la doc no da el sentido);
 * orejas 0° arriba, 90° delante (earLedsSetAngle); cabeza Brain0…11 de delante-derecha a delante-izquierda.
 */
const LAYOUT: Record<Layer, { eye: Vec3; ear: Vec3; brainZ: number; chest: Vec3; footX: number; eyeR: [number, number]; earR: [number, number] }> = {
  official: { eye: [0.0494, 0.0256, 0.0479], ear: [0.0005, 0.064, 0.055], brainZ: 0.12, chest: [0.0499, 0.0016, 0.0552], footX: 0.075, eyeR: [0.0058, 0.0102], earR: [0.0286, 0.0331] },
  primitive: { eye: [0.058, 0.027, 0.048], ear: [-0.005, 0.072, 0.055], brainZ: 0.12, chest: [0.052, 0.0016, 0.0552], footX: 0.075, eyeR: [0.004, 0.013], earR: [0.017, 0.024] },
};

const GAP = THREE.MathUtils.degToRad(5); // separación entre segmentos
const LIFT = 0.0007; // sobre la superficie, para no parpadear con la carcasa
/** Halo de cada LED: tamaño relativo al segmento y opacidad máxima (se suma a la luz de la escena) */
const HALO_SCALE = 2.1;
const HALO_OPACITY = 0.32;
/** Opacidad máxima del segmento: < 1 deja ver la carcasa, como luz a través de plástico translúcido */
const LED_OPACITY = 0.92;

/**
 * Los LEDs se dibujan con su color exacto (toneMapped: false: sin el tone mapping ACES de la escena,
 * que desaturaba el rojo hacia naranja) y un halo aditivo del mismo color. Sin post-proceso: más
 * barato que un bloom y el color no depende de lo luminoso que sea.
 */
let haloTexture: THREE.Texture | null = null;
function halo(): THREE.Texture {
  if (haloTexture) return haloTexture;
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d')!;
  const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grad.addColorStop(0, 'rgba(255,255,255,1)');
  grad.addColorStop(0.35, 'rgba(255,255,255,0.45)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 64, 64);
  haloTexture = new THREE.CanvasTexture(c);
  return haloTexture;
}

interface Segment {
  material: THREE.MeshBasicMaterial;
  glow: THREE.SpriteMaterial;
  /** Canales [R, G, B]; un LED monocromo repite el mismo canal y usa `tint` */
  channels: [string, string, string];
  tint?: THREE.Color;
}

export class LedsView {
  private readonly segments: Segment[] = [];
  private shownRevision = -1;

  /** Construye los LEDs de una vista y los cuelga del modelo */
  constructor(private readonly nao: NaoModel, layer: Layer) {
    const L = LAYOUT[layer];
    nao.root.updateMatrixWorld(true);
    const X: Vec3 = [1, 0, 0];
    const Y: Vec3 = [0, 1, 0];
    const Z: Vec3 = [0, 0, 1];
    const neg = ([a, b, c]: Vec3): Vec3 => [-a, -b, -c];

    // Ojos: 8 segmentos RGB por ojo
    for (const s of ['Left', 'Right'] as const) {
      const sign = s === 'Left' ? 1 : -1;
      const ring: RingSpec = { link: 'Head', center: [L.eye[0], sign * L.eye[1], L.eye[2]], normal: X, up: Z, side: sign > 0 ? Y : neg(Y), r0: L.eyeR[0], r1: L.eyeR[1] };
      [0, 45, 90, 135, 180, 225, 270, 315].forEach((deg) => {
        const ch = (c: string) => `Face/Led/${c}/${s}/${deg}Deg/Actuator/Value`;
        this.addSegment(layer, ring, deg, 45, [ch('Red'), ch('Green'), ch('Blue')]);
      });
    }
    // Orejas: 10 segmentos azules por oreja
    for (const s of ['Left', 'Right'] as const) {
      const sign = s === 'Left' ? 1 : -1;
      const ring: RingSpec = { link: 'Head', center: [L.ear[0], sign * L.ear[1], L.ear[2]], normal: sign > 0 ? Y : neg(Y), up: Z, side: X, r0: L.earR[0], r1: L.earR[1] };
      for (let i = 0; i < 10; i++) {
        const ch = `Ears/Led/${s}/${i * 36}Deg/Actuator/Value`;
        this.addSegment(layer, ring, i * 36, 36, [ch, ch, ch], new THREE.Color(0x2b6bff));
      }
    }
    // Cabeza: 12 LEDs en anillo alrededor de los sensores táctiles (APPROX: color azul de las fotos)
    const brainRing: RingSpec = { link: 'Head', center: [-0.005, 0, L.brainZ], normal: Z, up: X, side: neg(Y), r0: 0.027, r1: 0.034 };
    BRAIN.forEach((ch, k) => this.addSegment(layer, brainRing, (k + 0.5) * 30, 30, [ch, ch, ch], new THREE.Color(0x3a7bff)));
    // Pecho: anillo RGB alrededor del botón (donde va el logo)
    const chestRing: RingSpec = { link: 'torso', center: L.chest, normal: X, up: Z, side: Y, r0: 0.0148, r1: 0.0178 };
    const cc = (c: string) => `ChestBoard/Led/${c}/Actuator/Value`;
    this.addSegment(layer, chestRing, 0, 360, [cc('Red'), cc('Green'), cc('Blue')]);
    // Pies: el logo translúcido de la punta de cada pie
    for (const [link, side] of [['l_ankle', 'L'], ['r_ankle', 'R']] as const) {
      const sy = side === 'L' ? 0.003 : -0.003;
      const disc: RingSpec = { link, center: [L.footX, sy, 0], normal: Z, up: X, side: Y, r0: 0, r1: 0.0085 };
      const fc = (c: string) => `${side}Foot/Led/${c}/Actuator/Value`;
      this.addSegment(layer, disc, 0, 360, [fc('Red'), fc('Green'), fc('Blue')]);
    }
  }

  /** Copia las intensidades a los materiales (solo si cambiaron). Devuelve si hay que redibujar. */
  update(leds: LedState): boolean {
    if (leds.revision === this.shownRevision) return false;
    this.shownRevision = leds.revision;
    for (const s of this.segments) {
      const [r, g, b] = s.channels.map((c) => leds.get(c));
      const m = s.material;
      // Monocromo (orejas, cabeza): los tres canales son el mismo y se tiñe con `tint`
      const lit = s.tint ? s.tint.clone().multiplyScalar(r) : new THREE.Color(r, g, b);
      const level = s.tint ? r : Math.max(r, g, b);
      // Color puro del LED; la intensidad va en la opacidad (más luz = más visible a través del plástico)
      m.color.copy(level > 0 ? lit.clone().multiplyScalar(1 / level) : lit);
      m.opacity = LED_OPACITY * Math.min(1, level * 1.3);
      m.visible = m.opacity > 0.01;
      s.glow.color.copy(level > 0 ? lit.clone().multiplyScalar(1 / level) : lit);
      s.glow.opacity = HALO_OPACITY * level;
      s.glow.visible = level > 0.02;
    }
    return true;
  }

  private addSegment(
    layer: Layer,
    ring: RingSpec,
    angleDeg: number,
    spanDeg: number,
    channels: [string, string, string],
    tint?: THREE.Color,
  ): void {
    const full = spanDeg >= 360;
    const span = THREE.MathUtils.degToRad(spanDeg) - (full ? 0 : GAP);
    // En el plano del anillo: x = dirección `side`, y = `up`. Ángulo LED θ (desde arriba hacia
    // `side`) → ángulo polar φ = 90° − θ; el segmento cubre θ ± span/2.
    const phiCenter = Math.PI / 2 - THREE.MathUtils.degToRad(angleDeg);
    const geometry =
      ring.r0 > 0
        ? new THREE.RingGeometry(ring.r0, ring.r1, full ? 48 : 10, 6, full ? 0 : phiCenter - span / 2, full ? Math.PI * 2 : span)
        : new THREE.CircleGeometry(ring.r1, 32);
    const material = new THREE.MeshBasicMaterial({
      transparent: true,
      toneMapped: false,
      vertexColors: true, // alfa por vértice: bordes difusos (softEdges)
      side: THREE.DoubleSide,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -4,
    });
    softEdges(geometry, ring, full ? null : [phiCenter - span / 2, span]);
    const mesh = new THREE.Mesh(this.conform(layer, ring, geometry), material);
    mesh.name = `led:${channels[0]}`;
    mesh.renderOrder = 2;
    mesh.userData.material = material; // el resaltado de joints restaura este material
    mesh.userData.decal = true;

    // Halo: sprite aditivo sobre el centro del segmento, algo separado de la carcasa
    mesh.geometry.computeBoundingBox();
    const box = mesh.geometry.boundingBox!;
    const size = box.getSize(new THREE.Vector3()).length();
    const glow = new THREE.SpriteMaterial({
      map: halo(),
      blending: THREE.AdditiveBlending,
      transparent: true,
      depthWrite: false,
      toneMapped: false,
    });
    const sprite = new THREE.Sprite(glow);
    sprite.position.copy(box.getCenter(new THREE.Vector3())).addScaledVector(new THREE.Vector3(...ring.normal), 0.003);
    // Anillo completo (pecho) o disco (pies): halo apenas mayor que el LED; segmentos: proporcional
    sprite.scale.setScalar(full ? ring.r1 * 2 * 1.5 : size * HALO_SCALE);
    sprite.renderOrder = 3;
    sprite.userData.decal = true;
    const group = new THREE.Group();
    group.add(mesh, sprite);
    this.nao.attach(ring.link, group, layer);
    this.segments.push({ material, glow, channels, tint });
  }

  /** Lleva la forma plana al frame del link y proyecta cada vértice sobre la carcasa */
  private conform(layer: Layer, ring: RingSpec, geometry: THREE.BufferGeometry): THREE.BufferGeometry {
    const frame = this.nao.frame(ring.link)!;
    const surfaces = this.nao.surfaces(ring.link, layer);
    const [c, n, u, s] = [ring.center, ring.normal, ring.up, ring.side].map((v) => new THREE.Vector3(...v));
    const pos = geometry.attributes.position;
    const ray = new THREE.Raycaster();
    const p = new THREE.Vector3();
    for (let i = 0; i < pos.count; i++) {
      p.copy(c).addScaledVector(s, pos.getX(i)).addScaledVector(u, pos.getY(i));
      const origin = frame.localToWorld(p.clone().addScaledVector(n, 0.06));
      const dir = frame.localToWorld(p.clone()).sub(origin).normalize();
      ray.set(origin, dir);
      const hit = surfaces.length ? ray.intersectObjects(surfaces, true)[0] : undefined;
      const local = hit ? frame.worldToLocal(hit.point.clone()) : p.clone();
      local.addScaledVector(n, LIFT);
      pos.setXYZ(i, local.x, local.y, local.z);
    }
    pos.needsUpdate = true;
    geometry.computeBoundingSphere();
    return geometry;
  }
}

/**
 * Alfa por vértice para que la luz se vea "desde adentro": máxima en el centro del anillo y en el
 * centro del segmento, cayendo a 0 hacia los bordes (el plástico translúcido difumina el LED).
 * Se calcula sobre la forma plana, antes de proyectarla en la carcasa.
 */
function softEdges(geometry: THREE.BufferGeometry, ring: RingSpec, arc: [number, number] | null): void {
  const pos = geometry.attributes.position;
  const colors = new Float32Array(pos.count * 4);
  const TAU = Math.PI * 2;
  for (let i = 0; i < pos.count; i++) {
    const r = Math.hypot(pos.getX(i), pos.getY(i));
    let alpha: number;
    if (ring.r0 > 0) {
      const t = (r - ring.r0) / (ring.r1 - ring.r0); // 0 borde interior … 1 borde exterior
      alpha = Math.pow(Math.sin(Math.PI * Math.min(Math.max(t, 0), 1)), 0.7);
      if (arc) {
        // Posición a lo largo del segmento (0 … 1), medida desde su inicio para no cortar en ±180°
        const rel = (((Math.atan2(pos.getY(i), pos.getX(i)) - arc[0]) % TAU) + TAU) % TAU;
        const sAng = Math.min(rel / arc[1], 1);
        alpha *= Math.pow(Math.sin(Math.PI * sAng), 0.45);
      }
    } else {
      alpha = 1 - Math.pow(r / ring.r1, 2); // disco: más luz al centro
    }
    colors.set([1, 1, 1, alpha], i * 4);
  }
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 4));
}
