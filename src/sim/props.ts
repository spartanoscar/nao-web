// Objetos fijos de los cuartos (sim/rooms.ts) como datos, para el render (world.ts addProps) y la física (las piezas con
// física son piezas fijas de MuJoCo, environment.ts ENV_FIXED). Coordenadas Z arriba, metros. Medidas de casa real: el
// NAO (57 cm) es un juguete entre ellos. Diseño propio.
//
// Sala de pruebas (centrada en el origen, donde corren los bancos: todo va contra las paredes, a más de 1.2 m del centro):
// rampa suave con plataforma, escalones de 1, 2 y 4 cm con su rótulo y una escalera de casa (huella 28 cm, contrahuella
// 17 cm: con la marcha estándar el NAO real no la sube; es el "reto de la escalera", docs/PLAN.md F13).
// Baño: azulejo menos áspero que la madera, dos tapetes (más agarre y un borde de 1.2 cm para tropezar), lavamanos de
// pedestal, inodoro y un charco junto a la entrada (muy resbaloso: un peligro que la IA debería ver y evitar).

import type { RoomId } from './rooms';

type Vec3 = [number, number, number];

export type Look = 'wood' | 'riser' | 'concrete' | 'ramp' | 'step' | 'ceramic' | 'chrome' | 'fabric' | 'water' | 'label' | 'paint' | 'leaf' | 'board';

export interface PropPart {
  name: string;
  room: RoomId;
  kind: 'box' | 'cylinder' | 'ellipse' | 'sphere';
  /** Tamaño completo. Cilindro: [diámetro, diámetro, alto]; elipse (plana): [ancho x, ancho y, grosor]; esfera: elipsoide */
  size: Vec3;
  /** Centro */
  pos: Vec3;
  yaw?: number;
  /** Inclinación alrededor del eje Y propio (rad): la rampa */
  pitch?: number;
  look: Look;
  color?: number;
  /** Texto (rótulos de los escalones) */
  text?: string;
  /** Física: false = solo se ve; 'only' = solo física (no se dibuja) */
  physics: boolean | 'only';
  /** Fricción propia (μ). APPROX: valores típicos de goma sobre cada material */
  friction?: number;
  /**
   * Mueble que tendrá un modelo 3D (Meshy, docs/MESHY.md): las piezas con el mismo id forman el placeholder. Si existe
   * public/models/props/<id>.glb (listado en su manifest.json), se dibuja ese modelo ajustado a la caja del placeholder
   * y las piezas simples se ocultan; la física sigue siendo la de las piezas (cajas estables y livianas).
   */
  model?: string;
  /** Hacia dónde mira el frente del mueble (rad, 0 = +X), para orientar su modelo 3D */
  facing?: number;
}

const parts: PropPart[] = [];
const add = (p: PropPart) => parts.push(p);

// ─── Sala de pruebas ───────────────────────────────────────────────────────────
{
  // Rampa: sube 8 cm en 1.4 m (3.3°) hacia +x, y una plataforma a esa altura. Empieza en x = −0.6: entre la escalera
  // (termina en −1.35) y la rampa queda espacio para pararse frente a ella. En y = 1.1, a 0.85 m de la pared norte: en
  // y = 1.6 (0.35 m) la marcha, que se desvía unos 15°, metía la pared en el camino de los sonares y la marcha segura lo
  // frenaba al pie de la rampa (medido 2026-10-24; a un NAO real le pasaría igual)
  const [x0, x1, y, w, h, t] = [-0.6, 0.8, 1.1, 0.6, 0.08, 0.03];
  const len = Math.hypot(x1 - x0, h);
  const pitch = -Math.atan2(h, x1 - x0);
  add({
    name: 'ramp', room: 'pruebas', kind: 'box', size: [len, w, t], pitch, look: 'ramp', physics: true,
    // Centro de la tabla: la cara de arriba pasa por (x0, 0) y (x1, h)
    pos: [(x0 + x1) / 2 - Math.sin(pitch) * (t / 2), y, h / 2 - Math.cos(pitch) * (t / 2)],
  });
  add({ name: 'ramp_top', room: 'pruebas', kind: 'box', size: [0.6, w, h], pos: [x1 + 0.3, y, h / 2], look: 'ramp', physics: true });

  // Escalones sueltos de 1, 2 y 4 cm contra la pared este, cada uno con su rótulo en el piso
  [0.01, 0.02, 0.04].forEach((sh, i) => {
    const sy = -1.3 + i * 0.8;
    add({ name: `step_${i}`, room: 'pruebas', kind: 'box', size: [0.55, 0.5, sh], pos: [1.9, sy, sh / 2], look: 'step', physics: true });
    add({
      name: `step_label_${i}`, room: 'pruebas', kind: 'box', size: [0.3, 0.12, 0.001], pos: [1.9, sy - 0.33, 0.004],
      look: 'label', text: `${Math.round(sh * 100)} cm`, physics: false,
    });
  });

  // Escalera de casa en la esquina noroeste: 4 escalones (17 cm de alto, 28 de huella) y un descanso contra la pared
  const [sx0, sx1, rise, tread, landing] = [-2.2, -1.35, 0.17, 0.28, 0.3];
  const top = 1.95;
  const y0 = top - landing - 4 * tread;
  for (let k = 0; k < 4; k++) {
    const sh = (k + 1) * rise;
    add({
      name: `stair_${k}`, room: 'pruebas', kind: 'box', size: [sx1 - sx0, tread, sh],
      pos: [(sx0 + sx1) / 2, y0 + (k + 0.5) * tread, sh / 2], look: 'riser', physics: true,
    });
    // Huella de madera encima de cada escalón (solo se ve)
    add({
      name: `stair_tread_${k}`, room: 'pruebas', kind: 'box', size: [sx1 - sx0 + 0.02, tread + 0.02, 0.02],
      pos: [(sx0 + sx1) / 2, y0 + (k + 0.5) * tread, sh + 0.01], look: 'wood', physics: false,
    });
  }
  add({
    name: 'stair_landing', room: 'pruebas', kind: 'box', size: [sx1 - sx0, landing, 4 * rise],
    pos: [(sx0 + sx1) / 2, top - landing / 2, 2 * rise], look: 'riser', physics: true,
  });
  add({
    name: 'stair_landing_top', room: 'pruebas', kind: 'box', size: [sx1 - sx0 + 0.02, landing + 0.01, 0.02],
    pos: [(sx0 + sx1) / 2, top - landing / 2, 4 * rise + 0.01], look: 'wood', physics: false,
  });
}

// ─── Baño ──────────────────────────────────────────────────────────────────────
{
  // Piso: azulejo, menos agarre que la madera (APPROX μ 0.5, goma sobre cerámica seca); solo física
  add({ name: 'bath_tiles', room: 'bano', kind: 'box', size: [2.9, 2.9, 0.004], pos: [-6.75, -0.5, 0.002], look: 'ceramic', physics: 'only', friction: 0.5 });

  // Lavamanos de pedestal contra la pared norte (85 cm de alto, como uno real)
  add({ name: 'sink_pedestal', room: 'bano', kind: 'cylinder', size: [0.18, 0.18, 0.7], pos: [-7.6, 0.74, 0.35], look: 'ceramic', physics: true });
  add({ name: 'sink_basin', room: 'bano', kind: 'box', size: [0.56, 0.42, 0.16], pos: [-7.6, 0.72, 0.78], look: 'ceramic', physics: true });
  add({ name: 'sink_tap', room: 'bano', kind: 'cylinder', size: [0.035, 0.035, 0.14], pos: [-7.6, 0.88, 0.92], look: 'chrome', physics: false });
  add({ name: 'sink_spout', room: 'bano', kind: 'box', size: [0.03, 0.12, 0.03], pos: [-7.6, 0.83, 0.98], look: 'chrome', physics: false });

  // Inodoro contra la pared oeste: base, tanque y asiento
  add({ name: 'toilet_base', room: 'bano', kind: 'cylinder', size: [0.36, 0.36, 0.38], pos: [-7.88, -0.9, 0.19], look: 'ceramic', physics: true });
  add({ name: 'toilet_seat', room: 'bano', kind: 'cylinder', size: [0.4, 0.4, 0.04], pos: [-7.88, -0.9, 0.4], look: 'ceramic', color: 0xf2f2f2, physics: false });
  add({ name: 'toilet_tank', room: 'bano', kind: 'box', size: [0.2, 0.44, 0.36], pos: [-8.09, -0.9, 0.58], look: 'ceramic', physics: true });

  // Tapetes de tela de 1.2 cm: más agarre (APPROX μ 0.9) y un borde con el que se puede tropezar
  add({ name: 'mat_sink', room: 'bano', kind: 'box', size: [0.6, 0.4, 0.012], pos: [-7.6, 0.18, 0.006], look: 'fabric', color: 0x6cc2b2, physics: true, friction: 0.9 });
  add({ name: 'mat_center', room: 'bano', kind: 'box', size: [0.7, 0.45, 0.012], pos: [-6.55, -0.35, 0.006], yaw: 0.25, look: 'fabric', color: 0xf2a65a, physics: true, friction: 0.9 });

  // Charco junto a la entrada: muy resbaloso (APPROX μ 0.1, agua sobre azulejo). La física es una caja delgada que lo
  // cubre; se ve como una elipse de agua
  add({ name: 'puddle', room: 'bano', kind: 'ellipse', size: [0.55, 0.38, 0.003], pos: [-6.0, -1.15, 0.0045], look: 'water', physics: false });
  add({ name: 'puddle_slip', room: 'bano', kind: 'box', size: [0.48, 0.3, 0.003], pos: [-6.0, -1.15, 0.0015], look: 'water', physics: 'only', friction: 0.1 });
}

// ─── Muebles (placeholders simples; cada uno con su modelo 3D pendiente en docs/MESHY.md) ─────────────────────
{
  // Casa: cama individual contra la pared oeste (cabecera al sur), mesita de noche y estante de juguetes
  const bed = { model: 'bed', facing: Math.PI / 2, room: 'casa' as const };
  add({ ...bed, name: 'bed_frame', kind: 'box', size: [0.9, 1.9, 0.32], pos: [-4.75, -5.2, 0.16], look: 'wood', physics: true });
  add({ ...bed, name: 'bed_mattress', kind: 'box', size: [0.86, 1.84, 0.18], pos: [-4.75, -5.2, 0.41], look: 'fabric', color: 0xe9f1fb, physics: true });
  add({ ...bed, name: 'bed_pillow', kind: 'box', size: [0.6, 0.34, 0.1], pos: [-4.75, -5.95, 0.55], look: 'fabric', color: 0xffffff, physics: false });
  add({ ...bed, name: 'bed_blanket', kind: 'box', size: [0.88, 1.1, 0.04], pos: [-4.75, -4.85, 0.52], look: 'fabric', color: 0x5aa9e6, physics: false });
  add({ ...bed, name: 'bed_headboard', kind: 'box', size: [0.9, 0.05, 0.9], pos: [-4.75, -6.12, 0.45], look: 'wood', physics: true });
  add({ model: 'nightstand', facing: Math.PI / 2, room: 'casa', name: 'nightstand', kind: 'box', size: [0.4, 0.38, 0.5], pos: [-4.05, -5.95, 0.25], look: 'wood', color: 0xd6a06b, physics: true });
  const shelf = { model: 'toy_shelf', facing: Math.PI, room: 'casa' as const };
  add({ ...shelf, name: 'toy_shelf', kind: 'box', size: [0.3, 1.2, 0.9], pos: [-2.47, -4.95, 0.45], look: 'paint', color: 0xf7d774, physics: true });
  add({ ...shelf, name: 'toy_shelf_board', kind: 'box', size: [0.31, 1.18, 0.02], pos: [-2.47, -4.95, 0.45], look: 'paint', color: 0xf2a65a, physics: false });

  // Laboratorio: mesa baja de 35 cm (la cámara del NAO ve lo que hay encima), estantería y pizarra
  const table = { model: 'lab_table', facing: Math.PI / 2, room: 'laboratorio' as const };
  add({ ...table, name: 'lab_table_top', kind: 'box', size: [0.9, 0.5, 0.03], pos: [-2.75, -1.35, 0.335], look: 'paint', color: 0xf3f6f9, physics: true });
  for (const [dx, dy] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
    add({ ...table, name: `lab_table_leg_${dx}_${dy}`, kind: 'box', size: [0.04, 0.04, 0.32], pos: [-2.75 + dx * 0.41, -1.35 + dy * 0.21, 0.16], look: 'chrome', physics: true });
  }
  add({ model: 'lab_shelf', facing: 0, room: 'laboratorio', name: 'lab_shelf', kind: 'box', size: [0.35, 0.6, 1.2], pos: [-5.02, 0.55, 0.6], look: 'paint', color: 0xb8c4d0, physics: true });
  add({ model: 'whiteboard', facing: -Math.PI / 2, room: 'laboratorio', name: 'whiteboard', kind: 'box', size: [1.2, 0.03, 0.8], pos: [-3.75, 0.93, 1.3], look: 'board', physics: false });

  // Pasillo: planta grande al fondo (maceta con física; las hojas solo se ven)
  const plant = { model: 'plant', facing: Math.PI, room: 'pasillo' as const };
  add({ ...plant, name: 'plant_pot', kind: 'cylinder', size: [0.34, 0.34, 0.36], pos: [1.9, -2.85, 0.18], look: 'paint', color: 0xc8643b, physics: true });
  add({ ...plant, name: 'plant_leaves', kind: 'sphere', size: [0.6, 0.6, 0.75], pos: [1.9, -2.85, 0.75], look: 'leaf', physics: false });

  // Cuarto del espejo: un puf
  add({ model: 'pouf', facing: Math.PI, room: 'espejo', name: 'pouf', kind: 'cylinder', size: [0.45, 0.45, 0.38], pos: [-5.75, -3.95, 0.19], look: 'fabric', color: 0xb58cff, physics: true });
}

export const PROPS: readonly PropPart[] = parts;
