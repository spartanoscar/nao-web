// Controles de alto nivel: despertar/reposo, posturas (ALRobotPosture) y animaciones (.motion).
// Todo pasa por la API NAOqi, igual que lo haría un script en el robot.

import { MOTIONS, playMotion } from '../naoqi/motionFile';
import type { Session } from '../naoqi/session';
import type { RobotState } from '../robot/state';

export interface BehaviorPanel {
  refresh(): void;
}

export function createBehaviorPanel(
  host: HTMLElement,
  session: Session,
  state: RobotState,
  { onReset }: { onReset(): void },
): BehaviorPanel {
  const motion = session.service('ALMotion');
  const posture = session.service('ALRobotPosture');

  const status = el('div', 'status');
  const dot = el('span', 'status-dot');
  const statusText = el('span', '');
  status.append(dot, statusText);
  const activity = el('div', 'activity');

  // Muestra la llamada NAOqi en curso y los errores, como un log del robot
  const run = async (label: string, fn: () => Promise<unknown>) => {
    activity.textContent = `▶ ${label}`;
    activity.classList.remove('error');
    try {
      await fn();
      if (activity.textContent === `▶ ${label}`) activity.textContent = '';
    } catch (e) {
      activity.textContent = (e as Error).message;
      activity.classList.add('error');
    }
  };

  const power = el('div', 'chips');
  power.append(
    chip('Despertar', 'motion.wakeUp()', () => run('ALMotion.wakeUp()', () => motion.wakeUp())),
    chip('Reposo', 'motion.rest()', () => run('ALMotion.rest()', () => motion.rest())),
    chip('Reiniciar', 'Vuelve a Crouch en el centro, con los motores apagados', () => {
      onReset();
      activity.textContent = '';
    }),
  );

  const postures = el('div', 'chips');
  for (const name of posture.getPostureList()) {
    postures.append(
      chip(name, `posture.goToPosture("${name}", 0.6)`, () =>
        run(`ALRobotPosture.goToPosture("${name}", 0.6)`, async () => {
          if (!(await posture.goToPosture(name, 0.6)) && posture.lastFailure) {
            throw new Error(`goToPosture → False: ${posture.lastFailure}`);
          }
        }),
      ),
    );
  }

  const animations = el('div', 'chips');
  for (const clip of MOTIONS) {
    animations.append(
      chip(clip.name, `${clip.names.length} joints · ${clip.duration.toFixed(1)} s`, () =>
        run(`${clip.name}.motion`, async () => {
          // Con los motores apagados el robot no se movería: se despierta primero, como en Choregraphe
          if (!motion.robotIsWakeUp()) await motion.wakeUp();
          await playMotion(motion, clip);
        }),
      ),
    );
  }

  host.append(
    status,
    power,
    activity,
    section('Posturas · ALRobotPosture', postures),
    section('Animaciones · .motion', animations),
  );

  let shownRevision = -1;
  return {
    refresh() {
      if (state.revision === shownRevision) return;
      shownRevision = state.revision;
      const awake = motion.robotIsWakeUp();
      dot.classList.toggle('on', awake);
      const current = posture.getPosture();
      const family = posture.getPostureFamily();
      statusText.textContent = `${awake ? 'Despierto' : 'En reposo'} · ${current !== 'Unknown' ? current : family}`;
    },
  };
}

function section(title: string, body: HTMLElement): HTMLElement {
  const d = el('details', 'chain') as HTMLDetailsElement;
  d.open = true;
  d.append(el('summary', '', title), body);
  return d;
}

function chip(label: string, title: string, onClick: () => void): HTMLButtonElement {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'chip';
  b.textContent = label;
  b.title = title;
  b.addEventListener('click', onClick);
  return b;
}

function el(tag: string, className: string, text?: string): HTMLElement {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (text !== undefined) e.textContent = text;
  return e;
}
