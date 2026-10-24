import './ui/styles.css';
import { type Object3D, Spherical, Vector3 } from 'three';
import urdfXml from '../reference/urdf/naoV50.urdf?raw';
import { postureJoints } from './naoqi/postures';
import { MOTION_CYCLE } from './naoqi/engine';
import { Session } from './naoqi/session';
import { MotorSound } from './audio/motorSound';
import { KokoroSpeech } from './audio/speech';
import type { PhysicsClient } from './physics/physicsClient';
import { RobotState } from './robot/state';
import { parseUrdf } from './robot/urdf';
import { addChestLogo } from './sim/chestLogo';
import { LedsView } from './sim/ledsView';
import { NaoCameras } from './sim/naoCameras';
import { NaoModel } from './sim/naoModel';
import { createWorld } from './sim/world';
import { HOME_ROOM, ROOMS, SPOTS, type RoomId, type SpawnId, roomAt, spawnLabel, spawnPoint } from './sim/rooms';
import { spawnObstacles } from './sim/environment';
import { POD_COUNT } from './sim/pods';
import type { RootPose } from './robot/state';
import { attachCameraViews } from './ui/cameraViews';
import { attachKeyboard } from './ui/keyboard';
import { showMeshCredit } from './ui/meshLicense';
import { runBoot } from './ui/boot';
import { createHud } from './ui/hud';
import { attachRobotMenus } from './ui/robotMenus';
import { type Power, attachPower } from './ui/power';
import { attachBodyPicker } from './ui/bodyPicker';
import { attachSettings } from './ui/settings';
import { type User, me, updateMe } from './net/api';
import { attachPhoneLink } from './ui/phoneLink';
import { SharedWorld } from './net/world';
import { createTranscript } from './ui/transcript';
import { startCrashLog } from './ui/crashLog';
import { Brain } from './ai/brain';
import { Vision } from './ai/vision';
import { FaceWatcher } from './ai/faces';
import { attachChat } from './ui/chat';

// Si la pestaña se cierra sola (iPad: límite de memoria), la próxima vez se sabe en qué iba (ui/crashLog.ts)
const crash = startCrashLog();

// Como un NAO recién encendido: en Crouch y con los motores apagados. motion.wakeUp() lo levanta.
const BOOT_POSTURE = postureJoints('Crouch');
const urdf = parseUrdf(urdfXml);
const state = new RobotState(BOOT_POSTURE);
const session = new Session(state);

const world = createWorld(document.getElementById('app')!);
const nao = new NaoModel(urdf);
world.scene.add(nao.root);
nao.apply(state);
// LEDs (ojos, orejas, cabeza, pecho, pies): se montan sobre las mallas oficiales al cargarlas
const ledViews: LedsView[] = [];
// Pose de arranque apoyada en el suelo (Crouch en el origen, la sala de pruebas), para la física
const bootRoot = nao.groundedRootPose();
/**
 * Hogar: donde apareció el robot (un cuarto de sim/rooms.ts). Aparecer en otro cuarto lo cambia; los bancos de física
 * siguen en el origen (bootRoot, la sala de pruebas).
 */
let home: RootPose = bootRoot;
// Ningún punto de aparición puede caer dentro o al lado de una pieza sólida (sim/environment.ts spawnObstacles): la
// física sacaría al robot empujándolo y cualquier prueba desde ahí sería inválida
// Las cápsulas (sim/pods.ts) con 20 cm: agachado el NAO mide ~30 cm de ancho y los pilares quedan a 20 cm del centro
const SPAWN_IDS = [...Object.keys(ROOMS), ...Object.keys(SPOTS), ...Array.from({ length: POD_COUNT }, (_, i) => `pod${i}`)] as SpawnId[];
for (const id of SPAWN_IDS) {
  const { x, y } = spawnPoint(id);
  const hits = spawnObstacles(x, y, id.startsWith('pod') ? 0.2 : undefined);
  if (hits.length) console.error(`Punto de aparición "${id}" invadido por: ${hits.map((h) => `${h.name} a ${h.distance} m`).join(', ')}`);
}
/** Pose de arranque en un cuarto: la de bootRoot (apoyado en el suelo) girada a su rumbo y llevada a su punto */
const roomRoot = (id: SpawnId): RootPose => {
  const { x, y, z = 0, yaw } = spawnPoint(id);
  const [bw, bx, by, bz] = bootRoot.quaternion;
  const [c, s] = [Math.cos(yaw / 2), Math.sin(yaw / 2)];
  return { position: [x, y, bootRoot.position[2] + z], quaternion: [c * bw - s * bz, c * bx - s * by, c * by + s * bx, c * bz + s * bw] };
};

let physics: PhysicsClient | null = null;
/** Vuelve al hogar agachado y con los motores apagados, como recién encendido */
const resetAtHome = () => {
  session.engine.stopAll();
  session.service('ALMotion').setStiffnesses('Body', 0);
  state.setMany(BOOT_POSTURE);
  physics?.reset(home, BOOT_POSTURE);
};
/**
 * Aparece en un cuarto, agachado y con los motores apagados (como recién encendido). La cámara del mundo va con él, con
 * el mismo encuadre que en el origen (de frente y un poco al costado), girado a su rumbo.
 */
const place = (id: SpawnId) => {
  home = roomRoot(id);
  resetAtHome();
  const { x, y, yaw, camera } = spawnPoint(id);
  const [c, s] = [Math.cos(yaw), Math.sin(yaw)];
  const target = new Vector3(x, 0.28 + (spawnPoint(id).z ?? 0), -y); // three: Y arriba, z = −y del URDF
  const [ox, oy, oz] = camera ?? [1.0, 0.27, 0.75];
  world.controls.target.copy(target);
  world.rig.position.set(target.x + ox * c + oz * s, target.y + oy, target.z - ox * s + oz * c);
  world.controls.update();
  world.focus(x, y, true);
  world.invalidate(true);
};
/**
 * Su cápsula llega de nao-api después de entrar: solo lo lleva allá si nadie lo puso en otro lado antes (Ajustes,
 * `nao.spawn` de los bancos). Si no, un banco que empezó en la sala de pruebas terminaba en la cápsula a mitad de camino.
 */
let autoPlaced = true;
const spawn = (id: SpawnId) => {
  autoPlaced = false;
  place(id);
};

// Sonido de los motores (sintetizado desde la física). El audio solo puede arrancar tras un gesto.
const sound = new MotorSound();
// Voz: Kokoro en un worker (el modelo se descarga la primera vez que el robot habla)
const speech = new KokoroSpeech();
speech.onReady = (engine) => crash.stage(`voz lista (${engine})`);
const tts = session.service('ALTextToSpeech');
tts.backend = speech;
// Volumen general del robot (ALAudioDevice): lo controla el ícono del HUD
session.service('ALAudioDevice').onOutputChange((gain) => {
  sound.setOutput(gain);
  speech.setOutput(gain);
});
const startAudio = () => sound.start();
window.addEventListener('pointerdown', startAudio, { once: true });
window.addEventListener('keydown', startAudio, { once: true });
// Cámaras de la frente y la boca (frames ópticos del URDF), siempre visibles a la izquierda
const cameras = new NaoCameras(nao);
attachCameraViews(world, cameras);
session.service('ALVideoDevice').source = { capture: (i, w, h) => cameras.capture(world.renderer, world.scene, i, w, h) };

// La cámara sigue al robot cuando camina (suavizado, en el plano del suelo) y conserva el ángulo y la distancia que haya
// elegido el usuario (sim/chaseCamera.ts)
const follow = () => {
  const root = state.root;
  if (root) world.focus(root.position[0], root.position[1]);
};

// Apariencia del NAO del usuario (paleta libre, guardada en su cuenta): carcasa (mallas oficiales, pintado en memoria) y
// ojos (ALLeds). "" = la de fábrica.
const shell: { paint: ((hex: string) => Promise<void>) | null } = { paint: null };
const paintEyes = (hex: string) => {
  const leds = session.service('ALLeds');
  if (hex) void leds.fadeRGB('FaceLeds', parseInt(hex.slice(1), 16), 0.4);
  else leds.reset('FaceLeds');
};

/** Mallas sin pintar para los NAO de otras personas (mundo compartido, net/world.ts) */
let remoteMeshes: ReadonlyMap<string, Object3D> | null = null;
let paintRemote: ((meshes: Iterable<Object3D>, hex: string) => Promise<void>) | null = null;

let officialLoaded: (meshes: ReadonlyMap<string, Object3D>) => void = () => {};
const officialReady = new Promise<ReadonlyMap<string, Object3D>>((resolve) => (officialLoaded = resolve));

// Mallas oficiales del NAO: se descargan solo con la licencia aceptada (pantalla de entrada, ui/boot.ts)
const loadModel = async (onProgress: (loaded: number, total: number) => void) => {
  const { loadOfficialMeshes, setShellColor, cloneOfficialMeshes } = await import('./sim/officialMeshes');
  const meshes = await loadOfficialMeshes(urdf, onProgress);
  nao.setOfficialMeshes(meshes);
  remoteMeshes = cloneOfficialMeshes(meshes); // antes de pintar las del jugador
  paintRemote = (roots, hex) => setShellColor(roots, hex ? parseInt(hex.slice(1), 16) : null);
  shell.paint = async (hex) => {
    await setShellColor(meshes.values(), hex ? parseInt(hex.slice(1), 16) : null);
    world.invalidate();
  };
  await shell.paint(''); // siempre: también pone la lente oscura de los ojos
  if (!addChestLogo(nao, () => world.invalidate())) console.warn('No encontré el pecho de la malla oficial para el logo');
  ledViews.push(new LedsView(nao));
  Object.assign((window as unknown as { nao: object }).nao, { meshes });
  officialLoaded(meshes);
  world.invalidate(true);
};

// Física MuJoCo (~2 MB, se carga aparte): colisión con la forma real de cada pieza (envolventes de las mallas oficiales,
// por eso espera a que carguen) y choque del robot consigo mismo. goToPosture necesita el grafo de posturas de NAOqi
// (scripts/fetch-naoqi-postures.sh): sin él no se entra.
const physicsReady = Promise.all([import('./physics/physicsClient'), import('./sim/officialMeshes'), import('./naoqi/naoqiPostureGraph'), officialReady]).then(
  async ([{ PhysicsClient }, { collisionHulls }, { loadPostureGraph }, meshes]) => {
    if (!(await loadPostureGraph())) throw new Error('falta el grafo de posturas de NAOqi (scripts/fetch-naoqi-postures.sh)');
    // Con lugar para los NAO de las otras cápsulas del mundo compartido (cuerpos sólidos que mueven sus dueños)
    physics = await PhysicsClient.create(urdf, state, session.engine, bootRoot, world.objects, { hulls: collisionHulls(meshes), ghosts: POD_COUNT });
    crash.stage('física lista');
    // El NAO del usuario aparece en su cápsula (nao-api la reparte al entrar) o, mientras no llega, en el centro de la sala
    place(shared.myPod >= 0 ? `pod${shared.myPod}` : HOME_ROOM);
    world.invalidate(true);
  },
);

// Mundo compartido (docs/PLAN.md F16): las cápsulas y los NAO de las demás personas (net/world.ts). El jugador y su
// encendido llegan después de la pantalla de entrada
const player: { user: User | null; power: Power | null } = { user: null, power: null };
const shared = new SharedWorld({
  urdf,
  scene: world.scene,
  pods: world.pods,
  state,
  leds: session.leds,
  invalidate: (shadows) => world.invalidate(shadows),
  physics: () => physics,
  meshes: () => (remoteMeshes ? cloneMeshes(remoteMeshes) : null),
  paintShell: (roots, hex) => paintRemote?.(roots, hex) ?? Promise.resolve(),
  on: () => player.power?.state === 'on',
  me: () => ({ robot: player.user?.robotName ?? '', shell: player.user?.shellColor ?? '' }),
  // Al entrar (o si nao-api la cambió): a su cápsula, agachado y con los motores apagados
  onPod: (pod) => physics && autoPlaced && place(`pod${pod}`),
  parked: { root: (pod) => roomRoot(`pod${pod}`), angles: BOOT_POSTURE },
});
let cloneMeshes: (m: ReadonlyMap<string, Object3D>) => Map<string, Object3D> = () => new Map();
void import('./sim/officialMeshes').then((m) => (cloneMeshes = m.cloneOfficialMeshes));

// Inclinación del teléfono (ui/phoneLink.ts): gira la cámara alrededor del robot, como un joystick
const TILT_DEADZONE = 0.08;
const TILT_RATE = { azimuth: 1.6, polar: 0.9 }; // rad/s con el teléfono inclinado a fondo
/** Sin mensajes de inclinación por este tiempo se detiene (el teléfono se desconectó o perdió señal) */
const TILT_TIMEOUT = 0.4;
const tilt = { x: 0, y: 0, at: 0 };
const orbit = new Spherical();
const offset = new Vector3();
const applyTilt = (dt: number) => {
  if (performance.now() / 1000 - tilt.at > TILT_TIMEOUT) return;
  if (Math.abs(tilt.x) < TILT_DEADZONE && Math.abs(tilt.y) < TILT_DEADZONE) return;
  const { rig: camera, controls } = world; // se gira la guía del jugador, no la cámara acortada por las paredes
  offset.copy(camera.position).sub(controls.target);
  orbit.setFromVector3(offset);
  orbit.theta -= tilt.x * TILT_RATE.azimuth * dt;
  orbit.phi = Math.min(Math.max(orbit.phi + tilt.y * TILT_RATE.polar * dt, 0.15), controls.maxPolarAngle);
  offset.setFromSpherical(orbit);
  camera.position.copy(controls.target).add(offset);
  controls.update(); // dispara 'change' → world.invalidate()
};

/**
 * Velocidad de la simulación (bancos de prueba, consola): ×N = N veces más simulación por cuadro, la misma física.
 * Techo práctico ~×10: la física da ~14 veces el tiempo real.
 */
let speed = 1;
const sim = {
  speed: () => speed,
  setSpeed(k: number) {
    speed = Math.min(Math.max(Math.round(k), 1), 10);
  },
};

/** En qué cuarto está el torso: la cámara del mundo muestra ese cuarto y el pasillo (world.setRoom) */
let currentRoom: RoomId | null | undefined;
const trackRoom = () => {
  const p = state.root?.position ?? home.position;
  const room = roomAt(p[0], p[1]);
  if (room === currentRoom) return;
  currentRoom = room;
  world.setRoom(room);
};

/** Avisos en cada paso de la simulación (bancos de prueba: miden igual a ×1 que a ×10) */
const tickHooks = new Set<() => void>();

/**
 * Simulación: motor de NAOqi (aquí) y física (MuJoCo en un Web Worker, physics/physicsClient.ts) intercalados ciclo a
 * ciclo (≤ 20 ms, como el DCM): el motor decide los comandos del ciclo, el worker lo simula y devuelve el estado, y
 * recién entonces empieza el siguiente. Cada ciclo es una tarea aparte, así que entre ciclos avanzan las promesas de NAOqi
 * (moveTo decide cada 0.1 s de simulación) igual a ×1 que a ×10. Antes la física corría aquí mismo y dibujar esperaba a
 * MuJoCo: con el NAO de pie se llevaba ~la mitad de cada segundo y con dos pestañas el computador se saturaba (medido
 * 2026-10-24). Historia: a ×10 se llegó a simular 1 s de una vez y la marcha bajó de 7/7 a 4/7 (moveTo corregía una vez
 * por segundo); por eso el paso a paso.
 */
/** Simulación pendiente (s); si la computadora no alcanza, no se acumula más que esto (la velocidad real baja) */
const MAX_SIM_DEBT = 1;
let simDebt = 0;
let cycling = false;
const nextCycle = () => {
  if (!physics || cycling || simDebt <= 1e-9) return;
  const h = Math.min(simDebt, MOTION_CYCLE);
  simDebt -= h;
  cycling = true;
  session.update(h);
  void physics.cycle(h).then((moved) => {
    cycling = false;
    if (moved) world.invalidate(true);
    for (const fn of tickHooks) fn();
    nextCycle();
  });
};

world.onFrame((dt) => {
  simDebt = Math.min(simDebt + dt * speed, MAX_SIM_DEBT);
  nextCycle();
  applyTilt(dt);
  shared.update(dt);
  if (physics) {
    const hearing = world.camera.position.distanceTo(world.controls.target);
    sound.update(physics.telemetry(), hearing);
    for (const hit of physics.takeImpacts()) sound.impact(hit, hearing);
  }
  let ledsChanged = false;
  for (const v of ledViews) ledsChanged = v.update(session.leds) || ledsChanged;
  if (ledsChanged) world.invalidate();
  if (nao.apply(state)) {
    follow();
    trackRoom();
    world.invalidate(true);
  }
});

// Acceso desde la consola del navegador:
//   const motion = nao.session.service('ALMotion')
//   await motion.angleInterpolation('HeadYaw', [1, -1, 0], [1, 2, 3], true)
// Para la consola y los bancos (scripts/bench): `sim` = velocidad; `clock`/`wait`/`onTick` van con el reloj del motor
// de NAOqi, no con el de la pared, así que los bancos dan lo mismo a ×1 que a ×10; `reset` vuelve al hogar agachado.
const simWait = (ms: number) =>
  new Promise<void>((resolve) => {
    const end = session.engine.time + ms / 1000;
    const check = () => (session.engine.time >= end ? resolve() : setTimeout(check, 4));
    check();
  });
const onTick = (fn: () => void) => {
  tickHooks.add(fn);
  return () => void tickHooks.delete(fn);
};
Object.assign(window, {
  nao: {
    session, state, model: nao, world, ledViews, sound, cameras, urdf, bootRoot, get physics() { return physics; },
    sim, clock: () => session.engine.time, wait: simWait, onTick, spawn, reset: resetAtHome, rooms: ROOMS,
    get home() { return home; },
  },
});

// ─── Entrada al mundo ───────────────────────────────────────────────────────────
// Login + licencia + "Cargando universo…": el mundo se carga detrás y solo se muestra completo
const user = await runBoot({ loadModel, physics: physicsReady, warmUp: () => world.renderNow() });
crash.stage('en el mundo');
crash.report();
player.user = user;
showMeshCredit();
const hud = createHud(user, session.service('ALAudioDevice'));
// La apariencia guardada en la cuenta
if (user.shellColor) void shell.paint?.(user.shellColor);
if (user.eyeColor) paintEyes(user.eyeColor);
const applyAppearance = (prev: { shellColor: string; eyeColor: string }, next: User) => {
  if (next.shellColor !== prev.shellColor) void shell.paint?.(next.shellColor);
  if (next.eyeColor !== prev.eyeColor) paintEyes(next.eyeColor);
};
// Rostros en la cámara del teléfono (ai/faces.ts): detector diminuto siempre, reconocimiento solo con una cara clara
const faces = new FaceWatcher();
void faces.loadPeople();
// Ajustes: lo que se guarda se ve al instante en el HUD y en los subtítulos (leen `user` en cada uso)
attachSettings(hud.settingsButton, user, {
  faces,
  onChange: (u) => {
    applyAppearance(user, u);
    Object.assign(user, u);
    hud.setUser(u);
    shared.appearanceChanged();
  },
  // La biblioteca terminó de guardar algo: el servidor ya lo cobró
  onSpent: () => void me().then((u) => u && hud.setSpent(u.spentTodayUsd)),
  // Aparecer en un cuarto del mundo (sim/rooms.ts): agachado y con los motores apagados, como recién encendido
  rooms: [
    { id: 'capsula', label: 'TU CÁPSULA' },
    ...(['casa', 'laboratorio', 'espejo', 'bano', 'pruebas', 'rampa', 'escalera', 'pasillo'] as SpawnId[]).map((id) => ({ id, label: spawnLabel(id) })),
  ],
  onSpawn: (id) => spawn(id === 'capsula' ? (shared.myPod >= 0 ? `pod${shared.myPod}` : HOME_ROOM) : (id as SpawnId)),
});
const transcript = createTranscript();
// Lo que dice el NAO aparece en sus subtítulos (ámbar); lo que se le habla al teléfono, en los de quien habla
let naoLine = 0;
tts.onSay = (text) => transcript.show(`nao-${naoLine++}`, 'nao', user.robotName, text, true);
let captionError = '';
// Cerebro (Gemini por el servidor): lo que se le dice o escribe → lo que responde y hace
const vision = new Vision(session.service('ALVideoDevice'), cameras.cameras);
vision.phone = faces; // con la cámara del teléfono activa, su foto va a la derecha de la imagen del turno
session.service('ALFaceDetection').store = faces; // learnFace/forgetPerson con lo que ve el teléfono
const brain = new Brain(session, state, vision, {
  robotName: () => user.robotName,
  thinking: (on) => (on ? transcript.show('thinking', 'nao', user.robotName, '…', false) : transcript.clear('thinking')),
  spent: (usd) => hud.setSpent(usd),
  error: (message) => transcript.notice(message),
  action: (name, args, response) => console.info('NAO ▶', name, args, '→', response),
  appearance: () => ({ shell: user.shellColor, eyes: user.eyeColor }),
  setAppearance: async (patch) => {
    const u = await updateMe({ ...(patch.shell !== undefined ? { shellColor: patch.shell } : {}), ...(patch.eyes !== undefined ? { eyeColor: patch.eyes } : {}) });
    applyAppearance(user, u);
    Object.assign(user, u);
    hud.setUser(u);
    shared.appearanceChanged();
    return { shell: u.shellColor, eyes: u.eyeColor };
  },
  // "Te vas a llamar Lucky": se guarda en la cuenta y se ve al instante en la tarjeta (y la voz responde a ese nombre)
  setRobotName: async (name) => {
    const u = await updateMe({ robotName: name });
    Object.assign(user, u);
    hud.setUser(u);
    shared.appearanceChanged();
    return u.robotName;
  },
  // "Descansa": se apaga como con el botón (se acuesta boca arriba primero)
  powerOff: () => power.turnOff(),
});
// Encendido (ui/power.ts): botón en la tarjeta del jugador. Apagado no recibe órdenes de ningún lado.
const power = attachPower(hud.player, session, {
  notice: (message) => transcript.notice(message),
  lightsOn: () => user.eyeColor && paintEyes(user.eyeColor),
  onOff: () => brain.cancel(),
});
player.power = power;
// Mover una pieza a mano: Shift + clic la elige (amarilla) y las flechas la mueven; Esc la suelta (ui/bodyPicker.ts)
attachBodyPicker(world, nao, session, power);
// Posturas y animaciones: dos íconos del HUD con su lista (ui/robotMenus.ts)
attachRobotMenus(hud, session, () => power.ready(), (message) => transcript.notice(message));
attachChat(
  () => user.robotName,
  (text) => {
    transcript.show(`chat-${Date.now()}`, 'user', user.displayName, text, true);
    if (power.ready()) void brain.ask(text, 'texto');
  },
);
attachPhoneLink(hud, session.service('ALVideoDevice'), {
  tilt: (x, y) => Object.assign(tilt, { x, y, at: performance.now() / 1000 }),
  connected: () => power.state === 'on' && void tts.say('Bienvenido').catch((e) => console.warn('Voz:', e)),
  caption: (id, text, final) => {
    transcript.show(`user-${id}`, 'user', user.displayName, text, final);
    if (final && brain.addressed(text) && power.ready()) void brain.ask(text, 'voz');
  },
  usage: (spent) => hud.setSpent(spent),
  phoneFrame: (jpeg) => void faces.push(jpeg),
  world: (presence) => {
    shared.presence(presence);
    crash.stage(`mundo compartido: ${presence.players.length} persona(s), cápsula ${presence.pod + 1}`);
  },
  captionError: (message) => {
    if (message === captionError) return; // un aviso por motivo, no uno por frase
    captionError = message;
    transcript.notice(message);
  },
});
/**
 * Saludo local (sin IA, sin costo): una persona registrada aparece en la cámara del teléfono y no se la ha visto en
 * GREET_AGAIN_S → el NAO dice "¡Hola, Oscar!". Desconocidos no: no se saluda a quien no autorizó ser reconocido.
 */
const GREET_AGAIN_S = 600;
const greeted = new Map<string, number>();
/**
 * Alguien nuevo en el teléfono: el NAO toma la iniciativa y le pregunta su nombre y si puede recordar su cara (un turno
 * corto del modelo barato, ~US$0.001). Solo si la cara sigue ahí UNKNOWN_FOR_S y no hay otro turno en curso; a la misma
 * cara (huella parecida) no se le vuelve a preguntar en ASK_AGAIN_S (quizá dijo que no). La respuesta abre la
 * conversación y, si dice que sí, la IA usa remember_face.
 */
const UNKNOWN_FOR_S = 2;
const ASK_AGAIN_S = 1800;
let unknownSince = 0;
const asked: { descriptor: Float32Array; at: number }[] = [];
const meetStrangers = (now: number) => {
  const strangers = faces.strangers();
  if (!strangers.length) return void (unknownSince = 0);
  unknownSince ||= now;
  if (now - unknownSince < UNKNOWN_FOR_S || brain.busy) return;
  const recent = asked.filter((a) => now - a.at < ASK_AGAIN_S);
  const fresh = strangers.find((d) => !recent.some((a) => faces.same(a.descriptor, d)));
  if (!fresh) return;
  asked.splice(0, asked.length, ...recent, { descriptor: fresh, at: now });
  void brain.ask(
    '[evento] Apareció en la cámara del teléfono una persona que no conoces. Salúdala con naturalidad (no menciones el teléfono ni la palabra "registrar"), preséntate y pregúntale cómo se llama y si te deja recordar su cara.',
    'evento',
  );
};
faces.onUpdate = () => {
  if (power.state !== 'on') return; // apagado no ve ni saluda
  const now = performance.now() / 1000;
  meetStrangers(now);
  const names = faces.faces().flatMap((f) => (f.name ? [f.name] : []));
  for (const name of names) {
    const last = greeted.get(name);
    greeted.set(name, now);
    if (last === undefined || now - last > GREET_AGAIN_S) void tts.say(`¡Hola, ${name}!`).catch((e) => console.warn('Voz:', e));
  }
};
// La voz se descarga y se calienta en segundo plano (la primera frase salía con varios segundos de espera);
// después del primer cuadro del mundo, para no competir con lo que se ve
setTimeout(() => {
  crash.stage('voz: cargando');
  speech.preload(tts.getVoice());
}, 1500);
attachKeyboard(session, power);
Object.assign((window as unknown as { nao: object }).nao, { user, transcript, brain, vision, faces, power, shared });
