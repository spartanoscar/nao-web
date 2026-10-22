// Banco de pruebas: caídas y levantarse. El robot de pie (StandInit, motores encendidos) se inclina 25° hacia
// un lado, como un empujón, y la física lo tumba. Se mide cómo queda (inclinación y alabeo del torso), qué postura
// detecta ALRobotPosture y si goToPosture("StandInit") lo levanta.
// Uso: pegar en la consola (o evaluate_script) y llamar con las direcciones: run(['adelante', 'atrás', 'izquierda', 'derecha']).
async (directions) => {
  const { session, state, physics } = window.nao;
  const { postureJoints } = await import('/src/naoqi/postures.ts');
  const motion = session.service('ALMotion');
  const posture = session.service('ALRobotPosture');
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const TILT = (25 * Math.PI) / 180;
  // Giro en el mundo (Z arriba, X adelante): sobre +Y inclina hacia delante, sobre +X hacia la derecha
  const AXES = { adelante: [0, 1, 0, 1], atrás: [0, 1, 0, -1], derecha: [1, 0, 0, 1], izquierda: [1, 0, 0, -1] };
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
    const [ax, ay, az, sign] = AXES[dir];
    const s = Math.sin((sign * TILT) / 2);
    const q = mul([Math.cos((sign * TILT) / 2), ax * s, ay * s, az * s], state.root.quaternion);
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
