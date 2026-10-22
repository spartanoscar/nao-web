// Lo que ve el NAO, en el formato que se le manda a Gemini, y la geometría para ir hacia lo que vio.
//
//   - Vista: una sola imagen con las dos cámaras apiladas (frente arriba, boca abajo). Juntas cubren del suelo
//     cerca de los pies hasta el frente casi sin hueco (frente −23°…+21°, boca 18°…62° hacia abajo).
//   - Mosaico (scan): tres vistas con la cabeza a la izquierda, al centro y a la derecha, en una imagen; con la vuelta
//     completa, una segunda fila con lo de detrás (gira el cuerpo 180°): 360° en una sola imagen.
//   - Cada recuadro guarda la pose de su cámara en el momento de la foto: una caja que devuelve Gemini
//     ([ymin, xmin, ymax, xmax] de 0 a 1000) se convierte en un punto del suelo proyectando el borde inferior de la
//     caja (donde el objeto toca el piso) con la cámara estenopeica. En el NAO real sería lo mismo con
//     ALVideoDevice.getAngularPositionFromImagePosition + ALMotion.getPosition("CameraTop", FRAME_WORLD).
//
// Las imágenes salen de ALVideoDevice (kQVGA, RGB), igual que las pediría un programa en el robot.

import * as THREE from 'three';
import type { ALMotion } from '../naoqi/ALMotion';
import type { ALVideoDevice } from '../naoqi/ALVideoDevice';

const K_QVGA = 1;
const K_RGB = 11;
const W = 320;
const H = 240;
/** Ángulos de la cabeza del mosaico (rad, positivo = izquierda): ±60° con 56° de campo cubren ~176° */
const SCAN_YAWS = [1.05, 0, -1.05];
const SCAN_LABELS = ['izquierda', 'centro', 'derecha'];
const JPEG_QUALITY = 0.72;

interface Tile {
  /** Rectángulo en la imagen completa (px) */
  x: number;
  y: number;
  /** Pose y proyección de la cámara cuando se tomó */
  world: THREE.Matrix4;
  projectionInverse: THREE.Matrix4;
}

export interface Snapshot {
  /** data URL JPEG */
  jpeg: string;
  width: number;
  height: number;
  tiles: Tile[];
}

/** Punto del suelo en coordenadas del mundo (Z arriba, metros) */
export interface GroundPoint {
  x: number;
  y: number;
}

const nextFrame = () => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())));

export class Vision {
  private handles: string[] = [];
  private canvas = document.createElement('canvas');
  /** La última imagen que vio Gemini: las cajas que devuelve se refieren a ella */
  last: Snapshot | null = null;

  constructor(
    private readonly video: ALVideoDevice,
    /** Cámaras de la escena (pose en el momento de la foto) */
    private readonly cameras: readonly THREE.PerspectiveCamera[],
  ) {}

  /** Vista actual: frente arriba, boca abajo (320×480) */
  view(): Snapshot {
    const ctx = this.prepare(W, H * 2);
    const tiles = [this.draw(ctx, 0, 0, 0), this.draw(ctx, 1, 0, H)];
    return this.finish(tiles);
  }

  /**
   * Mosaico moviendo la cabeza: una fila de tres vistas (960×480), o con `turnAround` dos filas (960×960): lo de
   * delante y, tras girar el cuerpo 180°, lo de detrás. La cabeza vuelve al centro.
   */
  async scan(motion: ALMotion, turnAround?: () => Promise<boolean>): Promise<Snapshot> {
    const pitch = motion.getAngles('HeadPitch', false)[0];
    const rows = turnAround ? 2 : 1;
    const ctx = this.prepare(W * SCAN_YAWS.length, H * 2 * rows);
    const tiles: Tile[] = [];
    for (let row = 0; row < rows; row++) {
      if (row > 0) {
        await motion.angleInterpolationWithSpeed(['HeadYaw', 'HeadPitch'], [0, 0], 0.4);
        if (!(await turnAround!())) break;
      }
      const y0 = row * H * 2;
      for (const [i, yaw] of SCAN_YAWS.entries()) {
        await motion.angleInterpolationWithSpeed(['HeadYaw', 'HeadPitch'], [yaw, 0], 0.4);
        await nextFrame(); // que la escena dibuje la cabeza en su nueva pose
        tiles.push(this.draw(ctx, 0, i * W, y0), this.draw(ctx, 1, i * W, y0 + H));
        const label = (rows > 1 ? (row ? 'detrás · ' : 'delante · ') : '') + SCAN_LABELS[i];
        ctx.font = 'bold 15px system-ui, sans-serif';
        ctx.fillStyle = 'rgba(0, 0, 0, 0.55)';
        ctx.fillRect(i * W + 6, y0 + 6, ctx.measureText(label).width + 12, 22);
        ctx.fillStyle = '#fff';
        ctx.fillText(label, i * W + 12, y0 + 22);
      }
    }
    void motion.angleInterpolationWithSpeed(['HeadYaw', 'HeadPitch'], [0, pitch], 0.4);
    return this.finish(tiles);
  }

  /**
   * Punto del suelo bajo una caja de la última imagen: el centro de su borde inferior, proyectado con la cámara
   * de su recuadro. null si la caja no es válida o ese punto no mira al suelo.
   */
  groundPoint(box: number[]): GroundPoint | null {
    const snap = this.last;
    if (!snap || box.length !== 4 || box.some((v) => !Number.isFinite(v))) return null;
    const [ymin, xmin, ymax, xmax] = box.map((v) => Math.min(Math.max(v, 0), 1000) / 1000);
    if (ymax <= ymin || xmax <= xmin) return null;
    const px = ((xmin + xmax) / 2) * snap.width;
    const py = ymax * snap.height - 2; // un poco por dentro: el borde exacto puede caer en el recuadro de abajo
    const tile = snap.tiles.find((t) => px >= t.x && px < t.x + W && py >= t.y && py < t.y + H);
    if (!tile) return null;
    const ndc = new THREE.Vector3(((px - tile.x) / W) * 2 - 1, 1 - ((py - tile.y) / H) * 2, 0.5);
    const through = ndc.applyMatrix4(tile.projectionInverse).applyMatrix4(tile.world);
    const origin = new THREE.Vector3().setFromMatrixPosition(tile.world);
    const dir = through.sub(origin);
    if (dir.y > -1e-4) return null; // mira al horizonte o hacia arriba
    const t = -origin.y / dir.y;
    const hit = origin.addScaledVector(dir, t);
    // Escena de three (Y arriba) → mundo del URDF (Z arriba): x = x, y = −z
    return { x: hit.x, y: -hit.z };
  }

  private prepare(width: number, height: number): CanvasRenderingContext2D {
    this.canvas.width = width;
    this.canvas.height = height;
    const ctx = this.canvas.getContext('2d')!;
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, width, height);
    return ctx;
  }

  private draw(ctx: CanvasRenderingContext2D, camera: number, x: number, y: number): Tile {
    this.handles[camera] ??= this.video.subscribeCamera('brain', camera, K_QVGA, K_RGB, 30);
    const img = this.video.getImageRemote(this.handles[camera]);
    if (img) {
      const [w, h, , , , , data] = img;
      const out = ctx.createImageData(w, h);
      for (let i = 0, j = 0; i < w * h; i++, j += 3) {
        out.data[i * 4] = data[j];
        out.data[i * 4 + 1] = data[j + 1];
        out.data[i * 4 + 2] = data[j + 2];
        out.data[i * 4 + 3] = 255;
      }
      ctx.putImageData(out, x, y);
    }
    // getImageRemote acaba de dibujar la escena con esta cámara: su matriz es la de la foto
    const cam = this.cameras[camera];
    return { x, y, world: cam.matrixWorld.clone(), projectionInverse: cam.projectionMatrixInverse.clone() };
  }

  private finish(tiles: Tile[]): Snapshot {
    const snap = { jpeg: this.canvas.toDataURL('image/jpeg', JPEG_QUALITY), width: this.canvas.width, height: this.canvas.height, tiles };
    this.last = snap;
    return snap;
  }
}
