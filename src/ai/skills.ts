// Habilidades del NAO para el cerebro (server/prompt.go declara las mismas, con el mismo nombre). Cada una se
// arma con la API de NAOqi, como lo haría un programa en el robot real, y devuelve un resultado corto para que
// Gemini decida el siguiente paso ({ ok, … }); las que miran devuelven además una foto.

import type { Session } from '../naoqi/session';
import { MOTIONS, playMotion } from '../naoqi/motionFile';
import { wrapAngle } from '../naoqi/moveTo';
import { postureJoints } from '../naoqi/postures';
import { WALK_POSE } from '../naoqi/walk';
import { invertRigid, multiply } from '../robot/kinematics';
import { CHAINS } from '../robot/naoV6';
import type { Snapshot, Vision } from './vision';

export interface SkillResult {
  response: Record<string, unknown>;
  image?: Snapshot;
}

/** Apariencia guardada del NAO ("#rrggbb" o "" = la de fábrica) */
export interface Appearance {
  shell: string;
  eyes: string;
}

export interface SkillContext {
  session: Session;
  vision: Vision;
  /** El turno se canceló (la persona dijo otra cosa): no seguir */
  cancelled(): boolean;
  /** Cambia y guarda la apariencia (carcasa y ojos) del NAO del usuario */
  appearance?: (patch: Partial<Appearance>) => Promise<Appearance>;
}

type Args = Record<string, unknown>;

const DEG = Math.PI / 180;
/** Distancia del torso al borde del objeto al llegar con approach: deja las puntas de los pies a ~8 cm */
const APPROACH_GAP = 0.18;
/** Del sonar del pecho a la punta de los pies (APPROX, igual que ALMotion SONAR_TO_FRONT) */
const SONAR_TO_TOES = 0.1;
const SONAR_KEYS = ['Device/SubDeviceList/US/Left/Sensor/Value', 'Device/SubDeviceList/US/Right/Sensor/Value'];
/** Más lejos que esto, approach llega a medio camino y pide mirar de nuevo (la caja de lejos es imprecisa) */
const APPROACH_LEG = 1.2;
const APPROACH_MAX = 5;
const ANIMATIONS = ['HandWave', 'Shoot', 'TaiChi', 'WipeForehead'];
const POSTURES = ['Stand', 'StandInit', 'Sit', 'SitRelax', 'Crouch'];
const LED_GROUPS: Record<string, string> = { eyes: 'FaceLeds', ears: 'EarLeds', chest: 'ChestLeds', feet: 'FeetLeds', head: 'BrainLeds', all: 'AllLeds' };
/** Paleta libre: "#rrggbb" (también se aceptan los nombres de fadeRGB) → 0x00RRGGBB */
const NAMED = { white: 0xffffff, red: 0xff0000, green: 0x00ff00, blue: 0x0000ff, yellow: 0xffff00, magenta: 0xff00ff, cyan: 0x00ffff } as Record<string, number>;
const parseColor = (v: unknown): number | null => {
  const t = String(v ?? '').trim().toLowerCase();
  if (/^#[0-9a-f]{6}$/.test(t)) return parseInt(t.slice(1), 16);
  return NAMED[t] ?? null;
};
const hexOf = (n: number) => `#${n.toString(16).padStart(6, '0')}`;
/** Gestos de cabeza: [HeadYaw, HeadPitch] por keyframe y sus tiempos (s) */
const GESTURES: Record<string, { yaw: number[]; pitch: number[]; times: number[] }> = {
  nod: { yaw: [0, 0, 0, 0, 0], pitch: [0.35, -0.05, 0.35, -0.05, 0], times: [0.3, 0.6, 0.9, 1.2, 1.5] },
  shake: { yaw: [0.5, -0.5, 0.45, -0.45, 0], pitch: [0, 0, 0, 0, 0], times: [0.35, 0.8, 1.25, 1.7, 2] },
  look_around: { yaw: [1, 1, -1, -1, 0], pitch: [0, 0, 0, 0, 0], times: [1, 1.6, 3, 3.6, 4.4] },
  doubt: { yaw: [0.35, 0.35, 0], pitch: [-0.2, -0.2, 0], times: [0.5, 1.5, 2.1] },
};

/**
 * Poses de los brazos (brazo izquierdo, rad; el derecho es el espejo: roll y codo con signo opuesto). Dentro de los
 * límites del URDF. "down" = los brazos de StandInit (qiBullet) y le devuelve los brazos a la marcha.
 */
const ARM_POSES: Record<string, { ShoulderPitch: number; ShoulderRoll: number; ElbowYaw: number; ElbowRoll: number; WristYaw: number }> = {
  front: { ShoulderPitch: 0, ShoulderRoll: 0.05, ElbowYaw: -1.39, ElbowRoll: -0.04, WristYaw: 0 },
  high_front: { ShoulderPitch: -0.55, ShoulderRoll: 0.05, ElbowYaw: -1.39, ElbowRoll: -0.04, WristYaw: 0 },
  up: { ShoulderPitch: -1.5, ShoulderRoll: 0.1, ElbowYaw: -1.39, ElbowRoll: -0.04, WristYaw: 0 },
  open: { ShoulderPitch: 0.2, ShoulderRoll: 1.3, ElbowYaw: -1.39, ElbowRoll: -0.04, WristYaw: 0 },
};
const STAND_INIT = postureJoints('StandInit');
/** Eje de HeadYaw/HeadPitch sobre el torso (URDF: 0.1265 m) y altura aproximada de las cámaras sobre él */
const HEAD_PIVOT_Z = 0.1265;
const CAMERA_ABOVE_PIVOT = 0.05;
const LEGS = [...CHAINS.LLeg, ...CHAINS.RLeg];
/** Piernas listas para caminar: en StandInit o en la pose de marcha (rad, el joint más alejado) */
const LEGS_READY = 0.15;

const num = (v: unknown, fallback = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);
const round = (v: number, d = 2) => Math.round(v * 10 ** d) / 10 ** d;

export async function runSkill(name: string, args: Args, ctx: SkillContext): Promise<SkillResult> {
  const { session, vision } = ctx;
  const motion = session.service('ALMotion');
  const posture = session.service('ALRobotPosture');
  // Marcha segura de NAOqi: si durante esta habilidad la detiene un obstáculo (sonar), se dice cuál y a qué distancia
  const failures = motion.moveFailures;
  const blockedAt = (): number | null => {
    if (motion.moveFailures === failures || !motion.lastMoveFailure) return null;
    const [ox, oy] = motion.lastMoveFailure[2];
    const [x, y] = motion.getRobotPosition(true);
    return round(Math.max(0, Math.hypot(ox - x, oy - y) - SONAR_TO_TOES));
  };

  const where = () => {
    const [x, y, theta] = motion.getRobotPosition(true);
    return { posicion: { x: round(x), y: round(y) }, rumbo_grados: Math.round(theta / DEG) };
  };
  /** Dónde están las manos (propiocepción: getPosition en FRAME_ROBOT, con los sensores), en metros */
  const hands = () => {
    const at = (chain: string) => {
      const [x, y, z] = motion.getPosition(chain, 2, true);
      return { adelante_m: round(x), izquierda_m: round(y), altura_m: round(z) };
    };
    return { manos: { izquierda: at('LArm'), derecha: at('RArm') } };
  };
  const armSides = (side: unknown) => (side === 'left' ? ['L'] : side === 'right' ? ['R'] : ['L', 'R']);
  /** Saca de la marcha los brazos que se van a mover (setMoveArmsEnabled), para que se queden donde se ponen */
  const holdArms = (sides: string[]) =>
    motion.setMoveArmsEnabled(sides.includes('L') ? false : motion.getMoveArmsEnabled('LArm'), sides.includes('R') ? false : motion.getMoveArmsEnabled('RArm'));

  /**
   * Listo para caminar, como en todos los ejemplos oficiales de ALMotion (walk-api): goToPosture("StandInit", 0.5)
   * antes de moverse. Desde el suelo o sentado, goToPosture primero lo levanta. false si no lo logra.
   */
  /**
   * Motores encendidos en todo el cuerpo. wakeUp no hace nada si algún motor ya tiene stiffness (doc: "If the robot is
   * already stiffened, the call returns True immediately"): con solo la cabeza encendida las piernas quedaban flojas.
   */
  const wakeLegs = async () => {
    if (!motion.robotIsWakeUp()) await motion.wakeUp();
    else if (Math.min(...motion.getStiffnesses(LEGS)) < 0.9) motion.setStiffnesses('Body', 1);
  };
  const standUp = async (): Promise<boolean> => {
    await wakeLegs();
    // De pie con las piernas ya listas no hace falta (y goToPosture le bajaría los brazos si los tiene al frente)
    const near = (pose: Record<string, number>) => LEGS.every((j) => !(j in pose) || Math.abs(motion.getAngles(j, true)[0] - pose[j]) < LEGS_READY);
    if (posture.getPostureFamily() === 'Standing' && (near(STAND_INIT) || near(WALK_POSE))) return true;
    const ok = await posture.goToPosture('StandInit', 0.5);
    // goToPosture mueve todo el cuerpo: los brazos vuelven a la marcha
    if (ok) motion.setMoveArmsEnabled(true, true);
    return ok;
  };
  /** Caído = el torso acostado según la IMU (familias Lying*); una pose rara de pie (p. ej. tras patear) no lo es */
  const fallen = () => posture.getPostureFamily().startsWith('Lying');
  const notStanding = () => ({ ok: false, error: `no pude ponerme de pie: ${posture.lastFailure || posture.getPostureFamily()}` });
  const moveResult = (ok: boolean, extra: Args = {}) => {
    const blocked = blockedAt();
    const why = fallen()
      ? 'me caí'
      : blocked !== null
        ? `me detuve antes de chocar: mi sonar detecta algo sólido a ${blocked} m al frente y la marcha segura no deja avanzar más hacia allá. Mira qué es: si es algo que sabes que no es peligroso (una rampa, un escalón bajo, una pared al costado, algo que quieres tocar), apaga la marcha segura con safe_walk, sigue y vuelve a encenderla al terminar`
        : 'me interrumpieron o no llegué';
    return { ok, ...extra, ...where(), ...(ok ? {} : { postura: posture.getPostureFamily(), nota: why }) };
  };
  /** moveTo acepta theta en ]-π, π]: los giros más grandes van en dos tramos */
  const turnBy = async (rad: number): Promise<boolean> => {
    while (Math.abs(rad) > Math.PI) {
      const part = Math.sign(rad) * Math.PI * 0.9;
      if (!(await motion.moveTo(0, 0, part)) || ctx.cancelled()) return false;
      rad -= part;
    }
    return motion.moveTo(0, 0, rad);
  };

  switch (name) {
    case 'walk': {
      if (!(await standUp())) return { response: notStanding() };
      const ok = await motion.moveTo(num(args.forward_m), num(args.left_m), wrapAngle(num(args.turn_deg) * DEG));
      return { response: moveResult(ok) };
    }
    case 'turn': {
      if (!(await standUp())) return { response: notStanding() };
      return { response: moveResult(await turnBy(num(args.degrees) * DEG)) };
    }
    case 'go_to': {
      if (!(await standUp())) return { response: notStanding() };
      const [x, y, theta] = motion.getRobotPosition(true);
      const [dx, dy] = [num(args.x, x) - x, num(args.y, y) - y];
      const [c, s] = [Math.cos(theta), Math.sin(theta)];
      const heading = typeof args.heading_deg === 'number' ? wrapAngle(args.heading_deg * DEG - theta) : wrapAngle(Math.atan2(dy, dx) - theta);
      const ok = await motion.moveTo(c * dx + s * dy, -s * dx + c * dy, Math.hypot(dx, dy) < 0.05 && typeof args.heading_deg !== 'number' ? 0 : heading);
      return { response: moveResult(ok) };
    }
    case 'approach': {
      const box = Array.isArray(args.box_2d) ? args.box_2d.map(Number) : [];
      const goal = vision.groundPoint(box);
      if (!goal) return { response: { ok: false, error: 'esa caja no toca el suelo en la última imagen; mira de nuevo (look o scan)' } };
      if (!(await standUp())) return { response: notStanding() };
      const [x, y, theta] = motion.getRobotPosition(true);
      const [dx, dy] = [goal.x - x, goal.y - y];
      const dist = Math.hypot(dx, dy);
      if (dist > APPROACH_MAX) return { response: { ok: false, error: `está a unos ${round(dist, 1)} m: demasiado lejos para ir de una` } };
      const partial = dist - APPROACH_GAP > APPROACH_LEG;
      const walk = partial ? dist - APPROACH_GAP - APPROACH_LEG / 2 : Math.max(dist - APPROACH_GAP, 0);
      const bearing = Math.atan2(dy, dx) - theta;
      const ok = await motion.moveTo(Math.cos(bearing) * walk, Math.sin(bearing) * walk, wrapAngle(bearing));
      if (ctx.cancelled()) return { response: moveResult(false) };
      await new Promise((r) => setTimeout(r, 300));
      const image = vision.view();
      // La marcha segura lo detuvo frente a algo sólido: llegó hasta donde se puede
      const blocked = blockedAt();
      if (!ok && blocked !== null && !fallen()) {
        return {
          response: {
            ok: true, que: args.what, llegue: true, ...where(),
            nota: `llegué hasta donde la marcha segura me deja: hay algo sólido a ${blocked} m al frente (mi sonar). Si es lo que buscabas y quieres empujarlo, usa push`,
          },
          image,
        };
      }
      return {
        response: moveResult(ok, {
          que: args.what,
          llegue: ok && !partial,
          ...(partial ? { nota: `iba a ${round(dist, 1)} m: avancé una parte; busca el objeto en la foto nueva y vuelve a usar approach` } : {}),
        }),
        image,
      };
    }
    case 'locate': {
      // Dónde está algo de la última imagen respecto a los pies (FRAME_ROBOT): la caja proyectada al suelo con la
      // pose de la cámara al tomar la foto, y los pies con getPosition (sensores)
      const box = Array.isArray(args.box_2d) ? args.box_2d.map(Number) : [];
      const g = vision.groundPoint(box);
      if (!g) return { response: { ok: false, error: 'esa caja no toca el suelo en la última imagen; mira de nuevo' } };
      // mundo → FRAME_ROBOT: T_robot_mundo = T_robot_torso · (T_mundo_torso)⁻¹
      const toRobot = multiply(motion.getTransform('Torso', 2, true), invertRigid(motion.getTransform('Torso', 1, true)));
      const z = 0;
      const [x, y] = [toRobot[0] * g.x + toRobot[1] * g.y + toRobot[2] * z + toRobot[3], toRobot[4] * g.x + toRobot[5] * g.y + toRobot[6] * z + toRobot[7]];
      const foot = (chain: string) => {
        const [fx, fy] = motion.getPosition(chain, 2, true);
        return { adelante_m: round(fx), izquierda_m: round(fy) };
      };
      return {
        response: {
          ok: true,
          que: args.what,
          borde_cercano: { adelante_m: round(x), izquierda_m: round(y) },
          distancia_m: round(Math.hypot(x, y)),
          pie_izquierdo: foot('LLeg'),
          pie_derecho: foot('RLeg'),
          nota: 'medido desde el centro entre tus pies: adelante positivo, izquierda positivo',
        },
      };
    }
    case 'safe_walk': {
      // ALMotion.setExternalCollisionProtectionEnabled("Move", …): la decide la IA (rampa, pasar pegado a algo…)
      const on = args.enabled !== false;
      motion.setExternalCollisionProtectionEnabled('Move', on);
      return { response: { ok: true, marcha_segura: on ? 'encendida' : 'apagada' } };
    }
    case 'push': {
      if (!(await standUp())) return { response: notStanding() };
      const meters = Math.min(Math.max(num(args.meters, 0.5), 0), 3);
      // Lo que falta para tocarlo, medido con los sonares (ALSonar + ALMemory, como en el NAO real); sin eco cerca, 10 cm
      const sonar = session.service('ALSonar');
      const memory = session.service('ALMemory');
      sonar.subscribe('push');
      const ahead = Math.min(...SONAR_KEYS.map((k) => Number(memory.getData(k))));
      sonar.unsubscribe('push');
      const gap = ahead > 0 && ahead < 1 ? Math.max(ahead - SONAR_TO_TOES, 0) : 0.1;
      // Empujar es tocar a propósito: la marcha segura lo frenaría antes; se apaga mientras empuja y se deja como estaba
      const guarded = motion.getExternalCollisionProtectionEnabled('Move');
      motion.setExternalCollisionProtectionEnabled('Move', false);
      const [x0, y0] = motion.getRobotPosition(true);
      let ok: boolean;
      try {
        ok = await motion.moveTo(meters + gap, 0, 0);
      } finally {
        motion.setExternalCollisionProtectionEnabled('Move', guarded);
      }
      const [x1, y1] = motion.getRobotPosition(true);
      return { response: moveResult(ok, { avance_m: round(Math.hypot(x1 - x0, y1 - y0)), hasta_tocarlo_m: round(gap), ...hands() }) };
    }
    case 'posture': {
      const target = String(args.name);
      if (!POSTURES.includes(target)) return { response: { ok: false, error: `postura desconocida: ${target}` } };
      const ok = await posture.goToPosture(target, 0.6);
      motion.setMoveArmsEnabled(true, true); // la postura también pone los brazos
      return { response: { ok, postura: posture.getPosture(), ...(ok ? {} : { error: posture.lastFailure }) } };
    }
    case 'rest':
      await motion.rest();
      return { response: { ok: true, postura: posture.getPosture(), motores: 'apagados' } };
    case 'wake_up':
      await motion.wakeUp();
      return { response: { ok: posture.getPostureFamily() === 'Standing', postura: posture.getPosture() } };
    case 'gesture': {
      const g = GESTURES[String(args.name)];
      if (!g) return { response: { ok: false, error: `gesto desconocido: ${String(args.name)}` } };
      await wakeLegs();
      await motion.angleInterpolation(['HeadYaw', 'HeadPitch'], [g.yaw, g.pitch], [g.times, g.times], true);
      return { response: { ok: true } };
    }
    case 'arms': {
      const side = String(args.side ?? 'both');
      const sides = side === 'left' ? ['L'] : side === 'right' ? ['R'] : ['L', 'R'];
      const name = String(args.pose);
      if (name !== 'down' && !ARM_POSES[name]) return { response: { ok: false, error: `pose de brazos desconocida: ${name}` } };
      await wakeLegs();
      const names: string[] = [];
      const angles: number[] = [];
      for (const s of sides) {
        const mirror = s === 'R' ? -1 : 1;
        for (const [j, v] of Object.entries(ARM_POSES[name] ?? {})) {
          names.push(s + j);
          angles.push(j === 'ShoulderPitch' || j === 'WristYaw' ? v : v * mirror);
        }
        if (name === 'down') for (const j of CHAINS[`${s}Arm` as 'LArm' | 'RArm']) if (j in STAND_INIT && !j.endsWith('Hand')) {
          names.push(j);
          angles.push(STAND_INIT[j]);
        }
      }
      // Brazos fuera de la marcha mientras estén en una pose (como setMoveArmsEnabled en el robot real)
      const enabled = name === 'down';
      motion.setMoveArmsEnabled(sides.includes('L') ? enabled : motion.getMoveArmsEnabled('LArm'), sides.includes('R') ? enabled : motion.getMoveArmsEnabled('RArm'));
      await motion.angleInterpolationWithSpeed(names, angles, 0.4);
      return { response: { ok: true, brazos: name, lado: side, ...hands() } };
    }
    case 'reach': {
      // Mano(s) a un punto de FRAME_ROBOT (x adelante, y izquierda, z alto desde el suelo) con setPositions/IK
      const sides = armSides(args.side);
      await wakeLegs();
      const apart = Math.min(Math.max(num(args.apart_m, 0.22), 0), 0.5);
      const fwd = num(args.forward_m, 0.2);
      const height = num(args.height_m, 0.35);
      holdArms(sides);
      const errors: Record<string, number> = {};
      const speed = Math.min(Math.max(num(args.speed, 0.4), 0.05), 1);
      const names = sides.map((sd) => `${sd}Arm`);
      const points = sides.map((sd) => {
        const lateral = sides.length === 1 ? num(args.left_m, sd === 'L' ? 0.11 : -0.11) : (sd === 'L' ? apart : -apart) / 2;
        return [fwd, lateral, height, 0, 0, 0];
      });
      const duration = 0.4 + 0.8 / speed;
      await motion.positionInterpolations(names, sides.map(() => 2), names.length > 1 ? points : points[0], sides.map(() => 7), names.length > 1 ? sides.map(() => [duration]) : [duration]);
      const h = hands();
      for (const sd of sides) {
        const hand = sd === 'L' ? h.manos.izquierda : h.manos.derecha;
        const want = points[sides.indexOf(sd)];
        errors[sd === 'L' ? 'izquierda' : 'derecha'] = round(Math.hypot(hand.adelante_m - want[0], hand.izquierda_m - want[1], hand.altura_m - want[2]));
      }
      const far = Object.values(errors).some((e) => e > 0.03);
      return { response: { ok: !far, ...h, falta_m: errors, ...(far ? { nota: 'no alcanzo ese punto: está fuera del alcance del brazo (~0.22 m desde el hombro)' } : {}) } };
    }
    case 'arm_joints': {
      // Ángulos directos (grados) del brazo izquierdo; el derecho se refleja (mismo gesto en espejo)
      // Por brazo (left/right, valores distintos en la misma orden) o los mismos ángulos sueltos para `side`
      const perSide = (sd: string): Args | null => {
        const own = args[sd === 'L' ? 'left' : 'right'];
        if (own && typeof own === 'object') return own as Args;
        return armSides(args.side).includes(sd) && !args.left && !args.right ? args : null;
      };
      const sides = ['L', 'R'].filter((sd) => perSide(sd));
      await wakeLegs();
      holdArms(sides);
      const fields: [string, string][] = [['shoulder_pitch_deg', 'ShoulderPitch'], ['shoulder_roll_deg', 'ShoulderRoll'], ['elbow_yaw_deg', 'ElbowYaw'], ['elbow_roll_deg', 'ElbowRoll'], ['wrist_yaw_deg', 'WristYaw']];
      const names: string[] = [];
      const angles: number[] = [];
      for (const sd of sides) {
        const values = perSide(sd)!;
        for (const [field, joint] of fields) {
          if (typeof values[field] !== 'number') continue;
          const v = (values[field] as number) * DEG;
          names.push(sd + joint);
          angles.push(sd === 'R' && joint !== 'ShoulderPitch' && joint !== 'WristYaw' ? -v : v);
        }
      }
      if (!names.length) return { response: { ok: false, error: 'no diste ningún ángulo' } };
      const clamped = angles.map((a, i) => {
        const spec = motion.getLimits(names[i])[0];
        return Math.min(Math.max(a, spec[0]), spec[1]);
      });
      await motion.angleInterpolationWithSpeed(names, clamped, Math.min(Math.max(num(args.speed, 0.4), 0.05), 1));
      return { response: { ok: true, ...hands() } };
    }
    case 'look_at_point': {
      // Apunta la cabeza a la mano (getPosition en FRAME_TORSO) o a un punto de FRAME_ROBOT y toma una foto: para
      // revisar dónde quedó la mano respecto al objeto. Si hace falta mirar más abajo de lo que deja HeadPitch, la
      // cámara de la boca (39.7° más abajo) lo ve en la misma imagen.
      await wakeLegs();
      let p: number[];
      if (args.hand === 'left' || args.hand === 'right') p = motion.getPosition(args.hand === 'left' ? 'LArm' : 'RArm', 0, true);
      else {
        const t = invertRigid(motion.getTransform('Torso', 2, true)); // FRAME_ROBOT → torso
        const [x, y, z] = [num(args.forward_m, 0.2), num(args.left_m), num(args.height_m, 0.3)];
        p = [t[0] * x + t[1] * y + t[2] * z + t[3], t[4] * x + t[5] * y + t[6] * z + t[7], t[8] * x + t[9] * y + t[10] * z + t[11]];
      }
      const [dx, dy, dz] = [p[0], p[1], p[2] - HEAD_PIVOT_Z - CAMERA_ABOVE_PIVOT];
      const [limYaw, limPitch] = [motion.getLimits('HeadYaw')[0], motion.getLimits('HeadPitch')[0]];
      const yaw = Math.min(Math.max(Math.atan2(dy, dx), limYaw[0]), limYaw[1]);
      const pitch = Math.min(Math.max(Math.atan2(-dz, Math.hypot(dx, dy)), limPitch[0]), limPitch[1]);
      await motion.angleInterpolationWithSpeed(['HeadYaw', 'HeadPitch'], [yaw, pitch], 0.3);
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      const [hy, hp] = motion.getAngles(['HeadYaw', 'HeadPitch'], true);
      return {
        response: { ok: true, cabeza: { yaw: Math.round(hy / DEG), pitch: Math.round(hp / DEG) }, ...hands(), nota: 'foto nueva adjunta (arriba frente, abajo boca)' },
        image: vision.view(),
      };
    }
    case 'look_at': {
      await wakeLegs();
      await motion.angleInterpolationWithSpeed(['HeadYaw', 'HeadPitch'], [num(args.yaw_deg) * DEG, num(args.pitch_deg) * DEG], 0.3);
      const [yaw, pitch] = motion.getAngles(['HeadYaw', 'HeadPitch'], true);
      return { response: { ok: true, cabeza: { yaw: Math.round(yaw / DEG), pitch: Math.round(pitch / DEG) } } };
    }
    case 'animation': {
      const clip = MOTIONS.find((m) => m.name === args.name && ANIMATIONS.includes(m.name));
      if (!clip) return { response: { ok: false, error: `animación desconocida: ${String(args.name)}` } };
      if (!(await standUp())) return { response: notStanding() };
      motion.setMoveArmsEnabled(true, true);
      await playMotion(motion, clip);
      await new Promise((r) => setTimeout(r, 500));
      const down = fallen();
      return { response: { ok: !down, postura: posture.getPostureFamily(), ...(down ? { nota: 'me caí' } : {}) } };
    }
    case 'leds': {
      const group = LED_GROUPS[String(args.part)];
      const off = String(args.color).toLowerCase() === 'off';
      const color = off ? 0 : parseColor(args.color);
      if (!group || color === null) return { response: { ok: false, error: 'parte desconocida o color inválido (usa #rrggbb u off)' } };
      await session.service('ALLeds').fadeRGB(group, color, 0.3);
      // Orejas y cabeza son LEDs azules de un solo color (doc family_nao_technical_leds_naov6): fadeRGB solo les cambia
      // el brillo (la componente más fuerte del color). Se le dice a Gemini para que no anuncie un color que no hubo
      const part = String(args.part);
      const blueOnly = part === 'ears' || part === 'head' || part === 'all';
      const level = Math.round((Math.max((color >> 16) & 255, (color >> 8) & 255, color & 255) / 255) * 100);
      return {
        response: {
          ok: true,
          color: off ? 'off' : hexOf(color),
          ...(blueOnly ? { nota: `${part === 'all' ? 'ojos, pecho y pies quedaron en ese color; ' : ''}las orejas y la cabeza solo tienen luces azules: no cambian de color, quedaron en azul al ${level}% de brillo` } : {}),
        },
      };
    }
    case 'remember_face': {
      // ALFaceDetection.learnFace (o reLearnFace si ya la conoce), con las palabras de la persona como autorización
      const faces = session.service('ALFaceDetection');
      const name = String(args.name ?? '').trim();
      const known = faces.getLearnedFacesList().some((n) => n.toLowerCase() === name.toLowerCase());
      faces.setLearningConsent(String(args.authorization ?? ''));
      const ok = known ? await faces.reLearnFace(name) : await faces.learnFace(name);
      return { response: ok ? { ok, aprendido: name, nota: known ? 'sumé otra toma de su cara' : 'ya reconozco su cara' } : { ok, error: faces.lastError } };
    }
    case 'forget_face': {
      const faces = session.service('ALFaceDetection');
      const name = String(args.name ?? '').trim();
      const ok = await faces.forgetPerson(name);
      return { response: ok ? { ok, olvidado: name } : { ok, error: `no tenía guardada la cara de ${name}` } };
    }
    case 'my_colors': {
      if (!ctx.appearance) return { response: { ok: false, error: 'no puedo guardar mi apariencia ahora' } };
      const patch: Partial<Appearance> = {};
      for (const [field, key] of [['shell', 'shell'], ['eyes', 'eyes']] as const) {
        if (args[field] === undefined) continue;
        if (String(args[field]).toLowerCase() === 'original') patch[key] = '';
        else {
          const c = parseColor(args[field]);
          if (c === null) return { response: { ok: false, error: `color inválido para ${field}: usa #rrggbb` } };
          patch[key] = hexOf(c);
        }
      }
      if (!Object.keys(patch).length) return { response: { ok: false, error: 'di shell o eyes' } };
      const now = await ctx.appearance(patch);
      return {
        response: {
          ok: true,
          carcasa: now.shell || 'original',
          ojos: now.eyes || 'original',
          nota: 'solo se guardan carcasa y ojos; tus orejas y tu cabeza tienen luces azules de un solo color (no cambian de color)',
        },
      };
    }
    case 'look':
      return { response: { ok: true, nota: 'foto nueva adjunta (arriba frente, abajo boca)' }, image: vision.view() };
    case 'scan': {
      await wakeLegs();
      if (!args.full) {
        const image = await vision.scan(motion);
        return { response: { ok: true, nota: 'mosaico adjunto: izquierda, centro y derecha (cada una con frente arriba y boca abajo)' }, image };
      }
      if (!(await standUp())) return { response: notStanding() };
      let turned = false;
      const image = await vision.scan(motion, async () => (turned = await turnBy(Math.PI)));
      return {
        response: {
          ok: turned,
          nota: turned
            ? 'mosaico de 360° adjunto: fila de arriba lo que tenías delante, fila de abajo lo de detrás (giraste 180° y ahora miras hacia allá). Las vistas vecinas se solapan un poco: no cuentes dos veces lo mismo.'
            : 'no pude girar: el mosaico solo tiene lo de delante',
          ...where(),
        },
        image,
      };
    }
    case 'stop':
      await motion.stopMove();
      posture.stopMove();
      return { response: { ok: true, ...where() } };
    default:
      return { response: { ok: false, error: `no sé hacer "${name}"` } };
  }
}
