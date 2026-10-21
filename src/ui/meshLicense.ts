// Aceptación de la licencia de las mallas oficiales antes de descargarlas (condición de Aldebaran:
// "can be redistributed, but in their installer form", es decir, con un clic de aceptación) y
// atribución visible mientras se muestran. La aceptación se recuerda en este navegador.

import { MESHES_ATTRIBUTION, MESHES_LICENSE_URL } from '../sim/officialMeshes';

const STORAGE_KEY = 'nao.meshLicenseAccepted';

const remembered = (): boolean => {
  try {
    return localStorage.getItem(STORAGE_KEY) === '1';
  } catch {
    return false;
  }
};
const remember = () => {
  try {
    localStorage.setItem(STORAGE_KEY, '1');
  } catch {
    /* modo privado: se volverá a preguntar */
  }
};

export interface MeshLicenseHooks {
  /** Descarga y muestra las mallas; reporta el progreso */
  load(onProgress: (loaded: number, total: number) => void): Promise<void>;
  /** true = formas de colisión, false = modelo oficial */
  showPrimitives(show: boolean): void;
}

export function attachMeshLicense({ load, showPrimitives }: MeshLicenseHooks): void {
  const card = document.createElement('div');
  card.id = 'mesh-license';
  card.setAttribute('role', 'dialog');
  card.setAttribute('aria-label', 'Licencia del modelo 3D oficial');

  const credit = document.createElement('div');
  credit.id = 'mesh-credit';
  credit.hidden = true;

  const start = async () => {
    card.innerHTML = '<p class="ml-progress">Cargando modelo oficial del NAO…</p>';
    const progress = card.querySelector('.ml-progress')!;
    try {
      await load((n, total) => (progress.textContent = `Cargando modelo oficial del NAO… ${n}/${total}`));
      card.remove();
      showCredit();
    } catch (e) {
      console.warn('Modelo oficial no disponible:', e);
      card.innerHTML = '<p>No se pudo cargar el modelo oficial; se muestra el modelo simplificado.</p>';
      setTimeout(() => card.remove(), 5000);
    }
  };

  const showCredit = () => {
    let primitives = false;
    credit.innerHTML = `<a href="${MESHES_LICENSE_URL}" target="_blank" rel="noopener">${MESHES_ATTRIBUTION}</a>`;
    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.textContent = 'ver colisión';
    toggle.title = 'Alterna entre el modelo oficial y las formas que usa la física para chocar';
    toggle.addEventListener('click', () => {
      primitives = !primitives;
      showPrimitives(primitives);
      toggle.textContent = primitives ? 'ver modelo oficial' : 'ver colisión';
    });
    credit.append(' · ', toggle);
    credit.hidden = false;
  };

  document.body.append(credit);
  if (remembered()) {
    document.body.append(card);
    void start();
    return;
  }

  card.innerHTML = `
    <h2>Ver al NAO con su modelo 3D oficial</h2>
    <p>Las mallas 3D del NAO son de <strong>Aldebaran / SoftBank Robotics</strong> y se distribuyen bajo
      licencia <strong>CC BY-NC-ND 4.0</strong>: uso no comercial y sin modificaciones. Para descargarlas
      tienes que aceptar la licencia.</p>
    <p class="ml-actions">
      <button type="button" class="ml-accept">Acepto la licencia</button>
      <button type="button" class="ml-later">Ahora no</button>
      <a href="${MESHES_LICENSE_URL}" target="_blank" rel="noopener">Leer la licencia</a>
    </p>`;
  card.querySelector('.ml-accept')!.addEventListener('click', () => {
    remember();
    void start();
  });
  card.querySelector('.ml-later')!.addEventListener('click', () => card.remove());
  document.body.append(card);
}
