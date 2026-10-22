// Cámaras del NAO V6 (doc family_nao_technical_video_naov6): dos OV5640 idénticas, CameraTop en la frente
// (índice 0, AL::kTopCamera) y CameraBottom en la boca (índice 1, AL::kBottomCamera). Posición y orientación:
// los frames ópticos del URDF (la de abajo mira 39.7° hacia el suelo). Campo de visión 56.3° H × 43.7° V (4:3).
// Son la base de ALVideoDevice: lo que ve el robot sale de aquí.

import * as THREE from 'three';
import type { NaoModel } from './naoModel';

export const NAO_CAMERAS = [
  { index: 0, name: 'CameraTop', id: 'kTopCamera', frame: 'CameraTop_optical_frame' },
  { index: 1, name: 'CameraBottom', id: 'kBottomCamera', frame: 'CameraBottom_optical_frame' },
] as const;

/** Campo de visión horizontal y vertical (rad), doc video_naov6 */
export const CAMERA_HFOV = THREE.MathUtils.degToRad(56.3);
export const CAMERA_VFOV = THREE.MathUtils.degToRad(43.7);
/** APPROX: el lente está en la superficie de la carcasa; más cerca que esto se vería el plástico por dentro */
const NEAR = 0.01;

export class NaoCameras {
  readonly cameras: THREE.PerspectiveCamera[];

  constructor(model: NaoModel) {
    const aspect = Math.tan(CAMERA_HFOV / 2) / Math.tan(CAMERA_VFOV / 2);
    this.cameras = NAO_CAMERAS.map(({ frame }) => {
      const cam = new THREE.PerspectiveCamera(THREE.MathUtils.radToDeg(CAMERA_VFOV), aspect, NEAR, 20);
      // Frame óptico (convención ROS): Z adelante, X derecha, Y abajo. La cámara de three mira a −Z con
      // Y arriba: media vuelta sobre X
      cam.rotation.x = Math.PI;
      const parent = model.frame(frame);
      if (!parent) throw new Error(`El URDF no tiene ${frame}`);
      parent.add(cam);
      return cam;
    });
  }

  /**
   * Dibuja lo que ve la cámara `index` dentro de un rectángulo del canvas (píxeles CSS, origen arriba a la
   * izquierda), sin tocar el resto del cuadro. Llamar después del render principal.
   */
  renderTo(renderer: THREE.WebGLRenderer, scene: THREE.Scene, index: number, rect: { x: number; y: number; width: number; height: number }): void {
    const height = renderer.domElement.clientHeight;
    const y = height - rect.y - rect.height; // WebGL cuenta desde abajo
    renderer.setViewport(rect.x, y, rect.width, rect.height);
    renderer.setScissor(rect.x, y, rect.width, rect.height);
    renderer.setScissorTest(true);
    renderer.render(scene, this.cameras[index]);
    renderer.setScissorTest(false);
    renderer.setViewport(0, 0, renderer.domElement.clientWidth, height);
  }
}
