// Lo que ven las dos cámaras del NAO, siempre en pantalla (a la izquierda, la de la frente arriba y la de la boca
// pegada debajo): así se sabe qué percibe el robot. Se dibujan en el mismo canvas (scissor), solo cuando la escena se
// redibuja: no rompen el render bajo demanda. Cada cámara se actualiza a 10 imágenes por segundo (naoCameras.ts
// VIEW_FPS); si en un cuadro se copió la anterior, se pide uno más tarde para que la última imagen no quede vieja.

import { NAO_CAMERAS } from '../robot/cameras';
import type { NaoCameras } from '../sim/naoCameras';
import type { World } from '../sim/world';

export function attachCameraViews(world: World, cameras: NaoCameras): void {
  const dock = document.createElement('div');
  dock.id = 'camera-views';
  const images = NAO_CAMERAS.map(() => {
    const image = document.createElement('div');
    image.className = 'cam-image';
    dock.append(image);
    return image;
  });
  document.body.append(dock);

  let pending = 0;
  world.onAfterRender(() => {
    const canvas = world.renderer.domElement.getBoundingClientRect();
    let stale = false;
    images.forEach((image, i) => {
      const r = image.getBoundingClientRect();
      if (r.width < 1 || r.height < 1) return;
      if (!cameras.renderTo(world.renderer, world.scene, i, { x: r.left - canvas.left, y: r.top - canvas.top, width: r.width, height: r.height })) stale = true;
    });
    if (stale && !pending) {
      pending = window.setTimeout(() => {
        pending = 0;
        world.invalidate();
      }, 110);
    }
  });
  world.invalidate();
}
