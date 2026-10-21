// Selector del color de la carcasa (variantes de color del NAO). Se recuerda en este navegador.

import type { ShellColor } from '../sim/officialMeshes';

const STORAGE_KEY = 'nao.shellColor';
/** Color de muestra del azul original (textureNAO.png, "Colored part") */
const ORIGINAL_BLUE = '#0826e0';

export function rememberedShellColor(colors: readonly ShellColor[]): ShellColor {
  let id: string | null = null;
  try {
    id = localStorage.getItem(STORAGE_KEY);
  } catch {
    /* sin almacenamiento: azul */
  }
  return colors.find((c) => c.id === id) ?? colors[0];
}

export function createShellColorPicker(
  host: HTMLElement,
  colors: readonly ShellColor[],
  selected: ShellColor,
  onPick: (color: ShellColor) => void,
): void {
  const section = document.createElement('div');
  section.className = 'shell-colors';
  const label = document.createElement('span');
  label.textContent = 'Carcasa';
  section.append(label);

  const buttons = colors.map((color) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'swatch';
    b.title = color.label;
    b.setAttribute('aria-label', `Carcasa ${color.label}`);
    b.style.setProperty('--swatch', color.hex === null ? ORIGINAL_BLUE : `#${color.hex.toString(16).padStart(6, '0')}`);
    b.addEventListener('click', () => {
      for (const other of buttons) other.setAttribute('aria-pressed', String(other === b));
      try {
        localStorage.setItem(STORAGE_KEY, color.id);
      } catch {
        /* modo privado */
      }
      onPick(color);
    });
    b.setAttribute('aria-pressed', String(color === selected));
    return b;
  });
  section.append(...buttons);
  host.append(section);
}
