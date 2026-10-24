// Mundo compartido (docs/PLAN.md F16): varios NAO en el mismo mundo, cada uno simulado por el navegador de su dueño.
//
//   - Presencia (nao-api, por la sala del teléfono que la pantalla abre al entrar): la cápsula de cada uno y quién está.
//     Las cápsulas se encienden con el color de su dueño.
//   - Solo con 2 o más personas se abre la sala del mundo (Durable Object de Cloudflare, world/; o la de nao-api, plan B)
//     con un pase firmado; al quedar solo se cierra a los LINGER_S. Robot quieto = cero mensajes.
//   - Estado propio a SEND_HZ, solo si cambió: binario de 140 bytes (ver pack). Los demás se dibujan suavizados
//     (sim/remoteNao.ts) y en la física local son cuerpos sólidos con los que choca el NAO del jugador.
//   - Apariencia ({t:'hi'}) al entrar, al cambiar y cuando entra alguien nuevo (con el estado completo).

import { JOINTS } from '../robot/naoV6';
import type { LedState } from '../robot/leds';
import { expandLed } from '../robot/leds';
import type { RobotState, RootPose } from '../robot/state';
import type { UrdfRobot } from '../robot/urdf';
import type { PhysicsClient } from '../physics/physicsClient';
import type { Pods } from '../sim/pods';
import { PARKED, POD_COUNT } from '../sim/pods';
import { type RemoteFrame, RemoteNao } from '../sim/remoteNao';
import { worldPass, worldUrl } from './api';
import type * as THREE from 'three';

export interface Player {
  pod: number;
  name: string;
  robot: string;
  shell: string;
}

/** Lo que manda nao-api a la pantalla ({t:'world'}) */
export interface Presence {
  pod: number;
  players: Player[];
}

const SEND_HZ = 15;
/** Al quedar solo se espera esto antes de cerrar la sala (alguien recargando la página vuelve enseguida) */
const LINGER_S = 30;
const RETRY_S = 3;
const PING_S = 30;
/** Cambio mínimo para mandar otro estado (rad, m) */
const EPS = 0.002;
/** Ojos de los NAO quietos de las cápsulas sin dueño: azul tenue */
const PARKED_EYES = 0x1d3f7a;
/** Color de un NAO de fábrica (sin color propio) para las luces de su cápsula */
const DEFAULT_SHELL = '#2f6bff';

const JOINT_NAMES = JOINTS.map((j) => j.name);
const STATE_BYTES = 8 + (7 + JOINT_NAMES.length) * 4;
const FACE = expandLed('FaceLeds') ?? [];

/** Estado propio → binario: [1, cápsula, encendido, 0] [ojos 0xRRGGBB] [torso x y z, qw qx qy qz] [ángulos] (float32) */
function pack(state: RobotState, on: boolean, eyes: number, out: ArrayBuffer): boolean {
  const root = state.root;
  if (!root) return false;
  const v = new DataView(out);
  v.setUint8(0, 1);
  v.setUint8(2, on ? 1 : 0);
  v.setUint32(4, eyes, true);
  const f = new Float32Array(out, 8);
  f.set(root.position, 0);
  f.set(root.quaternion, 3);
  JOINT_NAMES.forEach((n, i) => (f[7 + i] = state.get(n)));
  return true;
}

function unpack(data: ArrayBuffer): { pod: number; frame: RemoteFrame } | null {
  if (data.byteLength !== STATE_BYTES) return null;
  const v = new DataView(data);
  if (v.getUint8(0) !== 1) return null;
  const f = new Float32Array(data, 8);
  if (!f.every(Number.isFinite)) return null;
  return {
    pod: v.getUint8(1),
    frame: {
      on: v.getUint8(2) === 1,
      eyes: v.getUint32(4, true),
      position: [f[0], f[1], f[2]],
      quaternion: [f[3], f[4], f[5], f[6]],
      angles: f.slice(7),
    },
  };
}

/** Color promedio de los ojos (ALLeds FaceLeds) como 0xRRGGBB */
function eyeColor(leds: LedState): number {
  const sum = { Red: 0, Green: 0, Blue: 0 };
  const n = { Red: 0, Green: 0, Blue: 0 };
  for (const ch of FACE) {
    const c = (['Red', 'Green', 'Blue'] as const).find((k) => ch.includes(k));
    if (!c) continue;
    sum[c] += leds.get(ch);
    n[c]++;
  }
  const byte = (c: keyof typeof sum) => Math.round((255 * sum[c]) / Math.max(n[c], 1));
  return (byte('Red') << 16) | (byte('Green') << 8) | byte('Blue');
}

export interface SharedWorldOptions {
  urdf: UrdfRobot;
  scene: THREE.Scene;
  pods: Pods;
  state: RobotState;
  leds: LedState;
  invalidate(shadows?: boolean): void;
  physics(): PhysicsClient | null;
  /** Mallas oficiales para otro NAO (copia sin pintar) y cómo pintarle la carcasa; null si aún no cargan */
  meshes(): Map<string, THREE.Object3D> | null;
  paintShell(meshes: Iterable<THREE.Object3D>, hex: string): Promise<void>;
  /** El jugador: encendido, y su NAO tal como lo ven los demás */
  on(): boolean;
  me(): { robot: string; shell: string };
  /** Llegó la cápsula del jugador (al entrar, o si cambió): ahí aparece su NAO */
  onPod(pod: number): void;
  /** NAO quietos de las cápsulas sin dueño (pods.ts PARKED): pose del torso en esa cápsula y ángulos */
  parked: { root(pod: number): RootPose; angles: Readonly<Record<string, number>> };
}

interface Peer {
  player: Player;
  /** Lo último que dijo de sí mismo ({t:'hi'}): manda sobre lo de la presencia */
  hi: { robot?: string; shell?: string };
  nao: RemoteNao | null;
  painted: string;
}

export class SharedWorld {
  private pod = -1;
  private players: Player[] = [];
  private readonly peers = new Map<number, Peer>();
  private ws: WebSocket | null = null;
  private connecting = false;
  private displaced = false;
  private lingerTimer = 0;
  private retryTimer = 0;
  private pingTimer = 0;
  private sendClock = 0;
  private readonly out = new ArrayBuffer(STATE_BYTES);
  private readonly last = new Float32Array(7 + JOINT_NAMES.length);
  private lastFlags = '';
  private forceSend = false;
  private parkedReady = false;

  constructor(private readonly o: SharedWorldOptions) {}

  /** Cápsula del jugador (−1 = aún no) */
  get myPod(): number {
    return this.pod;
  }

  /** {t:'world'} de nao-api: la cápsula propia y quién está */
  presence(p: Presence): void {
    const first = this.pod < 0 && p.pod >= 0;
    const moved = this.pod >= 0 && p.pod >= 0 && p.pod !== this.pod;
    this.pod = p.pod;
    this.players = p.players ?? [];
    for (const pl of this.players) {
      if (pl.pod === this.pod) continue;
      const peer = this.peers.get(pl.pod);
      if (peer) peer.player = pl;
      else this.peers.set(pl.pod, { player: pl, hi: {}, nao: null, painted: '' });
    }
    for (const pod of [...this.peers.keys()]) if (!this.players.some((pl) => pl.pod === pod)) this.drop(pod);
    this.paintPods();
    if (first || moved) this.o.onPod(this.pod);
    this.syncConnection();
  }

  /** El jugador cambió el nombre o el color de su NAO: los demás lo ven al instante */
  appearanceChanged(): void {
    this.sendHi();
    this.paintPods();
  }

  /** Cada cuadro: manda el estado propio y mueve a los demás */
  update(dt: number): void {
    if (!this.parkedReady) this.placeParked();
    this.sendClock += dt;
    if (this.sendClock >= 1 / SEND_HZ) {
      this.sendClock = 0;
      this.sendState();
    }
    const now = performance.now() / 1000;
    const physics = this.o.physics();
    for (const [pod, peer] of this.peers) {
      if (!peer.nao) continue;
      if (peer.nao.update(now)) {
        physics?.setGhost(pod, (l) => peer.nao!.linkPose(l));
        this.o.invalidate(true);
      }
    }
  }

  // ─── Conexión ───────────────────────────────────────────────────────────────

  private syncConnection(): void {
    const crowd = this.pod >= 0 && this.players.length >= 2;
    if (crowd) {
      clearTimeout(this.lingerTimer);
      this.lingerTimer = 0;
      if (!this.ws && !this.connecting && !this.retryTimer && !this.displaced) void this.connect();
    } else if (this.ws && !this.lingerTimer) {
      this.lingerTimer = window.setTimeout(() => {
        this.lingerTimer = 0;
        this.close();
      }, LINGER_S * 1000);
    }
  }

  private async connect(): Promise<void> {
    this.connecting = true;
    let url: string;
    try {
      const { pass, url: base } = await worldPass();
      url = worldUrl(base, pass);
    } catch (e) {
      console.warn('Mundo compartido: sin pase', e);
      this.connecting = false;
      this.retry();
      return;
    }
    this.connecting = false;
    const ws = new WebSocket(url);
    ws.binaryType = 'arraybuffer';
    this.ws = ws;
    ws.onopen = () => {
      this.sendHi();
      this.forceSend = true;
      this.pingTimer = window.setInterval(() => ws.readyState === WebSocket.OPEN && ws.send('ping'), PING_S * 1000);
    };
    ws.onmessage = (e) => this.receive(e.data);
    ws.onclose = (e) => {
      if (this.ws !== ws) return;
      this.ws = null;
      clearInterval(this.pingTimer);
      // Otra pestaña de la misma persona tomó su lugar
      if (e.reason === 'replaced') this.displaced = true;
      for (const pod of this.peers.keys()) this.hide(pod);
      this.retry();
    };
  }

  private retry(): void {
    if (this.retryTimer || this.displaced) return;
    this.retryTimer = window.setTimeout(() => {
      this.retryTimer = 0;
      this.syncConnection();
    }, RETRY_S * 1000);
  }

  private close(): void {
    const ws = this.ws;
    this.ws = null;
    clearInterval(this.pingTimer);
    ws?.close(1000, 'solo');
    for (const pod of this.peers.keys()) this.hide(pod);
  }

  private send(data: string | ArrayBuffer): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(data);
  }

  private sendHi(): void {
    const me = this.o.me();
    this.send(JSON.stringify({ t: 'hi', robot: me.robot, shell: me.shell }));
  }

  private sendState(): void {
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    const on = this.o.on();
    const eyes = eyeColor(this.o.leds);
    if (!pack(this.o.state, on, eyes, this.out)) return;
    const f = new Float32Array(this.out, 8);
    const flags = `${on}:${eyes}`;
    let changed = this.forceSend || flags !== this.lastFlags;
    for (let i = 0; i < f.length && !changed; i++) if (Math.abs(f[i] - this.last[i]) > EPS) changed = true;
    if (!changed) return;
    this.forceSend = false;
    this.lastFlags = flags;
    this.last.set(f);
    this.send(this.out.slice(0));
  }

  private receive(data: unknown): void {
    if (data instanceof ArrayBuffer) {
      const msg = unpack(data);
      if (!msg || msg.pod === this.pod) return;
      const peer = this.peers.get(msg.pod);
      if (!peer) return; // aún no llega su presencia
      const nao = this.ensureNao(msg.pod, peer);
      nao?.push(msg.frame, performance.now() / 1000);
      return;
    }
    if (typeof data !== 'string' || data === 'pong') return;
    let m: Record<string, unknown>;
    try {
      m = JSON.parse(data);
    } catch {
      return;
    }
    const pod = Number(m.pod);
    if (m.t === 'join') {
      // Alguien nuevo: no tiene el estado de un NAO quieto (no se manda nada sin cambios)
      this.sendHi();
      this.forceSend = true;
    } else if (m.t === 'leave') this.hide(pod);
    else if (m.t === 'hi') {
      const peer = this.peers.get(pod);
      if (!peer) return;
      peer.hi = { robot: typeof m.robot === 'string' ? m.robot.slice(0, 40) : undefined, shell: typeof m.shell === 'string' ? m.shell : undefined };
      this.dress(pod, peer);
      this.paintPods();
    }
  }

  // ─── Los otros NAO ──────────────────────────────────────────────────────────

  /**
   * Los NAO quietos de las cápsulas sin dueño: agachados y apagados como recién llegados, con los ojos tenues. Se dibujan
   * y chocan como los de las personas, pero nunca cambian (un solo estado, sin red).
   */
  private placeParked(): void {
    const physics = this.o.physics();
    if (!physics || !this.o.meshes()) return;
    this.parkedReady = true;
    const now = performance.now() / 1000;
    for (const [pod, { shell }] of PARKED) {
      const nao = new RemoteNao(this.o.urdf, this.o.meshes()!, JOINT_NAMES, this.o.scene, () => this.o.invalidate());
      const root = this.o.parked.root(pod);
      const angles = Float32Array.from(JOINT_NAMES, (n) => this.o.parked.angles[n] ?? 0);
      nao.push({ position: [...root.position], quaternion: [...root.quaternion], angles, eyes: PARKED_EYES, on: true }, now - 1);
      nao.update(now);
      const roots: THREE.Object3D[] = [];
      nao.model.root.traverse((o) => o.name.startsWith('mesh:') && roots.push(o));
      void this.o.paintShell(roots, shell).then(() => this.o.invalidate());
      physics.setGhost(pod, (l) => nao.linkPose(l));
    }
    this.paintPods();
    this.o.invalidate(true);
  }

  private look(peer: Peer) {
    const shell = peer.hi.shell ?? peer.player.shell;
    return { robot: peer.hi.robot || peer.player.robot || 'NAO', owner: peer.player.name, shell: /^#[0-9a-f]{6}$/i.test(shell) ? shell : '' };
  }

  private ensureNao(pod: number, peer: Peer): RemoteNao | null {
    if (peer.nao) return peer.nao;
    const meshes = this.o.meshes();
    if (!meshes) return null;
    peer.nao = new RemoteNao(this.o.urdf, meshes, JOINT_NAMES, this.o.scene, () => this.o.invalidate());
    this.dress(pod, peer);
    return peer.nao;
  }

  /** Placa y color de carcasa del NAO de otra persona */
  private dress(_pod: number, peer: Peer): void {
    if (!peer.nao) return;
    const { robot, owner, shell } = this.look(peer);
    peer.nao.setTag(robot, owner, shell || DEFAULT_SHELL);
    if (peer.painted !== shell) {
      peer.painted = shell;
      const roots: THREE.Object3D[] = [];
      peer.nao.model.root.traverse((o) => o.name.startsWith('mesh:') && roots.push(o));
      void this.o.paintShell(roots, shell).then(() => this.o.invalidate());
    }
    this.o.invalidate();
  }

  /** Su NAO deja de verse (se fue de la sala del mundo); sigue en su cápsula si aún está en la presencia */
  private hide(pod: number): void {
    const peer = this.peers.get(pod);
    if (!peer?.nao) return;
    peer.nao.dispose(this.o.scene);
    peer.nao = null;
    peer.painted = '';
    this.o.physics()?.setGhost(pod, null);
    this.o.invalidate(true);
  }

  private drop(pod: number): void {
    this.hide(pod);
    this.peers.delete(pod);
  }

  private paintPods(): void {
    const me = this.o.me();
    for (let i = 0; i < POD_COUNT; i++) {
      if (i === this.pod) {
        const mine = this.players.find((p) => p.pod === i);
        this.o.pods.set(i, { color: /^#[0-9a-f]{6}$/i.test(me.shell) ? me.shell : DEFAULT_SHELL, title: me.robot || 'NAO', owner: mine?.name ?? '', mine: true });
        continue;
      }
      const parked = PARKED.get(i);
      if (parked) {
        this.o.pods.set(i, { color: parked.light, title: 'NAO', owner: 'EN ESPERA' });
        continue;
      }
      const peer = this.peers.get(i);
      if (!peer) {
        this.o.pods.set(i, null);
        continue;
      }
      const { robot, owner, shell } = this.look(peer);
      this.o.pods.set(i, { color: shell || DEFAULT_SHELL, title: robot, owner });
    }
  }
}
