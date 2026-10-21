import './ui/styles.css';
import urdfXml from '../reference/urdf/naoV50.urdf?raw';
import { DEFAULT_POSE } from './robot/naoV6';
import { RobotState } from './robot/state';
import { parseUrdf } from './robot/urdf';
import { NaoModel } from './sim/naoModel';
import { createWorld } from './sim/world';
import { createJointPanel } from './ui/jointPanel';

const state = new RobotState(DEFAULT_POSE);
const world = createWorld(document.getElementById('app')!);
const nao = new NaoModel(parseUrdf(urdfXml));
world.scene.add(nao.root);

const panel = createJointPanel(document.getElementById('panel')!, state, {
  onHover: (joint) => {
    nao.highlight(joint);
    world.invalidate();
  },
});
document.getElementById('panel-toggle')!.addEventListener('click', () => document.body.classList.toggle('panel-open'));

world.onFrame(() => {
  if (nao.apply(state)) world.invalidate(true);
  panel.refresh();
});

// Acceso desde la consola del navegador mientras llega la consola de comandos (F4):
//   nao.state.set('HeadYaw', 1)
Object.assign(window, { nao: { state, model: nao, world } });
