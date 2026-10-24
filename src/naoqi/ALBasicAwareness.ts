// ALBasicAwareness (doc reference/naoqi-2.8-api/naoqi_interaction_albasicawareness.md y -api.md): la "conciencia
// básica" de la vida autónoma. "The robot doesn't look for stimuli, but if he gets one (with its associated position),
// he processes this stimulus by looking at the origin of the stimulus and checking if there is a human there. If yes, he
// tracks the human, else, he goes back to its previous occupation." Estímulos que hay aquí: "Sound" (ALSoundLocalization,
// prioridad 4) y "Movement" (ALMovementDetection, 5). "People" y "Touch" no (no hay ALPeoplePerception ni ALTouch): nunca
// sigue a un humano, así que después de mirar vuelve (HumanTracked nunca ocurre). Un NAO que se sigue moviendo produce
// estímulos nuevos y la cabeza lo va siguiendo; quieto, el NAO vuelve a lo suyo, como el real.
//
// Pausa automática: "when the activity uses the head motors in any way… ALBasicAwareness is then considered of lower
// priority, and paused. It will be automatically resumed when the head motors are freed." Aquí: una curva en la cabeza
// (angleInterpolation, posturas, animaciones), un setAngles de la cabeza que no es suyo, la marcha, o sin rigidez en la
// cabeza (dormido). Solo modo de seguimiento "Head".
// APPROX: velocidades por defecto (LookStimulusSpeed 0.3, LookBackSpeed 0.15) y espera antes de volver (4 s).

import type { ALMotion } from './ALMotion';
import type { MotionEngine } from './engine';
import type { RobotState } from '../robot/state';
import type { ALMovementDetection, MovementCluster } from './ALMovementDetection';
import type { ALSoundLocalization, SoundLocated } from './ALSoundLocalization';

const STIMULI = ['People', 'Touch', 'TabletTouch', 'Sound', 'Movement', 'NavigationMotion'] as const;
type Stimulus = (typeof STIMULI)[number];
const ENGAGEMENT = ['Unengaged', 'FullyEngaged', 'SemiEngaged'];
const TRACKING = ['Head', 'BodyRotation', 'WholeBody', 'MoveContextually'];
const HEAD = ['HeadYaw', 'HeadPitch'];
const LOOK_HOLD = 4;
/** Un movimiento menor que esto en ángulo no vale un giro de cabeza (la imagen ya lo tiene casi al centro) */
const MIN_TURN = (4 * Math.PI) / 180;
const NAME = 'ALBasicAwareness';

export class ALBasicAwareness {
  private enabled = true;
  private manualPause = false;
  private engagement = 'Unengaged';
  private tracking = 'Head';
  private readonly detection = new Map<Stimulus, boolean>(STIMULI.map((s) => [s, ['People', 'Touch', 'TabletTouch', 'Sound', 'Movement'].includes(s)]));
  private readonly params: Record<string, number> = { LookStimulusSpeed: 0.3, LookBackSpeed: 0.15 };
  /** Mirando un estímulo: a dónde miraba antes (para volver), el objetivo que mandó y cuándo llegó el último estímulo */
  private looking: { home: [number, number]; target: [number, number]; at: number } | null = null;
  private readonly listeners = new Set<(stimulus: string) => void>();
  /** ALMemory ALBasicAwareness/StimulusDetected (último) */
  lastStimulus = '';

  constructor(
    private readonly motion: ALMotion,
    private readonly engine: MotionEngine,
    private readonly state: RobotState,
    movement: ALMovementDetection,
    sound: ALSoundLocalization,
  ) {
    movement.onMovement((clusters) => this.onMovement(clusters));
    sound.onSoundLocated((s) => this.onSound(s));
    sound.subscribe(NAME);
  }

  setEnabled(enabled: boolean): void {
    this.enabled = Boolean(enabled);
    if (!this.enabled) {
      this.manualPause = false; // doc: "If ALBasicAwareness is disabled while it is paused, the pause mode will exit"
      this.looking = null;
    }
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  /** "Started and not paused (neither manually nor automatically)" */
  isRunning(): boolean {
    return this.enabled && !this.manualPause && !this.autoPaused();
  }

  pauseAwareness(): void {
    this.manualPause = true;
  }

  resumeAwareness(): void {
    this.manualPause = false;
  }

  isAwarenessPaused(): boolean {
    return this.manualPause || this.autoPaused();
  }

  setStimulusDetectionEnabled(stimType: string, enable: boolean): void {
    if (!STIMULI.includes(stimType as Stimulus)) throw new Error(`${NAME}::setStimulusDetectionEnabled: estímulo desconocido "${stimType}"`);
    this.detection.set(stimType as Stimulus, Boolean(enable));
  }

  isStimulusDetectionEnabled(stimType: string): boolean {
    if (!STIMULI.includes(stimType as Stimulus)) throw new Error(`${NAME}::isStimulusDetectionEnabled: estímulo desconocido "${stimType}"`);
    return this.detection.get(stimType as Stimulus)!;
  }

  setEngagementMode(modeName: string): void {
    if (!ENGAGEMENT.includes(modeName)) throw new Error(`${NAME}::setEngagementMode: modo desconocido "${modeName}"`);
    this.engagement = modeName;
  }

  getEngagementMode(): string {
    return this.engagement;
  }

  setTrackingMode(trackingMode: string): void {
    if (!TRACKING.includes(trackingMode)) throw new Error(`${NAME}::setTrackingMode: modo desconocido "${trackingMode}"`);
    this.tracking = trackingMode; // APPROX: siempre se sigue solo con la cabeza
  }

  getTrackingMode(): string {
    return this.tracking;
  }

  setParameter(paramName: string, value: number): void {
    if (!(paramName in this.params)) throw new Error(`${NAME}::setParameter: parámetro desconocido "${paramName}"`);
    const v = Number(value);
    if (!(v > 0 && v <= 1)) throw new Error(`${NAME}::setParameter: ${paramName} va en ]0;1]`);
    this.params[paramName] = v;
  }

  getParameter(paramName: string): number {
    if (!(paramName in this.params)) throw new Error(`${NAME}::getParameter: parámetro desconocido "${paramName}"`);
    return this.params[paramName];
  }

  resetAllParameters(): void {
    Object.assign(this.params, { LookStimulusSpeed: 0.3, LookBackSpeed: 0.15 });
  }

  /** Sin ALPeoplePerception no hay personas que encontrar: -1 (doc: "or -1, if no human has been found") */
  engagePerson(): boolean {
    return false;
  }

  /** Doc: "Triggers a custom stimulus… with a higher priority". Posición en FRAME_WORLD (aquí, el mundo de la física) */
  triggerStimulus(positionFrameWorld: number[]): number {
    const root = this.state.root;
    if (!root || !this.isRunning()) return -1;
    const [w, x, y, z] = root.quaternion;
    const bodyYaw = Math.atan2(2 * (w * z + x * y), 1 - 2 * (y * y + z * z));
    const dx = positionFrameWorld[0] - root.position[0];
    const dy = positionFrameWorld[1] - root.position[1];
    const dz = (positionFrameWorld[2] ?? 0) - root.position[2] - 0.17;
    const yaw = Math.atan2(dy, dx) - bodyYaw;
    this.lookAt(Math.atan2(Math.sin(yaw), Math.cos(yaw)), -Math.atan2(dz, Math.hypot(dx, dy)), 'Custom');
    return -1;
  }

  // Deprecados desde 2.4 (doc): equivalen a setEnabled / isRunning
  startAwareness(): void {
    this.setEnabled(true);
  }

  stopAwareness(): void {
    this.setEnabled(false);
  }

  isAwarenessRunning(): boolean {
    return this.isRunning();
  }

  /** Extensión propia: escuchar ALBasicAwareness/StimulusDetected (falta el sistema de eventos de ALMemory) */
  onStimulus(fn: (stimulus: string) => void): () => void {
    this.listeners.add(fn);
    return () => void this.listeners.delete(fn);
  }

  /** ¿Vale la pena tomar imágenes para la detección de movimiento? (app.ts: solo entonces se captura la cámara) */
  wantsMovement(): boolean {
    return this.isRunning() && this.detection.get('Movement')!;
  }

  /** Cada ciclo del motor: volver a donde miraba si ya no llegan estímulos (falsa alarma: no hay un humano) */
  update(): void {
    if (!this.looking) return;
    if (!this.isRunning()) {
      this.looking = null; // otra actividad tomó la cabeza: ya no hay a dónde volver
      return;
    }
    if (this.engine.time - this.looking.at < LOOK_HOLD) return;
    const home = this.looking.home;
    this.looking = null;
    this.command(home, this.params.LookBackSpeed);
  }

  private autoPaused(): boolean {
    if (this.state.getStiffness('HeadYaw') < 0.5 || this.motion.moveIsActive()) return true;
    // La cabeza la usa otra actividad: una curva, o un setAngles que no es el último que mandó la conciencia básica
    const own = this.own;
    return HEAD.some((name, i) => {
      const a = this.engine.activity(name);
      return a !== null && (a.kind === 'curve' || !own || Math.abs(a.target - own[i]) > 1e-3);
    });
  }

  private onMovement(clusters: MovementCluster[]): void {
    if (!this.detection.get('Movement') || !clusters.length) return;
    const [ax, ay] = clusters[0].positionOfCog;
    if (Math.hypot(ax, ay) < MIN_TURN) {
      if (this.looking) this.looking.at = this.engine.time; // lo sigue teniendo al centro: sigue mirándolo
      return;
    }
    this.lookAt(this.state.get('HeadYaw') + ax, this.state.get('HeadPitch') + ay, 'Movement');
  }

  private onSound(s: SoundLocated): void {
    if (!this.detection.get('Sound')) return;
    this.lookAt(this.state.get('HeadYaw') + s.azimuth, this.state.get('HeadPitch') - s.elevation, 'Sound');
  }

  private lookAt(yaw: number, pitch: number, stimulus: string): void {
    if (!this.isRunning()) return;
    const home: [number, number] = this.looking?.home ?? [this.state.get('HeadYaw'), this.state.get('HeadPitch')];
    const target: [number, number] = [yaw, pitch];
    this.looking = { home, target, at: this.engine.time };
    this.command(target, this.params.LookStimulusSpeed);
    this.lastStimulus = stimulus;
    for (const fn of this.listeners) fn(stimulus);
  }

  /** Último objetivo que mandó a la cabeza (mirar o volver), tal como lo dejó el motor */
  private own: [number, number] | null = null;

  private command(target: [number, number], speed: number): void {
    this.motion.setAngles(HEAD, [Math.min(Math.max(target[0], -2.0857), 2.0857), target[1]], speed);
    // El motor recorta a los límites (HeadPitch según HeadYaw): el objetivo propio es el que quedó
    const own = HEAD.map((name, i) => {
      const a = this.engine.activity(name);
      return a?.kind === 'follow' ? a.target : target[i];
    }) as [number, number];
    this.own = own;
    if (this.looking) this.looking.target = own;
  }
}
