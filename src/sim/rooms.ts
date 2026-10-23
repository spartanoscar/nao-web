// Mundo 1, "Laboratorio" (docs/PLAN.md F13): un pasillo con cuartos separados, cada uno un experimento. Datos
// compartidos por el render (world.ts) y la física (las paredes son piezas fijas de MuJoCo, environment.ts ENV_FIXED).
// Coordenadas Z arriba (URDF/MuJoCo), metros. La sala de pruebas queda centrada en el origen: ahí corren los bancos y
// el laboratorio de movimientos, como antes.
//
//   y ↑
//      ┌───────────┬───────────┬───────────────┐ 2.0
//      │   BAÑO    │LABORATORIO│ SALA DE       │
//   1.0├───────────┼───────────┤ PRUEBAS (0,0) │
//      │           │           │               │
//  −2.0└────┐ ┌────┴────┐ ┌────┴─────┐ ┌───────┤
//      │  PASILLO                              │
//  −3.2├────┘ └────┬────┘ └────┬─────────────────┘
//      │  ESPEJO   │   CASA    │
//  −6.2└───────────┴───────────┘
//    −8.25      −5.25       −2.25          2.25  → x
//
// Escala de una casa real (paredes de 2.5 m, techo): el NAO (57 cm) es un juguete en una casa de verdad, como en los
// juegos de juguetes. A su escala (~8 cm/s) un cuarto de 3 m ya es grande. Puertas en arco de 1.2 × 2.05 m, sin hoja (no
// agarra manijas, que le quedarían al doble de su altura). Con 0.9 m no salía de la casa (medido 2026-10-23): la marcha se
// desviaba 23° en ~1 m y el sonar veía la pared junto al marco, así que la marcha segura lo frenaba adentro; con 1.2 m
// los marcos quedan a 0.6 m del centro y no entran en la zona de seguridad (0.5 m) aunque llegue algo torcido.

export type RoomId = 'pruebas' | 'laboratorio' | 'bano' | 'pasillo' | 'espejo' | 'casa';

/** Papel de colgar (sim/decor.ts): pintura de base + patrón propio por cuarto */
export type WallStyle = 'stars' | 'dado' | 'wainscot' | 'band' | 'tiles' | 'hazard';
export type FloorStyle = 'wood' | 'darkwood' | 'tile' | 'vinyl' | 'concrete';
/** Pared exterior del cuarto con ventana (solo visual: cielo de día detrás de un marco) */
export type Side = 'north' | 'south' | 'east' | 'west';

export interface Room {
  id: RoomId;
  /** Texto del letrero de la puerta */
  label: string;
  x: [number, number];
  y: [number, number];
  /** Color del piso (render) */
  floor: number;
  /** Donde aparece el NAO en este cuarto: centro del torso en el plano y rumbo (rad, 0 = +X) */
  spawn: { x: number; y: number; yaw: number };
  /** Capa de three.js: la cámara del mundo solo ve el cuarto donde está el NAO (más el pasillo) */
  layer: number;
  style: { wall: WallStyle; paint: number; floorStyle: FloorStyle; lamp: number; window?: Side; rug?: 'round' | 'runner' };
}

export const ROOMS: Record<RoomId, Room> = {
  pruebas: { id: 'pruebas', label: 'SALA DE PRUEBAS', x: [-2.25, 2.25], y: [-2, 2], floor: 0x20262f, spawn: { x: 0, y: 0, yaw: 0 }, layer: 1, style: { wall: 'hazard', paint: 0xe3e6ea, floorStyle: 'concrete', lamp: 0xf4f7ff, window: 'east' } },
  laboratorio: { id: 'laboratorio', label: 'LABORATORIO', x: [-5.25, -2.25], y: [-2, 1], floor: 0x232a33, spawn: { x: -3.75, y: -0.5, yaw: 0 }, layer: 2, style: { wall: 'band', paint: 0xdde6ee, floorStyle: 'vinyl', lamp: 0xf1f5ff, window: 'north' } },
  bano: { id: 'bano', label: 'BAÑO', x: [-8.25, -5.25], y: [-2, 1], floor: 0x2b3a44, spawn: { x: -6.75, y: -0.5, yaw: -Math.PI / 2 }, layer: 3, style: { wall: 'tiles', paint: 0xa6e4d4, floorStyle: 'tile', lamp: 0xfff1dc, window: 'north' } },
  pasillo: { id: 'pasillo', label: 'PASILLO', x: [-8.25, 2.25], y: [-3.2, -2], floor: 0x1d2229, spawn: { x: -3, y: -2.6, yaw: Math.PI }, layer: 4, style: { wall: 'wainscot', paint: 0xf0e2c2, floorStyle: 'darkwood', lamp: 0xffdcae, window: 'west', rug: 'runner' } },
  espejo: { id: 'espejo', label: 'ESPEJO', x: [-8.25, -5.25], y: [-6.2, -3.2], floor: 0x2a2535, spawn: { x: -6.75, y: -4.6, yaw: -Math.PI / 2 }, layer: 5, style: { wall: 'dado', paint: 0xcdb9ef, floorStyle: 'wood', lamp: 0xffe4c4, window: 'west' } },
  casa: { id: 'casa', label: 'CASA', x: [-5.25, -2.25], y: [-6.2, -3.2], floor: 0x2e2a24, spawn: { x: -3.75, y: -4.7, yaw: Math.PI / 2 }, layer: 6, style: { wall: 'stars', paint: 0x9ec9e8, floorStyle: 'wood', lamp: 0xffd6a0, window: 'south', rug: 'round' } },
};

/** Donde aparece el NAO del usuario al entrar */
export const HOME_ROOM: RoomId = 'casa';

/** Alto de las paredes y del techo, y de las puertas (casa real) */
export const WALL_HEIGHT = 2.5;
export const WALL_THICKNESS = 0.1;
export const DOOR_WIDTH = 1.2;
export const DOOR_HEIGHT = 2.05;

/**
 * Pared recta (eje X o eje Y) de `from` a `to`, con puertas (centro a lo largo de la pared) y los cuartos desde los que
 * se ve (las compartidas, desde los dos). `sign`: letrero junto a cada puerta, del lado del pasillo.
 */
export interface Wall {
  from: [number, number];
  to: [number, number];
  doors?: { at: number; sign: RoomId; side: 1 | -1 }[];
  rooms: RoomId[];
}

// side: hacia qué lado de la pared mira el letrero (+1 = +y / +x), el del pasillo
export const WALLS: Wall[] = [
  // Sala de pruebas
  { from: [-2.25, 2], to: [2.25, 2], rooms: ['pruebas'] },
  { from: [2.25, -2], to: [2.25, 2], rooms: ['pruebas'] },
  { from: [-2.25, 1], to: [-2.25, 2], rooms: ['pruebas'] },
  { from: [-2.25, -2], to: [-2.25, 1], rooms: ['pruebas', 'laboratorio'] },
  { from: [-2.25, -2], to: [2.25, -2], doors: [{ at: 0, sign: 'pruebas', side: -1 }], rooms: ['pruebas', 'pasillo'] },
  // Laboratorio y baño
  { from: [-5.25, 1], to: [-2.25, 1], rooms: ['laboratorio'] },
  { from: [-5.25, -2], to: [-5.25, 1], rooms: ['laboratorio', 'bano'] },
  { from: [-5.25, -2], to: [-2.25, -2], doors: [{ at: -3.75, sign: 'laboratorio', side: -1 }], rooms: ['laboratorio', 'pasillo'] },
  { from: [-8.25, 1], to: [-5.25, 1], rooms: ['bano'] },
  { from: [-8.25, -2], to: [-8.25, 1], rooms: ['bano'] },
  { from: [-8.25, -2], to: [-5.25, -2], doors: [{ at: -6.75, sign: 'bano', side: -1 }], rooms: ['bano', 'pasillo'] },
  // Pasillo: extremos y pared sur (puertas del espejo y la casa)
  { from: [-8.25, -3.2], to: [-8.25, -2], rooms: ['pasillo'] },
  { from: [2.25, -3.2], to: [2.25, -2], rooms: ['pasillo'] },
  { from: [-8.25, -3.2], to: [-5.25, -3.2], doors: [{ at: -6.75, sign: 'espejo', side: 1 }], rooms: ['pasillo', 'espejo'] },
  { from: [-5.25, -3.2], to: [-2.25, -3.2], doors: [{ at: -3.75, sign: 'casa', side: 1 }], rooms: ['pasillo', 'casa'] },
  { from: [-2.25, -3.2], to: [2.25, -3.2], rooms: ['pasillo'] },
  // Espejo y casa
  { from: [-8.25, -6.2], to: [-8.25, -3.2], rooms: ['espejo'] },
  { from: [-8.25, -6.2], to: [-5.25, -6.2], rooms: ['espejo'] },
  { from: [-5.25, -6.2], to: [-5.25, -3.2], rooms: ['espejo', 'casa'] },
  { from: [-5.25, -6.2], to: [-2.25, -6.2], rooms: ['casa'] },
  { from: [-2.25, -6.2], to: [-2.25, -3.2], rooms: ['casa'] },
];

/** Un tramo macizo de pared: centro, tamaño completo (x, y, z) y cuartos que lo ven */
export interface WallPiece {
  center: [number, number, number];
  size: [number, number, number];
  rooms: RoomId[];
}

/** Las paredes partidas en tramos macizos (sin las puertas). Se alargan medio grosor para cerrar las esquinas. */
export function wallPieces(): WallPiece[] {
  const out: WallPiece[] = [];
  const t = WALL_THICKNESS;
  for (const w of WALLS) {
    const alongX = w.from[1] === w.to[1];
    const [a, b] = alongX ? [w.from[0], w.to[0]] : [w.from[1], w.to[1]];
    const fixed = alongX ? w.from[1] : w.from[0];
    // Cortes: los bordes de cada puerta
    const cuts: [number, number][] = [];
    let start = Math.min(a, b) - t / 2;
    for (const d of [...(w.doors ?? [])].sort((p, q) => p.at - q.at)) {
      cuts.push([start, d.at - DOOR_WIDTH / 2]);
      start = d.at + DOOR_WIDTH / 2;
    }
    cuts.push([start, Math.max(a, b) + t / 2]);
    const piece = (s: number, e: number, z0: number, z1: number) => {
      const mid = (s + e) / 2;
      out.push({
        center: alongX ? [mid, fixed, (z0 + z1) / 2] : [fixed, mid, (z0 + z1) / 2],
        size: alongX ? [e - s, t, z1 - z0] : [t, e - s, z1 - z0],
        rooms: w.rooms,
      });
    };
    for (const [s, e] of cuts) if (e - s > 1e-3) piece(s, e, 0, WALL_HEIGHT);
    // Dintel: la pared sigue sobre cada puerta hasta el techo
    for (const d of w.doors ?? []) piece(d.at - DOOR_WIDTH / 2, d.at + DOOR_WIDTH / 2, DOOR_HEIGHT, WALL_HEIGHT);
  }
  return out;
}

/**
 * Cuartos que se ven desde `id` a través de las puertas: el pasillo y los de enfrente cuya puerta queda alineada con la
 * suya (desde el espejo se ve, por dos puertas, el baño; desde la casa, el laboratorio)
 */
export function visibleFrom(id: RoomId): RoomId[] {
  const doors = new Map<RoomId, number[]>();
  for (const w of WALLS) for (const d of w.doors ?? []) doors.set(d.sign, [...(doors.get(d.sign) ?? []), d.at]);
  const mine = doors.get(id) ?? [];
  const across = [...doors].filter(([r, at]) => r !== id && at.some((a) => mine.some((m) => Math.abs(a - m) < DOOR_WIDTH)));
  return ['pasillo', ...across.map(([r]) => r)];
}

/** En qué cuarto está un punto (el pasillo incluye las puertas hasta la mitad de la pared) */
export function roomAt(x: number, y: number): RoomId | null {
  for (const r of Object.values(ROOMS)) {
    if (x >= r.x[0] && x <= r.x[1] && y >= r.y[0] && y <= r.y[1]) return r.id;
  }
  return null;
}
