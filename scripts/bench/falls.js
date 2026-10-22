// Banco de pruebas: caídas y levantarse. El robot de pie (StandInit, motores encendidos) se inclina 25° hacia
// un lado, como un empujón, y la física lo tumba. Se mide cómo queda (inclinación y alabeo del torso), qué postura
// detecta ALRobotPosture y si goToPosture("StandInit") lo levanta.
// Uso: pegar en la consola (o evaluate_script) y llamar con las direcciones:
//   run(['adelante', 'atrás', 'izquierda', 'derecha', 'adel-izq', 'adel-der', 'atrás-izq', 'atrás-der'])
// Medido (2026-10-22): las 8 → de pie (adelante 7 s, costados 9 s, atrás 12 s).
async (directions) => {
  const { session, state, physics } = window.nao;
  const { postureJoints } = await import('/src/naoqi/postures.ts');
  const motion = session.service('ALMotion');
  const posture = session.service('ALRobotPosture');
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const TILT = (25 * Math.PI) / 180;
  // Dirección de la caída en el mundo (Z arriba, X adelante, Y izquierda); el giro es sobre z × dirección
  const DIRS = {
    adelante: [1, 0], atrás: [-1, 0], izquierda: [0, 1], derecha: [0, -1],
    'adel-izq': [1, 1], 'adel-der': [1, -1], 'atrás-izq': [-1, 1], 'atrás-der': [-1, -1],
  };
  const mul = ([aw, ax, ay, az], [bw, bx, by, bz]) => [
    aw * bw - ax * bx - ay * by - az * bz, aw * bx + ax * bw + ay * bz - az * by,
    aw * by - ax * bz + ay * bw + az * bx, aw * bz + ax * by - ay * bx + az * bw,
  ];
  const torso = () => {
    const [w, x, y, z] = state.root.quaternion;
    const zx = 2 * (x * z + w * y), zy = 2 * (y * z - w * x), zz = 1 - 2 * (x * x + y * y);
    return `pitch ${Math.round(Math.atan2(zx, zz) * 57.3)}° roll ${Math.round(Math.atan2(-zy, zz) * 57.3)}° altura ${state.root.position[2].toFixed(2)} m`;
  };
  const out = [];
  for (const dir of directions) {
    document.querySelector('.chip[title^="Vuelve"]').click();
    await wait(1500);
    await motion.wakeUp();
    await wait(1000);
    const [dx, dy] = DIRS[dir];
    const n = Math.hypot(dx, dy);
    const s = Math.sin(TILT / 2);
    const q = mul([Math.cos(TILT / 2), (-dy / n) * s, (dx / n) * s, 0], state.root.quaternion);
    const p = state.root.position;
    physics.reset({ position: [p[0], p[1], p[2] + 0.01], quaternion: q }, postureJoints('StandInit'));
    await wait(3000);
    const fallen = `${torso()} · detecta ${posture.getPostureFamily()}`;
    const t0 = performance.now();
    const ok = await posture.goToPosture('StandInit', 0.8);
    await wait(1500);
    out.push(`${dir}: cae → ${fallen} · goToPosture(StandInit) → ${ok}${ok ? '' : ` (${posture.lastFailure})`} · queda ${torso()} · ${((performance.now() - t0) / 1000).toFixed(1)} s`);
  }
  return out;
}
