// Encendido del NAO (estilo juego): un botón en la tarjeta del jugador, verde encendido y gris apagado.
// Apagar es como apagar el NAO real sin que se caiga: primero se acuesta boca arriba (goToPosture "LyingBack", la ruta de
// NAOqi), después apaga los motores (ALMotion.rest: acostado ya no se mueve) y todas las luces (ALLeds). Apagado no
// recibe órdenes (menús, teclado, chat, voz, IA): se avisa en pantalla y el botón llama la atención. Encender vuelve a
// prender las luces; los motores siguen apagados, como en un NAO recién encendido: la primera orden lo despierta.
// ALMotion.rest() por sí solo sigue siendo el de NAOqi (agacharse y apagar motores), para los scripts del robot real.

import type { Session } from '../naoqi/session';
import { ICONS } from './icons';

export type PowerState = 'on' | 'off' | 'turning-off';

export interface Power {
  readonly state: PowerState;
  /** true si puede recibir órdenes; si no, avisa en pantalla (como mucho una vez cada NOTICE_EVERY_S) */
  ready(): boolean;
  /** Se acuesta boca arriba y se apaga; false si no pudo acostarse (no se apaga de pie: se caería) */
  turnOff(): Promise<boolean>;
  turnOn(): void;
}

const NOTICE_EVERY_S = 4;
const TITLE: Record<PowerState, string> = {
  on: 'Encendido · clic para apagarlo (se acuesta boca arriba)',
  off: 'Apagado · clic para encenderlo',
  'turning-off': 'Apagando…',
};

export function attachPower(
  host: HTMLElement,
  session: Session,
  {
    notice,
    lightsOn,
    onOff,
  }: {
    notice(message: string): void;
    /** Al encender: las luces del usuario (los ojos de su color) */
    lightsOn(): void;
    /** Al empezar a apagarse: cortar lo que esté haciendo (el turno de la IA) */
    onOff(): void;
  },
): Power {
  const motion = session.service('ALMotion');
  const posture = session.service('ALRobotPosture');
  const leds = session.service('ALLeds');

  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'hud-power';
  button.innerHTML = ICONS.power;
  host.append(button);

  let state: PowerState = 'on';
  let lastNotice = -Infinity;
  const paint = () => {
    button.dataset.state = state;
    button.title = TITLE[state];
    button.setAttribute('aria-label', TITLE[state]);
    button.setAttribute('aria-pressed', String(state === 'on'));
  };
  paint();

  const power: Power = {
    get state() {
      return state;
    },
    ready() {
      if (state === 'on') return true;
      const now = performance.now() / 1000;
      if (now - lastNotice > NOTICE_EVERY_S) {
        lastNotice = now;
        notice(state === 'off' ? 'Tu NAO está apagado: enciéndelo con el botón de encendido junto a tu nombre.' : 'Tu NAO se está apagando…');
      }
      // El botón llama la atención (la animación vuelve a empezar en cada aviso)
      button.classList.remove('attention');
      void button.offsetWidth;
      button.classList.add('attention');
      return false;
    },
    async turnOff() {
      if (state !== 'on') return state === 'off';
      state = 'turning-off';
      paint();
      onOff();
      if (motion.moveIsActive()) {
        await motion.stopMove();
        await motion.waitUntilMoveIsFinished();
      }
      // Se apaga solo acostado: de pie o sentado, sin motores, se caería
      if (posture.getPostureFamily() !== 'LyingBack') await posture.goToPosture('LyingBack', 0.8);
      if (!posture.getPostureFamily().startsWith('Lying')) {
        state = 'on';
        paint();
        notice('No pude acostarme, así que no me apago: de pie o sentado me caería.');
        return false;
      }
      await motion.rest();
      leds.off('AllLeds');
      state = 'off';
      paint();
      return true;
    },
    turnOn() {
      if (state !== 'off') return;
      leds.reset('AllLeds');
      lightsOn();
      state = 'on';
      paint();
    },
  };
  button.addEventListener('click', () => {
    if (state === 'on') void power.turnOff();
    else if (state === 'off') power.turnOn();
  });
  return power;
}
