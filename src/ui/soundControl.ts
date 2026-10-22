// Interruptor y volumen del sonido (motores) en el panel oculto. Se recuerda en este navegador.

import type { MotorSound } from '../audio/motorSound';

const STORAGE_KEY = 'nao.sound';

export function attachSoundControl(host: HTMLElement, sound: MotorSound): void {
  let prefs = { on: true, volume: 0.7 };
  try {
    prefs = { ...prefs, ...JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}') };
  } catch {
    /* sin almacenamiento */
  }
  const save = () => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs));
    } catch {
      /* modo privado */
    }
  };
  sound.setEnabled(prefs.on);
  sound.setVolume(prefs.volume);

  const row = document.createElement('div');
  row.className = 'sound-control';
  const label = document.createElement('span');
  label.textContent = 'Sonido';
  const toggle = document.createElement('button');
  toggle.type = 'button';
  toggle.className = 'chip';
  const paint = () => (toggle.textContent = prefs.on ? 'Motores: sí' : 'Motores: no');
  paint();
  toggle.addEventListener('click', () => {
    prefs.on = !prefs.on;
    sound.start(); // el clic también cuenta como gesto para habilitar el audio
    sound.setEnabled(prefs.on);
    paint();
    save();
  });
  const volume = document.createElement('input');
  volume.type = 'range';
  volume.min = '0';
  volume.max = '1';
  volume.step = '0.05';
  volume.value = String(prefs.volume);
  volume.setAttribute('aria-label', 'Volumen');
  volume.addEventListener('input', () => {
    prefs.volume = Number(volume.value);
    sound.setVolume(prefs.volume);
    save();
  });
  row.append(label, toggle, volume);
  host.append(row);
}
