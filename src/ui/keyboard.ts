// Control por teclado: mueve al robot con ALMotion.moveToward, como un joystick.
//   W/S o ↑/↓      avanzar / retroceder
//   A/D o ←/→      girar sobre sí mismo
//   Q/E o Shift+A/D (Shift+←/→)   paso lateral ("cangrejo")
// Si el robot está en reposo, la primera tecla lo despierta (wakeUp), como haría Choregraphe.

import type { Session } from '../naoqi/session';

type Axis = 'x' | 'y' | 'theta';

const FORWARD = new Set(['KeyW', 'ArrowUp']);
const BACKWARD = new Set(['KeyS', 'ArrowDown']);
const LEFT = new Set(['KeyA', 'ArrowLeft']);
const RIGHT = new Set(['KeyD', 'ArrowRight']);
const STRAFE_LEFT = new Set(['KeyQ']);
const STRAFE_RIGHT = new Set(['KeyE']);
const HANDLED = new Set([...FORWARD, ...BACKWARD, ...LEFT, ...RIGHT, ...STRAFE_LEFT, ...STRAFE_RIGHT]);

/** El teclado no se roba cuando se escribe o se usa un control (los sliders usan las flechas) */
function isEditable(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName);
}

export function attachKeyboard(session: Session, onStatus: (text: string) => void): void {
  const motion = session.service('ALMotion');
  const held = new Set<string>();
  let shift = false;
  let waking = false;
  let last = '';

  const velocity = (): Record<Axis, number> => {
    const any = (keys: Set<string>) => [...keys].some((k) => held.has(k));
    const x = Number(any(FORWARD)) - Number(any(BACKWARD));
    const side = Number(any(LEFT)) - Number(any(RIGHT));
    const strafe = Number(any(STRAFE_LEFT)) - Number(any(STRAFE_RIGHT));
    return { x, y: strafe || (shift ? side : 0), theta: shift ? 0 : side };
  };

  const update = async () => {
    const v = velocity();
    const key = `${v.x},${v.y},${v.theta}`;
    if (key === last) return;
    last = key;
    const moving = v.x || v.y || v.theta;
    if (moving && !motion.robotIsWakeUp()) {
      if (waking) return;
      waking = true;
      onStatus('▶ ALMotion.wakeUp()');
      await motion.wakeUp();
      waking = false;
      last = '';
      return update();
    }
    motion.moveToward(v.x, v.y, v.theta);
    onStatus(moving ? `▶ ALMotion.moveToward(${v.x}, ${v.y}, ${v.theta})` : '');
  };

  window.addEventListener('keydown', (e) => {
    shift = e.shiftKey;
    if (e.key === 'Shift') return void update(); // girar ↔ paso lateral con A/D ya apretada
    // En el modo animador (ui/animator.ts) las teclas mueven piezas, no hacen caminar al robot
    if (!HANDLED.has(e.code) || e.ctrlKey || e.metaKey || e.altKey || isEditable(e.target) || document.body.classList.contains('animating')) return;
    e.preventDefault(); // las flechas no deben desplazar la página
    held.add(e.code);
    void update();
  });
  window.addEventListener('keyup', (e) => {
    shift = e.shiftKey;
    if (e.key === 'Shift') return void update();
    held.delete(e.code);
    void update();
  });
  // Si la ventana pierde el foco con una tecla apretada, el keyup nunca llega: se suelta todo
  window.addEventListener('blur', () => {
    held.clear();
    shift = false;
    void update();
  });
}
