// LEDs visibles del NAO como tiras de luz continuas: en el robot los LEDs están detrás de plástico
// translúcido y la luz se ve como una línea continua, no como segmentos. Cada grupo (anillo del ojo,
// anillo de la oreja, rectángulo redondeado de la cabeza, aro del pecho, logo del pie) es una banda
// cuyo color en cada punto se mezcla suavemente entre los LEDs vecinos (los canales siguen siendo los
// de NAOqi: un LED solo encendido se ve como un punto de luz que se difumina hacia los lados).
//
// Son piezas propias (las mallas de Aldebaran no se modifican): la banda se dibuja en un plano y cada
// vértice se proyecta con un rayo sobre la carcasa real. El color sale de LedState (lo que escribe
// ALLeds), con color exacto (toneMapped: false) y una segunda banda más ancha y tenue como halo.

import * as THREE from 'three';
import { BRAIN, type LedState } from '../robot/leds';
import type { Vec3 } from '../robot/urdf';
import type { NaoModel } from './naoModel';

type Layer = 'official' | 'primitive';
type Rgb = [string, string, string];

/** Un LED a lo largo de la tira: posición s ∈ [0, 1) y sus canales (monocromo repite el mismo) */
interface StripLed {
  s: number;
  channels: Rgb;
}

/** Recorrido de la tira en el plano (x = `side`, y = `up`), parametrizado por s ∈ [0, 1] */
type Path = (s: number) => { p: THREE.Vector2; n: THREE.Vector2 };

interface StripSpec {
  link: string;
  center: Vec3;
  normal: Vec3;
  up: Vec3;
  side: Vec3;
  path: Path;
  /** Ancho de la banda principal y del halo (m) */
  width: number;
  glowWidth: number;
  leds: StripLed[];
  /** Tinte de LEDs monocromos (orejas, cabeza) */
  tint?: THREE.Color;
}

const SAMPLES = 96; // muestras a lo largo de la tira
const ROWS = 5; // muestras a lo ancho (perfil de luz)
const LIFT = 0.0007;
const CORE_ALPHA = 0.95;
const GLOW_ALPHA = 0.28;

/**
 * Ubicaciones (frame del link, metros). Oficial, medido sobre las mallas de Aldebaran: ojos por las
 * caras con UV en la zona "Eyes" del atlas; orejas por el borde realzado alrededor del parlante
 * (vértices con |y| > 65.5 mm: centro x 0.5, z 55 mm, radio 28.6–33.1 mm).
 * APPROX: la cabeza es un rectángulo redondeado alrededor de los 3 sensores táctiles del URDF
 * (HeadTouchFront/Middle/Rear, de x = 31 a −26 mm) como en las fotos; la doc no da su forma.
 */
const LAYOUT: Record<Layer, { eye: Vec3; eyeR: [number, number]; ear: Vec3; earR: [number, number]; chest: Vec3; footX: number }> = {
  official: { eye: [0.0494, 0.0256, 0.0479], eyeR: [0.0058, 0.0102], ear: [0.0005, 0.064, 0.055], earR: [0.0286, 0.0331], chest: [0.0499, 0.0016, 0.0552], footX: 0.075 },
  primitive: { eye: [0.058, 0.027, 0.048], eyeR: [0.004, 0.013], ear: [-0.005, 0.072, 0.055], earR: [0.017, 0.024], chest: [0.052, 0.0016, 0.0552], footX: 0.075 },
};
const BRAIN_RECT = { cx: 0.002, halfX: 0.043, halfY: 0.026, corner: 0.018, z: 0.14, width: 0.0032 };

/** Círculo: s = 0 arriba, crece hacia `side` (ángulo de LED θ = 360·s) */
const circle = (r: number): Path => (s) => {
  const a = s * Math.PI * 2;
  const d = new THREE.Vector2(Math.sin(a), Math.cos(a));
  return { p: d.clone().multiplyScalar(r), n: d };
};

/**
 * Rectángulo redondeado recorrido por longitud de arco. Plano: x = adelante, y = izquierda; empieza
 * en el centro del lado delantero y va en sentido horario visto desde arriba (hacia la derecha, −y).
 */
function roundedRect(halfX: number, halfY: number, rc: number): Path {
  const pts: { p: THREE.Vector2; n: THREE.Vector2 }[] = [];
  const corner = (cx: number, cy: number, a0: number) => {
    for (let i = 0; i <= 12; i++) {
      const a = a0 - (i / 12) * (Math.PI / 2);
      const n = new THREE.Vector2(Math.cos(a), Math.sin(a));
      pts.push({ p: new THREE.Vector2(cx, cy).addScaledVector(n, rc), n });
    }
  };
  const ix = halfX - rc;
  const iy = halfY - rc;
  pts.push({ p: new THREE.Vector2(halfX, 0), n: new THREE.Vector2(1, 0) });
  corner(ix, -iy, 0); // delante-derecha
  corner(-ix, -iy, -Math.PI / 2); // atrás-derecha
  corner(-ix, iy, Math.PI); // atrás-izquierda
  corner(ix, iy, Math.PI / 2); // delante-izquierda
  pts.push({ p: new THREE.Vector2(halfX, 0), n: new THREE.Vector2(1, 0) });
  const len = [0];
  for (let i = 1; i < pts.length; i++) len.push(len[i - 1] + pts[i].p.distanceTo(pts[i - 1].p));
  const total = len[len.length - 1];
  return (s) => {
    const d = Math.min(Math.max(s, 0), 1) * total;
    let i = 1;
    while (i < len.length - 1 && len[i] < d) i++;
    const t = (d - len[i - 1]) / Math.max(len[i] - len[i - 1], 1e-9);
    return { p: pts[i - 1].p.clone().lerp(pts[i].p, t), n: pts[i - 1].n.clone().lerp(pts[i].n, t).normalize() };
  };
}

interface Band {
  mesh: THREE.Mesh;
  /** Posición s de cada vértice y su perfil de luz a lo ancho */
  s: Float32Array;
  profile: Float32Array;
}

interface Strip {
  spec: StripSpec;
  core: Band;
  glow: Band;
}

export class LedsView {
  private readonly strips: Strip[] = [];
  private shownRevision = -1;

  constructor(
    private readonly nao: NaoModel,
    private readonly layer: Layer,
  ) {
    const L = LAYOUT[layer];
    nao.root.updateMatrixWorld(true);
    const X: Vec3 = [1, 0, 0];
    const Y: Vec3 = [0, 1, 0];
    const Z: Vec3 = [0, 0, 1];
    const neg = ([a, b, c]: Vec3): Vec3 => [-a, -b, -c];
    const rgb = (f: (c: string) => string): Rgb => [f('Red'), f('Green'), f('Blue')];
    const mono = (ch: string): Rgb => [ch, ch, ch];

    for (const s of ['Left', 'Right'] as const) {
      const sign = s === 'Left' ? 1 : -1;
      // Ojos: anillo continuo con 8 LEDs RGB (0° arriba y crecen hacia fuera; APPROX el sentido)
      this.add({
        link: 'Head', center: [L.eye[0], sign * L.eye[1], L.eye[2]], normal: X, up: Z, side: sign > 0 ? Y : neg(Y),
        path: circle((L.eyeR[0] + L.eyeR[1]) / 2), width: L.eyeR[1] - L.eyeR[0], glowWidth: (L.eyeR[1] - L.eyeR[0]) * 2.2,
        leds: [0, 45, 90, 135, 180, 225, 270, 315].map((d) => ({ s: d / 360, channels: rgb((c) => `Face/Led/${c}/${s}/${d}Deg/Actuator/Value`) })),
      });
      // Orejas: anillo continuo con 10 LEDs azules (0° arriba, 90° delante)
      this.add({
        link: 'Head', center: [L.ear[0], sign * L.ear[1], L.ear[2]], normal: sign > 0 ? Y : neg(Y), up: Z, side: X,
        path: circle((L.earR[0] + L.earR[1]) / 2), width: L.earR[1] - L.earR[0], glowWidth: (L.earR[1] - L.earR[0]) * 2.6,
        leds: Array.from({ length: 10 }, (_, i) => ({ s: (i * 36) / 360, channels: mono(`Ears/Led/${s}/${i * 36}Deg/Actuator/Value`) })),
        tint: new THREE.Color(0x2b6bff),
      });
    }
    // Cabeza: rectángulo redondeado. Brain0 delante-derecha → Brain5 atrás-derecha → Brain6 atrás-izquierda
    // → Brain11 delante-izquierda (sentido horario visto desde arriba, empezando por delante)
    this.add({
      link: 'Head', center: [BRAIN_RECT.cx, 0, BRAIN_RECT.z], normal: Z, up: Y, side: X,
      path: roundedRect(BRAIN_RECT.halfX, BRAIN_RECT.halfY, BRAIN_RECT.corner), width: BRAIN_RECT.width, glowWidth: BRAIN_RECT.width * 3.5,
      leds: BRAIN.map((ch, k) => ({ s: (k + 0.5) / 12, channels: mono(ch) })),
      tint: new THREE.Color(0x3a7bff),
    });
    // Pecho: aro alrededor del botón (donde va el logo)
    this.add({
      link: 'torso', center: L.chest, normal: X, up: Z, side: Y,
      path: circle(0.0163), width: 0.003, glowWidth: 0.008,
      leds: [{ s: 0, channels: rgb((c) => `ChestBoard/Led/${c}/Actuator/Value`) }],
    });
    // Pies: el logo translúcido de la punta (aro tan ancho que se ve como un disco)
    for (const [link, side] of [['l_ankle', 'L'], ['r_ankle', 'R']] as const) {
      this.add({
        link, center: [L.footX, side === 'L' ? 0.003 : -0.003, 0], normal: Z, up: X, side: Y,
        path: circle(0.0045), width: 0.009, glowWidth: 0.02,
        leds: [{ s: 0, channels: rgb((c) => `${side}Foot/Led/${c}/Actuator/Value`) }],
      });
    }
  }

  /** Copia las intensidades a las tiras (solo si cambiaron). Devuelve si hay que redibujar. */
  update(leds: LedState): boolean {
    if (leds.revision === this.shownRevision) return false;
    this.shownRevision = leds.revision;
    for (const strip of this.strips) {
      const colors = strip.spec.leds.map(({ channels }) => {
        const [r, g, b] = channels.map((c) => leds.get(c));
        return strip.spec.tint ? strip.spec.tint.clone().multiplyScalar(r) : new THREE.Color(r, g, b);
      });
      paint(strip.core, strip.spec, colors, CORE_ALPHA);
      paint(strip.glow, strip.spec, colors, GLOW_ALPHA);
    }
    return true;
  }

  private add(spec: StripSpec): void {
    const core = this.band(spec, spec.width, false);
    const glow = this.band(spec, spec.glowWidth, true);
    const group = new THREE.Group();
    group.add(core.mesh, glow.mesh);
    this.nao.attach(spec.link, group, this.layer);
    this.strips.push({ spec, core, glow });
  }

  /** Banda continua a lo largo del recorrido, proyectada sobre la carcasa */
  private band(spec: StripSpec, width: number, glow: boolean): Band {
    const samples = spec.leds.length > 1 ? SAMPLES : 48;
    const count = (samples + 1) * ROWS;
    const plane = new Float32Array(count * 2);
    const s = new Float32Array(count);
    const profile = new Float32Array(count);
    for (let i = 0; i <= samples; i++) {
      const t = i / samples;
      const { p, n } = spec.path(t);
      for (let j = 0; j < ROWS; j++) {
        const k = i * ROWS + j;
        const u = j / (ROWS - 1) - 0.5; // −0.5 … 0.5 a lo ancho
        plane[k * 2] = p.x + n.x * u * width;
        plane[k * 2 + 1] = p.y + n.y * u * width;
        s[k] = t;
        // Máximo al centro de la banda y 0 en los bordes: luz difusa a través del plástico
        profile[k] = Math.pow(Math.cos(Math.PI * u), glow ? 2 : 0.6);
      }
    }
    const index: number[] = [];
    for (let i = 0; i < samples; i++) {
      for (let j = 0; j < ROWS - 1; j++) {
        const a = i * ROWS + j;
        const b = a + ROWS;
        index.push(a, b, a + 1, a + 1, b, b + 1);
      }
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(this.project(spec, plane), 3));
    geometry.setAttribute('color', new THREE.BufferAttribute(new Float32Array(count * 4), 4));
    geometry.setIndex(index);
    geometry.computeBoundingSphere();
    const material = new THREE.MeshBasicMaterial({
      vertexColors: true,
      transparent: true,
      toneMapped: false,
      depthWrite: false,
      side: THREE.DoubleSide,
      polygonOffset: true,
      polygonOffsetFactor: glow ? -3 : -4,
      blending: glow ? THREE.AdditiveBlending : THREE.NormalBlending,
    });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.name = glow ? 'led-glow' : 'led';
    mesh.renderOrder = glow ? 3 : 2;
    mesh.userData.material = material; // el resaltado de joints restaura este material
    mesh.userData.decal = true;
    return { mesh, s, profile };
  }

  /** Del plano del recorrido al frame del link, proyectando cada vértice sobre la carcasa */
  private project(spec: StripSpec, plane: Float32Array): Float32Array {
    const frame = this.nao.frame(spec.link)!;
    const surfaces = this.nao.surfaces(spec.link, this.layer);
    const [c, n, u, sd] = [spec.center, spec.normal, spec.up, spec.side].map((v) => new THREE.Vector3(...v));
    const out = new Float32Array((plane.length / 2) * 3);
    const ray = new THREE.Raycaster();
    const p = new THREE.Vector3();
    for (let i = 0; i < plane.length / 2; i++) {
      p.copy(c).addScaledVector(sd, plane[i * 2]).addScaledVector(u, plane[i * 2 + 1]);
      const origin = frame.localToWorld(p.clone().addScaledVector(n, 0.06));
      ray.set(origin, frame.localToWorld(p.clone()).sub(origin).normalize());
      const hit = surfaces.length ? ray.intersectObjects(surfaces, true)[0] : undefined;
      const local = hit ? frame.worldToLocal(hit.point.clone()) : p.clone();
      local.addScaledVector(n, LIFT);
      out.set([local.x, local.y, local.z], i * 3);
    }
    return out;
  }
}

/** Color en cada vértice: mezcla suave (smoothstep) entre los dos LEDs vecinos a lo largo de la tira */
function paint(band: Band, spec: StripSpec, colors: THREE.Color[], maxAlpha: number): void {
  const attr = band.mesh.geometry.attributes.color as THREE.BufferAttribute;
  const leds = spec.leds;
  const c = new THREE.Color();
  for (let k = 0; k < band.s.length; k++) {
    if (leds.length === 1) c.copy(colors[0]);
    else {
      const s = band.s[k] % 1;
      let i = leds.length - 1;
      for (let j = 0; j < leds.length; j++) if (leds[j].s <= s) i = j;
      const next = (i + 1) % leds.length;
      const s0 = leds[i].s;
      const s1 = next === 0 ? leds[0].s + 1 : leds[next].s;
      const ss = s < s0 ? s + 1 : s;
      const t = (ss - s0) / (s1 - s0);
      c.copy(colors[i]).lerp(colors[next], t * t * (3 - 2 * t));
    }
    // Tono en RGB (normalizado) e intensidad en el alfa: luz más fuerte = más visible
    const level = Math.max(c.r, c.g, c.b);
    if (level > 0) c.multiplyScalar(1 / level);
    attr.setXYZW(k, c.r, c.g, c.b, maxAlpha * band.profile[k] * Math.min(1, level * 1.25));
  }
  attr.needsUpdate = true;
}
