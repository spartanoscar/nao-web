// Ajustes (modal grande, estilo juego): tu perfil (foto, nombre, cerrar sesión), tu NAO (nombre, colores e
// instrucciones propias que se suman al prompt base), la biblioteca, los rostros y en qué cuarto del mundo aparecer. Sin botones de guardar: cada cambio se guarda solo 3 s
// después de la última edición (PATCH /api/me) y aparece un "✓ Guardado" discreto. Se cierra con la ✕, con
// "Cerrar" o con Esc (no al hacer clic afuera, para no perder lo escrito); al cerrar se guarda lo pendiente.

import { ApiError, type User, type UserPatch, logout, updateMe } from '../net/api';
import { ICONS } from './icons';
import { createLibrary } from './library';
import { createFacesPanel } from './faces';
import type { FaceWatcher } from '../ai/faces';

const SAVE_DELAY = 3000;
const RETRY_DELAY = 5000;
const AVATAR_SIZE = 256;
/** Colores de fábrica (textureNAO.png "Colored part" y los ojos por defecto de ALLeds) para mostrar en el selector */
const FACTORY = { shellColor: '#0826e0', eyeColor: '#d1d1ff' } as const;
/** Variantes de color de fábrica del NAO V4 ("" = el azul original). APPROX: Aldebaran no publica los códigos. */
const SHELL_PRESETS: [string, string][] = [['', 'Azul'], ['#cc1f2a', 'Rojo'], ['#f0701a', 'Naranja'], ['#262628', 'Negro']];
const ROLE: Record<User['role'], string> = { admin: 'Administrador', teacher: 'Docente', student: 'Estudiante' };

export function attachSettings(
  button: HTMLButtonElement,
  user: User,
  {
    onChange,
    onSpent,
    faces,
    rooms,
    onSpawn,
  }: {
    onChange(user: User): void;
    onSpent(): void;
    faces: FaceWatcher;
    /** Cuartos donde se puede aparecer (sim/rooms.ts) */
    rooms: { id: string; label: string }[];
    onSpawn(id: string): void;
  },
): void {
  const modal = document.createElement('div');
  modal.className = 'settings-modal';
  modal.hidden = true;
  modal.innerHTML = `
    <div class="st-card" role="dialog" aria-modal="true" aria-labelledby="st-title">
      <header class="st-head">
        <h2 id="st-title">${ICONS.settings}<span>Ajustes</span></h2>
        <nav class="st-tabs" role="tablist">
          <button type="button" role="tab" data-tab="general" aria-selected="true">General</button>
          <button type="button" role="tab" data-tab="library" aria-selected="false">Biblioteca</button>
          <button type="button" role="tab" data-tab="faces" aria-selected="false">Rostros</button>
          <button type="button" role="tab" data-tab="world" aria-selected="false">Mundo</button>
        </nav>
        <span class="st-saved" aria-live="polite"></span>
        <button type="button" class="st-x" title="Cerrar" aria-label="Cerrar">${ICONS.close}</button>
      </header>
      <div class="st-body" data-panel="general">
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
          <div class="st-colors">
            <div class="st-color" data-field="shellColor"><span>Carcasa</span>
              <label class="st-swatch" title="Elegir color"><input type="color" /></label>
              <span class="st-presets">${SHELL_PRESETS.map(([hex, name]) => `<button type="button" class="st-preset" data-hex="${hex}" title="${name}" aria-label="Carcasa ${name}" style="--swatch: ${hex || FACTORY.shellColor}"></button>`).join('')}</span></div>
            <div class="st-color" data-field="eyeColor"><span>Ojos</span>
              <label class="st-swatch" title="Elegir color"><input type="color" /></label>
              <button type="button" class="st-link" hidden>Original</button></div>
          </div>
          <label class="st-field st-prompt">Personalidad e instrucciones
            <textarea name="prompt" maxlength="2000" rows="9"
              placeholder="Ej.: Eres curioso y paciente. Me ayudas a estudiar física. Llámame por mi nombre y hazme preguntas para repasar."></textarea>
          </label>
          <p class="st-help"><span>Se suma a las instrucciones base del NAO cuando converse con la IA.</span><span class="st-count"></span></p>
        </section>
      </div>
      <div class="st-library" data-panel="library" hidden></div>
      <div class="st-faces" data-panel="faces" hidden></div>
      <div class="st-world" data-panel="world" hidden>
        <h3>Aparecer en</h3>
        <p class="st-help"><span>Tu NAO aparece en ese cuarto agachado y con los motores apagados, como recién encendido.</span></p>
        <div class="st-rooms">${rooms.map((r) => `<button type="button" class="st-room" data-room="${r.id}">${r.label}</button>`).join('')}</div>
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
    for (const row of colorRows) paintColor(row, user[row.field]);
  };

  // Apariencia del NAO (paleta libre): se ve al instante y se guarda con el resto
  const colorRows = [...modal.querySelectorAll<HTMLElement>('.st-color')].map((el) => ({
    field: el.dataset.field as keyof typeof FACTORY,
    input: el.querySelector<HTMLInputElement>('input')!,
    swatch: el.querySelector<HTMLElement>('.st-swatch')!,
    /** Volver al de fábrica (la carcasa lo hace con su círculo azul) */
    reset: el.querySelector<HTMLButtonElement>('.st-link'),
  }));
  const presets = [...modal.querySelectorAll<HTMLButtonElement>('.st-preset')];
  const paintColor = (row: (typeof colorRows)[number], value: string) => {
    row.input.value = value || FACTORY[row.field];
    row.swatch.style.setProperty('--swatch', row.input.value);
    if (row.reset) row.reset.hidden = !value;
    if (row.field === 'shellColor') for (const p of presets) p.setAttribute('aria-pressed', String(p.dataset.hex === value));
  };
  for (const row of colorRows) {
    const pick = (value: string) => {
      paintColor(row, value);
      onChange({ ...user, [row.field]: value }); // vista previa inmediata (HUD y NAO)
      user = { ...user, [row.field]: value };
      queue({ [row.field]: value });
    };
    row.input.addEventListener('input', () => pick(row.input.value));
    row.reset?.addEventListener('click', () => pick(''));
    if (row.field === 'shellColor') for (const p of presets) p.addEventListener('click', () => pick(p.dataset.hex!));
  }

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

  // ─── Pestañas ───────────────────────────────────────────────────────────────
  const library = createLibrary({ onSpent });
  $('.st-library').append(library.element);
  const facesPanel = createFacesPanel(faces);
  $('.st-faces').append(facesPanel.element);
  const tabs = [...modal.querySelectorAll<HTMLButtonElement>('[role=tab]')];
  const selectTab = (name: string) => {
    for (const t of tabs) t.setAttribute('aria-selected', String(t.dataset.tab === name));
    for (const p of modal.querySelectorAll<HTMLElement>('[data-panel]')) p.hidden = p.dataset.panel !== name;
    modal.querySelector('.st-card')!.classList.toggle('wide', name === 'library');
    if (name === 'library') library.show();
    if (name === 'faces') facesPanel.show();
    else facesPanel.hide();
  };
  for (const t of tabs) t.addEventListener('click', () => selectTab(t.dataset.tab!));

  // ─── Mundo ──────────────────────────────────────────────────────────────────
  for (const b of modal.querySelectorAll<HTMLButtonElement>('.st-room')) {
    b.addEventListener('click', () => {
      onSpawn(b.dataset.room!);
      close();
    });
  }

  // ─── Abrir y cerrar ─────────────────────────────────────────────────────────
  const close = () => {
    if (modal.hidden) return;
    modal.hidden = true;
    facesPanel.hide();
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
