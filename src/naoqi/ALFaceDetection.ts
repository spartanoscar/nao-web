// ALFaceDetection (reference/naoqi-2.8-api/naoqi_peopleperception_alfacedetection-api.md): aprender, reconocer y olvidar
// caras. Como en el NAO real, learnFace(name) aprende la cara que tiene delante en ese momento; aquí "delante" es la
// cámara del teléfono (en el mundo virtual no hay personas). La detección y la huella las hace ai/faces.ts (face-api);
// este servicio no sabe de navegador: recibe un `FaceStore`.
//
// Extensión de NAO Web (no está en NAOqi): setLearningConsent(texto). La Ley 1581 de 2012 exige autorización para datos
// biométricos; el NAO la pide conversando y learnFace/reLearnFace guardan esas palabras como constancia. Sin ellas,
// learnFace devuelve false (lastError lo explica).

export interface FaceStore {
  /** Aprende la cara visible (3 tomas, o 1 si `append`). null = listo; si no, por qué no */
  learn(name: string, consentNote: string, append: boolean): Promise<string | null>;
  forget(name: string): Promise<boolean>;
  names(): string[];
  /** Umbral de confianza (0–1) con que se reconoce */
  threshold: number;
}

export class ALFaceDetection {
  store: FaceStore | null = null;
  /** Por qué falló la última operación (no está en NAOqi; para las habilidades de la IA) */
  lastError = '';
  private consent = '';
  private recognition = true;
  private tracking = true;

  /** Extensión NAO Web: las palabras con que la persona autorizó que se la recuerde (se consumen en el próximo learnFace) */
  setLearningConsent(text: string): void {
    this.consent = String(text ?? '').trim();
  }

  /** "Learns a new face and adds it in the database under the specified name." */
  learnFace(name: string): Promise<boolean> {
    return this.learn(name, false);
  }

  /** "Adds a new identification picture to a specific user record." Hasta 10 por persona (rueda) */
  reLearnFace(name: string): Promise<boolean> {
    return this.learn(name, true);
  }

  /** "Deletes from the database all learned faces corresponding to the specified person." */
  async forgetPerson(name: string): Promise<boolean> {
    if (!this.store) return this.fail('el reconocimiento de rostros no está disponible');
    return this.store.forget(String(name).trim());
  }

  /** "Gets a list containing the name of each learned face." */
  getLearnedFacesList(): string[] {
    return this.store?.names() ?? [];
  }

  /** "Removes all learned faces from the database." */
  async clearDatabase(): Promise<boolean> {
    if (!this.store) return false;
    const results = await Promise.all(this.getLearnedFacesList().map((n) => this.store!.forget(n)));
    return results.every(Boolean);
  }

  /** "Sets a new threshold value for face recognition. … between 0 and 1, with a default of 0.4." */
  setRecognitionConfidenceThreshold(threshold: number): void {
    if (this.store) this.store.threshold = Math.min(Math.max(Number(threshold) || 0, 0), 1);
  }

  getRecognitionConfidenceThreshold(): number {
    return this.store?.threshold ?? 0.4;
  }

  setRecognitionEnabled(enable: boolean): void {
    this.recognition = Boolean(enable);
  }

  isRecognitionEnabled(): boolean {
    return this.recognition;
  }

  setTrackingEnabled(enable: boolean): void {
    this.tracking = Boolean(enable);
  }

  isTrackingEnabled(): boolean {
    return this.tracking;
  }

  private async learn(name: string, append: boolean): Promise<boolean> {
    const who = String(name ?? '').trim();
    const consent = this.consent;
    this.consent = '';
    if (!this.store) return this.fail('el reconocimiento de rostros no está disponible');
    if (!who) return this.fail('falta el nombre');
    if (!consent) return this.fail('falta la autorización de la persona (sus palabras)');
    const error = await this.store.learn(who, consent, append);
    return error ? this.fail(error) : ((this.lastError = ''), true);
  }

  private fail(reason: string): false {
    this.lastError = reason;
    return false;
  }
}
