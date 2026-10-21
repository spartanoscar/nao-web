// Panel de articulaciones: un slider por joint, agrupado por cadena. Escribe en RobotState y se
// resincroniza cuando el estado cambia desde otro lado (consola, NAOqi, IA).

import { ACTUATOR_COUNT, CHAINS, COUPLED, DEFAULT_POSE, type ChainName } from '../robot/naoV6';
import type { RobotState } from '../robot/state';

const CHAIN_LABEL: Record<ChainName, string> = {
  Head: 'Cabeza',
  LArm: 'Brazo izquierdo',
  RArm: 'Brazo derecho',
  LLeg: 'Pierna izquierda',
  RLeg: 'Pierna derecha',
};
const CHAIN_ORDER: ChainName[] = ['Head', 'LArm', 'RArm', 'LLeg', 'RLeg'];

const isHand = (name: string) => name.endsWith('Hand');
const RAD2DEG = 180 / Math.PI;
const format = (name: string, v: number) => (isHand(name) ? `${Math.round(v * 100)}%` : `${(v * RAD2DEG).toFixed(1)}°`);

interface Row {
  name: string;
  input: HTMLInputElement;
  value: HTMLElement;
}

export interface JointPanel {
  /** Llamar en cada frame: solo toca el DOM si el estado cambió */
  refresh(): void;
}

export function createJointPanel(
  host: HTMLElement,
  state: RobotState,
  { onHover }: { onHover(joint: string | null): void },
): JointPanel {
  host.innerHTML = '';
  const rows: Row[] = [];

  const header = el('header', 'panel-header');
  header.append(el('h2', '', `Articulaciones · ${ACTUATOR_COUNT} actuadores`));
  const actions = el('div', 'panel-actions');
  actions.append(
    button('Pose inicial', () => state.setMany(DEFAULT_POSE)),
    button('Cero', () => state.setMany(Object.fromEntries(Object.keys(DEFAULT_POSE).map((n) => [n, 0])))),
  );
  header.append(actions);
  host.append(header);

  for (const chain of CHAIN_ORDER) {
    const group = el('details', 'chain') as HTMLDetailsElement;
    group.open = true;
    group.append(el('summary', '', CHAIN_LABEL[chain]));

    for (const name of CHAINS[chain]) {
      const coupledTo = COUPLED[name];
      const row = el('label', 'joint' + (coupledTo ? ' coupled' : ''));
      const [min, max] = state.limits(name);
      const input = document.createElement('input');
      input.type = 'range';
      input.min = String(min);
      input.max = String(max);
      input.step = isHand(name) ? '0.01' : '0.001';
      input.value = String(state.get(name));
      input.disabled = Boolean(coupledTo);
      input.addEventListener('input', () => state.set(name, Number(input.value)));

      const value = el('span', 'joint-value', format(name, state.get(name)));
      const title = el('span', 'joint-name', name);
      if (coupledTo) title.title = `Mismo motor que ${coupledTo}`;
      row.append(title, value, input);
      if (coupledTo) row.append(el('small', 'joint-note', `acoplado a ${coupledTo}`));

      const target = coupledTo ?? name;
      row.addEventListener('pointerenter', () => onHover(target));
      row.addEventListener('pointerleave', () => onHover(null));
      input.addEventListener('focus', () => onHover(target));
      input.addEventListener('blur', () => onHover(null));

      group.append(row);
      rows.push({ name, input, value });
    }
    host.append(group);
  }

  let shownRevision = state.revision;
  return {
    refresh() {
      if (state.revision === shownRevision) return;
      shownRevision = state.revision;
      for (const { name, input, value } of rows) {
        const v = state.get(name);
        if (name === 'HeadPitch') {
          // El rango cambia con HeadYaw (anti-colisión)
          const [min, max] = state.limits(name);
          input.min = String(min);
          input.max = String(max);
        }
        if (document.activeElement !== input) input.value = String(v);
        value.textContent = format(name, v);
      }
    },
  };
}

function el(tag: string, className: string, text?: string): HTMLElement {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (text !== undefined) e.textContent = text;
  return e;
}

function button(label: string, onClick: () => void): HTMLButtonElement {
  const b = document.createElement('button');
  b.type = 'button';
  b.textContent = label;
  b.addEventListener('click', onClick);
  return b;
}
