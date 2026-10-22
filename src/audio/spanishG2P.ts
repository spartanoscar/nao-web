// Español → fonemas IPA con la notación de espeak-ng es-419, que es la que aprendió Kokoro.
// El paquete `phonemizer` solo trae los datos de inglés de espeak-ng y el espeak-ng completo es GPL y
// pesa ~19 MB; el español se pronuncia casi enteramente por reglas, así que se convierte aquí
// (español latinoamericano: seseo y yeísmo). Validado frase a frase contra espeak-ng -v es-419.

const VOWELS = 'aeiouáéíóúü';
const ACCENTED: Record<string, string> = { á: 'a', é: 'e', í: 'i', ó: 'o', ú: 'u', ü: 'u' };
/** Palabras átonas (sin acento en espeak): artículos, preposiciones, pronombres clíticos, conjunciones */
const UNSTRESSED = new Set([
  'el', 'la', 'los', 'las', 'lo', 'le', 'les', 'de', 'del', 'al', 'a', 'en', 'con', 'por', 'sin', 'que',
  'y', 'e', 'o', 'u', 'ni', 'se', 'me', 'te', 'nos', 'os', 'mi', 'mis', 'tu', 'tus', 'su', 'sus', 'si', 'pero',
  'cuando', 'como', 'donde', 'mas', 'para', 'tan',
]);

interface Ph {
  /** símbolo IPA */
  s: string;
  /** vocal (núcleo posible) */
  v?: boolean;
  /** vocal débil (i/u) que puede formar diptongo */
  weak?: boolean;
  /** lleva tilde (fuerza acento e hiato) */
  acc?: boolean;
  /** ü: como glide se escribe u, no w */
  keep?: boolean;
  /** i escrita con y final (muy, soy) */
  fromY?: boolean;
}

/** Letras de una palabra → fonemas (antes de alófonos y acento) */
function letters(w: string): Ph[] {
  const out: Ph[] = [];
  // Ojo: 'abc'.includes('') es true; al final de la palabra n es '' y no debe contar como vocal
  const isVowel = (ch: string) => ch !== '' && VOWELS.includes(ch);
  const isFront = (ch: string) => ch !== '' && 'eéií'.includes(ch);
  const at = (i: number) => w[i] ?? '';
  for (let i = 0; i < w.length; i++) {
    const c = w[i];
    const n = at(i + 1);
    const front = isFront(n);
    if (VOWELS.includes(c)) {
      const base = ACCENTED[c] ?? c;
      const acc = c in ACCENTED && c !== 'ü';
      out.push({ s: base, v: true, weak: (base === 'i' || base === 'u') && !acc, acc, ...(c === 'ü' ? { keep: true } : {}) });
      continue;
    }
    switch (c) {
      case 'h':
        break; // muda ("hielo" → jˈelo: la i inicial se vuelve glide más abajo)
      case 'b':
      case 'v':
        out.push({ s: 'b' });
        break;
      case 'c':
        if (n === 'h') {
          out.push({ s: 'tʃ' });
          i++;
        } else out.push({ s: front ? 's' : 'k' });
        break;
      case 'z':
        out.push({ s: 's' });
        break;
      case 'q':
        out.push({ s: 'k' });
        if (n === 'u') i++; // qu → k
        break;
      case 'g':
        if (front) out.push({ s: 'x' });
        else {
          out.push({ s: 'ɡ' });
          if (n === 'u' && isFront(at(i + 2))) i++; // gue/gui → ɡe/ɡi (güe/güi conserva la u)
        }
        break;
      case 'j':
        out.push({ s: 'x' });
        break;
      case 'l':
        if (n === 'l') {
          // espeak es-419: inicial "ll" → ʝ (llamo), entre vocales → jj (pollo → pˈojjo)
          out.push({ s: isVowel(at(i - 1)) ? 'jj' : 'ʝ' });
          i++;
        } else out.push({ s: 'l' });
        break;
      case 'y':
        // Consonante ante vocal; vocal (i) al final o sola
        if (isVowel(n)) out.push({ s: 'ʝ' });
        else out.push({ s: 'i', v: true, weak: true, fromY: true });
        break;
      case 'ñ':
        out.push({ s: 'ɲ' });
        break;
      case 'r':
        if (n === 'r') {
          out.push({ s: 'r' });
          i++;
        } else {
          const prev = w[i - 1];
          out.push({ s: i === 0 || 'nls'.includes(prev ?? '') ? 'r' : 'ɾ' });
        }
        break;
      case 'x':
        out.push({ s: 'k' }, { s: 's' });
        break;
      case 'w':
        out.push({ s: 'w' });
        break;
      case 'k':
        out.push({ s: 'k' });
        break;
      default:
        if (/[a-zñ]/.test(c)) out.push({ s: c });
    }
  }
  return out;
}

/** Excepciones de escritura conocidas */
const WORDS: Record<string, string> = { méxico: 'méjico', mexicano: 'mejicano', mexicana: 'mejicana', oaxaca: 'oajaca', texas: 'tejas' };

const ONSET_CLUSTERS = new Set(['pl', 'pɾ', 'bl', 'bɾ', 'kl', 'kɾ', 'dɾ', 'fl', 'fɾ', 'ɡl', 'ɡɾ', 'tɾ', 'tl']);

/** Sílabas: inicio, núcleo (vocal fuerte o la última débil) y vocales del grupo (diptongos) */
function syllables(ph: Ph[]): { start: number; nucleus: number; vowels: number[] }[] {
  // Núcleos: grupos de vocales; dos fuertes seguidas, o débil con tilde, rompen el diptongo
  const groups: number[][] = [];
  for (let i = 0; i < ph.length; i++) {
    if (!ph[i].v) continue;
    const g = groups.at(-1);
    const prev = g && g.at(-1) === i - 1 ? ph[i - 1] : null;
    const hiatus = prev && ((!prev.weak && !ph[i].weak) || prev.acc && prev.weak || ph[i].acc && ph[i].weak);
    if (g && prev && !hiatus) g.push(i);
    else groups.push([i]);
  }
  const result: { start: number; nucleus: number; vowels: number[] }[] = [];
  for (let k = 0; k < groups.length; k++) {
    const g = groups[k];
    // Núcleo: la vocal fuerte; entre dos débiles, la segunda (ciudad → sjuðˈad) salvo "uy" final (muy → mˈuj)
    const nucleus = g.find((i) => !ph[i].weak) ?? (ph[g.at(-1)!].fromY ? g[0] : g.at(-1)!);
    let start = g[0];
    if (k === 0) start = 0;
    else {
      const prevEnd = groups[k - 1].at(-1)!;
      const cons = g[0] - prevEnd - 1; // consonantes entre núcleos
      if (cons === 1) start = g[0] - 1;
      else if (cons >= 2) {
        const pair = ph[g[0] - 2].s + ph[g[0] - 1].s;
        start = ONSET_CLUSTERS.has(pair) ? g[0] - 2 : g[0] - 1;
      }
    }
    result.push({ start, nucleus, vowels: g });
  }
  return result;
}

/** Sílaba acentuada: tilde, o regla de la penúltima (termina en vocal, n o s) / última */
function stressedSyllable(word: string, ph: Ph[], syl: { start: number }[]): number {
  const acc = ph.findIndex((p) => p.acc);
  if (acc >= 0) {
    let k = 0;
    while (k + 1 < syl.length && syl[k + 1].start <= acc) k++;
    return k;
  }
  if (syl.length === 1) return 0;
  return /[aeiouns]$/.test(word) ? syl.length - 2 : syl.length - 1;
}

/** Una palabra → IPA (sin alófonos dependientes del contexto) */
const SECONDARY_ONLY = new Set(['sobre', 'entre', 'hacia', 'desde', 'hasta', 'contra', 'según', 'durante', 'mediante']);

function wordToIpa(raw: string): { ph: Ph[]; stress: number; secondary: number[] } {
  const word = WORDS[raw] ?? raw;
  const ph = letters(word);
  const syl = syllables(ph);
  // Diptongos: la vocal débil antes del núcleo es glide j/w (cielo → sjelo, bueno → bweno, hielo →
  // jelo); después del núcleo, ɪ/ʊ como espeak (soy → soɪ, veinte → beɪnte, auto → aʊto)
  for (const { nucleus, vowels } of syl) {
    for (const i of vowels) {
      if (i === nucleus) continue;
      const after = ph[nucleus].weak ? 'j' : 'ɪ'; // tras núcleo débil espeak escribe j (muy → mˈuj)
      const glide = ph[i].keep ? 'u' : i < nucleus ? (ph[i].s === 'i' ? 'j' : 'w') : ph[i].s === 'i' ? after : 'ʊ';
      ph[i] = { s: glide };
    }
  }
  const unstressed = UNSTRESSED.has(raw);
  const stress = unstressed ? -1 : stressedSyllable(word, ph, syl);
  // e abierta como espeak: acentuada ante nasal + consonante o ante x (tengo → tˈɛŋɡo, gente →
  // xˈɛnte, méxico → mˈɛxiko), pero no en "es", "ver", "tres"
  if (stress >= 0) {
    const n = syl[stress].nucleus;
    const next = ph[n + 1];
    const after = ph[n + 2];
    const nasalCoda = next && 'nmŋ'.includes(next.s) && after && !after.v;
    if (ph[n].s === 'e' && (nasalCoda || next?.s === 'x')) ph[n] = { ...ph[n], s: 'ɛ' };
  }
  // Acento secundario alternado desde la primera sílaba, sin tocar la vecina del principal
  // (universidad → ˌuniβˌeɾsiðˈad, libertadores → lˌiβeɾtaðˈoɾes). Algunas preposiciones solo secundario.
  const secondary: number[] = [];
  if (SECONDARY_ONLY.has(raw)) return { ph, stress: -1, secondary: [syl[stressedSyllable(word, ph, syl)].nucleus] };
  for (let k = 0; k < stress - 1; k += 2) secondary.push(syl[k].nucleus);
  return { ph, stress: stress >= 0 ? syl[stress].nucleus : -1, secondary };
}

/** Números → palabras (0 – 999 999) */
function numberToWords(n: number): string {
  const units = ['cero', 'uno', 'dos', 'tres', 'cuatro', 'cinco', 'seis', 'siete', 'ocho', 'nueve', 'diez', 'once', 'doce', 'trece', 'catorce', 'quince', 'dieciséis', 'diecisiete', 'dieciocho', 'diecinueve', 'veinte', 'veintiuno', 'veintidós', 'veintitrés', 'veinticuatro', 'veinticinco', 'veintiséis', 'veintisiete', 'veintiocho', 'veintinueve'];
  const tens = ['', '', '', 'treinta', 'cuarenta', 'cincuenta', 'sesenta', 'setenta', 'ochenta', 'noventa'];
  const hundreds = ['', 'ciento', 'doscientos', 'trescientos', 'cuatrocientos', 'quinientos', 'seiscientos', 'setecientos', 'ochocientos', 'novecientos'];
  const below1000 = (x: number): string => {
    if (x < 30) return units[x];
    if (x < 100) return tens[Math.floor(x / 10)] + (x % 10 ? ' y ' + units[x % 10] : '');
    if (x === 100) return 'cien';
    return hundreds[Math.floor(x / 100)] + (x % 100 ? ' ' + below1000(x % 100) : '');
  };
  if (n < 1000) return below1000(n);
  const th = Math.floor(n / 1000);
  return (th === 1 ? 'mil' : below1000(th) + ' mil') + (n % 1000 ? ' ' + below1000(n % 1000) : '');
}

const PUNCT = /([,.;:!?¡¿…—"«»()])/;

/** Texto en español → cadena de fonemas para Kokoro (palabras separadas por espacio, puntuación conservada) */
export function spanishToIpa(text: string): string {
  const normalized = text
    .toLowerCase()
    .replace(/\d+/g, (d) => (Number(d) <= 999999 ? numberToWords(Number(d)) : d))
    .replace(/[^\p{L}\s,.;:!?¡¿…—"«»()'-]/gu, ' ');
  const tokens = normalized.split(/\s+/).flatMap((t) => t.split(PUNCT)).filter(Boolean);
  const out: string[] = [];
  // Último fonema emitido (para b/d/g suaves entre palabras); null = inicio o tras pausa
  let prev: string | null = null;
  for (const tok of tokens) {
    if (PUNCT.test(tok)) {
      if (out.length && !/^[¡¿"«(]$/.test(tok)) out[out.length - 1] += tok;
      else out.push(tok);
      prev = null; // la puntuación es una pausa: b/d/g vuelven a ser oclusivas
      continue;
    }
    const word = tok.replace(/[^\p{L}]/gu, '');
    if (!word) continue;
    const { ph, stress, secondary } = wordToIpa(word);
    let s = '';
    for (let i = 0; i < ph.length; i++) {
      let p = ph[i].s;
      const last = i === 0 ? prev : ph[i - 1].s;
      // b/d/g → β/ð/ɣ salvo tras pausa o nasal (y d tras l); d final se mantiene
      if (p === 'b' && last && !'mn'.includes(last)) p = 'β';
      else if (p === 'd' && last && !'mnl'.includes(last) && i < ph.length - 1) p = 'ð';
      else if (p === 'ɡ' && last && !'mnŋ'.includes(last)) p = 'ɣ';
      // Asimilación nasal: n ante ɡ/x → ŋ (tengo, ingeniería), ante b/p/m → m (investigue → imbestˈiɣe)
      const nextSym = ph[i + 1]?.s;
      if (p === 'n' && (nextSym === 'ɡ' || nextSym === 'x')) p = 'ŋ';
      else if (p === 'n' && nextSym && 'bpm'.includes(nextSym)) p = 'm';
      if (i === stress) s += 'ˈ';
      else if (secondary.includes(i)) s += 'ˌ';
      s += p;
    }
    // Entre palabras: "en baño" → em, "con pollo" → kom (n final ante b/p de la siguiente; ante m no)
    const before = out.at(-1);
    if (before && /n$/.test(before) && prev !== null && /^[bp]/.test(ph[0]?.s ?? '')) out[out.length - 1] = before.slice(0, -1) + 'm';
    out.push(s);
    prev = ph.at(-1)?.s ?? prev;
  }
  return out.join(' ').replace(/ ([,.;:!?…])/g, '$1').replace(/([¡¿"«(]) /g, '$1').trim();
}
