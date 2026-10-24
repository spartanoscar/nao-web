// Todos los bancos del mundo seguidos, a ×10 (misma física, más rápida), con la penetración de la forma real del NAO:
// lo más que se hunde en el suelo y en su propio cuerpo durante cada banco (physics.ts PenetrationProbe), sea cual sea
// la física en uso (?fisica=fiel o la de siempre). Se evalúa en la pestaña visible y devuelve enseguida un objeto que
// se va llenando: { physics, step, done, results: { falls: [...], falls_s, falls_pen, … } } (window.__steps = ['falls']
// limita los bancos). Tiempos en segundos de simulación.
async () => {
  for (let i = 0; i < 240 && !(window.nao?.physics && window.nao.model.official.length); i++) await new Promise((r) => setTimeout(r, 250));
  if (!window.nao.physics) return { error: 'sin física (modo cinemático)' };
  const nao = window.nao;
  const load = async (name) =>
    (0, eval)(JSON.parse((await (await fetch(`/scripts/bench/${name}.js?raw&t=${Date.now()}`)).text()).replace(/^export default /, '').replace(/;\s*$/, '')));
  const { PenetrationProbe } = await import('/src/physics/physics.ts');
  const { collisionHulls } = await import('/src/sim/officialMeshes.ts');
  const { MOTIONS } = await import('/src/naoqi/motionFile.ts');
  const meshes = new Map(nao.model.official.filter((o) => o.name.startsWith('mesh:')).map((o) => [o.name.slice(5), o]));
  const probe = await PenetrationProbe.create(nao.urdf, nao.bootRoot, collisionHulls(meshes));
  const names = Array.isArray(MOTIONS) ? MOTIONS.map((m) => m.name ?? m) : Object.keys(MOTIONS);
  const steps = window.__steps ?? ['falls', 'walk', 'physics', 'motions', 'aldebaran'];
  const args = {
    falls: [['adelante', 'atrás', 'izquierda', 'derecha', 'adel-izq', 'adel-der', 'atrás-izq', 'atrás-der']],
    motions: [names],
  };
  // Física fiel = colisión con envolventes (mallas en el modelo de MuJoCo)
  const R = { physics: nao.physics.model.nmesh > 0 ? 'fiel' : 'actual', step: '', done: false, results: {} };
  // El punto de partida tiene que estar libre: si cae dentro de una pieza, la física saca al robot empujándolo y todo lo
  // que se mida desde ahí es inválido (sim/environment.ts spawnObstacles)
  const { spawnObstacles } = await import('/src/sim/environment.ts');
  const blocked = spawnObstacles(0, 0);
  if (blocked.length) return { error: `el punto de partida (sala de pruebas) está invadido: ${JSON.stringify(blocked)}` };
  nao.sim.setSpeed(10);
  nao.spawn('pruebas'); // los bancos de física y marcha corren en la sala de pruebas (el origen, piso libre)
  (async () => {
    for (const name of steps) {
      R.step = name;
      // Penetración: máximos del banco y cuánto tiempo pasó con más de 1 cm
      const pen = { floor: 0, floorBody: '', self: 0, selfPair: '', floorOver1cm: 0, selfOver1cm: 0 };
      let last = nao.clock();
      const stop = nao.onTick(() => {
        const now = nao.clock();
        const dt = now - last;
        last = now;
        const p = probe.measure(nao.physics.qpos());
        if (p.floor > pen.floor) Object.assign(pen, { floor: p.floor, floorBody: p.floorBody });
        if (p.self > pen.self) Object.assign(pen, { self: p.self, selfPair: p.selfPair });
        if (p.floor > 0.01) pen.floorOver1cm += dt;
        if (p.self > 0.01) pen.selfOver1cm += dt;
      });
      const t0 = nao.clock();
      try {
        R.results[name] = await (await load(name))(...(args[name] ?? []));
      } catch (e) {
        R.results[name] = ['ERROR ' + (e?.stack ?? e)];
      }
      stop();
      R.results[name + '_s'] = Math.round(nao.clock() - t0);
      R.results[name + '_pen'] =
        `suelo máx ${(pen.floor * 100).toFixed(1)} cm (${pen.floorBody || '—'}), ${pen.floorOver1cm.toFixed(1)} s > 1 cm · ` +
        `cuerpo máx ${(pen.self * 100).toFixed(1)} cm (${pen.selfPair || '—'}), ${pen.selfOver1cm.toFixed(1)} s > 1 cm`;
    }
    nao.sim.setSpeed(1);
    probe.dispose();
    R.done = true;
  })();
  return R;
};
