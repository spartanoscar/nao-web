// Chat con el NAO (estilo juego): Enter abre la barra de abajo, Enter envía, Esc cierra. Para hablarle sin
// teléfono (lo escrito siempre le llega al NAO; la voz solo si lo llaman por su nombre).

import { ICONS } from './icons';

export function attachChat(robotName: () => string, onSend: (text: string) => void): void {
  const root = document.createElement('form');
  root.id = 'chat';
  root.innerHTML = `
    <button type="button" class="chat-open" title="Hablar con el NAO (Enter)">${ICONS.chat}<span>Enter para hablar</span></button>
    <div class="chat-bar" hidden>
      <input name="text" maxlength="600" autocomplete="off" spellcheck="true" />
      <button type="submit" class="chat-send" title="Enviar (Enter)" aria-label="Enviar">${ICONS.send}</button>
    </div>`;
  document.body.append(root);
  const open = root.querySelector<HTMLButtonElement>('.chat-open')!;
  const bar = root.querySelector<HTMLElement>('.chat-bar')!;
  const input = root.querySelector<HTMLInputElement>('input')!;

  const show = () => {
    input.placeholder = `Escríbele a ${robotName()}…`;
    bar.hidden = false;
    open.hidden = true;
    document.body.classList.add('chat-open');
    input.focus();
  };
  const hide = () => {
    bar.hidden = true;
    open.hidden = false;
    document.body.classList.remove('chat-open');
    input.blur();
  };
  open.addEventListener('click', show);
  root.addEventListener('submit', (e) => {
    e.preventDefault();
    const text = input.value.trim();
    input.value = '';
    if (text) onSend(text);
    hide();
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      hide();
    }
  });
  input.addEventListener('blur', () => !input.value.trim() && hide());
  window.addEventListener('keydown', (e) => {
    const t = e.target as HTMLElement | null;
    const editing = t && (t.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName));
    if (e.key !== 'Enter' || editing || e.ctrlKey || e.metaKey || e.altKey || !bar.hidden) return;
    if (document.querySelector('.settings-modal:not([hidden]), .phone-modal:not([hidden])')) return;
    e.preventDefault();
    show();
  });
}
