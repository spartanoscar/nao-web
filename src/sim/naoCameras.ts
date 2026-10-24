// Cámaras del NAO V6 en la escena: CameraTop en la frente (índice 0) y CameraBottom en la boca (índice 1),
// colgadas de los frames ópticos del URDF (la de abajo mira 39.7° hacia el suelo). Datos: robot/cameras.ts.
// Las usan la vista de depuración (renderTo) y ALVideoDevice (capture).

import * as THREE from 'three';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { CAMERA_HFOV, CAMERA_VFOV, NAO_CAMERAS } from '../robot/cameras';
import type { NaoModel } from './naoModel';

/** APPROX: el lente está en la superficie de la carcasa; más cerca que esto se vería el plástico por dentro */
const NEAR = 0.01;
/**
 * Imágenes por segundo de las vistas en pantalla (ui/cameraViews.ts). Antes se redibujaba la escena entera para cada
 * cámara en cada cuadro: costaban tanto como el mundo (medido 2026-10-24: 207 ms/s contra 195 del mundo, a 30 fps).
 * Ahora se dibujan en una textura a este ritmo y cada cuadro solo la copia.
 */
const VIEW_FPS = 10;

export class NaoCameras {
  readonly cameras: THREE.PerspectiveCamera[];
  /** Texturas de captura por tamaño: [escena lineal (media precisión), salida de 8 bits] */
  private readonly targets = new Map<string, [THREE.WebGLRenderTarget, THREE.WebGLRenderTarget]>();
  private readonly output = new OutputPass();
  /** Vistas en pantalla: textura de cada cámara, cuándo se dibujó y la copia al canvas (con el tonemapping del canvas) */
  private readonly views: { target: THREE.WebGLRenderTarget; at: number }[] = [];
  private readonly blit = Object.assign(new OutputPass(), { renderToScreen: true });

  constructor(model: NaoModel) {
    const aspect = Math.tan(CAMERA_HFOV / 2) / Math.tan(CAMERA_VFOV / 2);
    this.cameras = NAO_CAMERAS.map(({ frame }) => {
      const cam = new THREE.PerspectiveCamera(THREE.MathUtils.radToDeg(CAMERA_VFOV), aspect, NEAR, 20);
      // Frame óptico (convención ROS): Z adelante, X derecha, Y abajo. La cámara de three mira a −Z con
      // Y arriba: media vuelta sobre X
      cam.rotation.x = Math.PI;
      // El NAO ve todo lo que físicamente tiene delante (por la puerta, el pasillo y los otros cuartos): todas las capas
      // (la cámara del mundo solo ve el cuarto donde está, world.setRoom)
      cam.layers.enableAll();
      const parent = model.frame(frame);
      if (!parent) throw new Error(`El URDF no tiene ${frame}`);
      parent.add(cam);
      return cam;
    });
  }

  /**
   * Dibuja lo que ve la cámara `index` dentro de un rectángulo del canvas (píxeles CSS, origen arriba a la
   * izquierda), sin tocar el resto del cuadro. Llamar después del render principal. La escena se vuelve a dibujar para
   * esa cámara como mucho VIEW_FPS veces por segundo; devuelve false si esta vez copió la imagen anterior (quien llama
   * pide otro cuadro para que la última no quede vieja).
   */
  renderTo(renderer: THREE.WebGLRenderer, scene: THREE.Scene, index: number, rect: { x: number; y: number; width: number; height: number }): boolean {
    const ratio = renderer.getPixelRatio();
    const [w, h] = [Math.round(rect.width * ratio), Math.round(rect.height * ratio)];
    let view = this.views[index];
    if (!view || view.target.width !== w || view.target.height !== h) {
      view?.target.dispose();
      view = this.views[index] = { target: new THREE.WebGLRenderTarget(w, h, { type: THREE.HalfFloatType, samples: 4 }), at: -Infinity };
    }
    const now = performance.now() / 1000;
    const fresh = now - view.at >= 1 / VIEW_FPS;
    const previous = renderer.getRenderTarget();
    if (fresh) {
      view.at = now;
      renderer.setRenderTarget(view.target);
      renderer.render(scene, this.cameras[index]);
    }
    const height = renderer.domElement.clientHeight;
    const y = height - rect.y - rect.height; // WebGL cuenta desde abajo
    renderer.setRenderTarget(null);
    renderer.setViewport(rect.x, y, rect.width, rect.height);
    renderer.setScissor(rect.x, y, rect.width, rect.height);
    renderer.setScissorTest(true);
    this.blit.render(renderer, null as unknown as THREE.WebGLRenderTarget, view.target, 0, false);
    renderer.setScissorTest(false);
    renderer.setViewport(0, 0, renderer.domElement.clientWidth, height);
    renderer.setRenderTarget(previous);
    return fresh;
  }

  /**
   * Imagen de la cámara `index` en RGBA de 8 bits, filas de arriba abajo, igual que se vería en pantalla.
   * Un render a textura en three queda lineal y sin tonemapping: OutputPass aplica los mismos que el canvas.
   */
  capture(renderer: THREE.WebGLRenderer, scene: THREE.Scene, index: number, width: number, height: number): Uint8Array {
    const key = `${width}x${height}`;
    let pair = this.targets.get(key);
    if (!pair) {
      pair = [new THREE.WebGLRenderTarget(width, height, { type: THREE.HalfFloatType, samples: 4 }), new THREE.WebGLRenderTarget(width, height)];
      this.targets.set(key, pair);
    }
    const [linear, out] = pair;
    const previous = renderer.getRenderTarget();
    renderer.setRenderTarget(linear);
    renderer.render(scene, this.cameras[index]);
    this.output.render(renderer, out, linear, 0, false);
    const raw = new Uint8Array(width * height * 4);
    renderer.readRenderTargetPixels(out, 0, 0, width, height, raw);
    renderer.setRenderTarget(previous);
    // WebGL entrega las filas de abajo arriba
    const rgba = new Uint8Array(raw.length);
    const row = width * 4;
    for (let y = 0; y < height; y++) rgba.set(raw.subarray((height - 1 - y) * row, (height - y) * row), y * row);
    return rgba;
  }
}
