// HUD del mundo (estilo juego): arriba a la izquierda quién juega y cómo se llama su NAO; arriba a la derecha
// conectar el móvil, el volumen (ALAudioDevice: setOutputVolume / muteAudioOut) y salir.

import type { ALAudioDevice } from '../naoqi/ALAudioDevice';
import type { User } from '../net/api';
import { ICONS } from './icons';

const AUDIO_KEY = 'nao.audioOut';

export interface Hud {
  /** Botón "Conectar móvil" (lo maneja ui/phoneLink.ts) */
  phoneButton: HTMLButtonElement;
  setPhoneState(state: 'idle' | 'waiting' | 'connected'): void;
}

export function createHud(user: User, audio: ALAudioDevice, { onLogout }: { onLogout(): void }): Hud {
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
    </div>`;
  player.querySelector('.hud-avatar')!.textContent = user.displayName.trim().charAt(0).toUpperCase();
  player.querySelector('.hud-user')!.textContent = user.displayName;
  player.querySelector('.hud-robot span')!.textContent = user.robotName;

  const actions = document.createElement('div');
  actions.className = 'hud-actions';

  const phoneButton = document.createElement('button');
  phoneButton.type = 'button';
  phoneButton.className = 'hud-btn hud-phone';
  phoneButton.title = 'Usa tu teléfono como control: escanea el código QR';

  const volume = document.createElement('div');
  volume.className = 'hud-volume';
  const mute = document.createElement('button');
  mute.type = 'button';
  mute.className = 'hud-btn hud-icon';
  const slider = document.createElement('input');
  slider.type = 'range';
  slider.min = '0';
  slider.max = '100';
  slider.setAttribute('aria-label', 'Volumen');
  const paintVolume = () => {
    const v = audio.getOutputVolume();
    const muted = audio.isAudioOutMuted() || v === 0;
    mute.innerHTML = muted ? ICONS.mute : v < 50 ? ICONS.volumeLow : ICONS.volume;
    mute.title = muted ? 'Activar el sonido' : 'Silenciar';
    mute.setAttribute('aria-pressed', String(muted));
    slider.value = String(v);
    slider.style.setProperty('--fill', `${audio.isAudioOutMuted() ? 0 : v}%`);
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
  volume.append(mute, slider);

  const exit = document.createElement('button');
  exit.type = 'button';
  exit.className = 'hud-btn hud-icon';
  exit.title = 'Salir';
  exit.innerHTML = ICONS.logout;
  exit.addEventListener('click', onLogout);

  actions.append(phoneButton, volume, exit);
  document.body.append(player, actions);
  document.body.classList.add('in-world');
  paintVolume();

  const setPhoneState = (state: 'idle' | 'waiting' | 'connected') => {
    phoneButton.dataset.state = state;
    const label = state === 'connected' ? 'Móvil conectado' : state === 'waiting' ? 'Esperando móvil…' : 'Conectar móvil';
    phoneButton.innerHTML = `${ICONS.phone}<span>${label}</span>${state === 'connected' ? '<i class="hud-dot"></i>' : ''}`;
  };
  setPhoneState('idle');
  return { phoneButton, setPhoneState };
}
