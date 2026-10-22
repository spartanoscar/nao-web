// LEDs del NAO V6: canales, nombres cortos y grupos tal como los define NAOqi 2.8.
// Fuentes: reference/naoqi-2.8-api/family_nao_technical_leds_naov6.md (hardware y ubicación)
//          reference/naoqi-2.8-api/naoqi_sensors_alleds.md (grupos, short names, names)
//   Ojos   2 × 8 RGB   Face/Led/{Red,Green,Blue}/{Left,Right}/{0..315}Deg/Actuator/Value
//   Orejas 2 × 10 azul Ears/Led/{Left,Right}/{0..324}Deg/Actuator/Value
//   Cabeza 12          Head/Led/{Front,Middle,Rear}/{Left,Right}/{n}/Actuator/Value  (Brain0..11)
//   Pecho  1 RGB       ChestBoard/Led/{Red,Green,Blue}/Actuator/Value
//   Pies   2 RGB       {L,R}Foot/Led/{Red,Green,Blue}/Actuator/Value

const COLORS = ['Red', 'Green', 'Blue'] as const;
const EYE_ANGLES = [0, 45, 90, 135, 180, 225, 270, 315];
const EAR_ANGLES = [0, 36, 72, 108, 144, 180, 216, 252, 288, 324];
const SIDES = ['Left', 'Right'] as const;

const face = (c: string, side: string, deg: number) => `Face/Led/${c}/${side}/${deg}Deg/Actuator/Value`;
const ear = (side: string, deg: number) => `Ears/Led/${side}/${deg}Deg/Actuator/Value`;
const chest = (c: string) => `ChestBoard/Led/${c}/Actuator/Value`;
const foot = (side: 'L' | 'R', c: string) => `${side}Foot/Led/${c}/Actuator/Value`;

/** Brain0..11 en el orden de la doc */
export const BRAIN = [
  'Head/Led/Front/Right/1/Actuator/Value',
  'Head/Led/Front/Right/0/Actuator/Value',
  'Head/Led/Middle/Right/0/Actuator/Value',
  'Head/Led/Rear/Right/0/Actuator/Value',
  'Head/Led/Rear/Right/1/Actuator/Value',
  'Head/Led/Rear/Right/2/Actuator/Value',
  'Head/Led/Rear/Left/2/Actuator/Value',
  'Head/Led/Rear/Left/1/Actuator/Value',
  'Head/Led/Rear/Left/0/Actuator/Value',
  'Head/Led/Middle/Left/0/Actuator/Value',
  'Head/Led/Front/Left/0/Actuator/Value',
  'Head/Led/Front/Left/1/Actuator/Value',
];

/** Los 89 canales (intensidad 0–1 cada uno) */
export const LED_CHANNELS: readonly string[] = [
  ...SIDES.flatMap((s) => EYE_ANGLES.flatMap((d) => COLORS.map((c) => face(c, s, d)))),
  ...SIDES.flatMap((s) => EAR_ANGLES.map((d) => ear(s, d))),
  ...BRAIN,
  ...COLORS.map(chest),
  ...(['L', 'R'] as const).flatMap((s) => COLORS.map((c) => foot(s, c))),
];

const CHANNEL_SET = new Set(LED_CHANNELS);

// ─── Nombres cortos ─────────────────────────────────────────────────────────────
const short: Record<string, string[]> = {};
EYE_ANGLES.forEach((d, i) => {
  short[`LeftFaceLed${i + 1}`] = COLORS.map((c) => face(c, 'Left', d));
  short[`RightFaceLed${i + 1}`] = COLORS.map((c) => face(c, 'Right', d));
});
EAR_ANGLES.forEach((d, i) => {
  short[`LeftEarLed${i + 1}`] = [ear('Left', d)];
  short[`RightEarLed${i + 1}`] = [ear('Right', d)];
});
BRAIN.forEach((n, i) => (short[`Brain${i}`] = [n]));
COLORS.forEach((c) => {
  short[`ChestLeds${c}`] = [chest(c)];
  short[`LeftFootLeds${c}`] = [foot('L', c)];
  short[`RightFootLeds${c}`] = [foot('R', c)];
});

// ─── Grupos ─────────────────────────────────────────────────────────────────────
const eyes = (side: string, degs: number[] = EYE_ANGLES, colors: readonly string[] = COLORS) =>
  degs.flatMap((d) => colors.map((c) => face(c, side, d)));
const ears = (side: string, degs: number[] = EAR_ANGLES) => degs.map((d) => ear(side, d));
const brain = (idx: number[]) => idx.map((i) => BRAIN[i]);

// APPROX: la doc lista los grupos Top/Bottom/External/Internal (ojos) y Front/Back (orejas) sin
// decir qué segmentos incluyen; se reparten por cuadrantes (0° = arriba, 90° = hacia fuera / delante).
const EYE_QUADRANT = { Top: [315, 0], External: [45, 90], Bottom: [135, 180], Internal: [225, 270] };
const EAR_FRONT = [0, 36, 72, 108, 144];
const EAR_BACK = [180, 216, 252, 288, 324];

const groups: Record<string, string[]> = {
  AllLeds: [...LED_CHANNELS],
  ...Object.fromEntries(COLORS.map((c) => [`AllLeds${c}`, LED_CHANNELS.filter((n) => n.includes(`/${c}/`))])),
  BrainLeds: [...BRAIN],
  BrainLedsFront: BRAIN.filter((n) => n.includes('/Front/')),
  BrainLedsMiddle: BRAIN.filter((n) => n.includes('/Middle/')),
  BrainLedsBack: BRAIN.filter((n) => n.includes('/Rear/')),
  BrainLedsLeft: brain([6, 7, 8, 9, 10, 11]),
  BrainLedsRight: brain([0, 1, 2, 3, 4, 5]),
  EarLeds: [...ears('Left'), ...ears('Right')],
  LeftEarLeds: ears('Left'),
  RightEarLeds: ears('Right'),
  LeftEarLedsFront: ears('Left', EAR_FRONT),
  LeftEarLedsBack: ears('Left', EAR_BACK),
  RightEarLedsFront: ears('Right', EAR_FRONT),
  RightEarLedsBack: ears('Right', EAR_BACK),
  LeftEarLedsEven: ears('Left', EAR_ANGLES.filter((_, i) => i % 2 === 1)),
  LeftEarLedsOdd: ears('Left', EAR_ANGLES.filter((_, i) => i % 2 === 0)),
  RightEarLedsEven: ears('Right', EAR_ANGLES.filter((_, i) => i % 2 === 1)),
  RightEarLedsOdd: ears('Right', EAR_ANGLES.filter((_, i) => i % 2 === 0)),
  FaceLeds: [...eyes('Left'), ...eyes('Right')],
  LeftFaceLeds: eyes('Left'),
  RightFaceLeds: eyes('Right'),
  ...Object.fromEntries(COLORS.flatMap((c) => [[`LeftFaceLeds${c}`, eyes('Left', EYE_ANGLES, [c])], [`RightFaceLeds${c}`, eyes('Right', EYE_ANGLES, [c])]])),
  ...Object.fromEntries(
    Object.entries(EYE_QUADRANT).flatMap(([q, degs]) => [
      [`FaceLeds${q}`, [...eyes('Left', degs), ...eyes('Right', degs)]],
      [`FaceLedsLeft${q}`, eyes('Left', degs)],
      [`FaceLedsRight${q}`, eyes('Right', degs)],
    ]),
  ),
  ChestLeds: COLORS.map(chest),
  FeetLeds: (['L', 'R'] as const).flatMap((s) => COLORS.map((c) => foot(s, c))),
  LeftFootLeds: COLORS.map((c) => foot('L', c)),
  RightFootLeds: COLORS.map((c) => foot('R', c)),
};
// FaceLedN: ambos ojos de forma simétrica (Right a 315−45N, Left a 45N), FaceLedRightN / FaceLedLeftN
for (let n = 0; n < 8; n++) {
  groups[`FaceLedRight${n}`] = eyes('Right', [315 - 45 * n]);
  groups[`FaceLedLeft${n}`] = eyes('Left', [45 * n]);
  groups[`FaceLed${n}`] = [...groups[`FaceLedRight${n}`], ...groups[`FaceLedLeft${n}`]];
}

export const LED_GROUPS: Readonly<Record<string, readonly string[]>> = groups;
export const LED_SHORT_NAMES: Readonly<Record<string, readonly string[]>> = short;

/** Expande un nombre de LED, nombre corto o grupo a sus canales; null si no existe */
export function expandLed(name: string): string[] | null {
  if (CHANNEL_SET.has(name)) return [name];
  const list = groups[name] ?? short[name];
  return list ? [...list] : null;
}

export function createLedGroup(name: string, channels: string[]): void {
  groups[name] = channels.flatMap((c) => expandLed(c) ?? []);
}

/**
 * Estado por defecto del simulador (ALLeds.reset). APPROX: el estado real depende de Autonomous
 * Life; se usa el aspecto típico de las fotos del NAO encendido: ojos blanco-azulados, orejas y
 * cabeza azules, pecho blanco, pies apagados.
 */
export function defaultIntensity(channel: string): number {
  if (channel.startsWith('Face/')) return channel.includes('/Blue/') ? 1 : 0.82;
  if (channel.startsWith('Ears/')) return 1;
  if (channel.startsWith('Head/')) return 0.75;
  if (channel.startsWith('ChestBoard/')) return 0.55; // tenue: deja ver el logo del botón
  return 0;
}

/** Intensidades actuales de los 89 canales */
export class LedState {
  private readonly values = new Map<string, number>(LED_CHANNELS.map((c) => [c, defaultIntensity(c)]));
  revision = 0;

  get(channel: string): number {
    return this.values.get(channel) ?? 0;
  }

  set(channel: string, value: number): void {
    if (!CHANNEL_SET.has(channel)) return;
    const v = Math.min(Math.max(value, 0), 1);
    if (this.values.get(channel) === v) return;
    this.values.set(channel, v);
    this.revision++;
  }
}
