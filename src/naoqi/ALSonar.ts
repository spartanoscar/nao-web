// ALSonar: los dos sonares del pecho (doc http://doc.aldebaran.com/2-8/naoqi/sensors/alsonar.html, no está en
// reference/). "In order to save battery power, ultrasonic sensors are not activated by default": las lecturas solo se
// publican en ALMemory (Device/SubDeviceList/US/{Left,Right}/Sensor/Value) mientras haya alguien suscrito. La medición
// es de la física (physics.ts, RobotState.sonar). Pendiente: los eventos SonarLeftDetected… (falta el sistema de
// eventos de ALMemory).

export class ALSonar {
  private readonly subscribers = new Set<string>();

  /** "Subscribes to ALSonar": enciende los sonares para ese nombre */
  subscribe(name: string): void {
    this.subscribers.add(String(name));
  }

  unsubscribe(name: string): void {
    this.subscribers.delete(String(name));
  }

  /** Nombres suscritos (para ALMemory: con alguno, las lecturas están vivas) */
  getSubscribersInfo(): string[] {
    return [...this.subscribers];
  }

  get active(): boolean {
    return this.subscribers.size > 0;
  }
}
