// Biblioteca (pestaña del modal de ajustes): los archivos que la persona le da a su NAO. A la izquierda la lista
// (ícono de PDF, de Excel, miniatura para imágenes, documento para lo demás) con su estado en palabras sencillas
// ("Guardado", "Guardando…", "No se pudo guardar"); a la derecha el visor (imagen, PDF, texto, o "no se puede ver
// aquí" con la descarga). El servidor (server/library.go) lee cada archivo y lo vectoriza en segundo plano, y lo
// cobra de los tokens del día. Las imágenes se reducen aquí antes de subirlas (máx. 1600 px, JPEG).

import {
  ApiError, type LibraryDoc, deleteDocument, documentUrl, listDocuments, thumbUrl, uploadDocument,
} from '../net/api';
import { FILE_ICONS, ICONS } from './icons';

const MAX_BYTES = 4 << 20;
const MAX_DOCS = 30;
const IMAGE_SIDE = 1600;
const THUMB_SIDE = 160;
const POLL_MS = 3000;
const ACCEPT = '.pdf,.docx,.xlsx,.csv,.txt,.md,.jpg,.jpeg,.png,.webp,.gif,.heic,image/*';

/** Un archivo que aún no llega al servidor (subiendo, o rechazado antes de guardarse) */
interface LocalItem {
  key: string;
  title: string;
  size: number;
  error?: string;
}

export interface Library {
  element: HTMLElement;
  /** Se abrió la pestaña: refresca la lista */
  show(): void;
}

export function createLibrary({ onSpent }: { onSpent(): void }): Library {
  const root = document.createElement('div');
  root.className = 'lib';
  root.innerHTML = `
    <aside class="lib-side">
      <label class="lib-drop">
        <input type="file" multiple accept="${ACCEPT}" hidden />
        ${ICONS.upload}
        <b>Subir archivos</b>
        <span>PDF, Word, Excel, imágenes o texto · hasta 4 MB</span>
      </label>
      <p class="lib-quota"></p>
      <ul class="lib-list" aria-label="Tus archivos"></ul>
    </aside>
    <section class="lib-view" aria-live="polite"></section>`;
  const input = root.querySelector<HTMLInputElement>('input[type=file]')!;
  const drop = root.querySelector<HTMLElement>('.lib-drop')!;
  const list = root.querySelector<HTMLElement>('.lib-list')!;
  const quota = root.querySelector<HTMLElement>('.lib-quota')!;
  const view = root.querySelector<HTMLElement>('.lib-view')!;

  let docs: LibraryDoc[] = [];
  let locals: LocalItem[] = [];
  let selected: number | null = null;
  let poll = 0;

  // ─── Lista ──────────────────────────────────────────────────────────────────
  const statusOf = (d: LibraryDoc) =>
    d.status === 'ready'
      ? `<span class="lib-st ok">${ICONS.check}Guardado</span>`
      : d.status === 'error'
        ? '<span class="lib-st bad">No se pudo guardar</span>'
        : '<span class="lib-st busy"><i></i>Guardando…</span>';

  const render = () => {
    quota.textContent = `${docs.length} de ${MAX_DOCS} archivos`;
    const items = [
      ...locals.map((l) => {
        const li = document.createElement('li');
        li.className = `lib-item local${l.error ? ' failed' : ''}`;
        li.innerHTML = `<span class="lib-icon">${FILE_ICONS[kindFromName(l.title)]}</span>
          <div class="lib-meta"><b></b><span>${l.error ? '<span class="lib-st bad"></span>' : '<span class="lib-st busy"><i></i>Subiendo…</span>'}</span></div>`;
        li.querySelector('b')!.textContent = l.title;
        if (l.error) {
          li.querySelector('.lib-st.bad')!.textContent = l.error;
          const x = document.createElement('button');
          x.type = 'button';
          x.className = 'lib-del';
          x.title = 'Quitar';
          x.innerHTML = ICONS.close;
          x.addEventListener('click', () => {
            locals = locals.filter((o) => o !== l);
            render();
          });
          li.append(x);
        }
        return li;
      }),
      ...docs.map((d) => {
        const li = document.createElement('li');
        li.className = `lib-item${d.id === selected ? ' selected' : ''}`;
        li.tabIndex = 0;
        const icon = d.hasThumb ? `<img src="${thumbUrl(d.id)}" alt="" loading="lazy" />` : FILE_ICONS[d.kind];
        li.innerHTML = `<span class="lib-icon${d.hasThumb ? ' thumb' : ''}">${icon}</span>
          <div class="lib-meta"><b></b><span>${formatSize(d.size)} · ${statusOf(d)}</span></div>
          <button type="button" class="lib-del" title="Borrar">${ICONS.trash}</button>`;
        li.querySelector('b')!.textContent = d.title;
        li.title = d.status === 'error' && d.error ? d.error : d.title;
        const open = () => {
          selected = d.id;
          render();
          showDoc(d);
        };
        li.addEventListener('click', (e) => !(e.target as HTMLElement).closest('.lib-del') && open());
        li.addEventListener('keydown', (e) => e.key === 'Enter' && open());
        li.querySelector('.lib-del')!.addEventListener('click', async () => {
          if (!confirm(`¿Borrar "${d.title}" de tu biblioteca?`)) return;
          await deleteDocument(d.id).catch(() => undefined);
          if (selected === d.id) {
            selected = null;
            showEmpty();
          }
          await refresh();
        });
        return li;
      }),
    ];
    if (!items.length) {
      const empty = document.createElement('li');
      empty.className = 'lib-empty';
      empty.textContent = 'Aún no hay archivos. Sube apuntes, guías o fotos para que tu NAO los conozca.';
      items.push(empty);
    }
    list.replaceChildren(...items);
  };

  const refresh = async () => {
    const before = new Map(docs.map((d) => [d.id, d.status]));
    try {
      docs = await listDocuments();
    } catch {
      return;
    }
    // Algo terminó de guardarse (o falló): el servidor ya cobró, se refrescan los tokens
    if (docs.some((d) => before.has(d.id) && before.get(d.id) !== d.status && (d.status === 'ready' || d.status === 'error'))) onSpent();
    render();
    const current = docs.find((d) => d.id === selected);
    if (current && view.dataset.status !== current.status) showDoc(current);
    clearTimeout(poll);
    if (docs.some((d) => d.status === 'pending' || d.status === 'processing')) poll = window.setTimeout(() => void refresh(), POLL_MS);
  };

  // ─── Visor ──────────────────────────────────────────────────────────────────
  const showEmpty = () => {
    view.dataset.status = '';
    view.innerHTML = `<div class="lib-blank">${ICONS.library}<p>Elige un archivo para verlo</p></div>`;
  };

  const showDoc = (d: LibraryDoc) => {
    view.dataset.status = d.status;
    const head = document.createElement('header');
    head.className = 'lib-view-head';
    head.innerHTML = `<div><b></b><span>${formatSize(d.size)} · ${statusOf(d)}</span></div>
      <a class="lib-dl" href="${documentUrl(d.id, true)}" download>${ICONS.download}<span>Descargar</span></a>`;
    head.querySelector('b')!.textContent = d.title;
    const body = document.createElement('div');
    body.className = 'lib-view-body';
    if (d.status === 'error') {
      const note = document.createElement('p');
      note.className = 'lib-error';
      note.textContent = d.error ? `No se pudo guardar: ${d.error}.` : 'No se pudo guardar.';
      view.replaceChildren(head, note, body);
    } else view.replaceChildren(head, body);

    if (d.kind === 'image') {
      const img = document.createElement('img');
      img.src = documentUrl(d.id);
      img.alt = d.title;
      body.append(img);
    } else if (d.kind === 'pdf') {
      const frame = document.createElement('iframe');
      frame.src = documentUrl(d.id);
      frame.title = d.title;
      body.append(frame);
    } else if (d.mime.startsWith('text/')) {
      const pre = document.createElement('pre');
      pre.textContent = 'Cargando…';
      body.append(pre);
      fetch(documentUrl(d.id))
        .then((r) => r.text())
        .then((t) => (pre.textContent = t.length > 200_000 ? `${t.slice(0, 200_000)}\n…` : t))
        .catch(() => (pre.textContent = 'No se pudo cargar el texto.'));
    } else {
      body.classList.add('lib-cant');
      body.innerHTML = `${FILE_ICONS[d.kind]}<p>Este archivo no se puede ver aquí</p>
        <a class="lib-dl big" href="${documentUrl(d.id, true)}" download>${ICONS.download}<span>Descargar</span></a>`;
    }
  };

  // ─── Subida ─────────────────────────────────────────────────────────────────
  const upload = async (files: FileList | File[]) => {
    for (const original of Array.from(files)) {
      const item: LocalItem = { key: `${Date.now()}-${original.name}`, title: original.name, size: original.size };
      locals = [item, ...locals];
      render();
      try {
        if (docs.length >= MAX_DOCS) throw new Error('Ya tienes 30 archivos: borra alguno');
        let file = original;
        let thumb: Blob | undefined;
        if (isImage(original)) [file, thumb] = await shrinkImage(original);
        if (file.size > MAX_BYTES) throw new Error('Supera los 4 MB');
        const doc = await uploadDocument(file, thumb);
        locals = locals.filter((o) => o !== item);
        docs = [doc, ...docs];
        selected = doc.id;
        showDoc(doc);
      } catch (e) {
        item.error = e instanceof ApiError || e instanceof Error ? capitalize(e.message) : 'No se pudo subir';
      }
      render();
    }
    await refresh();
  };

  input.addEventListener('change', () => {
    if (input.files?.length) void upload(input.files);
    input.value = '';
  });
  drop.addEventListener('dragover', (e) => {
    e.preventDefault();
    drop.classList.add('over');
  });
  drop.addEventListener('dragleave', () => drop.classList.remove('over'));
  drop.addEventListener('drop', (e) => {
    e.preventDefault();
    drop.classList.remove('over');
    if (e.dataTransfer?.files.length) void upload(e.dataTransfer.files);
  });

  showEmpty();
  render();
  return {
    element: root,
    show: () => void refresh(),
  };
}

const isImage = (f: File) => f.type.startsWith('image/') || /\.(jpe?g|png|webp|gif|heic)$/i.test(f.name);

/**
 * Imagen → JPEG de máx. 1600 px (y miniatura de 160 px): así nunca llega al servidor (ni a la IA) una foto enorme.
 * createImageBitmap respeta la orientación de la cámara; en Safari también decodifica HEIC.
 */
async function shrinkImage(file: File): Promise<[File, Blob]> {
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch {
    throw new Error('Este navegador no pudo abrir esa imagen');
  }
  const draw = (side: number, crop: boolean) => {
    const scale = crop ? side / Math.min(bitmap.width, bitmap.height) : Math.min(1, side / Math.max(bitmap.width, bitmap.height));
    const w = crop ? side : Math.round(bitmap.width * scale);
    const h = crop ? side : Math.round(bitmap.height * scale);
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d')!;
    ctx.fillStyle = '#fff'; // los PNG transparentes no quedan negros en JPEG
    ctx.fillRect(0, 0, w, h);
    ctx.drawImage(bitmap, (w - bitmap.width * scale) / 2, (h - bitmap.height * scale) / 2, bitmap.width * scale, bitmap.height * scale);
    return new Promise<Blob>((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('No se pudo procesar la imagen'))), 'image/jpeg', crop ? 0.8 : 0.82));
  };
  const [full, thumb] = await Promise.all([draw(IMAGE_SIDE, false), draw(THUMB_SIDE, true)]);
  const name = file.name.replace(/\.[^.]+$/, '') + '.jpg';
  return [new File([full], name, { type: 'image/jpeg' }), thumb];
}

function kindFromName(name: string): LibraryDoc['kind'] {
  if (/\.pdf$/i.test(name)) return 'pdf';
  if (/\.(xlsx|xls|csv)$/i.test(name)) return 'excel';
  if (/\.docx?$/i.test(name)) return 'word';
  if (/\.(jpe?g|png|webp|gif|heic)$/i.test(name)) return 'image';
  return 'text';
}

const formatSize = (n: number) => (n < 1024 * 1024 ? `${Math.max(1, Math.round(n / 1024))} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`);
const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
