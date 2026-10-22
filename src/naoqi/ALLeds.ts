// ALLeds: LEDs de ojos, orejas, cabeza, pecho y pies. Misma firma que NAOqi 2.8.
// Docs: reference/naoqi-2.8-api/naoqi_sensors_alleds-api.md, naoqi_sensors_alleds.md
// Las llamadas bloqueantes (fade*, animaciones) devuelven una Promise que se resuelve al terminar.

import {
  LED_CHANNELS,
  LED_GROUPS,
  LED_SHORT_NAMES,
  type LedState,
  createLedGroup,
  defaultIntensity,
  expandLed,
} from '../robot/leds';
import { NaoqiError } from './args';

const SERVICE = 'ALLeds';

/** Colores con nombre de fadeRGB(name, colorName, duration) */
const NAMED_COLORS: Record<string, number> = {
  white: 0xffffff, red: 0xff0000, green: 0x00ff00, blue: 0x0000ff,
  yellow: 0xffff00, magenta: 0xff00ff, cyan: 0x00ffff,
};

interface Tween {
  from: number;
  to: number;
  t0: number;
  t1: number;
}

/** Canales RGB de un LED a partir de su nombre: Red/Green/Blue en la ruta */
const channelColor = (ch: string): 0 | 1 | 2 | null =>
  ch.includes('/Red/') ? 0 : ch.includes('/Green/') ? 1 : ch.includes('/Blue/') ? 2 : null;

const rgbOf = (hex: number): [number, number, number] => [((hex >> 16) & 255) / 255, ((hex >> 8) & 255) / 255, (hex & 255) / 255];

export class ALLeds {
  private time = 0;
  private readonly tweens = new Map<string, Tween>();
  private readonly agenda: { at: number; fn: () => void }[] = [];
  /** Animaciones en curso (rasta, rotateEyes…) y los canales que tocan: un comando nuevo las corta */
  private readonly animations = new Set<{ channels: Set<string>; cancelled: boolean }>();

  constructor(private readonly leds: LedState) {}

  /** Avanza fundidos y animaciones: llamar en cada frame */
  update(dt: number): void {
    this.time += dt;
    for (const [ch, tw] of this.tweens) {
      const s = tw.t1 <= tw.t0 ? 1 : Math.min((this.time - tw.t0) / (tw.t1 - tw.t0), 1);
      this.leds.set(ch, tw.from + (tw.to - tw.from) * s);
      if (s >= 1) this.tweens.delete(ch);
    }
    while (this.agenda.length && this.agenda[0].at <= this.time) this.agenda.shift()!.fn();
  }

  // ─── Intensidad ─────────────────────────────────────────────────────────────

  /** Inmediato */
  setIntensity(name: string, intensity: number): void {
    for (const ch of this.resolve('setIntensity', name)) this.fadeChannel(ch, intensity, 0);
  }

  getIntensity(name: string): number | number[] {
    const chs = this.resolve('getIntensity', name);
    const v = chs.map((c) => this.leds.get(c));
    return v.length === 1 ? v[0] : v;
  }

  on(name: string): void {
    this.setIntensity(name, 1);
  }

  off(name: string): void {
    this.setIntensity(name, 0);
  }

  /** Blocking. Funde a la intensidad dada en `duration` s. */
  fade(name: string, intensity: number, duration: number): Promise<void> {
    const chs = this.resolve('fade', name);
    for (const ch of chs) this.fadeChannel(ch, intensity, duration);
    return this.sleep(duration);
  }

  /**
   * Blocking. Tres sobrecargas como en NAOqi:
   *   fadeRGB(name, red, green, blue, duration) · fadeRGB(name, "white", duration) · fadeRGB(name, 0x00RRGGBB, duration)
   */
  fadeRGB(name: string, a: number | string, b: number, c?: number, d?: number): Promise<void> {
    let rgb: [number, number, number];
    let duration: number;
    if (typeof a === 'string') {
      const hex = NAMED_COLORS[a.toLowerCase()];
      if (hex === undefined) throw new NaoqiError(SERVICE, 'fadeRGB', `color desconocido "${a}"`);
      rgb = rgbOf(hex);
      duration = b;
    } else if (c === undefined) {
      rgb = rgbOf(a);
      duration = b;
    } else {
      rgb = [a, b, c];
      duration = d ?? 0;
    }
    for (const ch of this.resolve('fadeRGB', name)) {
      const k = channelColor(ch);
      // LEDs de un solo color (orejas, cabeza): usan el canal azul / la intensidad máxima del color
      this.fadeChannel(ch, k === null ? Math.max(...rgb) : rgb[k], duration);
    }
    return this.sleep(duration);
  }

  /** Blocking. Secuencia de colores 0x00RRGGBB en tiempos absolutos (s desde ahora). */
  async fadeListRGB(name: string, rgbList: number[], timeList: number[]): Promise<void> {
    if (rgbList.length !== timeList.length) throw new NaoqiError(SERVICE, 'fadeListRGB', 'rgbList y timeList deben tener el mismo largo');
    let prev = 0;
    for (let i = 0; i < rgbList.length; i++) {
      await this.fadeRGB(name, rgbList[i], Math.max(timeList[i] - prev, 0));
      prev = timeList[i];
    }
  }

  /** "Set a LED or Group of LEDs to their default state." */
  reset(name: string): void {
    for (const ch of this.resolve('reset', name)) this.fadeChannel(ch, defaultIntensity(ch), 0);
  }

  // ─── Animaciones ────────────────────────────────────────────────────────────

  /** Blocking. Rotación de un color por los segmentos de ambos ojos. */
  rotateEyes(rgb: number, timeForRotation: number, totalDuration: number): Promise<void> {
    const [r, g, b] = rgbOf(rgb);
    const step = Math.max(timeForRotation, 0.08) / 8;
    return this.animate('FaceLeds', totalDuration, step, (k) => {
      for (let n = 0; n < 8; n++) {
        const lit = n === k % 8 ? 1 : n === (k + 7) % 8 ? 0.35 : 0; // segmento actual y estela
        this.paintEyeSegment(n, r * lit, g * lit, b * lit, step * 0.8);
      }
    });
  }

  /** Blocking. Colores aleatorios en los ojos. */
  randomEyes(duration: number): Promise<void> {
    return this.animate('FaceLeds', duration, 0.2, () => {
      for (const ch of LED_GROUPS.FaceLeds) this.fadeChannel(ch, Math.random(), 0.18);
    });
  }

  /** Blocking. Animación rasta (rojo, amarillo, verde) en ojos y orejas. */
  rasta(duration: number): Promise<void> {
    const palette = [0xff0000, 0xffcc00, 0x00cc00];
    return this.animate('AllLeds', duration, 0.15, (k) => {
      for (let n = 0; n < 8; n++) {
        const [r, g, b] = rgbOf(palette[(n + k) % 3]);
        this.paintEyeSegment(n, r, g, b, 0.12);
      }
      LED_GROUPS.EarLeds.forEach((ch, i) => this.fadeChannel(ch, (i + k) % 3 === 0 ? 1 : 0.15, 0.12));
    });
  }

  /** Blocking. "An animation to show a direction with the ears." 0 = arriba, 90 = delante, 180 = abajo, 270 = atrás. */
  async earLedsSetAngle(degrees: number, duration: number, leaveOnAtEnd: boolean): Promise<void> {
    const deg = ((Math.round(degrees / 36) * 36) % 360 + 360) % 360;
    const lit = new Set([`Ears/Led/Left/${deg}Deg/Actuator/Value`, `Ears/Led/Right/${deg}Deg/Actuator/Value`]);
    this.cancelAnimations(new Set(LED_GROUPS.EarLeds));
    for (const ch of LED_GROUPS.EarLeds) this.fadeChannel(ch, lit.has(ch) ? 1 : 0, Math.min(duration, 0.2));
    await this.sleep(duration);
    if (!leaveOnAtEnd) for (const ch of lit) this.fadeChannel(ch, 0, 0.2);
  }

  // ─── Grupos y listas ────────────────────────────────────────────────────────

  createGroup(groupName: string, ledNames: string[]): void {
    createLedGroup(groupName, ledNames);
  }

  listGroup(groupName: string): string[] {
    const g = LED_GROUPS[groupName];
    if (!g) throw new NaoqiError(SERVICE, 'listGroup', `grupo desconocido "${groupName}"`);
    return [...g];
  }

  listGroups(): string[] {
    return Object.keys(LED_GROUPS);
  }

  /** Nombres de dispositivo de un nombre corto o LED */
  listLED(name: string): string[] {
    return [...(LED_SHORT_NAMES[name] ?? expandLed(name) ?? [])];
  }

  listLEDs(): string[] {
    return [...LED_CHANNELS];
  }

  // ─── Internos ───────────────────────────────────────────────────────────────

  private resolve(method: string, name: string): string[] {
    const chs = expandLed(name);
    if (!chs) throw new NaoqiError(SERVICE, method, `LED o grupo desconocido "${name}"`);
    this.cancelAnimations(new Set(chs));
    return chs;
  }

  private fadeChannel(ch: string, to: number, duration: number): void {
    const target = Math.min(Math.max(to, 0), 1);
    if (duration <= 0) {
      this.tweens.delete(ch);
      this.leds.set(ch, target);
      return;
    }
    this.tweens.set(ch, { from: this.leds.get(ch), to: target, t0: this.time, t1: this.time + duration });
  }

  /** Segmento n (0–7, numeración simétrica FaceLedN) de ambos ojos */
  private paintEyeSegment(n: number, r: number, g: number, b: number, duration: number): void {
    for (const ch of LED_GROUPS[`FaceLed${n}`]) {
      const k = channelColor(ch)!;
      this.fadeChannel(ch, [r, g, b][k], duration);
    }
  }

  private sleep(seconds: number): Promise<void> {
    return new Promise((resolve) => {
      this.agenda.push({ at: this.time + Math.max(seconds, 0), fn: resolve });
      this.agenda.sort((a, b) => a.at - b.at);
    });
  }

  private async animate(group: string, duration: number, step: number, frame: (k: number) => void): Promise<void> {
    const channels = new Set(LED_GROUPS[group]);
    this.cancelAnimations(channels);
    const anim = { channels, cancelled: false };
    this.animations.add(anim);
    const end = this.time + Math.max(duration, 0);
    for (let k = 0; this.time < end && !anim.cancelled; k++) {
      frame(k);
      await this.sleep(step);
    }
    this.animations.delete(anim);
    if (!anim.cancelled) for (const ch of channels) this.fadeChannel(ch, defaultIntensity(ch), 0.3);
  }

  private cancelAnimations(channels: Set<string>): void {
    for (const a of this.animations) {
      if ([...channels].some((c) => a.channels.has(c))) {
        a.cancelled = true;
        this.animations.delete(a);
      }
    }
  }
}
