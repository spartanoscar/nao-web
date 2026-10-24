// Cámara de juego en tercera persona ("brazo con resorte", como en los juegos): el jugador orbita y hace zoom con una
// cámara guía (`rig`, la de OrbitControls) que nunca se toca; la cámara que se dibuja va sobre la misma línea guía →
// robot pero se acorta cuando una pared u objeto alto queda en medio, y vuelve suave a la distancia elegida cuando ya
// no estorba. El punto que se mira sigue al torso suavizado (sin el vaivén de cada paso).
//
// Antes (2026-10-23) la cámara se encerraba en el cuarto del robot moviendo su posición: al cruzar una puerta el límite
// cambiaba de cuarto y la cámara saltaba de golpe, y OrbitControls tomaba la posición empujada como la nueva distancia
// (el zoom elegido se perdía: "a veces se acerca mucho, a veces se aleja demasiado").

import * as THREE from 'three';
import { ENV_FIXED } from './environment';
import { WALL_HEIGHT } from './rooms';

/** Distancia que la cámara prefiere guardar de paredes y objetos (m): hacia ahí se acerca, suave */
const MARGIN = 0.15;
/** La que nunca cruza (m): aunque se acerque suave, jamás queda detrás de la cara de una pared */
const HARD_MARGIN = 0.04;
/** Constante de tiempo con que el brazo se acorta cuando una pared se interpone (s): rápido pero sin salto */
const ARM_IN = 0.07;
/** Lo más cerca que llega del robot aunque una pared empuje (m) */
const MIN_ARM = 0.3;
/** Constante de tiempo con que el brazo vuelve a su largo al dejar de estorbar la pared (s) */
const ARM_RETURN = 0.35;
/**
 * Sin espacio (un pasillo de 1.2 m no deja una cámara de costado a 1.3 m), la cámara sube hasta tener al menos esto libre
 * (m), como en los juegos en tercera persona: el robot se ve desde arriba en vez de con la cámara pegada a sus piernas
 */
const ROOMY = 0.9;
/** Lo más que sube: hasta este ángulo desde la vertical (rad) */
const TOP_POLAR = 0.3;
/** Lo más que gira alrededor del robot buscando espacio (rad): en un pasillo queda mirando a lo largo de él */
const MAX_SWING = 1.2;
/** Costo de cada forma de buscar espacio (por rad): subir es lo más natural; girar, algo menos; cambiar de lado, poco */
const COST = { lift: 1, swing: 1.4, flip: 0.5 };
/** Constante de tiempo con que sube, gira o vuelve (s) */
const LIFT_TIME = 0.4;
/** Constante de tiempo del seguimiento del torso (s): quita el balanceo de ±3 cm por paso */
const FOLLOW = 0.25;
/** Solo estorban las piezas más altas que esto (paredes, muebles altos); la rampa o un tapete no */
const MIN_HEIGHT = 0.6;

/** Cajas de colisión de la cámara en coordenadas de three (Y arriba, z = −y del mundo), agrandadas por `margin` */
function obstacles(margin: number): THREE.Box3[] {
  return ENV_FIXED.filter((o) => o.pos[2] + o.size[2] / 2 > MIN_HEIGHT).map((o) => {
    // Caja que contiene la pieza girada en el plano (conservadora con yaw ≠ 0)
    const [c, s] = [Math.abs(Math.cos(o.yaw)), Math.abs(Math.sin(o.yaw))];
    const hx = (c * o.size[0] + s * o.size[1]) / 2 + margin;
    const hy = (s * o.size[0] + c * o.size[1]) / 2 + margin;
    const hz = o.size[2] / 2 + margin;
    return new THREE.Box3(
      new THREE.Vector3(o.pos[0] - hx, o.pos[2] - hz, -o.pos[1] - hy),
      new THREE.Vector3(o.pos[0] + hx, o.pos[2] + hz, -o.pos[1] + hy),
    );
  });
}

export class ChaseCamera {
  private readonly soft = obstacles(MARGIN);
  private readonly hard = obstacles(HARD_MARGIN);
  private readonly ray = new THREE.Ray();
  private readonly hit = new THREE.Vector3();
  private readonly dir = new THREE.Vector3();
  /** Dónde debería estar el punto que se mira (el torso, sin suavizar) */
  private readonly goal = new THREE.Vector3();
  private arm = -1;
  /** Cuánto se subió (rad de ángulo polar) y cuánto giró (rad de azimut) respecto a la guía, suavizado */
  private lift = 0;
  private swing = 0;
  private readonly spherical = new THREE.Spherical();

  constructor(
    /** La que se dibuja (y con la que se elige con el ratón) */
    readonly camera: THREE.PerspectiveCamera,
    /** La guía del jugador: OrbitControls la mueve; nunca se acorta */
    readonly rig: THREE.PerspectiveCamera,
    private readonly target: THREE.Vector3,
  ) {
    this.goal.copy(target);
  }

  /** Seguir este punto (three); `snap` lo pone ya, sin suavizar (aparecer en otro lugar) */
  focus(point: THREE.Vector3, snap = false): void {
    this.goal.copy(point);
    if (!snap) return;
    this.rig.position.add(this.hit.subVectors(point, this.target));
    this.target.copy(point);
    this.arm = -1;
    this.lift = -1;
    this.swing = 0;
  }

  /** Avanza el seguimiento y el brazo; devuelve true si la cámara que se dibuja se movió */
  update(dt: number): boolean {
    // Seguimiento suave: la guía se traslada con el punto (conserva ángulo y distancia elegidos)
    const k = dt > 0 ? 1 - Math.exp(-dt / FOLLOW) : 1;
    const step = this.hit.subVectors(this.goal, this.target).multiplyScalar(k);
    if (step.lengthSq() > 1e-12) {
      this.target.add(step);
      this.rig.position.add(step);
    }

    // Dirección de la guía; si no hay ROOMY libre, la más parecida que lo tenga (subir y girar alrededor del robot, con
    // su costo) o, si ninguna, la que deja más espacio
    this.spherical.setFromVector3(this.dir.subVectors(this.rig.position, this.target));
    const want = this.spherical.radius;
    const needed = Math.min(want, ROOMY);
    let [goalLift, goalSwing] = [0, 0];
    this.aim(0, 0);
    if (this.clearance(want, this.soft, MARGIN) < needed) {
      const top = Math.max(this.spherical.phi - TOP_POLAR, 0);
      let [bestCost, bestFree] = [Infinity, -1];
      let [fallLift, fallSwing] = [0, 0];
      for (let lift = 0; lift <= top + 1e-6; lift += Math.max(top / 8, 0.01)) {
        for (let k = -6; k <= 6; k++) {
          const swing = (k / 6) * MAX_SWING;
          this.aim(lift, swing);
          const free = this.clearance(want, this.soft, MARGIN);
          const cost = COST.lift * lift + COST.swing * Math.abs(swing) + COST.flip * Math.abs(swing - this.swing);
          if (free >= needed && cost < bestCost) [bestCost, goalLift, goalSwing] = [cost, lift, swing];
          if (free > bestFree) [bestFree, fallLift, fallSwing] = [free, lift, swing];
        }
      }
      if (bestCost === Infinity) [goalLift, goalSwing] = [fallLift, fallSwing];
    }
    if (this.lift < 0 || dt <= 0) [this.lift, this.swing] = [goalLift, goalSwing];
    else {
      const k = 1 - Math.exp(-dt / LIFT_TIME);
      this.lift += (goalLift - this.lift) * k;
      this.swing += (goalSwing - this.swing) * k;
    }
    this.aim(this.lift, this.swing);

    const limit = Math.max(MIN_ARM, Math.min(want, this.clearance(want, this.soft, MARGIN)));
    const hard = Math.max(MIN_ARM, Math.min(want, this.clearance(want, this.hard, HARD_MARGIN)));
    // Hacia adentro rápido y hacia afuera más lento, ambos suaves; pero nunca más allá del límite duro (no se ve a
    // través de la pared mientras se acerca)
    if (this.arm < 0) this.arm = limit;
    else if (dt > 0) this.arm += (limit - this.arm) * (1 - Math.exp(-dt / (limit < this.arm ? ARM_IN : ARM_RETURN)));
    this.arm = Math.min(this.arm, hard);

    const before = this.camera.position.clone();
    this.camera.position.copy(this.target).addScaledVector(this.dir, this.arm);
    this.camera.lookAt(this.target);
    return before.distanceToSquared(this.camera.position) > 1e-10;
  }

  /** Pone `dir` hacia la guía, subida `lift` rad hacia la vertical y girada `swing` rad alrededor del robot */
  private aim(lift: number, swing: number): void {
    const { theta, phi } = this.spherical;
    this.dir.setFromSphericalCoords(1, Math.max(phi - lift, 0.01), theta + swing);
  }

  /** Distancia libre desde el punto que se mira hacia la guía: la primera pared, objeto alto o el techo */
  private clearance(want: number, boxes: THREE.Box3[], margin: number): number {
    this.ray.set(this.target, this.dir);
    let free = want;
    for (const box of boxes) {
      if (box.containsPoint(this.target)) continue; // el robot junto a una pieza: no lo encierra
      if (this.ray.intersectBox(box, this.hit)) free = Math.min(free, this.hit.distanceTo(this.target));
    }
    const ceiling = WALL_HEIGHT - margin;
    if (this.dir.y > 0) free = Math.min(free, (ceiling - this.target.y) / this.dir.y);
    return free;
  }
}
