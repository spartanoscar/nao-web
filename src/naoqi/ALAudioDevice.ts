// ALAudioDevice: volumen general de salida del robot. Misma firma que NAOqi 2.8.
// Docs: reference/naoqi-2.8-api/naoqi_audio_alaudiodevice-api.md
// La capa NAOqi no conoce WebAudio: guarda el estado y avisa a quien reproduce sonido (motores, voz), que
// multiplica su salida por `outputGain()`. Micrófonos y buffers (subscribe, sendRemoteBufferToOutput…) llegan con
// el audio del teléfono.

import { NaoqiError } from './args';

const SERVICE = 'ALAudioDevice';

export class ALAudioDevice {
  private volume = 70;
  private muted = false;
  private readonly listeners = new Set<(gain: number) => void>();

  /** "Gets the overall output volume of the system" [0, 100] */
  getOutputVolume(): number {
    return this.volume;
  }

  /** "Sets the overall output volume of the system" [0, 100] */
  setOutputVolume(volume: number): void {
    if (!Number.isFinite(volume)) throw new NaoqiError(SERVICE, 'setOutputVolume', 'volume debe ser un número entre 0 y 100');
    this.volume = Math.round(Math.min(Math.max(volume, 0), 100));
    this.emit();
  }

  /** "Mutes the output device" */
  muteAudioOut(mute: boolean): void {
    this.muted = Boolean(mute);
    this.emit();
  }

  /** "Tells if the audio output device has been muted by a call to muteAudioOut" */
  isAudioOutMuted(): boolean {
    return this.muted;
  }

  /**
   * Ganancia lineal para WebAudio. APPROX: el NAO no documenta su curva; se usa (v/100)² para que el control
   * suene parejo al oído (el volumen percibido es aproximadamente logarítmico).
   */
  outputGain(): number {
    return this.muted ? 0 : (this.volume / 100) ** 2;
  }

  /** Se llama ya con la ganancia actual y luego en cada cambio */
  onOutputChange(cb: (gain: number) => void): () => void {
    this.listeners.add(cb);
    cb(this.outputGain());
    return () => this.listeners.delete(cb);
  }

  private emit(): void {
    const g = this.outputGain();
    for (const cb of this.listeners) cb(g);
  }
}
