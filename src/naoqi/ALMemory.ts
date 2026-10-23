// ALMemory mínimo: pares clave-valor (reference/naoqi-2.8-api/naoqi_core_almemory-api.md). Por ahora: insertData,
// getData, getDataList, getDataListName, removeData, las lecturas del sonar y el último ALMotion/MoveFailed.
// Pendiente (F5): eventos (subscribeToEvent, raiseEvent con suscriptores) y el resto de los sensores.

import type { RobotState } from '../robot/state';
import { NaoqiError } from './args';
import type { ALSonar } from './ALSonar';

const SERVICE = 'ALMemory';
const SONAR_KEYS = ['Device/SubDeviceList/US/Left/Sensor/Value', 'Device/SubDeviceList/US/Right/Sensor/Value'];

export class ALMemory {
  private readonly data = new Map<string, unknown>();

  constructor(
    private readonly state: RobotState,
    private readonly sonar: ALSonar,
  ) {
    for (const key of SONAR_KEYS) this.data.set(key, 0);
  }

  /** "Inserts a key-value pair into memory" */
  insertData(key: string, value: unknown): void {
    this.data.set(String(key), value);
  }

  /**
   * "Gets the value of a key-value pair stored in memory". Sonar: la lectura de ahora si ALSonar está encendido; si no,
   * la última que se publicó (como los sensores apagados del robot real).
   */
  getData(key: string, _deprecatedParameter?: number): unknown {
    const i = SONAR_KEYS.indexOf(key);
    if (i >= 0 && this.sonar.active && this.state.sonar) this.data.set(key, this.state.sonar[i]);
    if (!this.data.has(key)) throw new NaoqiError(SERVICE, 'getData', `no existe la clave "${key}"`);
    return this.data.get(key);
  }

  /** "Gets a list of all key names that contain a given string" */
  getDataList(filter: string): string[] {
    return [...this.data.keys()].filter((k) => k.includes(filter));
  }

  /** "Gets the key names for all the key-value pairs in memory" */
  getDataListName(): string[] {
    return [...this.data.keys()];
  }

  removeData(key: string): void {
    this.data.delete(key);
  }
}
