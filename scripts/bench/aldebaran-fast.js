// Banco de fidelidad rápido: las rutinas originales de Aldebaran en el simulador del laboratorio (src/lab/labSim.ts:
// física aparte, sin dibujar, ~14× tiempo real), para probar muchas combinaciones de física en segundos.
// window.__configs = [{ label, hulls, self }] → cada una arma su propia física; hulls: true colisiona con las envolventes
// de las mallas oficiales (sim/officialMeshes.ts collisionHulls), si no con las formas simples (sim/shapes.ts); self: true
// activa el choque del robot consigo mismo.
// window.__only = ['SitToCrouch', …] limita las rutinas. Sin __configs prueba la física actual.
async () => {
  const { LabSim } = await import('/src/lab/labSim.ts');
  const { aldebaranMotions, playAldebaranMotion, loadAldebaranMotions } = await import('/src/naoqi/aldebaranMotions.ts');
  const { postureJoints } = await import('/src/naoqi/postures.ts');
  if (!aldebaranMotions().length) await loadAldebaranMotions();
  const { urdf, bootRoot } = window.nao;
  const CASES = [
    ['CrouchToSitDown', 'Crouch', 'Sitting'],
    ['SitToCrouch', 'Sit', 'Crouching'],
    ['CrouchToStand', 'Crouch', 'Standing'],
    ['BackToSitDown', 'LyingBack', 'Sitting'],
    ['BackToStand', 'LyingBack', 'Standing'],
    ['BellyToCrouch', 'LyingBelly', 'Crouching'],
    ['BellyToStand', 'LyingBelly', 'Standing'],
  ].filter(([n]) => !window.__only || window.__only.includes(n));
  const configs = window.__configs ?? [{ label: 'física actual' }];
  const { collisionHulls } = await import('/src/sim/officialMeshes.ts');
  const meshes = new Map(window.nao.model.official.filter((o) => o.name.startsWith('mesh:')).map((o) => [o.name.slice(5), o]));
  const hulls = collisionHulls(meshes);
  const out = [];
  const t0 = performance.now();
  for (const cfg of configs) {
    const lab = await LabSim.create(urdf, bootRoot, postureJoints('Crouch'), { hulls: cfg.hulls ? hulls : undefined, selfCollision: !!cfg.self });
    const motion = () => lab.session.service('ALMotion');
    const posture = () => lab.session.service('ALRobotPosture');
    // Posturas de partida (fotos exactas, cada caso parte de la suya)
    const starts = {};
    const take = async (name, fn) => {
      lab.physics.reset(bootRoot, postureJoints('Crouch'));
      lab.restore({ ...lab.snapshot(), angles: postureJoints('Crouch') });
      await fn();
      await lab.hold(0.8);
      starts[name] = { snap: lab.snapshot(), family: posture().getPostureFamily() };
    };
    const hold0 = () => {
      const names = motion().getBodyNames('Body').filter((j) => !j.endsWith('Hand') && j !== 'RHipYawPitch');
      motion().setAngles(names, motion().getAngles(names, true), 0.2);
      motion().setStiffnesses('Body', 1);
    };
    const lying = async (name, sign) => {
      const joints = postureJoints(name);
      const [w, x, y, z] = bootRoot.quaternion;
      const [c, s] = [Math.SQRT1_2, sign * Math.SQRT1_2];
      lab.physics.reset({ position: [bootRoot.position[0], bootRoot.position[1], 0.08], quaternion: [c * w - s * y, c * x + s * z, c * y + s * w, c * z - s * x] }, joints);
      lab.restore({ ...lab.snapshot(), angles: joints });
      motion().setStiffnesses('Body', 0);
      await lab.hold(1.2);
      hold0();
      await lab.hold(0.5);
    };
    const need = new Set(CASES.map(([, from]) => from));
    if (need.has('Crouch')) await take('Crouch', async () => hold0());
    if (need.has('Sit')) await take('Sit', async () => { hold0(); await lab.drive(posture().goToPosture('Sit', 1), 12); });
    if (need.has('LyingBack')) { await lying('LyingBack', -1); starts.LyingBack = { snap: lab.snapshot(), family: posture().getPostureFamily() }; }
    if (need.has('LyingBelly')) { await lying('LyingBelly', 1); starts.LyingBelly = { snap: lab.snapshot(), family: posture().getPostureFamily() }; }
    let passed = 0;
    const lines = [];
    for (const [name, from, expected] of CASES) {
      const st = starts[from];
      lab.restore(st.snap);
      let prevZ = null;
      let maxDrop = 0;
      const watch = (s) => {
        if (prevZ !== null) maxDrop = Math.max(maxDrop, (prevZ - s.z) / 0.02);
        prevZ = s.z;
      };
      const m = aldebaranMotions().find((x) => x.name === name);
      await lab.drive(playAldebaranMotion(motion(), name), m.duration + 1, watch);
      await lab.hold(1.5, watch);
      const family = posture().getPostureFamily();
      const ok = family === expected && st.family !== 'Unknown';
      passed += ok ? 1 : 0;
      lines.push(`${ok ? '✓' : '✗'} ${name} (${st.family} → ${family}) ${maxDrop.toFixed(2)} m/s`);
    }
    out.push(`[${cfg.label}] ${passed}/${CASES.length} · ${lines.join(' · ')}`);
  }
  out.push(`${configs.length} configuraciones en ${((performance.now() - t0) / 1000).toFixed(1)} s`);
  return out;
};
