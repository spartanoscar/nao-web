import './ui/styles.css';
import urdfXml from '../reference/urdf/naoV50.urdf?raw';
import { postureJoints } from './naoqi/postures';
import { Session } from './naoqi/session';
import type { PhysicsSim } from './physics/physics';
import { RobotState } from './robot/state';
import { parseUrdf } from './robot/urdf';
import { addOfficialChestLogo, addPrimitiveChestLogo } from './sim/chestLogo';
import { NaoModel } from './sim/naoModel';
import { createWorld } from './sim/world';
import { createBehaviorPanel } from './ui/behaviorPanel';
import { createJointPanel } from './ui/jointPanel';
import { attachKeyboard } from './ui/keyboard';
import { attachMeshLicense } from './ui/meshLicense';
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
// Pose de arranque apoyada en el suelo (calculada por el modelo cinemático), para la física y el reinicio
const bootRoot = nao.kinematicRootPose();

let physics: PhysicsSim | null = null;
const hud = document.querySelector('#hud p')!;
const setMode = (mode: string) => (hud.textContent = `Gemelo digital NAO V6 · NAOqi 2.8 · ${mode}`);
setMode('cargando física…');

const panelHost = document.getElementById('panel')!;
const behavior = createBehaviorPanel(panelHost, session, state, {
  onReset: () => {
    session.engine.stopAll();
    session.service('ALMotion').setStiffnesses('Body', 0);
    state.setMany(BOOT_POSTURE);
    physics?.reset(bootRoot, BOOT_POSTURE);
  },
});
const joints = createJointPanel(panelHost, state, session.engine, {
  onHover: (joint) => {
    nao.highlight(joint);
    world.invalidate();
  },
});
document.getElementById('panel-toggle')!.addEventListener('click', () => document.body.classList.toggle('panel-open'));
const keyStatus = document.querySelector<HTMLElement>('.keys-status')!;
attachKeyboard(session, (text) => (keyStatus.textContent = text));

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

// Mallas oficiales del NAO: solo tras aceptar su licencia (ui/meshLicense.ts)
attachMeshLicense({
  load: async (onProgress) => {
    const { loadOfficialMeshes, setShellColor, SHELL_COLORS } = await import('./sim/officialMeshes');
    const meshes = await loadOfficialMeshes(urdf, onProgress);
    nao.setOfficialMeshes(meshes);
    const paint = async (color: (typeof SHELL_COLORS)[number]) => {
      await setShellColor(meshes.values(), color);
      world.invalidate();
    };
    const initial = rememberedShellColor(SHELL_COLORS);
    if (initial.hex !== null) await paint(initial);
    createShellColorPicker(behavior.slot, SHELL_COLORS, initial, (c) => void paint(c));
    if (!addOfficialChestLogo(nao, () => world.invalidate())) console.warn('No encontré el pecho de la malla oficial para el logo');
    world.invalidate(true);
  },
  showPrimitives: (show) => {
    nao.showPrimitives(show);
    world.invalidate(true);
  },
});

// MuJoCo (~2 MB) se carga aparte: la escena aparece antes y, si falla, queda el modo cinemático
import('./physics/physics')
  .then(({ PhysicsSim }) => PhysicsSim.create(urdf, state, session.engine, bootRoot, world.objects))
  .then((sim) => {
    physics = sim;
    session.engine.physical = true;
    session.engine.onManual = (name, value) => sim.placeJoint(name, value);
    setMode('física MuJoCo');
    world.invalidate(true);
  })
  .catch((e) => {
    console.warn('Física no disponible, modo cinemático:', e);
    setMode('modo cinemático (sin física)');
  });

world.onFrame((dt) => {
  session.update(dt);
  if (physics?.step(dt)) world.invalidate(true);
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
Object.assign(window, { nao: { session, state, model: nao, world, get physics() { return physics; } } });
