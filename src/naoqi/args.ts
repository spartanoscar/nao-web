// Normalización de argumentos ALValue según las reglas de la doc de ALMotion
// (reference/naoqi-2.8-api/naoqi_motion_control-joint.md, "Case 2: Timed Interpolations"):
//   names = "HeadYaw",          angles = 1.0,                times = 1.0
//   names = "Head",             angles = [-1.0, -1.0],       times = 1.0          (un ángulo por joint)
//   names = "HeadYaw",          angles = [1.0, -1.0, 0.0],   times = [1, 2, 3]    (trayectoria)
//   names = ["HeadYaw", "HeadPitch"], angles = [[1, -1], [-1]], times = [[1, 2], [5]]

import { COUPLED, expandNames } from '../robot/naoV6';

export type ALValue = number | string | boolean | null | ALValue[];

export class NaoqiError extends Error {
  constructor(service: string, method: string, message: string) {
    super(`${service}::${method}: ${message}`);
    this.name = 'NaoqiError';
  }
}

const isNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isNumberList = (v: unknown): v is number[] => Array.isArray(v) && v.every(isNumber);

export function toNames(service: string, method: string, names: ALValue): string[] {
  const list = Array.isArray(names) ? names : [names];
  if (!list.every((n) => typeof n === 'string')) throw new NaoqiError(service, method, 'names debe ser string o lista de strings');
  try {
    return expandNames(list as string[]);
  } catch (e) {
    throw new NaoqiError(service, method, (e as Error).message);
  }
}

/** Un valor por joint: escalar (se repite) o lista del mismo largo que joints */
export function perJoint(service: string, method: string, what: string, joints: string[], value: ALValue): number[] {
  if (isNumber(value)) return joints.map(() => value);
  if (isNumberList(value) && value.length === joints.length) return value;
  throw new NaoqiError(service, method, `${what}: se esperaba un número o una lista de ${joints.length} números`);
}

/** Trayectorias por joint para angleInterpolation / stiffnessInterpolation */
export function trajectories(
  service: string,
  method: string,
  joints: string[],
  valueLists: ALValue,
  timeLists: ALValue,
): { values: number[]; times: number[] }[] {
  const fail = (msg: string): never => {
    throw new NaoqiError(service, method, msg);
  };
  const n = joints.length;

  let values: number[][];
  if (isNumber(valueLists)) values = joints.map(() => [valueLists]);
  else if (isNumberList(valueLists)) {
    if (n === 1) values = [valueLists];
    else if (valueLists.length === n) values = valueLists.map((v) => [v]);
    else values = fail(`se esperaban ${n} valores (uno por joint) y llegaron ${valueLists.length}`);
  } else if (Array.isArray(valueLists) && valueLists.length === n) {
    values = valueLists.map((v) => (isNumber(v) ? [v] : isNumberList(v) ? v : fail('valores: lista de listas de números')));
  } else values = fail(`se esperaban valores para ${n} joint(s)`);

  let times: number[][];
  if (isNumber(timeLists)) times = joints.map(() => [timeLists]);
  else if (isNumberList(timeLists)) {
    if (values.every((v) => v.length === timeLists.length)) times = joints.map(() => timeLists);
    else if (timeLists.length === n && values.every((v) => v.length === 1)) times = timeLists.map((t) => [t]);
    else times = fail('la lista de tiempos no coincide con la de valores');
  } else if (Array.isArray(timeLists) && timeLists.length === n) {
    times = timeLists.map((t) => (isNumber(t) ? [t] : isNumberList(t) ? t : fail('tiempos: lista de listas de números')));
  } else times = fail(`se esperaban tiempos para ${n} joint(s)`);

  return joints.map((joint, i) => {
    if (values[i].length !== times[i].length) fail(`${joint}: ${values[i].length} valores pero ${times[i].length} tiempos`);
    times[i].forEach((t, k) => {
      if (t <= 0 || (k > 0 && t <= times[i][k - 1])) fail(`${joint}: los tiempos deben ser > 0 y estrictamente crecientes`);
    });
    return { values: values[i], times: times[i] };
  });
}

/**
 * "LHipYawPitch and RHipYawPitch are physically just one motor [...] In case of conflicting orders,
 * LHipYawPitch always takes the priority." Devuelve los pares (joint real a mover, índice original).
 */
export function resolveCoupled(joints: string[]): { joint: string; index: number }[] {
  const out: { joint: string; index: number }[] = [];
  joints.forEach((name, index) => {
    const master = COUPLED[name];
    if (!master) out.push({ joint: name, index });
    else if (!joints.includes(master)) out.push({ joint: master, index });
  });
  return out;
}
