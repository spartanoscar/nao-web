// Lo que ven las dos cámaras del NAO, siempre en pantalla (recuadros pequeños a la izquierda): así se sabe qué
// percibe el robot. Con el panel abierto se ve además el nombre técnico de cada cámara. Se dibujan en el mismo
// canvas (scissor), solo cuando la escena se redibuja: no rompen el render bajo demanda.

import { NAO_CAMERAS } from '../robot/cameras';
import type { NaoCameras } from '../sim/naoCameras';
import type { World } from '../sim/world';

/** Rótulo para el público por cámara (índice 0 = frente, 1 = boca) */
const LABELS = ['Frente', 'Boca'];

export function attachCameraViews(world: World, cameras: NaoCameras): void {
  const dock = document.createElement('div');
  dock.id = 'camera-views';
  const images = NAO_CAMERAS.map(({ index, name, id }) => {
    const view = document.createElement('figure');
    view.className = 'cam-view';
    const image = document.createElement('div');
    image.className = 'cam-image';
    const caption = document.createElement('figcaption');
    const label = document.createElement('span');
    label.textContent = LABELS[index];
    const tech = document.createElement('span');
    tech.className = 'cam-tech';
    tech.textContent = ` · ${name} · ${id} (${index})`;
    caption.append(label, tech);
    view.append(image, caption);
    dock.append(view);
    return image;
  });
  document.body.append(dock);

  world.onAfterRender(() => {
    const canvas = world.renderer.domElement.getBoundingClientRect();
    images.forEach((image, i) => {
      const r = image.getBoundingClientRect();
      if (r.width < 1 || r.height < 1) return;
      cameras.renderTo(world.renderer, world.scene, i, { x: r.left - canvas.left, y: r.top - canvas.top, width: r.width, height: r.height });
    });
  });

  world.invalidate();
  // Los recuadros cambian de sitio al abrir/cerrar el panel (el título ocupa la esquina)
  new MutationObserver(() => world.invalidate()).observe(document.body, { attributes: true, attributeFilter: ['class'] });
}
