import './ui/styles.css';
import urdfXml from '../reference/urdf/naoV50.urdf?raw';
import { postureJoints } from './naoqi/postures';
import { Session } from './naoqi/session';
import { RobotState } from './robot/state';
import { parseUrdf } from './robot/urdf';
import { NaoModel } from './sim/naoModel';
import { createWorld } from './sim/world';
import { createBehaviorPanel } from './ui/behaviorPanel';
import { createJointPanel } from './ui/jointPanel';

// Como un NAO recién encendido: en Crouch y con los motores apagados. motion.wakeUp() lo levanta.
const state = new RobotState(postureJoints('Crouch'));
const session = new Session(state);

const world = createWorld(document.getElementById('app')!);
const nao = new NaoModel(parseUrdf(urdfXml));
world.scene.add(nao.root);

const panelHost = document.getElementById('panel')!;
const behavior = createBehaviorPanel(panelHost, session, state);
const joints = createJointPanel(panelHost, state, session.engine, {
  onHover: (joint) => {
    nao.highlight(joint);
    world.invalidate();
  },
});
document.getElementById('panel-toggle')!.addEventListener('click', () => document.body.classList.toggle('panel-open'));

world.onFrame((dt) => {
  session.update(dt);
  if (nao.apply(state)) world.invalidate(true);
  behavior.refresh();
  joints.refresh();
});

// Acceso desde la consola del navegador mientras llega la consola de comandos (F4):
//   const motion = nao.session.service('ALMotion')
//   await motion.angleInterpolation('HeadYaw', [1, -1, 0], [1, 2, 3], true)
Object.assign(window, { nao: { session, state, model: nao, world } });
