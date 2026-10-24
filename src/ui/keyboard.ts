// Control por teclado (Oscar, 2026-10-24: "las flechas mueven el cuerpo y WASD la cabeza"):
//   ↑/↓            avanzar / retroceder (ALMotion.moveToward, como un joystick)
//   ←/→            girar sobre sí mismo
//   Shift+←/→, Q/E paso lateral ("cangrejo")
//   W/S            cabeza arriba / abajo (HeadPitch)      A/D   cabeza a la izquierda / derecha (HeadYaw)
// Al empezar a caminar la cabeza vuelve al centro (pudo quedar girada mirando algo). Si el robot está en reposo, la
// primera tecla lo despierta (wakeUp), como haría Choregraphe. Apagado (ui/power.ts) no se mueve: la primera tecla avisa.

import type { Session } from '../naoqi/session';
import type { Power } from './power';

type Axis = 'x' | 'y' | 'theta';

const FORWARD = new Set(['ArrowUp']);
const BACKWARD = new Set(['ArrowDown']);
const LEFT = new Set(['ArrowLeft']);
const RIGHT = new Set(['ArrowRight']);
const STRAFE_LEFT = new Set(['KeyQ']);
const STRAFE_RIGHT = new Set(['KeyE']);
const BODY = new Set([...FORWARD, ...BACKWARD, ...LEFT, ...RIGHT, ...STRAFE_LEFT, ...STRAFE_RIGHT]);
/** Cabeza: [joint, sentido] (HeadPitch + = abajo, HeadYaw + = izquierda) */
const HEAD_KEYS: Record<string, ['HeadYaw' | 'HeadPitch', number]> = {
  KeyW: ['HeadPitch', -1], KeyS: ['HeadPitch', 1], KeyA: ['HeadYaw', 1], KeyD: ['HeadYaw', -1],
};
/** Velocidad de la cabeza con la tecla apretada (rad/s) y cada cuánto se renueva el objetivo */
const HEAD_RATE = 1.2;
const HEAD_TICK_MS = 50;
/** Fracción de la velocidad máxima: alcanza de sobra para seguir el objetivo, que avanza a HEAD_RATE */
const HEAD_SPEED = 0.35;
const YAW_LIMIT = 2.0857;

/** El teclado no se roba cuando se escribe o se usa un control */
function isEditable(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName);
}

export interface KeyboardControl {
  /** Cuándo se usó por última vez (performance.now, ms) y si hay alguna tecla apretada */
  lastUse(): number;
  holding(): boolean;
  /** Avisa cada vez que se usa (para esconder la guía en pantalla) */
  onUse?: () => void;
}

export function attachKeyboard(session: Session, power: Pick<Power, 'state' | 'ready'>): KeyboardControl {
  const motion = session.service('ALMotion');
  const held = new Set<string>();
  let shift = false;
  let waking = false;
  let last = '';
  let walking = false;
  let lastUse = -Infinity;
  let headTimer = 0;
  const control: KeyboardControl = { lastUse: () => lastUse, holding: () => held.size > 0 };

  const wake = async (): Promise<boolean> => {
    if (motion.robotIsWakeUp()) return true;
    if (waking) return false;
    waking = true;
    await motion.wakeUp();
    waking = false;
    return true;
  };

  const velocity = (): Record<Axis, number> => {
    const any = (keys: Set<string>) => [...keys].some((k) => held.has(k));
    const x = Number(any(FORWARD)) - Number(any(BACKWARD));
    const side = Number(any(LEFT)) - Number(any(RIGHT));
    const strafe = Number(any(STRAFE_LEFT)) - Number(any(STRAFE_RIGHT));
    return { x, y: strafe || (shift ? side : 0), theta: shift ? 0 : side };
  };

  const update = async () => {
    const v = velocity();
    const moving = Boolean(v.x || v.y || v.theta);
    if (moving && power.state !== 'on') return; // apagado (o apagándose) no camina
    const key = `${v.x},${v.y},${v.theta}`;
    if (key === last) return;
    last = key;
    if (moving && !motion.robotIsWakeUp()) {
      if (!(await wake())) return;
      last = '';
      return update();
    }
    // Al arrancar a caminar, la cabeza al centro (si no se la está moviendo con WASD)
    if (moving && !walking && !Object.keys(HEAD_KEYS).some((k) => held.has(k))) motion.setAngles(['HeadYaw', 'HeadPitch'], [0, 0], 0.2);
    walking = moving;
    motion.moveToward(v.x, v.y, v.theta);
  };

  /** Mientras haya teclas de cabeza apretadas, el objetivo va un poco más allá de donde está */
  const headTick = async () => {
    const keys = Object.keys(HEAD_KEYS).filter((k) => held.has(k));
    if (!keys.length || power.state !== 'on') {
      clearInterval(headTimer);
      headTimer = 0;
      return;
    }
    if (!motion.robotIsWakeUp() && !(await wake())) return;
    const names: ('HeadYaw' | 'HeadPitch')[] = [];
    const targets: number[] = [];
    for (const name of ['HeadYaw', 'HeadPitch'] as const) {
      const dir = keys.reduce((s, k) => s + (HEAD_KEYS[k][0] === name ? HEAD_KEYS[k][1] : 0), 0);
      if (!dir) continue;
      const now = motion.getAngles(name, false)[0];
      let target = now + Math.sign(dir) * HEAD_RATE * (HEAD_TICK_MS / 1000);
      if (name === 'HeadYaw') target = Math.min(Math.max(target, -YAW_LIMIT), YAW_LIMIT);
      names.push(name);
      targets.push(target);
    }
    if (names.length) motion.setAngles(names, targets, HEAD_SPEED);
  };

  /** Al soltar las teclas de cabeza: se queda donde está */
  const holdHead = (name: 'HeadYaw' | 'HeadPitch') => {
    if (power.state === 'on' && motion.robotIsWakeUp()) motion.setAngles(name, motion.getAngles(name, true)[0], HEAD_SPEED);
  };

  window.addEventListener('keydown', (e) => {
    shift = e.shiftKey;
    if (e.key === 'Shift') return void update(); // girar ↔ paso lateral con ←/→ ya apretada
    const head = HEAD_KEYS[e.code];
    if ((!BODY.has(e.code) && !head) || e.ctrlKey || e.metaKey || e.altKey || isEditable(e.target)) return;
    e.preventDefault(); // las flechas no deben desplazar la página
    if (power.state !== 'on') {
      if (!e.repeat) power.ready(); // avisa que está apagado
      return;
    }
    lastUse = performance.now();
    control.onUse?.();
    held.add(e.code);
    if (head) {
      if (!headTimer) {
        void headTick();
        headTimer = window.setInterval(() => void headTick(), HEAD_TICK_MS);
      }
      return;
    }
    void update();
  });
  window.addEventListener('keyup', (e) => {
    shift = e.shiftKey;
    if (e.key === 'Shift') return void update();
    if (!held.delete(e.code)) return;
    lastUse = performance.now();
    const head = HEAD_KEYS[e.code];
    if (head) holdHead(head[0]);
    else void update();
  });
  // Si la ventana pierde el foco con una tecla apretada, el keyup nunca llega: se suelta todo
  window.addEventListener('blur', () => {
    held.clear();
    shift = false;
    void update();
  });
  return control;
}
