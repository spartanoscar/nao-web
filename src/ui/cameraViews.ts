// Depuración: lo que ven las dos cámaras del NAO en recuadros flotantes a la izquierda. Se activan desde
// el panel oculto y se recuerda en este navegador. Se dibujan en el mismo canvas (scissor), solo cuando
// la escena se redibuja: no rompen el render bajo demanda.

import { NAO_CAMERAS } from '../robot/cameras';
import type { NaoCameras } from '../sim/naoCameras';
import type { World } from '../sim/world';

const STORAGE_KEY = 'nao.debugCameras';

export function attachCameraViews(host: HTMLElement, world: World, cameras: NaoCameras): void {
  let on = false;
  try {
    on = localStorage.getItem(STORAGE_KEY) === '1';
  } catch {
    /* sin almacenamiento */
  }

  const dock = document.createElement('div');
  dock.id = 'camera-views';
  const images = NAO_CAMERAS.map(({ index, name, id }) => {
    const view = document.createElement('figure');
    view.className = 'cam-view';
    const image = document.createElement('div');
    image.className = 'cam-image';
    const caption = document.createElement('figcaption');
    caption.textContent = `${name} · ${id} (${index})`;
    view.append(image, caption);
    dock.append(view);
    return image;
  });
  document.body.append(dock);

  world.onAfterRender(() => {
    if (!on) return;
    const canvas = world.renderer.domElement.getBoundingClientRect();
    images.forEach((image, i) => {
      const r = image.getBoundingClientRect();
      if (r.width < 1 || r.height < 1) return;
      cameras.renderTo(world.renderer, world.scene, i, { x: r.left - canvas.left, y: r.top - canvas.top, width: r.width, height: r.height });
    });
  });

  const row = document.createElement('div');
  row.className = 'sound-control';
  const label = document.createElement('span');
  label.textContent = 'Depuración';
  const toggle = document.createElement('button');
  toggle.type = 'button';
  toggle.className = 'chip';
  const apply = () => {
    toggle.textContent = on ? 'Cámaras: sí' : 'Cámaras: no';
    dock.hidden = !on;
    world.invalidate();
  };
  toggle.addEventListener('click', () => {
    on = !on;
    apply();
    try {
      localStorage.setItem(STORAGE_KEY, on ? '1' : '0');
    } catch {
      /* modo privado */
    }
  });
  row.append(label, toggle);
  host.append(row);
  apply();
  // Los recuadros cambian de sitio al abrir/cerrar el panel (el título ocupa la esquina)
  new MutationObserver(() => world.invalidate()).observe(document.body, { attributes: true, attributeFilter: ['class'] });
}
