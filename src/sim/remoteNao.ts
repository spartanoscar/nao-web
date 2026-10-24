// El NAO de otra persona en el mundo compartido (docs/PLAN.md F16). Su física corre en el navegador de su dueño; aquí
// llega su estado (~15 por segundo, net/world.ts) y se dibuja con las mallas oficiales, su color de carcasa, sus ojos y
// una placa con su nombre, suavizado: se muestra con DELAY de atraso, interpolando entre los dos estados que lo rodean.
// En la física local sus piezas son cuerpos mocap (PhysicsSim.setGhost): el NAO del jugador choca con él.

import * as THREE from 'three';
import { LED_CHANNELS, LedState, defaultIntensity, expandLed } from '../robot/leds';
import { RobotState } from '../robot/state';
import type { UrdfRobot } from '../robot/urdf';
import { addChestLogo } from './chestLogo';
import { LedsView } from './ledsView';
import { NaoModel } from './naoModel';

/** Estado recibido: torso (Z arriba), ángulos en el orden de `joints`, ojos (0xRRGGBB) y encendido */
export interface RemoteFrame {
  position: [number, number, number];
  quaternion: [number, number, number, number];
  angles: Float32Array;
  eyes: number;
  on: boolean;
}

/** Atraso con que se muestra (s): con ~15 estados por segundo siempre hay dos alrededor, aun con algo de variación */
const DELAY = 0.15;
const FACE = expandLed('FaceLeds') ?? [];

export class RemoteNao {
  readonly model: NaoModel;
  private readonly state = new RobotState();
  private readonly leds = new LedState();
  private readonly view: LedsView;
  private readonly tag: THREE.Sprite;
  private readonly frames: { t: number; f: RemoteFrame }[] = [];
  private lights = '';
  /** Último estado ya mostrado sin nada más nuevo: mientras no llegue otro, no se recalcula ni se redibuja */
  private settled: RemoteFrame | null = null;
  /** Hay estado para dibujar (antes del primero no se muestra) */
  shown = false;

  constructor(
    urdf: UrdfRobot,
    meshes: Map<string, THREE.Object3D>,
    private readonly joints: readonly string[],
    scene: THREE.Scene,
    invalidate: () => void,
  ) {
    this.model = new NaoModel(urdf);
    this.model.setOfficialMeshes(meshes);
    addChestLogo(this.model, invalidate);
    this.view = new LedsView(this.model);
    this.model.root.visible = false;
    scene.add(this.model.root);
    this.tag = new THREE.Sprite(new THREE.SpriteMaterial({ transparent: true, depthWrite: false }));
    this.tag.scale.set(0.24, 0.06, 1);
    this.tag.visible = false;
    scene.add(this.tag);
  }

  /** Placa sobre la cabeza: nombre del NAO y de su dueño, con el color de su NAO */
  setTag(robot: string, owner: string, color: string): void {
    const c = document.createElement('canvas');
    c.width = 512;
    c.height = 128;
    const g = c.getContext('2d')!;
    g.fillStyle = 'rgba(11,15,20,0.78)';
    g.beginPath();
    g.roundRect(4, 4, 504, 120, 26);
    g.fill();
    g.fillStyle = color;
    g.fillRect(4, 112, 504, 8);
    g.textAlign = 'center';
    g.fillStyle = '#fff';
    g.font = '800 54px system-ui, -apple-system, "Segoe UI", sans-serif';
    g.fillText(robot.toUpperCase(), 256, 62, 480);
    g.fillStyle = color;
    g.font = '700 30px system-ui, -apple-system, "Segoe UI", sans-serif';
    g.fillText(owner, 256, 100, 480);
    const old = this.tag.material.map;
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    this.tag.material.map = tex;
    this.tag.material.needsUpdate = true;
    old?.dispose();
  }

  push(f: RemoteFrame, now: number): void {
    this.frames.push({ t: now, f });
    // Lo que ya quedó atrás del tiempo que se muestra no hace falta (se guarda uno anterior para interpolar)
    while (this.frames.length > 2 && this.frames[1].t < now - DELAY - 0.5) this.frames.shift();
  }

  /** Lleva el modelo al estado de hace DELAY. Devuelve si algo cambió (redibujar) */
  update(now: number): boolean {
    const at = now - DELAY;
    const fs = this.frames;
    if (!fs.length) return false;
    // Ya se mostró el último estado y no llegó otro: nada cambió (si no, cada cuadro se redibujaba con sombras, la
    // física nunca quedaba en reposo y con dos pestañas la computadora se saturaba; medido 2026-10-24)
    const newest = fs[fs.length - 1];
    if (this.settled === newest.f && at >= newest.t) return false;
    let i = fs.length - 1;
    while (i > 0 && fs[i - 1].t > at) i--;
    // fs[i] es el primero posterior a `at` (o el último); se interpola desde el anterior
    const b = fs[i].f;
    const a = i > 0 ? fs[i - 1].f : b;
    const span = i > 0 ? fs[i].t - fs[i - 1].t : 1;
    const k = i > 0 ? Math.min(Math.max((at - fs[i - 1].t) / span, 0), 1) : 1;
    while (i > 1) {
      fs.shift(); // los anteriores a a ya no se usan
      i--;
    }
    const angles: Record<string, number> = {};
    this.joints.forEach((name, j) => (angles[name] = a.angles[j] + (b.angles[j] - a.angles[j]) * k));
    const qa = new THREE.Quaternion(a.quaternion[1], a.quaternion[2], a.quaternion[3], a.quaternion[0]);
    const qb = new THREE.Quaternion(b.quaternion[1], b.quaternion[2], b.quaternion[3], b.quaternion[0]);
    const q = qa.slerp(qb, k);
    const position = a.position.map((v, j) => v + (b.position[j] - v) * k) as [number, number, number];
    this.state.setFromPhysics({ position, quaternion: [q.w, q.x, q.y, q.z] }, angles);
    for (const name of ['LHand', 'RHand']) if (name in angles) this.state.set(name, angles[name]);
    if (at >= newest.t) this.settled = newest.f;
    this.setLights(b.on, b.eyes);
    let changed = this.model.apply(this.state);
    changed = this.view.update(this.leds) || changed;
    if (!this.shown) {
      this.shown = true;
      this.model.root.visible = true;
      this.tag.visible = !!this.tag.material.map; // los NAO quietos de las cápsulas no llevan placa
      changed = true;
    }
    if (changed) {
      // Placa: 0.38 m sobre el torso, en three (Y arriba, z = −y)
      this.tag.position.set(position[0], position[2] + 0.38, -position[1]);
      this.model.root.updateMatrixWorld(true);
    }
    return changed;
  }

  /** Ojos del color recibido; apagado, todas las luces apagadas */
  private setLights(on: boolean, eyes: number): void {
    const key = `${on}:${eyes}`;
    if (key === this.lights) return;
    this.lights = key;
    const rgb = { Red: ((eyes >> 16) & 255) / 255, Green: ((eyes >> 8) & 255) / 255, Blue: (eyes & 255) / 255 };
    for (const ch of LED_CHANNELS) this.leds.set(ch, on ? defaultIntensity(ch) : 0);
    if (on) for (const ch of FACE) this.leds.set(ch, rgb[(['Red', 'Green', 'Blue'] as const).find((c) => ch.includes(c)) ?? 'Blue']);
  }

  /** Posición del torso que se muestra (Z arriba), o null antes del primer estado */
  get rootPosition(): readonly number[] | null {
    return this.shown ? this.state.root?.position ?? null : null;
  }

  /** Pose de cada link (Z arriba) para la física local */
  linkPose(link: string) {
    return this.model.linkPose(link);
  }

  dispose(scene: THREE.Scene): void {
    scene.remove(this.model.root, this.tag);
    this.tag.material.map?.dispose();
    this.tag.material.dispose();
  }
}
