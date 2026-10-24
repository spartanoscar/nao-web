// Pestaña "Rostros" del modal de ajustes: a quién reconoce tu NAO. No se registra a nadie desde aquí: el NAO conoce gente
// conversando (pregunta el nombre y si puede recordar su cara; con un sí usa ALFaceDetection.learnFace, ai/skills.ts).
// Aquí se ve lo que ve el teléfono, la lista con la constancia de cada autorización (Ley 1581: sus palabras y la fecha)
// y se puede borrar a cualquiera (forgetPerson).

import type { FaceWatcher } from '../ai/faces';

interface FacesPanel {
  element: HTMLElement;
  show(): void;
  hide(): void;
}

interface Person {
  name: string;
  consentAt: string;
  consentNote: string;
  embeddings: unknown[];
}

export function createFacesPanel(watcher: FaceWatcher): FacesPanel {
  const element = document.createElement('div');
  element.className = 'fc';
  element.innerHTML = `
    <section class="fc-side">
      <h3>Personas que reconoce</h3>
      <ul class="fc-list"></ul>
      <p class="fc-empty">Todavía nadie.</p>
    </section>
    <section class="fc-main">
      <h3>Cómo conoce gente</h3>
      <div class="fc-preview"><canvas width="320" height="240"></canvas>
        <p class="fc-hint">Conecta el móvil (QR) y activa su cámara, apuntando a la cara.</p></div>
      <p class="fc-how">Apunta la cámara del teléfono a alguien que tu NAO no conoce: le preguntará su nombre y si puede
        recordar su cara. Solo si dice que sí la aprende, y guarda sus palabras como constancia. Nunca guarda la foto, solo
        una huella numérica del rostro. Para olvidar a alguien, bórralo aquí o pídeselo al NAO.</p>
    </section>`;

  const $ = <T extends HTMLElement>(sel: string) => element.querySelector<T>(sel)!;
  const list = $('.fc-list');
  const empty = $('.fc-empty');
  const canvas = $<HTMLCanvasElement>('.fc-preview canvas');
  const hint = $('.fc-hint');
  let timer = 0;

  const refresh = async () => {
    let people: Person[] = [];
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
        const info = document.createElement('div');
        const name = document.createElement('b');
        name.textContent = p.name;
        const note = document.createElement('small');
        const when = new Date(p.consentAt).toLocaleDateString('es-CO', { day: 'numeric', month: 'short', year: 'numeric' });
        note.textContent = p.consentNote ? `«${p.consentNote}» · ${when}` : when;
        info.append(name, note);
        const del = document.createElement('button');
        del.type = 'button';
        del.className = 'st-link';
        del.textContent = 'Borrar';
        del.addEventListener('click', async () => {
          if (!confirm(`¿Borrar el rostro de ${p.name}? Tu NAO dejará de reconocerle.`)) return;
          await watcher.forget(p.name);
          await refresh();
        });
        li.append(info, del);
        return li;
      }),
    );
  };

  // Vista previa de lo que llega del teléfono, con las caras que ve el detector (verde = la reconoce)
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
    g.font = 'bold 12px system-ui, sans-serif';
    for (const face of watcher.faces()) {
      const color = face.name ? '#4ade80' : '#f5a524';
      const [bx, by] = [x + face.box.x * k, y + face.box.y * k];
      g.strokeStyle = color;
      g.strokeRect(bx, by, face.box.width * k, face.box.height * k);
      g.fillStyle = color;
      g.fillText(face.name ?? 'no la conoce', bx, Math.max(by - 4, 12));
    }
  };

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
