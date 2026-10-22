// Ajustes (modal grande, estilo juego): tu perfil (foto, nombre, cerrar sesión) y tu NAO (nombre e instrucciones
// propias que se sumarán al prompt base cuando llegue la IA). Sin botones de guardar: cada cambio se guarda solo 3 s
// después de la última edición (PATCH /api/me) y aparece un "✓ Guardado" discreto. Se cierra con la ✕, con
// "Cerrar" o con Esc (no al hacer clic afuera, para no perder lo escrito); al cerrar se guarda lo pendiente.

import { ApiError, type User, type UserPatch, logout, updateMe } from '../net/api';
import { ICONS } from './icons';

const SAVE_DELAY = 3000;
const RETRY_DELAY = 5000;
const AVATAR_SIZE = 256;
const ROLE: Record<User['role'], string> = { admin: 'Administrador', teacher: 'Docente', student: 'Estudiante' };

export function attachSettings(button: HTMLButtonElement, user: User, { onChange }: { onChange(user: User): void }): void {
  const modal = document.createElement('div');
  modal.className = 'settings-modal';
  modal.hidden = true;
  modal.innerHTML = `
    <div class="st-card" role="dialog" aria-modal="true" aria-labelledby="st-title">
      <header class="st-head">
        <h2 id="st-title">${ICONS.settings}<span>Ajustes</span></h2>
        <span class="st-saved" aria-live="polite"></span>
        <button type="button" class="st-x" title="Cerrar" aria-label="Cerrar">${ICONS.close}</button>
      </header>
      <div class="st-body">
        <section class="st-profile">
          <h3>Tu perfil</h3>
          <button type="button" class="st-avatar" title="Cambiar foto" aria-label="Cambiar foto">
            <span class="st-avatar-img"></span><span class="st-avatar-edit">${ICONS.camera}</span>
          </button>
          <input type="file" accept="image/*" class="st-file" hidden />
          <button type="button" class="st-link st-remove" hidden>Quitar foto</button>
          <label class="st-field">Tu nombre<input name="displayName" maxlength="40" autocomplete="name" /></label>
          <p class="st-meta"></p>
          <button type="button" class="st-logout">${ICONS.logout}<span>Cerrar sesión</span></button>
        </section>
        <section class="st-nao">
          <h3>Tu NAO</h3>
          <label class="st-field">Nombre del NAO<input name="robotName" maxlength="24" placeholder="NAO" /></label>
          <label class="st-field st-prompt">Personalidad e instrucciones
            <textarea name="prompt" maxlength="2000" rows="9"
              placeholder="Ej.: Eres curioso y paciente. Me ayudas a estudiar física. Llámame por mi nombre y hazme preguntas para repasar."></textarea>
          </label>
          <p class="st-help"><span>Se suma a las instrucciones base del NAO cuando converse con la IA.</span><span class="st-count"></span></p>
        </section>
      </div>
      <footer class="st-foot"><button type="button" class="st-close">Cerrar</button></footer>
    </div>`;
  document.body.append(modal);

  const $ = <T extends HTMLElement>(sel: string) => modal.querySelector<T>(sel)!;
  const nameInput = $<HTMLInputElement>('[name=displayName]');
  const robotInput = $<HTMLInputElement>('[name=robotName]');
  const promptInput = $<HTMLTextAreaElement>('[name=prompt]');
  const count = $('.st-count');
  const saved = $('.st-saved');
  const avatarImg = $('.st-avatar-img');
  const file = $<HTMLInputElement>('.st-file');
  const remove = $<HTMLButtonElement>('.st-remove');

  // ─── Guardado automático ────────────────────────────────────────────────────
  let pending: UserPatch = {};
  let timer = 0;
  let saving: Promise<void> | null = null;
  let fadeTimer = 0;

  const showSaved = (state: 'saving' | 'saved' | 'error', message = '') => {
    clearTimeout(fadeTimer);
    saved.dataset.state = state;
    saved.innerHTML = state === 'saving' ? 'Guardando…' : state === 'saved' ? `${ICONS.check}<span>Guardado</span>` : message;
    if (state === 'saved') fadeTimer = window.setTimeout(() => (saved.dataset.state = 'idle'), 2500);
  };

  const flush = async (): Promise<void> => {
    clearTimeout(timer);
    if (saving) await saving;
    const patch = pending;
    if (!Object.keys(patch).length) return;
    pending = {};
    showSaved('saving');
    saving = updateMe(patch)
      .then((u) => {
        user = u;
        onChange(u);
        showSaved('saved');
      })
      .catch((e) => {
        pending = { ...patch, ...pending }; // se reintenta con lo nuevo encima
        showSaved('error', e instanceof ApiError ? e.message : 'Sin conexión: se reintentará');
        if (!(e instanceof ApiError && e.status === 400)) timer = window.setTimeout(() => void flush(), RETRY_DELAY);
      })
      .finally(() => (saving = null));
    await saving;
  };

  const queue = (patch: UserPatch) => {
    pending = { ...pending, ...patch };
    clearTimeout(timer);
    timer = window.setTimeout(() => void flush(), SAVE_DELAY);
  };

  // ─── Campos ─────────────────────────────────────────────────────────────────
  const paintAvatar = (url: string) => {
    if (url) {
      const img = document.createElement('img');
      img.src = url;
      img.alt = '';
      avatarImg.replaceChildren(img);
    } else avatarImg.textContent = (nameInput.value.trim() || user.displayName).charAt(0).toUpperCase();
    remove.hidden = !url;
  };

  const fill = () => {
    nameInput.value = user.displayName;
    robotInput.value = user.robotName === 'NAO' ? '' : user.robotName;
    promptInput.value = user.prompt;
    count.textContent = `${promptInput.value.length} / 2000`;
    $('.st-meta').textContent = `@${user.username} · ${ROLE[user.role]}`;
    paintAvatar(user.avatarUrl);
  };

  nameInput.addEventListener('input', () => {
    const name = nameInput.value.trim();
    if (!avatarImg.querySelector('img')) paintAvatar('');
    if (!name) return showSaved('error', 'Escribe tu nombre');
    queue({ displayName: name });
  });
  robotInput.addEventListener('input', () => queue({ robotName: robotInput.value.trim() }));
  promptInput.addEventListener('input', () => {
    count.textContent = `${promptInput.value.length} / 2000`;
    queue({ prompt: promptInput.value });
  });

  // Foto: se recorta al centro en cuadrado y se reduce a 256×256 JPEG (~20 KB) antes de subirla
  $('.st-avatar').addEventListener('click', () => file.click());
  file.addEventListener('change', async () => {
    const f = file.files?.[0];
    file.value = '';
    if (!f) return;
    try {
      const bitmap = await createImageBitmap(f);
      const side = Math.min(bitmap.width, bitmap.height);
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = AVATAR_SIZE;
      canvas.getContext('2d')!.drawImage(bitmap, (bitmap.width - side) / 2, (bitmap.height - side) / 2, side, side, 0, 0, AVATAR_SIZE, AVATAR_SIZE);
      const url = canvas.toDataURL('image/jpeg', 0.85);
      paintAvatar(url);
      queue({ avatar: url });
    } catch {
      showSaved('error', 'No se pudo leer esa imagen');
    }
  });
  remove.addEventListener('click', () => {
    paintAvatar('');
    queue({ avatar: '' });
  });

  // ─── Abrir y cerrar ─────────────────────────────────────────────────────────
  const close = () => {
    if (modal.hidden) return;
    modal.hidden = true;
    void flush(); // lo pendiente se guarda al cerrar
    button.focus();
  };
  button.addEventListener('click', () => {
    fill();
    saved.dataset.state = 'idle';
    modal.hidden = false;
    nameInput.focus();
  });
  $('.st-x').addEventListener('click', close);
  $('.st-close').addEventListener('click', close);
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !modal.hidden) {
      e.stopPropagation();
      close();
    }
  });
  $('.st-logout').addEventListener('click', async () => {
    await flush();
    await logout().catch(() => undefined);
    location.reload();
  });
}
