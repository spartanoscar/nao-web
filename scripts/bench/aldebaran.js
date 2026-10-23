// Banco de fidelidad física: las rutinas originales de Aldebaran (Choregraphe 1.x, naoqi/aldebaranMotions.ts) deben
// funcionar SIN CAMBIOS si la simulación se comporta como el NAO real. Cada una parte de su postura y debe terminar en
// la familia esperada. Se ejecuta en la página (consola o chrome-devtools evaluate_script con sourcePath).
async () => {
  for (let i = 0; i < 60 && !window.nao.physics; i++) await new Promise((r) => setTimeout(r, 250));
  if (!window.nao.physics) return ['sin física (modo cinemático)'];
  const { session, state, physics, bootRoot } = window.nao;
  const { aldebaranMotions, playAldebaranMotion, loadAldebaranMotions } = await import('/src/naoqi/aldebaranMotions.ts');
  const { postureJoints } = await import('/src/naoqi/postures.ts');
  if (!aldebaranMotions().length) await loadAldebaranMotions();
  if (!aldebaranMotions().length) return ['no están las rutinas: bash scripts/fetch-aldebaran-motions.sh'];
  const motion = session.service('ALMotion');
  const posture = session.service('ALRobotPosture');
  const wait = (ms) => window.nao.wait(ms); // reloj del motor: igual a ×1 que a ×10
  const reset = async () => { document.querySelector('.chip[title^="Vuelve"]').click(); await wait(1500); };
  /** Acostado de espaldas (pitch −90°) o boca abajo (+90°) sobre el eje Y del mundo, motores encendidos */
  const lying = async (posture, sign) => {
    motion.setStiffnesses('Body', 0);
    const joints = postureJoints(posture);
    state.setMany(joints);
    const [w, x, y, z] = bootRoot.quaternion;
    const [c, s] = [Math.SQRT1_2, sign * Math.SQRT1_2];
    physics.reset({ position: [bootRoot.position[0], bootRoot.position[1], 0.08], quaternion: [c * w - s * y, c * x + s * z, c * y + s * w, c * z - s * x] }, joints);
    await wait(1200);
    const names = motion.getBodyNames('Body').filter((j) => !j.endsWith('Hand') && j !== 'RHipYawPitch');
    void motion.angleInterpolationWithSpeed(names, motion.getAngles(names, true), 0.2);
    motion.setStiffnesses('Body', 1);
    await wait(500);
  };
  const start = {
    Crouch: async () => { await motion.wakeUp(); await posture.goToPosture('Crouch', 0.6); },
    Sit: async () => { await motion.wakeUp(); await posture.goToPosture('Sit', 0.6); },
    LyingBack: () => lying('LyingBack', -1),
    LyingBelly: () => lying('LyingBelly', 1),
  };
  // [rutina, postura de partida, familia esperada al final]
  const CASES = [
    ['CrouchToSitDown', 'Crouch', 'Sitting'],
    ['SitToCrouch', 'Sit', 'Crouching'],
    ['CrouchToStand', 'Crouch', 'Standing'],
    ['BackToSitDown', 'LyingBack', 'Sitting'],
    ['BackToStand', 'LyingBack', 'Standing'],
    ['BellyToCrouch', 'LyingBelly', 'Crouching'],
    ['BellyToStand', 'LyingBelly', 'Standing'],
  ];
  const out = [];
  let passed = 0;
  // window.__only = ['SitToCrouch', …] para repetir solo algunas mientras se ajusta la física
  const cases = window.__only ? CASES.filter(([n]) => window.__only.includes(n)) : CASES;
  for (const [name, from, expected] of cases) {
    await reset();
    await start[from]();
    await wait(800);
    const begin = posture.getPostureFamily();
    let prev = null;
    let maxDrop = 0;
    const stopTick = window.nao.onTick(() => {
      const z = state.root.position[2];
      const now = window.nao.clock() * 1000;
      if (prev && now - prev.t < 50) return; // cada 50 ms de simulación
      if (prev) maxDrop = Math.max(maxDrop, (prev.z - z) / ((now - prev.t) / 1000));
      prev = { z, t: now };
    });
    await playAldebaranMotion(motion, name);
    await wait(1500);
    stopTick();
    const family = posture.getPostureFamily();
    const ok = family === expected;
    passed += ok ? 1 : 0;
    out.push(`${ok ? '✓' : '✗'} ${name} (${begin} → ${family}, esperado ${expected}) · bajada máx ${maxDrop.toFixed(2)} m/s`);
  }
  out.unshift(`${passed} de ${cases.length} rutinas originales funcionan sin cambios`);
  await reset();
  return out;
};
