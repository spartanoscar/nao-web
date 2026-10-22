// Habilidades del NAO para el cerebro (server/prompt.go declara las mismas, con el mismo nombre). Cada una se
// arma con la API de NAOqi, como lo haría un programa en el robot real, y devuelve un resultado corto para que
// Gemini decida el siguiente paso ({ ok, … }); las que miran devuelven además una foto.

import type { Session } from '../naoqi/session';
import { MOTIONS, playMotion } from '../naoqi/motionFile';
import { wrapAngle } from '../naoqi/moveTo';
import type { Snapshot, Vision } from './vision';

export interface SkillResult {
  response: Record<string, unknown>;
  image?: Snapshot;
}

export interface SkillContext {
  session: Session;
  vision: Vision;
  /** El turno se canceló (la persona dijo otra cosa): no seguir */
  cancelled(): boolean;
}

type Args = Record<string, unknown>;

const DEG = Math.PI / 180;
/** Distancia del torso al borde del objeto al llegar con approach: deja las puntas de los pies a ~8 cm */
const APPROACH_GAP = 0.18;
/** Más lejos que esto, approach llega a medio camino y pide mirar de nuevo (la caja de lejos es imprecisa) */
const APPROACH_LEG = 1.2;
const APPROACH_MAX = 5;
const ANIMATIONS = ['HandWave', 'Shoot', 'TaiChi', 'WipeForehead'];
const POSTURES = ['Stand', 'StandInit', 'Sit', 'SitRelax', 'Crouch'];
const LED_GROUPS: Record<string, string> = { eyes: 'FaceLeds', ears: 'EarLeds', chest: 'ChestLeds', all: 'AllLeds' };
const LED_COLORS = ['white', 'red', 'green', 'blue', 'yellow', 'magenta', 'cyan'];
/** Gestos de cabeza: [HeadYaw, HeadPitch] por keyframe y sus tiempos (s) */
const GESTURES: Record<string, { yaw: number[]; pitch: number[]; times: number[] }> = {
  nod: { yaw: [0, 0, 0, 0, 0], pitch: [0.35, -0.05, 0.35, -0.05, 0], times: [0.3, 0.6, 0.9, 1.2, 1.5] },
  shake: { yaw: [0.5, -0.5, 0.45, -0.45, 0], pitch: [0, 0, 0, 0, 0], times: [0.35, 0.8, 1.25, 1.7, 2] },
  look_around: { yaw: [1, 1, -1, -1, 0], pitch: [0, 0, 0, 0, 0], times: [1, 1.6, 3, 3.6, 4.4] },
  doubt: { yaw: [0.35, 0.35, 0], pitch: [-0.2, -0.2, 0], times: [0.5, 1.5, 2.1] },
};

const num = (v: unknown, fallback = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);
const round = (v: number, d = 2) => Math.round(v * 10 ** d) / 10 ** d;

export async function runSkill(name: string, args: Args, ctx: SkillContext): Promise<SkillResult> {
  const { session, vision } = ctx;
  const motion = session.service('ALMotion');
  const posture = session.service('ALRobotPosture');

  const where = () => {
    const [x, y, theta] = motion.getRobotPosition(true);
    return { posicion: { x: round(x), y: round(y) }, rumbo_grados: Math.round(theta / DEG) };
  };
  /**
   * Listo para caminar, como en todos los ejemplos oficiales de ALMotion (walk-api): goToPosture("StandInit", 0.5)
   * antes de moverse. Desde el suelo o sentado, goToPosture primero lo levanta. false si no lo logra.
   */
  const standUp = async (): Promise<boolean> => {
    if (!motion.robotIsWakeUp()) await motion.wakeUp();
    if (posture.getPosture() === 'StandInit') return true;
    return posture.goToPosture('StandInit', 0.5);
  };
  const notStanding = () => ({ ok: false, error: `no pude ponerme de pie: ${posture.lastFailure || posture.getPostureFamily()}` });
  const moveResult = (ok: boolean, extra: Args = {}) => ({
    ok,
    ...extra,
    ...where(),
    ...(ok ? {} : { postura: posture.getPostureFamily(), nota: posture.getPostureFamily() === 'Standing' ? 'me interrumpieron o no llegué' : 'me caí' }),
  });
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
      return {
        response: moveResult(ok, {
          que: args.what,
          llegue: ok && !partial,
          ...(partial ? { nota: `iba a ${round(dist, 1)} m: avancé una parte; busca el objeto en la foto nueva y vuelve a usar approach` } : {}),
        }),
        image,
      };
    }
    case 'push': {
      if (!(await standUp())) return { response: notStanding() };
      const meters = Math.min(Math.max(num(args.meters, 0.5), 0), 3);
      const [x0, y0] = motion.getRobotPosition(true);
      const ok = await motion.moveTo(meters + 0.1, 0, 0); // + lo que falta para tocarlo
      const [x1, y1] = motion.getRobotPosition(true);
      return { response: moveResult(ok, { avance_m: round(Math.hypot(x1 - x0, y1 - y0)) }) };
    }
    case 'posture': {
      const target = String(args.name);
      if (!POSTURES.includes(target)) return { response: { ok: false, error: `postura desconocida: ${target}` } };
      const ok = await posture.goToPosture(target, 0.6);
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
      if (!motion.robotIsWakeUp()) motion.setStiffnesses('Head', 1);
      await motion.angleInterpolation(['HeadYaw', 'HeadPitch'], [g.yaw, g.pitch], [g.times, g.times], true);
      return { response: { ok: true } };
    }
    case 'look_at': {
      if (!motion.robotIsWakeUp()) motion.setStiffnesses('Head', 1);
      await motion.angleInterpolationWithSpeed(['HeadYaw', 'HeadPitch'], [num(args.yaw_deg) * DEG, num(args.pitch_deg) * DEG], 0.3);
      const [yaw, pitch] = motion.getAngles(['HeadYaw', 'HeadPitch'], true);
      return { response: { ok: true, cabeza: { yaw: Math.round(yaw / DEG), pitch: Math.round(pitch / DEG) } } };
    }
    case 'animation': {
      const clip = MOTIONS.find((m) => m.name === args.name && ANIMATIONS.includes(m.name));
      if (!clip) return { response: { ok: false, error: `animación desconocida: ${String(args.name)}` } };
      if (!(await standUp())) return { response: notStanding() };
      await playMotion(motion, clip);
      await new Promise((r) => setTimeout(r, 500));
      const family = posture.getPostureFamily();
      return { response: { ok: family === 'Standing', postura: family, ...(family === 'Standing' ? {} : { nota: 'me caí' }) } };
    }
    case 'leds': {
      const group = LED_GROUPS[String(args.part)];
      const color = String(args.color);
      if (!group || (color !== 'off' && !LED_COLORS.includes(color))) return { response: { ok: false, error: 'color o parte desconocidos' } };
      const leds = session.service('ALLeds');
      await (color === 'off' ? leds.fadeRGB(group, 0x000000, 0.3) : leds.fadeRGB(group, color, 0.3));
      return { response: { ok: true } };
    }
    case 'look':
      return { response: { ok: true, nota: 'foto nueva adjunta (arriba frente, abajo boca)' }, image: vision.view() };
    case 'scan': {
      if (!motion.robotIsWakeUp()) motion.setStiffnesses('Head', 1);
      const image = await vision.scan(motion);
      return { response: { ok: true, nota: 'mosaico adjunto: izquierda, centro y derecha (cada una con frente arriba y boca abajo)' }, image };
    }
    case 'stop':
      await motion.stopMove();
      posture.stopMove();
      return { response: { ok: true, ...where() } };
    default:
      return { response: { ok: false, error: `no sé hacer "${name}"` } };
  }
}
