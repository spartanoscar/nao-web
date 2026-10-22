// Subtítulos de la conversación, abajo al centro: quien habla y el NAO con colores distintos (como un juego).
// Las líneas se desvanecen solas. Hasta que llegue la conversación con IA (F8) solo se muestran líneas de ejemplo.

export type Speaker = 'user' | 'nao';

export interface Transcript {
  add(speaker: Speaker, name: string, text: string): void;
}

const LINE_TTL = 9000;
const MAX_LINES = 4;

export function createTranscript(): Transcript {
  const box = document.createElement('div');
  box.id = 'transcript';
  box.setAttribute('aria-live', 'polite');
  document.body.append(box);

  return {
    add(speaker, name, text) {
      const line = document.createElement('p');
      line.className = `line ${speaker}`;
      const who = document.createElement('span');
      who.className = 'who';
      who.textContent = name;
      line.append(who, document.createTextNode(text));
      box.append(line);
      while (box.children.length > MAX_LINES) box.firstElementChild!.remove();
      setTimeout(() => line.classList.add('fade'), LINE_TTL);
      setTimeout(() => line.remove(), LINE_TTL + 800);
    },
  };
}

/** Diálogo de ejemplo para ver cómo lucen los subtítulos (se reemplaza por la transcripción real en F8) */
export function playDemo(t: Transcript, userName: string, robotName: string): void {
  const lines: [number, Speaker, string][] = [
    [1500, 'user', 'Oye NAO, ¿qué es esto?'],
    [4000, 'nao', 'Es un cubo rojo. Está en el suelo, frente a mí.'],
    [7000, 'user', '¿Puedes ir hasta allá?'],
    [9500, 'nao', '¡Claro! Voy caminando.'],
  ];
  for (const [at, speaker, text] of lines) setTimeout(() => t.add(speaker, speaker === 'user' ? userName : robotName, text), at);
}
