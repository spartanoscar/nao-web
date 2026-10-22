// Pantalla limpia: el panel (estado, posturas, LEDs, articulaciones, colores…) queda oculto y se abre
// con una tecla. Con teclado: º/` o F2 (Esc cierra). Sin teclado (táctil): un botón pequeño "⋯".

const KEYS = new Set(['Backquote', 'IntlBackslash', 'F2']); // IntlBackslash: la tecla º de teclados Mac ISO
const HINT_KEY = 'nao.panelHintSeen';

const isEditable = (t: EventTarget | null) =>
  t instanceof HTMLElement && (t.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName));

export function attachHiddenPanel(): void {
  const body = document.body;
  const toggle = (show = !body.classList.contains('panel-visible')) => body.classList.toggle('panel-visible', show);

  window.addEventListener('keydown', (e) => {
    if (isEditable(e.target)) return;
    if (KEYS.has(e.code) || e.key === 'F2') {
      e.preventDefault();
      toggle();
      dismissHint();
    } else if (e.key === 'Escape') toggle(false);
  });
  document.getElementById('panel-toggle')?.addEventListener('click', () => toggle());

  // Aviso de la tecla, una sola vez por navegador
  let seen = false;
  try {
    seen = localStorage.getItem(HINT_KEY) === '1';
  } catch {
    /* sin almacenamiento */
  }
  const hint = document.createElement('div');
  hint.id = 'panel-hint';
  hint.innerHTML = 'Pulsa <kbd>º</kbd> o <kbd>F2</kbd> para abrir el panel · <kbd>W</kbd><kbd>A</kbd><kbd>S</kbd><kbd>D</kbd> para caminar';
  const dismissHint = () => {
    hint.classList.add('gone');
    try {
      localStorage.setItem(HINT_KEY, '1');
    } catch {
      /* sin almacenamiento */
    }
  };
  if (!seen) {
    body.append(hint);
    setTimeout(dismissHint, 9000);
  }
}
