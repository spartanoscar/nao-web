// Rostros en lo que ve la cámara del teléfono (F11), en el navegador y en cascada para no gastar de más:
//
//   1. Cada foto que llega (~2 por segundo) pasa SOLO por el detector diminuto de face-api (TinyFaceDetector, 190 KB,
//      ~15 ms). Sin caras no se hace nada más. Los modelos de puntos de la cara y de huella (6.5 MB) se descargan en
//      segundo plano con la primera foto del teléfono (la primera vez tardaban 10 s en estar listos y el saludo
//      esperaba), pero solo corren con una cara.
//   2. Puntos de la cara (68, versión diminuta) + huella de 128 números SOLO si hay una cara lo bastante grande
//      (≥ MIN_FACE px) y clara (score ≥ MIN_SCORE) que todavía no esté identificada: una cara reconocida se sigue de
//      cuadro en cuadro por su posición (se superpone con la de antes) y se vuelve a verificar cada RECHECK_S.
//   3. La huella se compara aquí con las de las personas registradas por el usuario (GET /api/faces, nunca de otros):
//      distancia euclidiana < MATCH (el umbral habitual de face-api es 0.6; más estricto para no confundir).
//
// Nunca se guarda ni se envía la foto para reconocer: solo viaja a Gemini dentro de la imagen del turno (ai/vision.ts),
// como lo que ve el NAO. Registrar una persona exige su autorización (Ley 1581): ui/faces.ts.

import type * as FaceApi from '@vladmandic/face-api';

const MODELS = '/models/face';
/** Lado mínimo de la caja (px de la foto de 320) para intentar reconocer: más chica, la huella no es confiable */
const MIN_FACE = 48;
const MIN_SCORE = 0.6;
/** Distancia máxima para decir "es esta persona" */
const MATCH = 0.5;
/** Una cara ya reconocida se vuelve a verificar cada tanto (s); una desconocida, más seguido (quizá giró la cara) */
const RECHECK_S = 3;
const RETRY_UNKNOWN_S = 2;
/** Lo que se vio vale este tiempo (s): después, nadie a la vista */
const STALE_S = 3;

export interface SeenFace {
  /** Caja en la foto del teléfono (px) */
  box: { x: number; y: number; width: number; height: number };
  /** null = una persona sin registrar (o aún sin reconocer si `pending`) */
  name: string | null;
  distance: number | null;
  pending: boolean;
}

export interface FaceStats {
  frames: number;
  /** Fotos en que el detector encontró al menos una cara */
  withFaces: number;
  /** Veces que corrió la etapa cara (puntos + huella) */
  recognitions: number;
  detectMs: number;
  recognizeMs: number;
}

interface Track extends SeenFace {
  checkedAt: number;
}

type Person = { name: string; embeddings: number[][] };

export class FaceWatcher {
  private api: typeof FaceApi | null = null;
  private loading: Promise<typeof FaceApi> | null = null;
  private heavy: Promise<void> | null = null;
  private busy = false;
  private tracks: Track[] = [];
  private people: Person[] = [];
  /** La última foto del teléfono (para la imagen del turno) y cuándo llegó */
  readonly frame = document.createElement('canvas');
  frameAt = 0;
  readonly stats: FaceStats = { frames: 0, withFaces: 0, recognitions: 0, detectMs: 0, recognizeMs: 0 };
  /** Después de procesar cada foto (app.ts: saludar a quien aparece) */
  onUpdate: (() => void) | null = null;
  /** Quien espera la próxima huella (registrar una persona) */
  private waiting: ((descriptor: Float32Array | null, faces: number) => void) | null = null;

  /** Las personas registradas cambiaron (o al entrar): se piden al servidor */
  async loadPeople(): Promise<void> {
    try {
      const res = await fetch('/api/faces', { credentials: 'same-origin' });
      if (res.ok) this.people = ((await res.json()).people ?? []) as Person[];
    } catch {
      /* sin red: se queda con las de antes */
    }
    for (const t of this.tracks) t.checkedAt = 0; // reconocer de nuevo con la lista nueva
  }

  /** ¿Hay foto reciente del teléfono? (cámara activa) */
  get live(): boolean {
    return performance.now() / 1000 - this.frameAt < STALE_S;
  }

  /** Caras a la vista ahora (vacío si la cámara del teléfono no está activa) */
  faces(): SeenFace[] {
    return this.live ? this.tracks.map(({ box, name, distance, pending }) => ({ box, name, distance, pending })) : [];
  }

  /** Una foto nueva del teléfono. Si todavía está procesando la anterior, esta se salta (llega otra en 0.5 s) */
  async push(jpeg: Blob): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      const bitmap = await createImageBitmap(jpeg);
      [this.frame.width, this.frame.height] = [bitmap.width, bitmap.height];
      this.frame.getContext('2d')!.drawImage(bitmap, 0, 0);
      bitmap.close();
      this.frameAt = performance.now() / 1000;
      await this.process();
      this.onUpdate?.();
    } catch (e) {
      console.warn('Rostros:', e);
    } finally {
      this.busy = false;
    }
  }

  /**
   * Para registrar a alguien: la huella de la próxima foto que tenga exactamente una cara clara. null si en `timeoutMs`
   * no hubo (sin cara, o más de una).
   */
  nextDescriptor(timeoutMs = 4000): Promise<{ descriptor: Float32Array | null; faces: number }> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.waiting = null;
        resolve({ descriptor: null, faces: this.tracks.length });
      }, timeoutMs);
      this.waiting = (descriptor, faces) => {
        if (!descriptor) return; // se sigue esperando hasta el tiempo límite
        clearTimeout(timer);
        this.waiting = null;
        resolve({ descriptor, faces });
      };
    });
  }

  private async process(): Promise<void> {
    const api = await this.load();
    void this.loadHeavy(api); // en segundo plano: listos para cuando aparezca una cara
    const now = performance.now() / 1000;
    this.stats.frames++;

    // Etapa 1: solo el detector diminuto
    let t0 = performance.now();
    const found = await api.detectAllFaces(this.frame, new api.TinyFaceDetectorOptions({ inputSize: 224, scoreThreshold: 0.5 }));
    this.stats.detectMs = performance.now() - t0;
    if (found.length) this.stats.withFaces++;

    // Seguir de cuadro en cuadro: cada cara nueva hereda el nombre de la de antes que más se le superpone
    const next: Track[] = found.map((d) => {
      const box = { x: d.box.x, y: d.box.y, width: d.box.width, height: d.box.height };
      const prev = this.tracks.reduce<{ t: Track | null; iou: number }>((best, t) => {
        const v = iou(t.box, box);
        return v > best.iou ? { t, iou: v } : best;
      }, { t: null, iou: 0.3 }).t;
      const clear = d.score >= MIN_SCORE && Math.min(box.width, box.height) >= MIN_FACE;
      return prev
        ? { ...prev, box }
        : { box, name: null, distance: null, pending: clear, checkedAt: 0 };
    });
    this.tracks = next;

    const clear = (t: Track) => Math.min(t.box.width, t.box.height) >= MIN_FACE;
    const due = next.filter((t) => clear(t) && now - t.checkedAt > (t.name ? RECHECK_S : RETRY_UNKNOWN_S));
    if (!due.length && !(this.waiting && next.length === 1)) {
      this.waiting?.(null, next.length);
      return;
    }

    // Etapa 2: puntos + huella (solo aquí se cargan y corren los modelos grandes)
    await this.loadHeavy(api);
    t0 = performance.now();
    const full = await api
      .detectAllFaces(this.frame, new api.TinyFaceDetectorOptions({ inputSize: 224, scoreThreshold: 0.5 }))
      .withFaceLandmarks(true)
      .withFaceDescriptors();
    this.stats.recognizeMs = performance.now() - t0;
    this.stats.recognitions++;
    for (const r of full) {
      const box = { x: r.detection.box.x, y: r.detection.box.y, width: r.detection.box.width, height: r.detection.box.height };
      const track = next.reduce<{ t: Track | null; iou: number }>((best, t) => {
        const v = iou(t.box, box);
        return v > best.iou ? { t, iou: v } : best;
      }, { t: null, iou: 0.3 }).t;
      if (!track) continue;
      const { name, distance } = this.match(r.descriptor);
      Object.assign(track, { name, distance, pending: false, checkedAt: now });
    }
    if (this.waiting) this.waiting(full.length === 1 ? full[0].descriptor : null, full.length);
  }

  private match(descriptor: Float32Array): { name: string | null; distance: number | null } {
    let best: { name: string | null; distance: number } = { name: null, distance: Infinity };
    for (const p of this.people) {
      for (const e of p.embeddings) {
        const d = this.api!.euclideanDistance(descriptor, e);
        if (d < best.distance) best = { name: p.name, distance: d };
      }
    }
    return best.distance < MATCH ? best : { name: null, distance: Number.isFinite(best.distance) ? best.distance : null };
  }

  private load(): Promise<typeof FaceApi> {
    this.loading ??= (async () => {
      const api = await import('@vladmandic/face-api');
      // El tfjs que trae face-api tiene estas funciones, pero sus tipos publicados no las declaran
      const tf = api.tf as unknown as { setBackend(name: string): Promise<boolean>; ready(): Promise<void> };
      await tf.setBackend('webgl').catch(() => tf.setBackend('cpu'));
      await tf.ready();
      await api.nets.tinyFaceDetector.loadFromUri(MODELS);
      this.api = api;
      return api;
    })();
    return this.loading;
  }

  private loadHeavy(api: typeof FaceApi): Promise<void> {
    this.heavy ??= Promise.all([api.nets.faceLandmark68TinyNet.loadFromUri(MODELS), api.nets.faceRecognitionNet.loadFromUri(MODELS)]).then(() => undefined);
    return this.heavy;
  }
}

function iou(a: SeenFace['box'], b: SeenFace['box']): number {
  const x = Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x));
  const y = Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));
  const inter = x * y;
  return inter / (a.width * a.height + b.width * b.height - inter || 1);
}
