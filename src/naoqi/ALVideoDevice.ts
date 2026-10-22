// ALVideoDevice: imágenes de las dos cámaras del NAO. Misma firma que NAOqi 2.8.
// Docs: reference/naoqi-2.8-api/naoqi_vision_alvideodevice-api.md, family_nao_technical_video_naov6.md
// La capa NAOqi no conoce la escena: un VideoSource (sim/naoCameras.ts) entrega lo que ve cada cámara en RGBA
// y aquí se aplican resolución, parámetros de cámara, espacio de color y frecuencia de cuadros del suscriptor.
// Sin implementar: putImage y getExpectedImageParameters (solo para el simulador antiguo de Aldebaran).

import { CAMERA_HFOV, CAMERA_MODEL_OV5640, CAMERA_VFOV, NAO_CAMERAS } from '../robot/cameras';
import { NaoqiError } from './args';
import {
  CAMERA_PARAMETERS, COLOR_SPACES, K16VGA, NATIVE_COLOR_SPACE, PARAM, RESOLUTIONS,
  adjustImage, averageLuminance, convertImage,
} from './visionDefinitions';

const SERVICE = 'ALVideoDevice';

export interface VideoSource {
  /** Lo que ve la cámara `camera` en RGBA de 8 bits, filas de arriba abajo; null si no se puede dibujar */
  capture(camera: number, width: number, height: number): Uint8Array | null;
}

/**
 * Contenedor de imagen (doc "Internal Types"): [ancho, alto, capas, espacio de color, segundos, microsegundos,
 * datos, cámara, ángulo izquierdo, superior, derecho, inferior].
 */
export type ALImage = [number, number, number, number, number, number, Uint8Array, number, number, number, number, number];

interface Stream {
  camera: number;
  resolution: number;
  colorSpace: number;
  last: ALImage | null;
  lastAt: number;
}

interface Subscriber {
  streams: Stream[];
  fps: number;
}

/** qi::Clock: reloj monótono desde el arranque (aquí, desde que cargó la página) */
const clock = (): [number, number] => {
  const us = Math.round(performance.now() * 1000);
  return [Math.floor(us / 1e6), us % 1e6];
};

/**
 * Convención angular. APPROX: la doc no da signos; se usa la de los extractores de visión de NAOqi
 * (alpha = horizontal, positivo a la izquierda; beta = vertical, positivo hacia abajo: como HeadYaw y HeadPitch),
 * con la proyección exacta de una cámara estenopeica (la imagen de la escena lo es).
 */
const TAN_H = Math.tan(CAMERA_HFOV / 2);
const TAN_V = Math.tan(CAMERA_VFOV / 2);

export class ALVideoDevice {
  /** Fuente de imágenes (la escena); se asigna desde main */
  source: VideoSource | null = null;
  private readonly subscribers = new Map<string, Subscriber>();
  private readonly params = NAO_CAMERAS.map(() => new Map<number, number>());
  private readonly open = NAO_CAMERAS.map(() => true);
  private readonly started = NAO_CAMERAS.map(() => true);
  /** Cámara activa por defecto (getActiveCamera() sin handle y el subscribe antiguo) */
  private activeCamera = 0;

  constructor() {
    NAO_CAMERAS.forEach((_, i) => this.setAllParametersToDefault(i));
  }

  // ─── Suscripción ────────────────────────────────────────────────────────────

  /** Devuelve el handle: el nombre con "_n" añadido (n = primer número libre) */
  subscribeCamera(name: string, cameraIndex: number, resolution: number, colorSpace: number, fps: number): string {
    return this.add('subscribeCamera', name, [cameraIndex], [resolution], [colorSpace], fps);
  }

  subscribeCameras(name: string, cameraIndexes: number[], resolutions: number[], colorSpaces: number[], fps: number): string {
    return this.add('subscribeCameras', name, cameraIndexes, resolutions, colorSpaces, fps);
  }

  /**
   * Firma antigua (anterior a subscribeCamera), la que aún usa el ejemplo de la doc
   * (`subscribe(subscriberID, AL::kVGA, AL::kRGBColorSpace, fps)`): usa la cámara activa.
   */
  subscribe(name: string, resolution: number, colorSpace: number, fps: number): string {
    return this.add('subscribe', name, [this.activeCamera], [resolution], [colorSpace], fps);
  }

  private add(method: string, name: string, cameraIndexes: number[], resolutions: number[], colorSpaces: number[], fps: number): string {
    if (!Array.isArray(cameraIndexes) || !Array.isArray(resolutions) || !Array.isArray(colorSpaces)) {
      throw new NaoqiError(SERVICE, method, 'CameraIndexes, Resolutions y ColorSpaces deben ser listas');
    }
    if (cameraIndexes.length !== resolutions.length || cameraIndexes.length !== colorSpaces.length) {
      throw new NaoqiError(SERVICE, method, 'CameraIndexes, Resolutions y ColorSpaces deben tener el mismo largo');
    }
    if (new Set(cameraIndexes).size !== cameraIndexes.length) throw new NaoqiError(SERVICE, method, 'no se puede repetir una cámara');
    const streams = cameraIndexes.map((camera, i) => {
      this.checkCamera(method, camera);
      this.checkResolution(method, camera, resolutions[i]);
      this.checkColorSpace(method, colorSpaces[i]);
      return { camera, resolution: resolutions[i], colorSpace: colorSpaces[i], last: null, lastAt: -Infinity };
    });
    this.checkFps(method, fps, resolutions);
    let n = 0;
    while (this.subscribers.has(`${name}_${n}`)) n++;
    const handle = `${name}_${n}`;
    this.subscribers.set(handle, { streams, fps });
    return handle;
  }

  unsubscribe(handle: string): boolean {
    return this.subscribers.delete(handle);
  }

  getSubscribers(): string[] {
    return [...this.subscribers.keys()];
  }

  // ─── Cámaras ────────────────────────────────────────────────────────────────

  getCameraIndexes(): number[] {
    return NAO_CAMERAS.map((c) => c.index);
  }

  hasDepthCamera(): boolean {
    return false;
  }

  getCameraModel(cameraIndex: number): number {
    this.checkCamera('getCameraModel', cameraIndex);
    return CAMERA_MODEL_OV5640;
  }

  getCameraName(cameraIndex: number): string {
    this.checkCamera('getCameraName', cameraIndex);
    return NAO_CAMERAS[cameraIndex].name;
  }

  /** Sin argumento: cámara activa por defecto. Con handle: la del suscriptor (mono stream) */
  getActiveCamera(handle?: string): number {
    return handle === undefined ? this.activeCamera : this.sub('getActiveCamera', handle).streams[0].camera;
  }

  /** setActiveCamera(cameraIndex) o setActiveCamera(handle, cameraIndex) */
  setActiveCamera(a: number | string, b?: number): boolean {
    if (typeof a === 'number') {
      this.checkCamera('setActiveCamera', a);
      this.activeCamera = a;
      return true;
    }
    const stream = this.sub('setActiveCamera', a).streams[0];
    this.checkCamera('setActiveCamera', b!);
    this.checkResolution('setActiveCamera', b!, stream.resolution);
    stream.camera = b!;
    stream.last = null;
    return true;
  }

  /** Por cámara: la de la fuente (la más alta pedida, 30 si nadie la usa). Por handle: la del suscriptor */
  getFrameRate(target: number | string): number {
    if (typeof target === 'string') return this.sub('getFrameRate', target).fps;
    this.checkCamera('getFrameRate', target);
    const rates = [...this.subscribers.values()].filter((s) => s.streams.some((st) => st.camera === target)).map((s) => s.fps);
    return rates.length ? Math.max(...rates) : 30;
  }

  setFrameRate(handle: string, fps: number): boolean {
    const sub = this.sub('setFrameRate', handle);
    this.checkFps('setFrameRate', fps, sub.streams.map((s) => s.resolution));
    sub.fps = fps;
    return true;
  }

  /** Por cámara: el formato nativo (kYUV422ColorSpace). Por handle: el del suscriptor */
  getColorSpace(target: number | string): number {
    if (typeof target === 'string') return this.sub('getColorSpace', target).streams[0].colorSpace;
    this.checkCamera('getColorSpace', target);
    return NATIVE_COLOR_SPACE;
  }

  setColorSpace(handle: string, colorSpace: number): boolean {
    this.checkColorSpace('setColorSpace', colorSpace);
    const stream = this.sub('setColorSpace', handle).streams[0];
    stream.colorSpace = colorSpace;
    stream.last = null;
    return true;
  }

  /** Por handle: la resolución del suscriptor. Por cámara (obsoleto en 2.8): la de la fuente */
  getResolution(target: number | string): number {
    if (typeof target === 'string') return this.sub('getResolution', target).streams[0].resolution;
    this.checkCamera('getResolution', target);
    return 2; // APPROX: kVGA, la resolución interna a 30 fps
  }

  setResolution(handle: string, resolution: number): boolean {
    const sub = this.sub('setResolution', handle);
    this.checkResolution('setResolution', sub.streams[0].camera, resolution);
    this.checkFps('setResolution', sub.fps, [resolution]);
    sub.streams[0].resolution = resolution;
    sub.streams[0].last = null;
    return true;
  }

  /** Radianes (doc video_naov6: 56.3°) */
  getHorizontalFOV(cameraIndex: number): number {
    this.checkCamera('getHorizontalFOV', cameraIndex);
    return CAMERA_HFOV;
  }

  /** Radianes (doc video_naov6: 43.7°) */
  getVerticalFOV(cameraIndex: number): number {
    this.checkCamera('getVerticalFOV', cameraIndex);
    return CAMERA_VFOV;
  }

  /** Obsoleto desde 1.14: = getHorizontalFOV */
  getHorizontalAperture(cameraIndex: number): number {
    return this.getHorizontalFOV(cameraIndex);
  }

  /** Obsoleto desde 1.14: = getVerticalFOV */
  getVerticalAperture(cameraIndex: number): number {
    return this.getVerticalFOV(cameraIndex);
  }

  // ─── Parámetros de cámara ───────────────────────────────────────────────────

  getParameter(cameraIndex: number, parameter: number): number {
    this.checkCamera('getParameter', cameraIndex);
    this.checkParameter('getParameter', parameter);
    return this.params[cameraIndex].get(parameter) ?? 0;
  }

  /** [mín, máx, defecto] */
  getParameterRange(cameraIndex: number, id: number): number[] {
    this.checkCamera('getParameterRange', cameraIndex);
    const p = this.checkParameter('getParameterRange', id);
    return [p.min, p.max, p.default ?? 0];
  }

  /** false si el valor está fuera de rango o el parámetro es de solo lectura en ese momento */
  setParameter(cameraIndex: number, parameter: number, newValue: number): boolean {
    this.checkCamera('setParameter', cameraIndex);
    const p = this.checkParameter('setParameter', parameter);
    const values = this.params[cameraIndex];
    if (!Number.isInteger(newValue) || newValue < p.min || newValue > p.max) return false;
    if (parameter === PARAM.averageLuminance) return false;
    // "Read only if auto exposure enabled" / foco manual "available only when Auto Focus is disabled"
    if ((parameter === PARAM.gain || parameter === PARAM.exposure) && values.get(PARAM.autoExposition) === 1) return false;
    if (parameter === PARAM.focus && values.get(PARAM.autoFocus) === 1) return false;
    values.set(parameter, newValue);
    this.invalidate(cameraIndex);
    return true;
  }

  setParameterToDefault(cameraIndex: number, parameter: number): boolean {
    this.checkCamera('setParameterToDefault', cameraIndex);
    const p = this.checkParameter('setParameterToDefault', parameter);
    if (p.default === null) return false;
    this.params[cameraIndex].set(parameter, p.default);
    this.invalidate(cameraIndex);
    return true;
  }

  /** Obsoleto: = setParameterToDefault */
  setParamDefault(cameraIndex: number, parameter: number): boolean {
    return this.setParameterToDefault(cameraIndex, parameter);
  }

  setAllParametersToDefault(cameraIndex: number): boolean {
    this.checkCamera('setAllParametersToDefault', cameraIndex);
    for (const [id, p] of Object.entries(CAMERA_PARAMETERS)) this.params[cameraIndex].set(Number(id), p.default ?? 0);
    this.invalidate(cameraIndex);
    return true;
  }

  getCameraParameter(handle: string, id: number): number {
    return this.getParameter(this.sub('getCameraParameter', handle).streams[0].camera, id);
  }

  getCameraParameterRange(handle: string, id: number): number[] {
    return this.getParameterRange(this.sub('getCameraParameterRange', handle).streams[0].camera, id);
  }

  setCameraParameter(handle: string, id: number, newValue: number): boolean {
    return this.setParameter(this.sub('setCameraParameter', handle).streams[0].camera, id, newValue);
  }

  setCameraParameterToDefault(handle: string, id: number): boolean {
    return this.setParameterToDefault(this.sub('setCameraParameterToDefault', handle).streams[0].camera, id);
  }

  setAllCameraParametersToDefault(handle: string): boolean {
    return this.setAllParametersToDefault(this.sub('setAllCameraParametersToDefault', handle).streams[0].camera);
  }

  // ─── Encender / apagar ──────────────────────────────────────────────────────

  openCamera(cameraIndex: number): boolean {
    this.checkCamera('openCamera', cameraIndex);
    this.open[cameraIndex] = true;
    return true;
  }

  closeCamera(cameraIndex: number): boolean {
    this.checkCamera('closeCamera', cameraIndex);
    this.open[cameraIndex] = false;
    this.started[cameraIndex] = false;
    return true;
  }

  isCameraOpen(cameraIndex: number): boolean {
    this.checkCamera('isCameraOpen', cameraIndex);
    return this.open[cameraIndex];
  }

  /** Solo una cámara abierta puede arrancar */
  startCamera(cameraIndex: number): boolean {
    this.checkCamera('startCamera', cameraIndex);
    if (!this.open[cameraIndex]) return false;
    this.started[cameraIndex] = true;
    return true;
  }

  stopCamera(cameraIndex: number): boolean {
    this.checkCamera('stopCamera', cameraIndex);
    this.started[cameraIndex] = false;
    return true;
  }

  isCameraStarted(cameraIndex: number): boolean {
    this.checkCamera('isCameraStarted', cameraIndex);
    return this.started[cameraIndex];
  }

  // ─── Imágenes ───────────────────────────────────────────────────────────────

  /** La última imagen de la cámara del suscriptor; null si la cámara está apagada o no hay escena */
  getImageRemote(handle: string): ALImage | null {
    const sub = this.sub('getImageRemote', handle);
    return this.image(sub.streams[0], sub.fps);
  }

  /** APPROX: en el navegador no hay memoria compartida con otro proceso; devuelve lo mismo que getImageRemote */
  getImageLocal(handle: string): ALImage | null {
    const sub = this.sub('getImageLocal', handle);
    return this.image(sub.streams[0], sub.fps);
  }

  releaseImage(handle: string): boolean {
    this.sub('releaseImage', handle);
    return true;
  }

  getImagesRemote(handle: string): (ALImage | null)[] {
    const sub = this.sub('getImagesRemote', handle);
    return sub.streams.map((s) => this.image(s, sub.fps));
  }

  getImagesLocal(handle: string): (ALImage | null)[] {
    const sub = this.sub('getImagesLocal', handle);
    return sub.streams.map((s) => this.image(s, sub.fps));
  }

  releaseImages(handle: string): boolean[] {
    return this.sub('releaseImages', handle).streams.map(() => true);
  }

  // ─── Varias cámaras por suscriptor ──────────────────────────────────────────

  getActiveCameras(handle: string): number[] {
    return this.sub('getActiveCameras', handle).streams.map((s) => s.camera);
  }

  setActiveCameras(handle: string, activeCameras: number[]): boolean[] {
    const sub = this.sub('setActiveCameras', handle);
    return this.each('setActiveCameras', sub, activeCameras, (s, camera) => {
      this.checkCamera('setActiveCameras', camera);
      this.checkResolution('setActiveCameras', camera, s.resolution);
      s.camera = camera;
    });
  }

  /** Obsoleto en 2.8 */
  getResolutions(handle: string): number[] {
    return this.sub('getResolutions', handle).streams.map((s) => s.resolution);
  }

  setResolutions(handle: string, resolutions: number[]): boolean[] {
    const sub = this.sub('setResolutions', handle);
    this.checkFps('setResolutions', sub.fps, resolutions);
    return this.each('setResolutions', sub, resolutions, (s, resolution) => {
      this.checkResolution('setResolutions', s.camera, resolution);
      s.resolution = resolution;
    });
  }

  getColorSpaces(handle: string): number[] {
    return this.sub('getColorSpaces', handle).streams.map((s) => s.colorSpace);
  }

  setColorSpaces(handle: string, colorSpaces: number[]): boolean[] {
    return this.each('setColorSpaces', this.sub('setColorSpaces', handle), colorSpaces, (s, colorSpace) => {
      this.checkColorSpace('setColorSpaces', colorSpace);
      s.colorSpace = colorSpace;
    });
  }

  getCamerasParameter(handle: string, id: number): number[] {
    return this.sub('getCamerasParameter', handle).streams.map((s) => this.getParameter(s.camera, id));
  }

  /** Un valor para todas las cámaras del suscriptor */
  setCamerasParameter(handle: string, id: number, newValue: number): boolean[] {
    return this.sub('setCamerasParameter', handle).streams.map((s) => this.setParameter(s.camera, id, newValue));
  }

  setCamerasParameterToDefault(handle: string, id: number): boolean[] {
    return this.sub('setCamerasParameterToDefault', handle).streams.map((s) => this.setParameterToDefault(s.camera, id));
  }

  // ─── Conversión entre imagen (normalizada 0–1) y ángulos de cámara (rad) ────

  getAngularPositionFromImagePosition(cameraIndex: number, imagePosition: number[]): number[] {
    this.checkCamera('getAngularPositionFromImagePosition', cameraIndex);
    const [x, y] = imagePosition;
    return [Math.atan((0.5 - x) * 2 * TAN_H), Math.atan((y - 0.5) * 2 * TAN_V)];
  }

  getImagePositionFromAngularPosition(cameraIndex: number, angularPosition: number[]): number[] {
    this.checkCamera('getImagePositionFromAngularPosition', cameraIndex);
    const [alpha, beta] = angularPosition;
    return [0.5 - Math.tan(alpha) / (2 * TAN_H), 0.5 + Math.tan(beta) / (2 * TAN_V)];
  }

  /** APPROX: tamaños proporcionales al campo de visión (exacto en el centro de la imagen) */
  getAngularSizeFromImageSize(cameraIndex: number, imageSize: number[]): number[] {
    this.checkCamera('getAngularSizeFromImageSize', cameraIndex);
    return [imageSize[0] * CAMERA_HFOV, imageSize[1] * CAMERA_VFOV];
  }

  getImageSizeFromAngularSize(cameraIndex: number, angularSize: number[]): number[] {
    this.checkCamera('getImageSizeFromAngularSize', cameraIndex);
    return [angularSize[0] / CAMERA_HFOV, angularSize[1] / CAMERA_VFOV];
  }

  /** [alpha, beta, tamañoX, tamañoY] (como los extractores de visión) → [X, Y, ancho, alto] normalizados */
  getImageInfoFromAngularInfo(cameraIndex: number, angularInfo: number[]): number[] {
    const [x, y] = this.getImagePositionFromAngularPosition(cameraIndex, angularInfo.slice(0, 2));
    const [w, h] = this.getImageSizeFromAngularSize(cameraIndex, angularInfo.slice(2, 4));
    return [x, y, w, h];
  }

  /** Igual, en píxeles de la resolución pedida */
  getImageInfoFromAngularInfoWithResolution(cameraIndex: number, angularInfo: number[], resolutionIndex: number): number[] {
    this.checkResolution('getImageInfoFromAngularInfoWithResolution', cameraIndex, resolutionIndex);
    const { width, height } = RESOLUTIONS[resolutionIndex];
    const [x, y, w, h] = this.getImageInfoFromAngularInfo(cameraIndex, angularInfo);
    return [x * width, y * height, w * width, h * height];
  }

  // ─── Interno ────────────────────────────────────────────────────────────────

  /**
   * Una imagen nueva como mucho cada 1/fps: dentro de ese plazo se repite la anterior (mismo sello de tiempo),
   * como una cámara a esa frecuencia; además ahorra GPU si un script pide imágenes en un bucle sin pausa.
   */
  private image(stream: Stream, fps: number): ALImage | null {
    const { camera, resolution, colorSpace } = stream;
    if (!this.open[camera] || !this.started[camera]) return null;
    const now = performance.now() / 1000;
    if (stream.last && now - stream.lastAt < 1 / fps) return stream.last;
    const { width, height } = RESOLUTIONS[resolution];
    const rgba = this.source?.capture(camera, width, height);
    if (!rgba) return null;
    const values = this.params[camera];
    adjustImage(rgba, width, height, (id) => values.get(id) ?? 0);
    values.set(PARAM.averageLuminance, averageLuminance(rgba));
    const [sec, usec] = clock();
    const data = convertImage(rgba, width, height, colorSpace);
    const h = CAMERA_HFOV / 2;
    const v = CAMERA_VFOV / 2;
    stream.last = [width, height, COLOR_SPACES[colorSpace].layers, colorSpace, sec, usec, data, camera, h, -v, -h, v];
    stream.lastAt = now;
    return stream.last;
  }

  /** Un cambio de parámetros se ve en la siguiente imagen, sin esperar al plazo de fps */
  private invalidate(camera: number): void {
    for (const sub of this.subscribers.values()) for (const s of sub.streams) if (s.camera === camera) s.last = null;
  }

  private each<T>(method: string, sub: Subscriber, values: T[], set: (s: Stream, v: T) => void): boolean[] {
    if (!Array.isArray(values) || values.length !== sub.streams.length) {
      throw new NaoqiError(SERVICE, method, `se esperaba una lista de ${sub.streams.length} valores`);
    }
    return sub.streams.map((s, i) => {
      set(s, values[i]);
      s.last = null;
      return true;
    });
  }

  private sub(method: string, handle: string): Subscriber {
    const sub = this.subscribers.get(handle);
    if (!sub) throw new NaoqiError(SERVICE, method, `no hay ningún suscriptor "${handle}"`);
    return sub;
  }

  private checkCamera(method: string, camera: number): void {
    if (!NAO_CAMERAS.some((c) => c.index === camera)) throw new NaoqiError(SERVICE, method, `cámara inválida: ${camera} (0 = kTopCamera, 1 = kBottomCamera)`);
  }

  private checkResolution(method: string, camera: number, resolution: number): void {
    if (!RESOLUTIONS[resolution]) throw new NaoqiError(SERVICE, method, `resolución inválida: ${resolution}`);
    if (resolution === K16VGA && camera !== 0) throw new NaoqiError(SERVICE, method, 'k16VGA solo está disponible en la cámara de arriba');
  }

  private checkColorSpace(method: string, colorSpace: number): void {
    if (!COLOR_SPACES[colorSpace]) throw new NaoqiError(SERVICE, method, `espacio de color inválido: ${colorSpace}`);
  }

  private checkFps(method: string, fps: number, resolutions: number[]): void {
    const max = Math.min(...resolutions.map((r) => RESOLUTIONS[r]?.maxFps ?? 30));
    if (!Number.isInteger(fps) || fps < 1 || fps > max) throw new NaoqiError(SERVICE, method, `fps inválido: ${fps} (1 a ${max})`);
  }

  private checkParameter(method: string, id: number) {
    const p = CAMERA_PARAMETERS[id];
    if (!p) throw new NaoqiError(SERVICE, method, `parámetro de cámara inválido: ${id}`);
    return p;
  }
}
