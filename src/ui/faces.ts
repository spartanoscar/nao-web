// Pestaña "Rostros" del modal de ajustes: las personas que el NAO reconoce por la cámara del teléfono (ai/faces.ts).
// Registrar exige la autorización de la persona (Ley 1581 de 2012: datos biométricos = sensibles): la casilla está
// desmarcada y sin ella no se envía nada. Se guarda solo la huella numérica (3 muestras de 128 números), nunca la foto;
// borrar quita todas sus muestras.

import type { FaceWatcher } from '../ai/faces';
import { ICONS } from './icons';

/** Muestras por persona: varias tomas cubren pequeños cambios de ángulo y luz */
const SAMPLES = 3;

interface FacesPanel {
  element: HTMLElement;
  show(): void;
  hide(): void;
}

export function createFacesPanel(watcher: FaceWatcher): FacesPanel {
  const element = document.createElement('div');
  element.className = 'fc';
  element.innerHTML = `
    <section class="fc-side">
      <h3>Personas que reconoce</h3>
      <ul class="fc-list"></ul>
      <p class="fc-empty">Todavía nadie. Registra a alguien a la derecha.</p>
    </section>
    <section class="fc-main">
      <h3>Registrar un rostro</h3>
      <div class="fc-preview"><canvas width="320" height="240"></canvas>
        <p class="fc-hint">Conecta el móvil (QR) y activa su cámara, apuntando a la cara.</p></div>
      <label class="st-field">Nombre<input name="faceName" maxlength="40" placeholder="Ej.: Oscar" autocomplete="off" /></label>
      <label class="fc-consent"><input type="checkbox" />
        <span><b class="fc-who">Esta persona</b> autoriza que su NAO reconozca su rostro. Se guarda solo una huella
        numérica (nunca la foto), sirve únicamente para saludarla y llamarla por su nombre, y puede borrarse cuando
        quiera (Ley 1581 de 2012).</span></label>
      <button type="button" class="fc-add">${ICONS.camera}<span>Registrar rostro</span></button>
      <p class="fc-status" aria-live="polite"></p>
    </section>`;

  const $ = <T extends HTMLElement>(sel: string) => element.querySelector<T>(sel)!;
  const list = $('.fc-list');
  const empty = $('.fc-empty');
  const name = $<HTMLInputElement>('[name=faceName]');
  const consent = $<HTMLInputElement>('.fc-consent input');
  const who = $('.fc-who');
  const add = $<HTMLButtonElement>('.fc-add');
  const status = $('.fc-status');
  const canvas = $<HTMLCanvasElement>('.fc-preview canvas');
  const hint = $('.fc-hint');
  let busy = false;
  let timer = 0;

  const say = (text: string, kind: '' | 'ok' | 'error' = '') => {
    status.textContent = text;
    status.dataset.kind = kind;
  };
  const paintButton = () => {
    who.textContent = name.value.trim() || 'Esta persona';
    add.disabled = busy || !name.value.trim() || !consent.checked;
  };
  name.addEventListener('input', paintButton);
  consent.addEventListener('change', paintButton);

  const refresh = async () => {
    let people: { name: string; embeddings: unknown[] }[] = [];
    try {
      const res = await fetch('/api/faces', { credentials: 'same-origin' });
      if (res.ok) people = (await res.json()).people ?? [];
    } catch {
      /* sin red */
    }
    empty.hidden = people.length > 0;
    list.replaceChildren(
      ...people.map((p) => {
        const li = document.createElement('li');
        const label = document.createElement('span');
        label.textContent = p.name;
        const del = document.createElement('button');
        del.type = 'button';
        del.className = 'st-link';
        del.textContent = 'Borrar';
        del.addEventListener('click', async () => {
          if (!confirm(`¿Borrar el rostro de ${p.name}? El NAO dejará de reconocerle.`)) return;
          await fetch(`/api/faces/${encodeURIComponent(p.name)}`, { method: 'DELETE', credentials: 'same-origin' });
          await watcher.loadPeople();
          await refresh();
        });
        li.append(label, del);
        return li;
      }),
    );
  };

  // Vista previa de lo que llega del teléfono, con las caras que ve el detector
  const paintPreview = () => {
    const g = canvas.getContext('2d')!;
    hint.hidden = watcher.live;
    if (!watcher.live) {
      g.clearRect(0, 0, canvas.width, canvas.height);
      return;
    }
    const f = watcher.frame;
    const k = Math.min(canvas.width / f.width, canvas.height / f.height);
    const [x, y] = [(canvas.width - f.width * k) / 2, (canvas.height - f.height * k) / 2];
    g.fillStyle = '#0c0f14';
    g.fillRect(0, 0, canvas.width, canvas.height);
    g.drawImage(f, x, y, f.width * k, f.height * k);
    g.lineWidth = 2;
    for (const face of watcher.faces()) {
      g.strokeStyle = face.name ? '#4ade80' : '#f5a524';
      g.strokeRect(x + face.box.x * k, y + face.box.y * k, face.box.width * k, face.box.height * k);
    }
  };

  add.addEventListener('click', async () => {
    if (busy) return;
    const person = name.value.trim();
    if (!watcher.live) return say('Conecta el móvil y activa su cámara, apuntando a la cara.', 'error');
    busy = true;
    paintButton();
    try {
      const embeddings: number[][] = [];
      for (let i = 0; i < SAMPLES; i++) {
        say(`Mira al teléfono… ${i + 1} de ${SAMPLES}`);
        const { descriptor, faces } = await watcher.nextDescriptor();
        if (!descriptor) {
          say(faces > 1 ? 'Debe verse una sola cara.' : 'No veo una cara clara. Acércate un poco a la cámara.', 'error');
          return;
        }
        embeddings.push(Array.from(descriptor));
        await new Promise((r) => setTimeout(r, 600)); // otra toma, un poco distinta
      }
      const res = await fetch('/api/faces', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: person, consent: true, embeddings }),
      });
      if (!res.ok) {
        say((await res.json().catch(() => ({}))).error ?? 'No se pudo guardar.', 'error');
        return;
      }
      say(`✓ ${person} registrado. Tu NAO ya le reconoce.`, 'ok');
      name.value = '';
      consent.checked = false;
      await watcher.loadPeople();
      await refresh();
    } finally {
      busy = false;
      paintButton();
    }
  });

  paintButton();
  return {
    element,
    show() {
      void refresh();
      clearInterval(timer);
      timer = window.setInterval(paintPreview, 250);
      paintPreview();
    },
    hide() {
      clearInterval(timer);
    },
  };
}
