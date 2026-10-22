import './ui/styles.css';
import { Spherical, Vector3 } from 'three';
import urdfXml from '../reference/urdf/naoV50.urdf?raw';
import { postureJoints } from './naoqi/postures';
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
import { createBehaviorPanel } from './ui/behaviorPanel';
import { attachCameraViews } from './ui/cameraViews';
import { attachHiddenPanel } from './ui/hiddenPanel';
import { createJointPanel } from './ui/jointPanel';
import { attachPoseRecorder, bootsLyingBack } from './ui/poseRecorder';
import { attachKeyboard } from './ui/keyboard';
import { showMeshCredit } from './ui/meshLicense';
import { runBoot } from './ui/boot';
import { createHud } from './ui/hud';
import { attachPhoneLink } from './ui/phoneLink';
import { createTranscript, playDemo } from './ui/transcript';
import { logout } from './net/api';
import { attachSoundControl } from './ui/soundControl';
import { createVoicePanel } from './ui/voicePanel';
import { createShellColorPicker, rememberedShellColor } from './ui/shellColor';

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

let physics: PhysicsSim | null = null;
const modeLine = document.querySelector('#hud p')!;
const setMode = (mode: string) => (modeLine.textContent = `Gemelo digital NAO V6 · NAOqi 2.8 · ${mode}`);
setMode('cargando física…');

const panelHost = document.getElementById('panel')!;
// El título técnico (versión, modo de física) va dentro del panel oculto: la pantalla queda para el juego
panelHost.prepend(document.getElementById('hud')!);
const behavior = createBehaviorPanel(panelHost, session, state, {
  onReset: () => {
    session.engine.stopAll();
    session.service('ALMotion').setStiffnesses('Body', 0);
    state.setMany(BOOT_POSTURE);
    physics?.reset(bootRoot, BOOT_POSTURE);
  },
});
// Grabador de poses (enseñar movimientos a mano, p. ej. levantarse de espaldas): parte boca arriba, en el centro
const LYING_BACK = postureJoints('LyingBack');
const startLyingBack = async (): Promise<boolean> => {
  if (!physics) return false;
  const motion = session.service('ALMotion');
  session.engine.stopAll();
  motion.setStiffnesses('Body', 0);
  state.setMany(LYING_BACK);
  // Girado 90° hacia atrás sobre el eje Y del mundo (Z arriba): la espalda queda en el suelo
  const [w, x, y, z] = bootRoot.quaternion;
  const [c, s] = [Math.SQRT1_2, -Math.SQRT1_2];
  const quaternion: [number, number, number, number] = [c * w - s * y, c * x + s * z, c * y + s * w, c * z - s * x];
  physics.reset({ position: [bootRoot.position[0], bootRoot.position[1], 0.08], quaternion }, LYING_BACK);
  await new Promise((r) => setTimeout(r, 1200)); // que se asiente antes de encender los motores
  motion.setStiffnesses('Body', 1);
  return true;
};
attachPoseRecorder(panelHost, session.service('ALMotion'), session.engine, { startLyingBack });
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

// La cámara sigue al robot cuando camina: se traslada con el torso (en el plano del suelo) y
// conserva el ángulo que haya elegido el usuario. Three: x = X del mundo, z = −Y del mundo.
let followed: [number, number] | null = null;
const follow = () => {
  const root = state.root;
  if (!root) return;
  const [x, y] = root.position;
  if (followed) {
    const [dx, dz] = [x - followed[0], -(y - followed[1])];
    if (Math.abs(dx) + Math.abs(dz) > 1e-5) {
      world.camera.position.x += dx;
      world.camera.position.z += dz;
      world.controls.target.x += dx;
      world.controls.target.z += dz;
    }
  }
  followed = [x, y];
};

// Mallas oficiales del NAO: se descargan solo con la licencia aceptada (pantalla de entrada, ui/boot.ts)
const loadModel = async (onProgress: (loaded: number, total: number) => void) => {
  const { loadOfficialMeshes, setShellColor, SHELL_COLORS } = await import('./sim/officialMeshes');
  const meshes = await loadOfficialMeshes(urdf, onProgress);
  nao.setOfficialMeshes(meshes);
  const paint = async (color: (typeof SHELL_COLORS)[number]) => {
    await setShellColor(meshes.values(), color);
    world.invalidate();
  };
  const initial = rememberedShellColor(SHELL_COLORS);
  await paint(initial); // siempre: también pone la lente oscura de los ojos
  createShellColorPicker(behavior.slot, SHELL_COLORS, initial, (c) => void paint(c));
  if (!addOfficialChestLogo(nao, () => world.invalidate())) console.warn('No encontré el pecho de la malla oficial para el logo');
  ledViews.push(new LedsView(nao, 'official'));
  world.invalidate(true);
};

// MuJoCo (~2 MB) se carga aparte: la escena aparece antes y, si falla, queda el modo cinemático
const physicsReady = import('./physics/physics')
  .then(({ PhysicsSim }) => PhysicsSim.create(urdf, state, session.engine, bootRoot, world.objects))
  .then((sim) => {
    physics = sim;
    session.engine.physical = true;
    session.engine.onManual = (name, value) => sim.placeJoint(name, value);
    setMode('física MuJoCo');
    world.invalidate(true);
    if (bootsLyingBack()) void startLyingBack();
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
  const { camera, controls } = world;
  offset.copy(camera.position).sub(controls.target);
  orbit.setFromVector3(offset);
  orbit.theta -= tilt.x * TILT_RATE.azimuth * dt;
  orbit.phi = Math.min(Math.max(orbit.phi + tilt.y * TILT_RATE.polar * dt, 0.15), controls.maxPolarAngle);
  offset.setFromSpherical(orbit);
  camera.position.copy(controls.target).add(offset);
  controls.update(); // dispara 'change' → world.invalidate()
};

world.onFrame((dt) => {
  session.update(dt);
  applyTilt(dt);
  if (physics?.step(dt)) world.invalidate(true);
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
    world.invalidate(true);
  }
  behavior.refresh();
  joints.refresh();
});

// Acceso desde la consola del navegador mientras llega la consola de comandos (F4):
//   const motion = nao.session.service('ALMotion')
//   await motion.angleInterpolation('HeadYaw', [1, -1, 0], [1, 2, 3], true)
Object.assign(window, { nao: { session, state, model: nao, world, ledViews, sound, cameras, get physics() { return physics; } } });

// ─── Entrada al mundo ───────────────────────────────────────────────────────────
// Login + licencia + "Cargando universo…": el mundo se carga detrás y solo se muestra completo
const user = await runBoot({ loadModel, physics: physicsReady, warmUp: () => world.renderNow() });
showMeshCredit((show) => {
  nao.showPrimitives(show);
  world.invalidate(true);
});
const hud = createHud(user, session.service('ALAudioDevice'), {
  onLogout: () => void logout().finally(() => location.reload()),
});
attachPhoneLink(hud, session.service('ALVideoDevice'), { tilt: (x, y) => Object.assign(tilt, { x, y, at: performance.now() / 1000 }) });
const transcript = createTranscript();
playDemo(transcript, user.displayName, user.robotName);
attachHiddenPanel();
const keyStatus = document.querySelector<HTMLElement>('.keys-status')!;
attachKeyboard(session, (text) => (keyStatus.textContent = text));
Object.assign((window as unknown as { nao: object }).nao, { user, transcript });
