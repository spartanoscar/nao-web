import './ui/styles.css';
import { type Object3D, Spherical, Vector3 } from 'three';
import urdfXml from '../reference/urdf/naoV50.urdf?raw';
import { postureJoints } from './naoqi/postures';
import { MOTION_CYCLE } from './naoqi/engine';
import { Session } from './naoqi/session';
import { MotorSound } from './audio/motorSound';
import { KokoroSpeech } from './audio/speech';
import type { PhysicsSim } from './physics/physics';
import { RobotState } from './robot/state';
import { parseUrdf } from './robot/urdf';
import { addOfficialChestLogo, addPrimitiveChestLogo } from './sim/chestLogo';
import { LedsView } from './sim/ledsView';
import { NaoCameras } from './sim/naoCameras';
import { NaoModel } from './sim/naoModel';
import { createWorld } from './sim/world';
import { HOME_ROOM, ROOMS, SPOTS, type RoomId, type SpawnId, roomAt, spawnLabel, spawnPoint } from './sim/rooms';
import { spawnObstacles } from './sim/environment';
import type { RootPose } from './robot/state';
import { createBehaviorPanel } from './ui/behaviorPanel';
import { attachCameraViews } from './ui/cameraViews';
import { attachHiddenPanel } from './ui/hiddenPanel';
import { createJointPanel } from './ui/jointPanel';
import { attachPoseRecorder } from './ui/poseRecorder';
import { type SimControl, attachAnimator } from './ui/animator';
import { attachLabPanel } from './ui/labPanel';
import { attachKeyboard } from './ui/keyboard';
import { showMeshCredit } from './ui/meshLicense';
import { runBoot } from './ui/boot';
import { createHud } from './ui/hud';
import { attachSettings } from './ui/settings';
import { type User, me, updateMe } from './net/api';
import { attachPhoneLink } from './ui/phoneLink';
import { createTranscript } from './ui/transcript';
import { attachSoundControl } from './ui/soundControl';
import { createVoicePanel } from './ui/voicePanel';
import { createShellColorPicker, rememberedShellColor } from './ui/shellColor';
import { Brain } from './ai/brain';
import { Vision } from './ai/vision';
import { FaceWatcher } from './ai/faces';
import { attachChat } from './ui/chat';

// Como un NAO recién encendido: en Crouch y con los motores apagados. motion.wakeUp() lo levanta.
const BOOT_POSTURE = postureJoints('Crouch');
const urdf = parseUrdf(urdfXml);
const state = new RobotState(BOOT_POSTURE);
const session = new Session(state);

const world = createWorld(document.getElementById('app')!);
const nao = new NaoModel(urdf);
world.scene.add(nao.root);
nao.apply(state);
addPrimitiveChestLogo(nao, () => world.invalidate());
// LEDs (ojos, orejas, cabeza, pecho, pies): una vista por cada modelo, ambas leen los mismos canales
const ledViews = [new LedsView(nao, 'primitive')];
// Pose de arranque apoyada en el suelo (calculada por el modelo cinemático), para la física y el reinicio
const bootRoot = nao.kinematicRootPose();
/**
 * Hogar: donde apareció el robot (un cuarto de sim/rooms.ts). "Reiniciar" y las poses de partida del grabador vuelven
 * aquí; el laboratorio de movimientos y los bancos de física siguen en el origen (bootRoot, la sala de pruebas).
 */
let home: RootPose = bootRoot;
// Ningún punto de aparición puede caer dentro o al lado de una pieza sólida (sim/environment.ts spawnObstacles): la
// física sacaría al robot empujándolo y cualquier prueba desde ahí sería inválida
for (const id of [...Object.keys(ROOMS), ...Object.keys(SPOTS)] as SpawnId[]) {
  const { x, y } = spawnPoint(id);
  const hits = spawnObstacles(x, y);
  if (hits.length) console.error(`Punto de aparición "${id}" invadido por: ${hits.map((h) => `${h.name} a ${h.distance} m`).join(', ')}`);
}
/** Pose de arranque en un cuarto: la de bootRoot (apoyado en el suelo) girada a su rumbo y llevada a su punto */
const roomRoot = (id: SpawnId): RootPose => {
  const { x, y, yaw } = spawnPoint(id);
  const [bw, bx, by, bz] = bootRoot.quaternion;
  const [c, s] = [Math.cos(yaw / 2), Math.sin(yaw / 2)];
  return { position: [x, y, bootRoot.position[2]], quaternion: [c * bw - s * bz, c * bx - s * by, c * by + s * bx, c * bz + s * bw] };
};

let physics: PhysicsSim | null = null;
const modeLine = document.querySelector('#hud p')!;
const setMode = (mode: string) => (modeLine.textContent = `Gemelo digital NAO V6 · NAOqi 2.8 · ${mode}`);
setMode('cargando física…');

const panelHost = document.getElementById('panel')!;
// El título técnico (versión, modo de física) va dentro del panel oculto: la pantalla queda para el juego
panelHost.prepend(document.getElementById('hud')!);
const resetAtHome = () => {
  session.engine.stopAll();
  session.service('ALMotion').setStiffnesses('Body', 0);
  state.setMany(BOOT_POSTURE);
  const { position, quaternion } = home;
  const [w, , , z] = quaternion;
  nao.setAnchor(position[0], position[1], 2 * Math.atan2(z, w)); // sin física (y para arrancarla) también ahí
  physics?.reset(home, BOOT_POSTURE);
};
/**
 * Aparece en un cuarto, agachado y con los motores apagados (como recién encendido). La cámara del mundo va con él, con
 * el mismo encuadre que en el origen (de frente y un poco al costado), girado a su rumbo.
 */
const spawn = (id: SpawnId) => {
  home = roomRoot(id);
  resetAtHome();
  const { x, y, yaw } = spawnPoint(id);
  const [c, s] = [Math.cos(yaw), Math.sin(yaw)];
  const target = new Vector3(x, 0.28, -y); // three: Y arriba, z = −y del URDF
  const [ox, oy, oz] = [1.0, 0.27, 0.75];
  world.controls.target.copy(target);
  world.rig.position.set(target.x + ox * c + oz * s, target.y + oy, target.z - ox * s + oz * c);
  world.controls.update();
  world.focus(x, y, true);
  world.invalidate(true);
};
const behavior = createBehaviorPanel(panelHost, session, state, {
  onReset: resetAtHome,
  rooms: (['casa', 'laboratorio', 'espejo', 'bano', 'pruebas', 'rampa', 'pasillo'] as SpawnId[]).map((id) => ({ id, label: spawnLabel(id) })),
  onSpawn: (id) => spawn(id as SpawnId),
});
// Grabador de poses (enseñar movimientos a mano): la pose de partida sale directa, sin ponerse de pie antes
const LYING_BACK = postureJoints('LyingBack');
/** Motores encendidos sosteniendo la pose en la que está (sin moverlo hacia un comando viejo) */
const holdCurrentPose = () => {
  const motion = session.service('ALMotion');
  const names = motion.getBodyNames('Body').filter((j) => !j.endsWith('Hand') && j !== 'RHipYawPitch');
  void motion.angleInterpolationWithSpeed(names, names.map((j) => state.get(j)), 0.2);
  motion.setStiffnesses('Body', 1);
};
/**
 * Con la física apagada (modo animador) las poses de partida son cinemáticas: ángulos de la postura y apoyo en el suelo
 * como esa postura (de pie sobre los pies; sentado o acostado, donde su centro de masa queda más bajo)
 */
const startKinematic = (posture: Parameters<typeof postureJoints>[0], footSupport: number, pitch: number): boolean => {
  session.engine.stopAll();
  state.setMany(postureJoints(posture));
  state.setBody({ footSupport, pitch });
  return true;
};
// Boca arriba: colocado 90° hacia atrás sobre el eje Y del mundo (Z arriba), la espalda en el suelo
const startLyingBack = async (): Promise<boolean> => {
  if (!simControl.physics()) return startKinematic('LyingBack', 0, -Math.PI / 2);
  if (!physics) return false;
  session.engine.stopAll();
  session.service('ALMotion').setStiffnesses('Body', 0);
  state.setMany(LYING_BACK);
  const [w, x, y, z] = home.quaternion;
  const [c, s] = [Math.SQRT1_2, -Math.SQRT1_2];
  const quaternion: [number, number, number, number] = [c * w - s * y, c * x + s * z, c * y + s * w, c * z - s * x];
  physics.reset({ position: [home.position[0], home.position[1], 0.08], quaternion }, LYING_BACK);
  await new Promise((r) => setTimeout(r, 1200)); // que se asiente antes de encender los motores
  holdCurrentPose();
  return true;
};
// Sentado: desde el arranque (Crouch) con los motores encendidos, Crouch → SitRelax → Sit a velocidad máxima: 3.2 s y
// sin ponerse de pie (5 de 5). Colocarlo de golpe en Sit no sirve: esa pose rígida se va de espaldas (medido, −40° → −87°
// en 0.7 s); sentado se sostiene por cómo quedan los apoyos al llegar.
const startSitting = async (): Promise<boolean> => {
  if (!simControl.physics()) return startKinematic('Sit', 0, -0.6);
  if (!physics) return false;
  session.engine.stopAll();
  session.service('ALMotion').setStiffnesses('Body', 0);
  state.setMany(BOOT_POSTURE);
  physics.reset(home, BOOT_POSTURE);
  await new Promise((r) => setTimeout(r, 1000));
  holdCurrentPose();
  await new Promise((r) => setTimeout(r, 200));
  return session.service('ALRobotPosture').goToPosture('Sit', 1);
};
// De pie: desde el arranque, wakeUp → StandInit
const startStanding = async (): Promise<boolean> => {
  if (!simControl.physics()) return startKinematic('StandInit', 1, 0);
  if (!physics) return false;
  session.engine.stopAll();
  session.service('ALMotion').setStiffnesses('Body', 0);
  state.setMany(BOOT_POSTURE);
  physics.reset(home, BOOT_POSTURE);
  await new Promise((r) => setTimeout(r, 1000));
  return session.service('ALMotion').wakeUp();
};
const recorder = attachPoseRecorder(panelHost, session.service('ALMotion'), session.engine, {
  back: startLyingBack,
  sit: startSitting,
  stand: startStanding,
});
// Laboratorio: busca movimientos equilibrados (CMA-ES sobre una física aparte) y los deja en el grabador
attachLabPanel(panelHost, urdf, bootRoot, recorder);
const joints = createJointPanel(panelHost, state, session.engine, {
  onHover: (joint) => {
    nao.highlight(joint);
    world.invalidate();
  },
});

// Sonido de los motores (sintetizado desde la física). El audio solo puede arrancar tras un gesto.
const sound = new MotorSound();
attachSoundControl(behavior.slot, sound);
// Voz: Kokoro en un worker (el modelo se descarga la primera vez que el robot habla)
const speech = new KokoroSpeech();
const tts = session.service('ALTextToSpeech');
tts.backend = speech;
const voicePanel = createVoicePanel(behavior.slot, tts);
speech.onStatus = (s) => voicePanel.setStatus(s);
// Volumen general del robot (ALAudioDevice): lo controla el ícono del HUD
session.service('ALAudioDevice').onOutputChange((gain) => {
  sound.setOutput(gain);
  speech.setOutput(gain);
});
const startAudio = () => sound.start();
window.addEventListener('pointerdown', startAudio, { once: true });
window.addEventListener('keydown', startAudio, { once: true });
// Cámaras de la frente y la boca (frames ópticos del URDF), siempre visibles en recuadros a la izquierda
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

// Física fiel (?fisica=fiel, en evaluación): colisión con la forma real de cada pieza (envolventes de las mallas
// oficiales) y choque del robot consigo mismo. Necesita las mallas: la física espera a que carguen.
const FAITHFUL_PHYSICS = new URLSearchParams(location.search).get('fisica') === 'fiel';
/** ?fisica=choque (en evaluación): las formas simples de siempre + choque del robot consigo mismo (piernas y brazos no se
 * atraviesan) */
const SELF_COLLISION = new URLSearchParams(location.search).get('fisica') === 'choque';
let officialLoaded: (meshes: ReadonlyMap<string, Object3D>) => void = () => {};
const officialReady = new Promise<ReadonlyMap<string, Object3D>>((resolve) => (officialLoaded = resolve));

// Mallas oficiales del NAO: se descargan solo con la licencia aceptada (pantalla de entrada, ui/boot.ts)
const loadModel = async (onProgress: (loaded: number, total: number) => void) => {
  const { loadOfficialMeshes, setShellColor, SHELL_COLORS } = await import('./sim/officialMeshes');
  const meshes = await loadOfficialMeshes(urdf, onProgress);
  nao.setOfficialMeshes(meshes);
  officialLoaded(meshes);
  const paint = async (color: (typeof SHELL_COLORS)[number]) => {
    await setShellColor(meshes.values(), color);
    world.invalidate();
  };
  shell.paint = (hex) => paint(hex ? { id: 'custom', label: 'Personalizado', hex: parseInt(hex.slice(1), 16) } : SHELL_COLORS[0]);
  const initial = rememberedShellColor(SHELL_COLORS);
  await paint(initial); // siempre: también pone la lente oscura de los ojos
  createShellColorPicker(behavior.slot, SHELL_COLORS, initial, (c) => void paint(c));
  if (!addOfficialChestLogo(nao, () => world.invalidate())) console.warn('No encontré el pecho de la malla oficial para el logo');
  ledViews.push(new LedsView(nao, 'official'));
  world.invalidate(true);
};

// Rutinas originales de Aldebaran (sentarse/levantarse, descargadas por scripts/fetch-aldebaran-motions.sh)
void import('./naoqi/aldebaranMotions').then(({ loadAldebaranMotions }) => loadAldebaranMotions());
// Grafo de posturas real de NAOqi 2.8 (scripts/fetch-naoqi-postures.sh): goToPosture lo usa con la física fiel, la única
// donde se verificó (ALRobotPosture.useNaoqiGraph)
if (FAITHFUL_PHYSICS) {
  void import('./naoqi/naoqiPostureGraph').then(async ({ loadPostureGraph }) => {
    if (await loadPostureGraph()) session.service('ALRobotPosture').useNaoqiGraph = true;
  });
}

// MuJoCo (~2 MB) se carga aparte: la escena aparece antes y, si falla, queda el modo cinemático
const physicsReady = import('./physics/physics')
  .then(async ({ PhysicsSim }) => {
    if (SELF_COLLISION) return PhysicsSim.create(urdf, state, session.engine, bootRoot, world.objects, { selfCollision: true });
    if (!FAITHFUL_PHYSICS) return PhysicsSim.create(urdf, state, session.engine, bootRoot, world.objects);
    const [{ collisionHulls }, { SHELL_FRICTION }, meshes] = await Promise.all([
      import('./sim/officialMeshes'),
      import('./physics/mjcf'),
      officialReady,
    ]);
    return PhysicsSim.create(urdf, state, session.engine, bootRoot, world.objects, {
      hulls: collisionHulls(meshes),
      selfCollision: true,
      shellFriction: SHELL_FRICTION,
    });
  })
  .then((sim) => {
    physics = sim;
    session.engine.physical = true;
    session.engine.onManual = (name, value) => sim.placeJoint(name, value);
    spawn(HOME_ROOM); // el NAO del usuario aparece en su punto de inicio (la física se arma en el origen)
    setMode(FAITHFUL_PHYSICS ? 'física MuJoCo (fiel)' : SELF_COLLISION ? 'física MuJoCo (con choque propio)' : 'física MuJoCo');
    world.invalidate(true);
    return true;
  })
  .catch((e) => {
    console.warn('Física no disponible, modo cinemático:', e);
    setMode('modo cinemático (sin física)');
    return false;
  });

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

// Controles de simulación (modo animador): física sí/no y velocidad. ×N = N pasos del motor de NAOqi y de la física por
// cuadro: la misma simulación, más rápido (techo práctico ~×10: la física da ~14 veces el tiempo real)
let physicsOn = true;
let speed = 1;
const simControl: SimControl = {
  physics: () => physicsOn && physics !== null,
  setPhysics(on) {
    if (!physics || on === physicsOn) return;
    const motion = session.service('ALMotion');
    if (!on) {
      // Sin física: queda donde está (posición y rumbo) y apoyado como su postura (de pie sobre los pies; sentado o
      // acostado, donde su centro de masa queda más bajo, cerca de la inclinación que tenía)
      const root = state.root;
      if (root) {
        const [w, x, y, z] = root.quaternion;
        nao.setAnchor(root.position[0], root.position[1], Math.atan2(2 * (w * z + x * y), 1 - 2 * (y * y + z * z)));
        const family = session.service('ALRobotPosture').getPostureFamily();
        state.setBody({ footSupport: family === 'Standing' || family === 'Crouching' ? 1 : 0, pitch: Math.atan2(2 * (x * z + w * y), 1 - 2 * (x * x + y * y)) });
      }
      session.engine.stopAll();
      session.engine.physical = false;
      state.clearRoot();
    } else {
      // Con física otra vez: arranca desde la pose que se ve, con los motores sosteniéndola
      session.engine.stopAll();
      const angles = Object.fromEntries(motion.getBodyNames('Body').map((j) => [j, state.get(j)]));
      physics.reset(nao.kinematicRootPose(), angles);
      session.engine.physical = true;
      const names = motion.getBodyNames('Body').filter((j) => !j.endsWith('Hand') && j !== 'RHipYawPitch');
      void motion.angleInterpolationWithSpeed(names, names.map((j) => state.get(j)), 0.2);
      motion.setStiffnesses('Body', 1);
    }
    physicsOn = on;
    world.invalidate(true);
  },
  speed: () => speed,
  setSpeed(k) {
    speed = Math.min(Math.max(Math.round(k), 1), 10);
  },
};

// Modo animador: tocar la pieza y moverla con las flechas, en vez de 25 sliders (mismas poses que el grabador)
const animator = attachAnimator(world, nao, session, recorder, simControl);
recorder.openAnimator = () => animator.open();

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
 * Simulación: motor de NAOqi y física intercalados en pasos de un ciclo (20 ms, como el DCM), en tramos de como mucho
 * SIM_CHUNK. Entre tramos se cede el turno (una tarea aparte con MessageChannel) para que avancen las promesas de NAOqi:
 * moveTo decide cada 0.1 s de simulación. Antes, a ×10 con el mundo completo cada cuadro tardaba ~100 ms y simulaba 1 s
 * de una vez: el motor calculaba una vez para 50 pasos de física y moveTo corregía una vez por segundo; la marcha se
 * desviaba y se caía (medido 2026-10-24: marcha 7/7 → 4/7). Así la simulación rápida es la misma que a ×1.
 */
const SIM_CHUNK = 5 * MOTION_CYCLE;
/** Simulación pendiente (s); si la computadora no alcanza, no se acumula más que esto (la velocidad real baja) */
const MAX_SIM_DEBT = 1;
let simDebt = 0;
const simulate = (seconds: number) => {
  const steps = Math.max(1, Math.ceil(seconds / MOTION_CYCLE - 1e-6));
  const h = seconds / steps;
  for (let i = 0; i < steps; i++) {
    session.update(h);
    if (physicsOn && physics?.step(h)) world.invalidate(true);
    for (const fn of tickHooks) fn();
  }
};
const pump = new MessageChannel();
let pumping = false;
const runChunk = () => {
  const h = Math.min(simDebt, SIM_CHUNK);
  if (h <= 1e-9) return;
  simDebt -= h;
  simulate(h);
};
pump.port1.onmessage = () => {
  pumping = false;
  runChunk();
  if (simDebt > 1e-9) {
    pumping = true;
    pump.port2.postMessage(0);
  }
};

world.onFrame((dt) => {
  simDebt = Math.min(simDebt + dt * speed, MAX_SIM_DEBT);
  runChunk();
  if (simDebt > 1e-9 && !pumping) {
    pumping = true;
    pump.port2.postMessage(0);
  }
  applyTilt(dt);
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
  behavior.refresh();
  joints.refresh();
});

// Acceso desde la consola del navegador mientras llega la consola de comandos (F4):
//   const motion = nao.session.service('ALMotion')
//   await motion.angleInterpolation('HeadYaw', [1, -1, 0], [1, 2, 3], true)
// Para la consola y los bancos (scripts/bench): `sim` = física sí/no y velocidad; `clock`/`wait`/`onTick` van con el
// reloj del motor de NAOqi, no con el de la pared, así que los bancos dan lo mismo a ×1 que a ×10
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
    sim: simControl, clock: () => session.engine.time, wait: simWait, onTick, spawn, rooms: ROOMS,
    get home() { return home; },
  },
});

// ─── Entrada al mundo ───────────────────────────────────────────────────────────
// Login + licencia + "Cargando universo…": el mundo se carga detrás y solo se muestra completo
const user = await runBoot({ loadModel, physics: physicsReady, warmUp: () => world.renderNow() });
showMeshCredit((show) => {
  nao.showPrimitives(show);
  world.invalidate(true);
});
const hud = createHud(user, session.service('ALAudioDevice'));
// La apariencia guardada en la cuenta gana sobre la del panel (que es solo de este navegador)
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
  },
  // La biblioteca terminó de guardar algo: el servidor ya lo cobró
  onSpent: () => void me().then((u) => u && hud.setSpent(u.spentTodayUsd)),
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
    return { shell: u.shellColor, eyes: u.eyeColor };
  },
});
attachChat(
  () => user.robotName,
  (text) => {
    transcript.show(`chat-${Date.now()}`, 'user', user.displayName, text, true);
    void brain.ask(text, 'texto');
  },
);
attachPhoneLink(hud, session.service('ALVideoDevice'), {
  tilt: (x, y) => Object.assign(tilt, { x, y, at: performance.now() / 1000 }),
  connected: () => void tts.say('Bienvenido').catch((e) => console.warn('Voz:', e)),
  caption: (id, text, final) => {
    transcript.show(`user-${id}`, 'user', user.displayName, text, final);
    if (final && brain.addressed(text)) void brain.ask(text, 'voz');
  },
  usage: (spent) => hud.setSpent(spent),
  phoneFrame: (jpeg) => void faces.push(jpeg),
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
setTimeout(() => speech.preload(tts.getVoice()), 1500);
attachHiddenPanel();
const keyStatus = document.querySelector<HTMLElement>('.keys-status')!;
attachKeyboard(session, (text) => (keyStatus.textContent = text));
Object.assign((window as unknown as { nao: object }).nao, { user, transcript, brain, vision, faces });
