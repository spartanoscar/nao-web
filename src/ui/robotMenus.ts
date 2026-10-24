// Posturas y animaciones desde el HUD: dos íconos antes del móvil, cada uno con su lista flotante hacia abajo. Elegir es
// ejecutar, por la misma API NAOqi que usaría un script en el robot: la postura con ALRobotPosture.goToPosture (el
// grafo real de NAOqi) y la animación (.motion de Webots) con ALMotion.angleInterpolation.

import { MOTIONS, playMotion } from '../naoqi/motionFile';
import type { Session } from '../naoqi/session';
import type { Hud } from './hud';
import { ICONS } from './icons';

/** Velocidad de goToPosture desde el menú (las cajas de Choregraphe 2.8 usan 0.8) */
const POSTURE_SPEED = 0.8;

/** Posturas de NAOqi con su nombre en español (el título del botón muestra la llamada) */
const POSTURES: [string, string][] = [
  ['StandInit', 'De pie'],
  ['Stand', 'Erguido'],
  ['StandZero', 'Brazos al frente'],
  ['Crouch', 'Agachado'],
  ['Sit', 'Sentado'],
  ['SitRelax', 'Sentado relajado'],
  ['LyingBelly', 'Boca abajo'],
  ['LyingBack', 'Boca arriba'],
];

/**
 * Animaciones (reference/motions) en dos grupos. StandUpFromFront no está: solo sirve boca abajo y levantarse ya lo hace
 * goToPosture por la ruta de NAOqi.
 */
const ANIMATIONS: { title: string; items: [string, string][] }[] = [
  {
    title: 'Gestos',
    items: [['HandWave', 'Saludar'], ['WipeForehead', 'Secarse la frente'], ['Shoot', 'Patear'], ['TaiChi', 'Tai chi']],
  },
  {
    title: 'Pasos',
    items: [
      ['Forwards', 'Paso adelante'], ['Forwards50', 'Avanzar 50 cm'], ['Backwards', 'Paso atrás'],
      ['SideStepLeft', 'Paso a la izquierda'], ['SideStepRight', 'Paso a la derecha'],
      ['TurnLeft40', 'Girar 40° a la izquierda'], ['TurnRight40', 'Girar 40° a la derecha'],
      ['TurnLeft60', 'Girar 60° a la izquierda'], ['TurnRight60', 'Girar 60° a la derecha'], ['TurnLeft180', 'Media vuelta'],
    ],
  },
];

interface Item {
  label: string;
  /** La llamada de NAOqi (título del botón) */
  call: string;
  run(): Promise<void>;
}

/** `ready`: el NAO puede recibir órdenes (apagado no: ui/power.ts avisa) */
export function attachRobotMenus(hud: Hud, session: Session, ready: () => boolean, onError: (message: string) => void): void {
  const motion = session.service('ALMotion');
  const posture = session.service('ALRobotPosture');

  const postureItems: Item[] = POSTURES.map(([name, label]) => ({
    label,
    call: `ALRobotPosture.goToPosture("${name}", ${POSTURE_SPEED})`,
    async run() {
      if (!(await posture.goToPosture(name, POSTURE_SPEED))) onError(`No llegó a "${label}": ${posture.lastFailure}`);
    },
  }));

  const animationGroups = ANIMATIONS.map(({ title, items }) => ({
    title,
    items: items.flatMap(([name, label]): Item[] => {
      const clip = MOTIONS.find((m) => m.name === name);
      if (!clip) return [];
      return [{
        label,
        call: `${name}.motion (${clip.duration.toFixed(1)} s)`,
        async run() {
          // Con los motores apagados el robot no se movería: se despierta primero, como en Choregraphe
          if (!motion.robotIsWakeUp()) await motion.wakeUp();
          await playMotion(motion, clip);
        },
      }];
    }),
  }));

  const menus = [
    menu('Posturas', ICONS.posture, [{ title: 'Posturas', items: postureItems }]),
    menu('Animaciones', ICONS.animation, animationGroups),
  ];
  hud.phoneButton.before(...menus.map((m) => m.root));

  function menu(title: string, icon: string, groups: { title: string; items: Item[] }[]) {
    const root = document.createElement('div');
    root.className = 'hud-menu';
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'hud-btn hud-icon';
    button.title = title;
    button.innerHTML = icon;
    button.setAttribute('aria-label', title);
    button.setAttribute('aria-haspopup', 'menu');
    button.setAttribute('aria-expanded', 'false');
    /** Órdenes en curso de este menú */
    let busy = 0;
    const list = document.createElement('div');
    list.className = 'hud-list';
    list.setAttribute('role', 'menu');
    list.hidden = true;
    for (const group of groups) {
      const head = document.createElement('span');
      head.className = 'hud-list-head';
      head.textContent = group.title;
      list.append(head);
      for (const item of group.items) {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'hud-item';
        b.setAttribute('role', 'menuitem');
        b.textContent = item.label;
        b.title = item.call;
        b.addEventListener('click', () => {
          close();
          if (!ready()) return;
          // Una orden nueva reemplaza a la anterior, como en NAOqi; el ícono pulsa mientras alguna está en curso
          busy++;
          button.classList.add('busy');
          item
            .run()
            .catch((e) => onError((e as Error).message))
            .finally(() => button.classList.toggle('busy', --busy > 0));
        });
        list.append(b);
      }
    }
    root.append(button, list);
    const open = () => {
      for (const m of menus) if (m.root !== root) m.close();
      list.hidden = false;
      button.setAttribute('aria-expanded', 'true');
    };
    const close = () => {
      list.hidden = true;
      button.setAttribute('aria-expanded', 'false');
    };
    button.addEventListener('click', () => (list.hidden ? open() : close()));
    document.addEventListener('pointerdown', (e) => {
      if (!root.contains(e.target as Node)) close();
    });
    window.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') close();
    });
    return { root, close };
  }
}
