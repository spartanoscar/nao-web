// Posturas predefinidas del NAO. Valores articulares de qiBullet (SoftBank Robotics, Apache-2.0),
// extraídos con scripts/extract-postures.py → reference/qibullet/nao_postures.json.
// Lista y familias: reference/naoqi-2.8-api/naoqi_motion_alrobotposture.md

import postureData from '../../reference/qibullet/nao_postures.json';
import { COUPLED, JOINTS } from '../robot/naoV6';
import type { BodySupport, RobotState } from '../robot/state';
import { BODY_FOOT_SUPPORT, BODY_PITCH, type MotionEngine, type MotionTask } from './engine';

export type PostureName = keyof typeof postureData;

const POSTURES: Readonly<Record<PostureName, Readonly<Record<string, number>>>> = postureData;

export const POSTURE_NAMES = Object.keys(POSTURES) as PostureName[];

const FAMILY: Record<PostureName, string> = {
  Stand: 'Standing',
  StandInit: 'Standing',
  StandZero: 'Standing',
  Crouch: 'Crouching',
  Sit: 'Sitting',
  SitRelax: 'Sitting',
  LyingBelly: 'LyingBelly',
  LyingBack: 'LyingBack',
};

export const POSTURE_FAMILIES = [...new Set(Object.values(FAMILY))];

// APPROX: en el robot real la orientación del torso sale de la gravedad. De pie y agachado manda el
// pie plano en el suelo; sentado y acostado, el cuerpo reposa donde su centro de masa es más bajo
// cerca de esta inclinación sugerida (la calcula NaoModel con las masas del URDF).
const SUPPORT: Record<PostureName, BodySupport> = {
  Stand: { footSupport: 1, pitch: 0 },
  StandInit: { footSupport: 1, pitch: 0 },
  StandZero: { footSupport: 1, pitch: 0 },
  Crouch: { footSupport: 1, pitch: 0 },
  Sit: { footSupport: 0, pitch: 0 },
  SitRelax: { footSupport: 0, pitch: -0.4 },
  LyingBelly: { footSupport: 0, pitch: Math.PI / 2 },
  LyingBack: { footSupport: 0, pitch: -Math.PI / 2 },
};

/** Nombre canónico (acepta mayúsculas/minúsculas distintas, como qiBullet) */
export function findPosture(name: string): PostureName | undefined {
  return POSTURE_NAMES.find((p) => p.toLowerCase() === String(name).toLowerCase());
}

export function postureJoints(name: PostureName): Readonly<Record<string, number>> {
  return POSTURES[name];
}

/** Mueve todo el cuerpo a la postura, sincronizado, a una fracción de la velocidad máxima */
export function moveToPosture(engine: MotionEngine, name: PostureName, speed: number): MotionTask {
  const support = SUPPORT[name];
  // RHipYawPitch es el mismo motor que LHipYawPitch: se comanda solo el izquierdo
  const joints = Object.fromEntries(Object.entries(POSTURES[name]).filter(([j]) => !(j in COUPLED)));
  // APPROX: las velocidades máximas del URDF son sin carga; el NAO real cambia de postura mucho más
  // despacio (~2 s de Crouch a StandInit a velocidad 0.5). Duración mínima = 1 s / speed.
  return engine.interpolateWithSpeed(
    { ...joints, [BODY_FOOT_SUPPORT]: support.footSupport, [BODY_PITCH]: support.pitch },
    speed,
    1 / Math.min(Math.max(speed, 0.1), 1),
  );
}

/**
 * Postura más cercana al estado actual. APPROX: ALRobotPosture usa joints + sensor inercial; aquí
 * el error máximo articular (sin manos) y la orientación del cuerpo.
 */
export function nearestPosture(state: RobotState): { name: PostureName; error: number } {
  let best: { name: PostureName; error: number } = { name: 'Crouch', error: Infinity };
  for (const name of POSTURE_NAMES) {
    let error = Math.abs(state.body.pitch - SUPPORT[name].pitch);
    for (const { name: joint } of JOINTS) {
      if (joint.endsWith('Hand')) continue;
      error = Math.max(error, Math.abs(state.get(joint) - POSTURES[name][joint]));
    }
    if (error < best.error) best = { name, error };
  }
  return best;
}

export function familyOf(name: PostureName): string {
  return FAMILY[name];
}
