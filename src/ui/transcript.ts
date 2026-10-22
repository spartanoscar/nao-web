// Subtítulos de la conversación, abajo al centro: quien habla y el NAO con colores distintos (como un juego).
// Los parciales de la transcripción reemplazan su renglón (mismo id) hasta que llega el final; los renglones
// finales se desvanecen solos.

export type Speaker = 'user' | 'nao';

export interface Transcript {
  /** Renglón nuevo o actualización de uno existente (`id`); `final` lo fija y empieza a desvanecerse */
  show(id: string, speaker: Speaker, name: string, text: string, final: boolean): void;
  /** Aviso del sistema (p. ej. sin tokens), en el mismo lugar */
  notice(text: string): void;
}

const LINE_TTL = 9000;
const MAX_LINES = 4;

export function createTranscript(): Transcript {
  const box = document.createElement('div');
  box.id = 'transcript';
  box.setAttribute('aria-live', 'polite');
  document.body.append(box);
  const lines = new Map<string, HTMLElement>();

  const fade = (id: string, line: HTMLElement) => {
    setTimeout(() => line.classList.add('fade'), LINE_TTL);
    setTimeout(() => {
      line.remove();
      if (lines.get(id) === line) lines.delete(id);
    }, LINE_TTL + 800);
  };

  return {
    show(id, speaker, name, text, final) {
      let line = lines.get(id);
      if (!line) {
        line = document.createElement('p');
        line.className = `line ${speaker}`;
        const who = document.createElement('span');
        who.className = 'who';
        who.textContent = name;
        line.append(who, document.createElement('span'));
        box.append(line);
        lines.set(id, line);
        while (box.children.length > MAX_LINES) box.firstElementChild!.remove();
      }
      line.lastElementChild!.textContent = text;
      line.classList.toggle('interim', !final);
      if (final) fade(id, line);
    },
    notice(text) {
      const id = `notice-${Date.now()}`;
      this.show(id, 'nao', '⚠', text, true);
      lines.get(id)?.classList.add('notice');
    },
  };
}
