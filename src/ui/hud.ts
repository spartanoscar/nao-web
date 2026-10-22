// HUD del mundo (estilo juego): arriba a la izquierda quién juega, cómo se llama su NAO y sus tokens; arriba a la
// derecha solo íconos: el móvil (QR), el volumen (ALAudioDevice: setOutputVolume / muteAudioOut; el control
// vertical se despliega hacia abajo al pasar el cursor) y los ajustes.

import type { ALAudioDevice } from '../naoqi/ALAudioDevice';
import type { User } from '../net/api';
import { ICONS } from './icons';

const AUDIO_KEY = 'nao.audioOut';

export interface Hud {
  /** Botón del móvil (lo maneja ui/phoneLink.ts) */
  phoneButton: HTMLButtonElement;
  /** Botón de ajustes (lo maneja ui/settings.ts) */
  settingsButton: HTMLButtonElement;
  setPhoneState(state: 'idle' | 'waiting' | 'connected'): void;
  /** Gasto del día actualizado (de /api/me o del servidor durante la transcripción) */
  setSpent(spentTodayUsd: number): void;
  /** Nombre, foto o nombre del NAO cambiaron (modal de ajustes) */
  setUser(user: User): void;
}

/** Tokens del juego: 1 token = US$0.001 del tope diario de IA (US$2 → 2000 tokens) */
export const TOKENS_PER_USD = 1000;

const PHONE_TITLE = {
  idle: 'Conectar móvil: usa tu teléfono como control (código QR)',
  waiting: 'Esperando el móvil…',
  connected: 'Móvil conectado',
};

export function createHud(user: User, audio: ALAudioDevice): Hud {
  // Volumen recordado en este navegador
  try {
    const saved = JSON.parse(localStorage.getItem(AUDIO_KEY) ?? 'null');
    if (saved) {
      audio.setOutputVolume(saved.volume);
      audio.muteAudioOut(saved.muted);
    }
  } catch {
    /* sin almacenamiento */
  }
  const save = () => {
    try {
      localStorage.setItem(AUDIO_KEY, JSON.stringify({ volume: audio.getOutputVolume(), muted: audio.isAudioOutMuted() }));
    } catch {
      /* modo privado */
    }
  };

  const player = document.createElement('div');
  player.className = 'hud-player';
  player.innerHTML = `
    <div class="hud-avatar" aria-hidden="true"></div>
    <div class="hud-names">
      <span class="hud-user"></span>
      <span class="hud-robot">${ICONS.robot}<span></span></span>
    </div>
    <div class="hud-tokens" title="Tokens disponibles hoy (1 token = US$0.001 de IA; se renuevan cada día)">${ICONS.token}<span></span></div>`;

  const actions = document.createElement('div');
  actions.className = 'hud-actions';

  const iconButton = (cls: string) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = `hud-btn hud-icon ${cls}`;
    return b;
  };
  const phoneButton = iconButton('hud-phone');

  // Volumen: el ícono silencia; el control vertical aparece debajo al pasar el cursor (o al enfocar, en táctil)
  const volume = document.createElement('div');
  volume.className = 'hud-volume';
  const mute = iconButton('hud-mute');
  const pop = document.createElement('div');
  pop.className = 'hud-volume-pop';
  const slider = document.createElement('input');
  slider.type = 'range';
  slider.min = '0';
  slider.max = '100';
  slider.setAttribute('aria-label', 'Volumen');
  const percent = document.createElement('span');
  pop.append(percent, slider);
  volume.append(mute, pop);
  const paintVolume = () => {
    const v = audio.getOutputVolume();
    const muted = audio.isAudioOutMuted() || v === 0;
    mute.innerHTML = muted ? ICONS.mute : v < 50 ? ICONS.volumeLow : ICONS.volume;
    mute.title = muted ? 'Activar el sonido' : 'Silenciar';
    mute.setAttribute('aria-label', mute.title);
    mute.setAttribute('aria-pressed', String(muted));
    slider.value = String(v);
    slider.style.setProperty('--fill', `${audio.isAudioOutMuted() ? 0 : v}%`);
    percent.textContent = audio.isAudioOutMuted() ? '0' : String(v);
  };
  mute.addEventListener('click', () => {
    audio.muteAudioOut(!audio.isAudioOutMuted());
    paintVolume();
    save();
  });
  slider.addEventListener('input', () => {
    audio.setOutputVolume(Number(slider.value));
    if (audio.isAudioOutMuted() && Number(slider.value) > 0) audio.muteAudioOut(false);
    paintVolume();
    save();
  });

  const settingsButton = iconButton('hud-settings');
  settingsButton.title = 'Ajustes';
  settingsButton.setAttribute('aria-label', 'Ajustes');
  settingsButton.innerHTML = ICONS.settings;

  actions.append(phoneButton, volume, settingsButton);
  document.body.append(player, actions);
  document.body.classList.add('in-world');
  paintVolume();

  const setPhoneState = (state: 'idle' | 'waiting' | 'connected') => {
    phoneButton.dataset.state = state;
    phoneButton.title = PHONE_TITLE[state];
    phoneButton.setAttribute('aria-label', PHONE_TITLE[state]);
    phoneButton.innerHTML = `${ICONS.phone}${state === 'connected' ? '<i class="hud-dot"></i>' : ''}`;
  };
  setPhoneState('idle');

  const tokens = player.querySelector<HTMLElement>('.hud-tokens span')!;
  const setSpent = (spentTodayUsd: number) => {
    const left = Math.max(0, Math.floor((user.dailyLimitUsd - spentTodayUsd) * TOKENS_PER_USD));
    tokens.textContent = left.toLocaleString('es-CO');
    player.classList.toggle('hud-low', left < user.dailyLimitUsd * TOKENS_PER_USD * 0.1);
  };

  const avatar = player.querySelector<HTMLElement>('.hud-avatar')!;
  const setUser = (u: User) => {
    user = u;
    if (u.avatarUrl) {
      const img = document.createElement('img');
      img.src = u.avatarUrl;
      img.alt = '';
      avatar.replaceChildren(img);
    } else avatar.textContent = u.displayName.trim().charAt(0).toUpperCase();
    player.querySelector('.hud-user')!.textContent = u.displayName;
    player.querySelector('.hud-robot span')!.textContent = u.robotName;
    setSpent(u.spentTodayUsd);
  };
  setUser(user);
  return { phoneButton, settingsButton, setPhoneState, setSpent, setUser };
}
