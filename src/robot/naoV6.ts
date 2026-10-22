// Especificación de los actuadores del NAO V6 según la documentación oficial NAOqi 2.8.
// Fuente: reference/naoqi-2.8-api/family_nao_technical_joints_naov6.md
// (los límites del URDF V5 difieren en milésimas; mandan los de V6).

export type ChainName = 'Head' | 'LArm' | 'LLeg' | 'RLeg' | 'RArm';

export interface JointSpec {
  name: string;
  chain: ChainName;
  /** rad (LHand/RHand: 0 = cerrada, 1 = abierta) */
  min: number;
  max: number;
  /** rad/s (manos: unidades/s). Del atributo velocity del URDF; la doc V6 no lo da. */
  maxVelocity: number;
}

const j = (name: string, chain: ChainName, min: number, max: number, maxVelocity: number): JointSpec => ({
  name, chain, min, max, maxVelocity,
});

/** Orden de ALMotion.getBodyNames("Body"): Head, LArm, LLeg, RLeg, RArm (26 nombres) */
export const JOINTS: readonly JointSpec[] = [
  j('HeadYaw', 'Head', -2.0857, 2.0857, 8.26797),
  j('HeadPitch', 'Head', -0.672, 0.5149, 7.19407),

  j('LShoulderPitch', 'LArm', -2.0857, 2.0857, 8.26797),
  j('LShoulderRoll', 'LArm', -0.3142, 1.3265, 7.19407),
  j('LElbowYaw', 'LArm', -2.0857, 2.0857, 8.26797),
  j('LElbowRoll', 'LArm', -1.5446, -0.0349, 7.19407),
  j('LWristYaw', 'LArm', -1.8238, 1.8238, 24.6229),
  j('LHand', 'LArm', 0, 1, 8.33),

  j('LHipYawPitch', 'LLeg', -1.145303, 0.74081, 4.16174),
  j('LHipRoll', 'LLeg', -0.379472, 0.790477, 4.16174),
  j('LHipPitch', 'LLeg', -1.535889, 0.48409, 6.40239),
  j('LKneePitch', 'LLeg', -0.092346, 2.112528, 6.40239),
  j('LAnklePitch', 'LLeg', -1.189516, 0.922747, 6.40239),
  j('LAnkleRoll', 'LLeg', -0.39788, 0.769001, 4.16174),

  // Mismo motor físico que LHipYawPitch (ver COUPLED)
  j('RHipYawPitch', 'RLeg', -1.145303, 0.74081, 4.16174),
  j('RHipRoll', 'RLeg', -0.790477, 0.379472, 4.16174),
  j('RHipPitch', 'RLeg', -1.535889, 0.48409, 6.40239),
  j('RKneePitch', 'RLeg', -0.103083, 2.120198, 6.40239),
  j('RAnklePitch', 'RLeg', -1.186448, 0.932056, 6.40239),
  j('RAnkleRoll', 'RLeg', -0.768992, 0.397935, 4.16174),

  j('RShoulderPitch', 'RArm', -2.0857, 2.0857, 8.26797),
  j('RShoulderRoll', 'RArm', -1.3265, 0.3142, 7.19407),
  j('RElbowYaw', 'RArm', -2.0857, 2.0857, 8.26797),
  j('RElbowRoll', 'RArm', 0.0349, 1.5446, 7.19407),
  j('RWristYaw', 'RArm', -1.8238, 1.8238, 24.6229),
  j('RHand', 'RArm', 0, 1, 8.33),
];

export const JOINT_BY_NAME: ReadonlyMap<string, JointSpec> = new Map(JOINTS.map((s) => [s.name, s]));

export const CHAINS: Readonly<Record<ChainName, readonly string[]>> = {
  Head: JOINTS.filter((s) => s.chain === 'Head').map((s) => s.name),
  LArm: JOINTS.filter((s) => s.chain === 'LArm').map((s) => s.name),
  LLeg: JOINTS.filter((s) => s.chain === 'LLeg').map((s) => s.name),
  RLeg: JOINTS.filter((s) => s.chain === 'RLeg').map((s) => s.name),
  RArm: JOINTS.filter((s) => s.chain === 'RArm').map((s) => s.name),
};

/**
 * "LHipYawPitch and RHipYawPitch are physically just one motor so they cannot be controlled
 * independently. In case of conflicting orders, LHipYawPitch always takes the priority."
 */
export const COUPLED: Readonly<Record<string, string>> = { RHipYawPitch: 'LHipYawPitch' };

/** 26 nombres de joint, 25 actuadores reales */
export const ACTUATOR_COUNT = JOINTS.length - Object.keys(COUPLED).length;

// Anti-colisión de la cabeza con la carcasa: el rango de HeadPitch depende de HeadYaw.
// Tabla oficial NAO V6 (rad). APPROX: la doc no dice cómo se interpola; usamos lineal.
const HEAD_YAW = [-2.086017, -1.526988, -1.089958, -0.903033, -0.756077, -0.486074, 0, 0.486074, 0.756077, 0.903033, 1.089958, 1.526988, 2.086017];
const HEAD_PITCH_MIN = [-0.449073, -0.330041, -0.430049, -0.479965, -0.548033, -0.671951, -0.671951, -0.671951, -0.548033, -0.479965, -0.430049, -0.330041, -0.449073];
const HEAD_PITCH_MAX = [0.330041, 0.200015, 0.300022, 0.330041, 0.37001, 0.422021, 0.515047, 0.422021, 0.37001, 0.330041, 0.300022, 0.200015, 0.330041];

export function headPitchLimits(headYaw: number): [number, number] {
  const yaw = Math.min(Math.max(headYaw, HEAD_YAW[0]), HEAD_YAW[HEAD_YAW.length - 1]);
  let i = 0;
  while (i < HEAD_YAW.length - 2 && yaw > HEAD_YAW[i + 1]) i++;
  const t = (yaw - HEAD_YAW[i]) / (HEAD_YAW[i + 1] - HEAD_YAW[i]);
  const lerp = (a: number[]) => a[i] + (a[i + 1] - a[i]) * t;
  return [lerp(HEAD_PITCH_MIN), lerp(HEAD_PITCH_MAX)];
}

/**
 * Motores del NAO V6 (reference/naoqi-2.8-api/family_nao_technical_motors_naov6.md): modelo, torque
 * de bloqueo, velocidad sin carga y reducción por joint. A la salida de la reductora:
 *   τ_stall = stall · reducción,  ω₀ = rpm_sin_carga · 2π/60 / reducción
 */
const MOTOR_TYPES = {
  t1: { model: '22NT Z13', stallMNm: 65, noLoadRpm: 8700 },
  t2: { model: '17N', stallMNm: 9.4, noLoadRpm: 8400 },
  t3: { model: '16GT', stallMNm: 14.3, noLoadRpm: 10700 },
  t4: { model: 'DCX 16S', stallMNm: 22.4, noLoadRpm: 11400 },
  t5: { model: '22NT Z20', stallMNm: 65, noLoadRpm: 8700 },
} as const;

const MOTOR_OF: Record<string, [keyof typeof MOTOR_TYPES, number]> = {
  HipYawPitch: ['t1', 201.3], HipRoll: ['t1', 201.3], AnkleRoll: ['t1', 201.3],
  WristYaw: ['t2', 50.61], Hand: ['t2', 36.24],
  HeadYaw: ['t3', 150.27], ElbowYaw: ['t3', 150.27],
  HeadPitch: ['t3', 173.22], ShoulderRoll: ['t3', 173.22], ElbowRoll: ['t3', 173.22],
  ShoulderPitch: ['t4', 150.27],
  HipPitch: ['t5', 130.85], KneePitch: ['t5', 130.85], AnklePitch: ['t5', 130.85],
};

export interface MotorSpec {
  model: string;
  /** Torque de bloqueo a la salida (N·m): el máximo que entrega el motor parado */
  stallTorque: number;
  /** Velocidad sin carga a la salida (rad/s): a esta velocidad el torque disponible es 0 */
  noLoadSpeed: number;
  /** Reducción de la caja de engranajes (velocidad del rotor = velocidad del joint × ratio) */
  ratio: number;
}

export function motorOf(joint: string): MotorSpec {
  const key = joint.startsWith('Head') ? joint : joint.slice(1);
  const entry = MOTOR_OF[key];
  if (!entry) throw new Error(`Sin motor documentado: ${joint}`);
  const [type, ratio] = entry;
  const m = MOTOR_TYPES[type];
  return { model: m.model, stallTorque: (m.stallMNm / 1000) * ratio, noLoadSpeed: (m.noLoadRpm * 2 * Math.PI) / 60 / ratio, ratio };
}

const GROUPS: Readonly<Record<string, readonly string[]>> = {
  ...CHAINS,
  Body: JOINTS.map((s) => s.name),
  Joints: JOINTS.map((s) => s.name),
  JointActuators: JOINTS.map((s) => s.name),
  Actuators: JOINTS.map((s) => s.name),
};

/**
 * Expande nombres de la API NAOqi: joint, cadena ("Head", "LArm"…) o grupo ("Body", "JointActuators",
 * "Joints", "Actuators"). Lanza error con un nombre desconocido, como ALMotion.
 */
export function expandNames(names: string | readonly string[]): string[] {
  const out: string[] = [];
  for (const n of typeof names === 'string' ? [names] : names) {
    const group = GROUPS[n] ?? (JOINT_BY_NAME.has(n) ? [n] : undefined);
    if (!group) throw new Error(`nombre de joint o cadena desconocido: "${n}"`);
    for (const g of group) if (!out.includes(g)) out.push(g);
  }
  return out;
}
