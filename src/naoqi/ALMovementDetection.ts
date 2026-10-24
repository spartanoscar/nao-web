// ALMovementDetection (doc reference/naoqi-2.8-api/naoqi_vision_almovementdetection.md y -api.md): detecta movimiento en
// lo que ve la cámara. "Frames are collected at a regular interval and each new frame is compared with the previous
// one. The pixels for which the difference is above a threshold are identified as moving pixels. Then all the moving
// pixels are clustered using both their physical proximity and their value difference." El NAO no tiene cámara 3D: usa
// la RGB y su sensibilidad de color. "Only works if the camera is not moving": mientras el robot (o su cabeza) se mueve
// la detección se desactiva y se reinicia (resetDetection), sin eventos.
//
// No conoce Three.js: recibe la imagen RGBA de la cámara de arriba (app.ts la toma de NaoCameras unas 5 veces por
// segundo, APPROX: la doc no da la frecuencia) y si la cámara se movió desde la anterior.
// APPROX: agrupación por proximidad en una rejilla de 8×8 px (no por "value difference"); umbral de diferencia
// = (1 − sensibilidad)·255 en gris; menos del 0.2% de píxeles moviéndose = sin movimiento.

import { CAMERA_HFOV, CAMERA_VFOV } from '../robot/cameras';

export interface MovementCluster {
  /** Centro de gravedad [x, y] en ángulos (rad) respecto al centro de la cámara: x + izquierda, y + abajo */
  positionOfCog: [number, number];
  /** [x, y, ancho, alto] en ángulos (rad): esquina de arriba a la izquierda y tamaño */
  angularRoi: [number, number, number, number];
  /** [en el cuadro, en el ROI] */
  proportionMovingPixels: [number, number];
}

const CELL = 8;
const MIN_CELL_PIXELS = 4;
const MIN_PROPORTION = 0.002;
/** Si cambia más que esto del cuadro, fue la cámara o la luz, no algo que se mueve */
const MAX_PROPORTION = 0.6;

export class ALMovementDetection {
  private sensitivity = 0.9;
  private previous: Float32Array | null = null;
  /** Último resultado (ALMemory MovementDetection/MovementInfo) y quién escucha los eventos */
  movementInfo: unknown = null;
  private readonly listeners = new Set<(clusters: MovementCluster[]) => void>();

  /** Doc: "Resets to zero the values of the previously seen images" (se llama solo cuando el robot se mueve) */
  resetDetection(): void {
    this.previous = null;
  }

  /** Doc: "color sensitivity (between 0 and 1)… The lower this sensitivity is, the higher the variation… must be" */
  getColorSensitivity(): number {
    return this.sensitivity;
  }

  setColorSensitivity(sensitivity: number): void {
    this.sensitivity = Math.min(Math.max(Number(sensitivity), 0), 1);
  }

  /** Extensión propia: escuchar MovementDetection/MovementDetected (falta el sistema de eventos de ALMemory) */
  onMovement(fn: (clusters: MovementCluster[]) => void): () => void {
    this.listeners.add(fn);
    return () => void this.listeners.delete(fn);
  }

  /** Un cuadro nuevo de la cámara (RGBA). `cameraMoved`: la cámara no estaba quieta desde el anterior */
  process(rgba: Uint8Array, width: number, height: number, cameraMoved: boolean, time: number): MovementCluster[] {
    const gray = new Float32Array(width * height);
    for (let i = 0; i < gray.length; i++) gray[i] = 0.299 * rgba[4 * i] + 0.587 * rgba[4 * i + 1] + 0.114 * rgba[4 * i + 2];
    const prev = this.previous;
    this.previous = gray;
    if (cameraMoved || !prev || prev.length !== gray.length) {
      this.previous = cameraMoved ? null : gray;
      return [];
    }
    const threshold = Math.max((1 - this.sensitivity) * 255, 4);
    const cols = Math.ceil(width / CELL);
    const rows = Math.ceil(height / CELL);
    const cells = new Uint16Array(cols * rows);
    let moving = 0;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const i = y * width + x;
        if (Math.abs(gray[i] - prev[i]) > threshold) {
          moving++;
          cells[Math.floor(y / CELL) * cols + Math.floor(x / CELL)]++;
        }
      }
    }
    const proportion = moving / gray.length;
    if (proportion < MIN_PROPORTION || proportion > MAX_PROPORTION) return [];

    // Grupos de celdas vecinas con movimiento
    const seen = new Uint8Array(cells.length);
    const clusters: { px: number; sx: number; sy: number; x0: number; y0: number; x1: number; y1: number }[] = [];
    for (let c = 0; c < cells.length; c++) {
      if (seen[c] || cells[c] < MIN_CELL_PIXELS) continue;
      const g = { px: 0, sx: 0, sy: 0, x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
      const stack = [c];
      seen[c] = 1;
      while (stack.length) {
        const k = stack.pop()!;
        const cx = k % cols;
        const cy = Math.floor(k / cols);
        g.px += cells[k];
        g.sx += cells[k] * (cx + 0.5) * CELL;
        g.sy += cells[k] * (cy + 0.5) * CELL;
        g.x0 = Math.min(g.x0, cx * CELL);
        g.y0 = Math.min(g.y0, cy * CELL);
        g.x1 = Math.max(g.x1, Math.min((cx + 1) * CELL, width));
        g.y1 = Math.max(g.y1, Math.min((cy + 1) * CELL, height));
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const nx = cx + dx;
          const ny = cy + dy;
          const n = ny * cols + nx;
          if (nx < 0 || ny < 0 || nx >= cols || ny >= rows || seen[n] || cells[n] < MIN_CELL_PIXELS) continue;
          seen[n] = 1;
          stack.push(n);
        }
      }
      clusters.push(g);
    }
    if (!clusters.length) return [];
    clusters.sort((a, b) => b.px - a.px);

    // Píxeles → ángulos (cámara estenopeica con el campo de visión de la doc del V6)
    const fx = width / 2 / Math.tan(CAMERA_HFOV / 2);
    const fy = height / 2 / Math.tan(CAMERA_VFOV / 2);
    const ax = (x: number) => Math.atan((width / 2 - x) / fx);
    const ay = (y: number) => Math.atan((y - height / 2) / fy);
    const result: MovementCluster[] = clusters.slice(0, 5).map((g) => ({
      positionOfCog: [ax(g.sx / g.px), ay(g.sy / g.px)],
      angularRoi: [ax(g.x0), ay(g.y0), ax(g.x0) - ax(g.x1), ay(g.y1) - ay(g.y0)],
      proportionMovingPixels: [g.px / gray.length, g.px / ((g.x1 - g.x0) * (g.y1 - g.y0))],
    }));
    this.movementInfo = [[Math.floor(time), Math.round((time % 1) * 1e6)], result.map((c) => [c.positionOfCog, c.angularRoi, c.proportionMovingPixels]), [], [], 0];
    for (const fn of this.listeners) fn(result);
    return result;
  }
}
