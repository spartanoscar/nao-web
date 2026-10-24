// Búsqueda de los tiempos de la ruta real de NAOqi para levantarse de espaldas (LyingBack → StandInit, 19 tramos del
// grafo postures_naoh25.xml): las posturas quedan fijas (son las del robot real); CMA-ES (src/lab/cmaes.ts) busca solo la
// duración de cada tramo, que NAOqi no publica. En el simulador del laboratorio (física de la app, carcasa de plástico).
// Cada candidato se evalúa en 4 episodios: 2 partidas (caída real de espaldas y boca arriba llegando desde sentado) ×
// 2 escalas de tiempo (×0.9 y ×1.1), para no quedar en el filo. Costo por episodio: 0 si queda de pie; si no,
// 1 + la fracción de la ruta en que el torso dejó de seguir la inclinación del real (±26°). Prior: alejarse de los tiempos
// calibrados con el video (log-duración) cuesta poco, pero cuesta.
// Devuelve enseguida; el progreso queda en window.__times ({ gen, best, bestEpisodes, durations, done, log }).
// window.__timesGens = 25 (generaciones). Correr con la pestaña visible o de fondo (el laboratorio cede con mensajes).
async () => {
  const { LabSim } = await import('/src/lab/labSim.ts');
  const { SepCMA } = await import('/src/lab/cmaes.ts');
  const { postureJoints } = await import('/src/naoqi/postures.ts');
  const { JOINT_BY_NAME } = await import('/src/robot/naoV6.ts');
  const { collisionHulls } = await import('/src/sim/officialMeshes.ts');
  const graph = await (await fetch('/motions/naoqi28/postures-h25.json')).json();
  const P = graph.postures;
  // Camino que da planGraphRoute('2000', 'StandInit') y el de Sit → LyingBack (para la segunda partida)
  const ROUTE = '2000 2001 2002 2003 2005 20053 20054 2006 1005 1006 1007 1008 1009 1012 1013 1014 1015 1016 10161 4003'.split(' ');
  const TO_BACK = '1001 1002 1003 1004 1005 2006 2106 2105 2001 2000'.split(' ');
  const used = graph.joints.map((j, i) => [j, i]).filter(([j]) => j !== 'RHipYawPitch');
  const names = used.map(([j]) => j);
  const coef = (a, b) => P[a].neighbours.find(([n]) => String(n) === b)?.[3] ?? 1;
  const need = (a, b) => Math.max(...used.map(([j, i]) => Math.abs(P[b].angles[i] - P[a].angles[i]) / JOINT_BY_NAME.get(j).maxVelocity));
  // Semilla: el modelo de la app (0.45 de la velocidad máxima, calibrado con el video); el primer tramo (pose actual →
  // 2000) dura 0.8 s
  const seedDur = [0.8, ...ROUTE.slice(1).map((b, k) => Math.max(need(ROUTE[k], b) / (0.45 * coef(ROUTE[k], b)), 0.05))];
  // El prior se ancla al modelo del video; la búsqueda puede partir de otros tiempos (window.__timesSeed)
  const xVideo = seedDur.map(Math.log);
  const x0 = (window.__timesSeed ?? seedDur).map(Math.log);
  const plan = (nodes, durations) => {
    const angles = names.map(() => []);
    const times = names.map(() => []);
    let t = 0;
    nodes.forEach((id, k) => {
      t += durations[k];
      used.forEach(([, i], n) => {
        angles[n].push(P[id].angles[i]);
        times[n].push(t);
      });
    });
    return { angles, times, duration: t };
  };

  const { urdf, bootRoot } = window.nao;
  const stand = postureJoints('StandInit');
  const V = window.__timesValidate; // { durations, scales, plastic } → valida en vez de buscar
  const lab = await LabSim.create(urdf, bootRoot, stand, { hulls: collisionHulls(window.nao.meshes), shellFriction: V?.plastic });
  const motion = () => lab.session.service('ALMotion');
  const posture = () => lab.session.service('ALRobotPosture');

  // Partida 1: caída de espaldas como en scripts/bench/falls.js (de pie, inclinado 25° hacia [dx, dy], la física lo tumba)
  const mul = ([aw, ax, ay, az], [bw, bx, by, bz]) => [
    aw * bw - ax * bx - ay * by - az * bz, aw * bx + ax * bw + ay * bz - az * by,
    aw * by - ax * bz + ay * bw + az * bx, aw * bz + ax * by - ay * bx + az * bw,
  ];
  const fallFrom = async (dx, dy, deg = 25) => {
    const n = Math.hypot(dx, dy);
    const s = Math.sin((deg * Math.PI) / 360);
    const q = mul([Math.cos((deg * Math.PI) / 360), (-dy / n) * s, (dx / n) * s, 0], bootRoot.quaternion);
    lab.physics.reset({ position: [bootRoot.position[0], bootRoot.position[1], bootRoot.position[2] + 0.01], quaternion: q }, stand);
    lab.restore({ ...lab.snapshot(), angles: stand });
    await lab.hold(3);
    return { snap: lab.snapshot(), family: posture().getPostureFamily() };
  };
  const fall = await fallFrom(-1, 0);
  // Partida 2: boca arriba llegando desde sentado por la ruta de NAOqi (Crouch → Sit con los tramos validados)
  lab.physics.reset(bootRoot, postureJoints('Crouch'));
  lab.restore({ ...lab.snapshot(), angles: postureJoints('Crouch') });
  await lab.drive(posture().goToPosture('Sit', 1), 12);
  await lab.hold(0.8);
  const back = plan(TO_BACK.slice(1), TO_BACK.slice(1).map((b, k) => Math.max(need(TO_BACK[k], b) / 0.5, 0.05)));
  await lab.drive(motion().angleInterpolation(names, back.angles, back.times, true), back.duration + 1);
  await lab.hold(1);
  const fromSit = { snap: lab.snapshot(), family: posture().getPostureFamily() };
  const extra = { 'atrás-izq': await fallFrom(-1, 1), 'atrás-der': await fallFrom(-1, -1), 'atrás 40°': await fallFrom(-1, 0, 40) };
  const ALL = { atrás: fall, 'desde sentado': fromSit, ...extra };
  // window.__timesStarts = ['atrás', 'desde sentado', 'atrás-izq', 'atrás-der']: con qué partidas se evalúa la búsqueda
  const STARTS = (window.__timesStarts ?? ['atrás', 'desde sentado']).map((k) => ALL[k]);
  const SCALES = [0.9, 1.1];

  const episode = async (durations, start) => {
    lab.restore(start.snap);
    const p = plan(ROUTE, durations);
    const samples = [];
    await lab.drive(motion().angleInterpolation(names, p.angles, p.times, true), p.duration + 1, (x) => samples.push(x));
    await lab.hold(1.5);
    const up = posture().getPostureFamily() === 'Standing' && lab.state.root.position[2] > 0.28;
    if (up) return 0;
    const t0 = samples[0]?.t ?? 0;
    let progress = 0;
    for (let k = 1; k < ROUTE.length; k++) {
      const s = samples.reduce((a, b) => (Math.abs(b.t - t0 - p.times[0][k]) < Math.abs(a.t - t0 - p.times[0][k]) ? b : a));
      if (Math.abs(s.pitch - P[ROUTE[k]].inertial[1]) > 0.45) break;
      progress = k;
    }
    return 1 + (1 - progress / (ROUTE.length - 1));
  };
  const evaluate = async (xs) => {
    const costs = [];
    for (const start of STARTS) for (const scale of SCALES) costs.push(await episode(xs.map((v) => Math.exp(v) * scale), start));
    const prior = 0.05 * xs.reduce((a, v, i) => a + (v - xVideo[i]) ** 2, 0) / xs.length;
    return { cost: costs.reduce((a, b) => a + b, 0) / costs.length + prior, episodes: costs };
  };

  if (V) {
    // Partidas que la búsqueda no vio: caídas en diagonal, más fuerte, y boca arriba colocado flojo (qiBullet)
    const lying = postureJoints('LyingBack');
    const [c, sn] = [Math.SQRT1_2, -Math.SQRT1_2];
    const [w, x, y, z] = bootRoot.quaternion;
    lab.physics.reset({ position: [bootRoot.position[0], bootRoot.position[1], 0.08], quaternion: [c * w - sn * y, c * x + sn * z, c * y + sn * w, c * z - sn * x] }, lying);
    lab.restore({ ...lab.snapshot(), angles: lying });
    motion().setStiffnesses('Body', 0);
    await lab.hold(1.2);
    lab.restore({ ...lab.snapshot(), angles: lying });
    await lab.hold(0.5);
    const all = { ...ALL, 'colocado flojo': { snap: lab.snapshot(), family: posture().getPostureFamily() } };
    const rows = [];
    for (const [label, start] of Object.entries(all)) {
      const marks = [];
      for (const scale of V.scales) marks.push((await episode(V.durations.map((d) => d * scale), start)) === 0 ? '✓' : '·');
      rows.push(`${label.padEnd(15)} (${start.family}): ${marks.join(' ')}`);
    }
    return `μ ${V.plastic ?? 0.4} · escalas ${V.scales.join(' ')}\n${rows.join('\n')}`;
  }
  const R = (window.__times = { starts: STARTS.map((st) => st.family), gen: 0, best: Infinity, bestEpisodes: null, durations: null, seed: null, done: false, log: [] });
  (async () => {
    const seed = await evaluate(x0);
    R.seed = { cost: seed.cost, episodes: seed.episodes };
    let best = { ...seed, x: x0 };
    const es = new SepCMA(x0, 0.3, { seed: 1 });
    const gens = window.__timesGens ?? 25;
    const t0 = performance.now();
    for (let g = 0; g < gens && !window.__timesStop; g++) {
      const xs = es.ask();
      const costs = [];
      for (const xx of xs) {
        const r = await evaluate(xx);
        costs.push(r.cost);
        if (r.cost < best.cost) best = { ...r, x: xx };
      }
      es.tell(costs);
      R.gen = g + 1;
      R.best = best.cost;
      R.bestEpisodes = best.episodes;
      R.durations = best.x.map((v) => +Math.exp(v).toFixed(3));
      R.log.push(`gen ${g + 1}: mejor ${Math.min(...costs).toFixed(3)} · global ${best.cost.toFixed(3)} [${best.episodes.map((c) => c.toFixed(2)).join(' ')}] · σ ${es.sigma.toFixed(3)} · ${((performance.now() - t0) / 1000).toFixed(0)} s`);
    }
    R.route = ROUTE;
    R.done = true;
  })();
  return { starts: R.starts, seedDurations: seedDur.map((d) => +d.toFixed(3)) };
};
