// Guía de las teclas abajo a la izquierda (Oscar, 2026-10-24): las flechas mueven el cuerpo y W A S D la cabeza
// (ui/keyboard.ts). Se va apenas se usa el teclado y vuelve cuando el NAO lleva IDLE_S quieto sin que nadie lo mueva.
// No sale en pantallas táctiles sin ratón (iPad, tablets): ahí no hay teclado.

import { isAppleMobile } from './device';

const IDLE_S = 10;

export function attachControlsHint(status: { lastUse(): number; holding(): boolean; walking(): boolean }): { hide(): void } {
  const touchOnly = isAppleMobile() || matchMedia('(pointer: coarse) and (hover: none)').matches;
  const el = document.createElement('div');
  el.className = 'controls-hint';
  el.setAttribute('aria-hidden', 'true');
  const key = (label: string, cls = '') => `<span class="kh-key ${cls}">${label}</span>`;
  el.innerHTML = `
    <div class="kh-group">
      <div class="kh-keys">
        <span class="kh-gap"></span>${key('↑')}<span class="kh-gap"></span>
        ${key('←')}${key('↓')}${key('→')}
      </div>
      <span class="kh-label">Cuerpo</span>
    </div>
    <div class="kh-group">
      <div class="kh-keys">
        <span class="kh-gap"></span>${key('W')}<span class="kh-gap"></span>
        ${key('A')}${key('S')}${key('D')}
      </div>
      <span class="kh-label">Cabeza</span>
    </div>`;
  if (!touchOnly) document.body.append(el);

  let shown = !touchOnly;
  el.classList.toggle('show', shown);
  const set = (on: boolean) => {
    if (touchOnly || on === shown) return;
    shown = on;
    el.classList.toggle('show', on);
  };
  setInterval(() => {
    const idle = !status.holding() && !status.walking() && performance.now() - status.lastUse() > IDLE_S * 1000;
    if (idle) set(true);
  }, 500);
  return { hide: () => set(false) };
}
