// Licencia de las mallas oficiales (CC BY-NC-ND 4.0 + condición de Aldebaran: "can be redistributed, but in
// their installer form", es decir, con un clic de aceptación). La aceptación es obligatoria para entrar al mundo
// (pantalla de entrada, ui/boot.ts) y se recuerda en este navegador; la atribución queda visible mientras se ven.

import { MESHES_ATTRIBUTION, MESHES_LICENSE_URL } from '../sim/officialMeshes';

const STORAGE_KEY = 'nao.meshLicenseAccepted';

export { MESHES_LICENSE_URL };

export function licenseAccepted(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) === '1';
  } catch {
    return false;
  }
}

export function acceptLicense(): void {
  try {
    localStorage.setItem(STORAGE_KEY, '1');
  } catch {
    /* modo privado: se volverá a preguntar */
  }
}

/** Atribución abajo a la derecha mientras se ve el modelo */
export function showMeshCredit(): void {
  const credit = document.createElement('div');
  credit.id = 'mesh-credit';
  credit.innerHTML = `<a href="${MESHES_LICENSE_URL}" target="_blank" rel="noopener">${MESHES_ATTRIBUTION}</a>`;
  document.body.append(credit);
}
