// Banco del grafo de posturas real de NAOqi 2.8 (postures_naoh25.xml de Choregraphe 2.8.7.4, convertido a
// public/motions/naoqi28/postures-h25.json; fuera de git). Camino más barato entre posturas (costos del
// archivo) y reproducción nodo a nodo con angleInterpolation en el simulador del laboratorio (física aparte, rápida).
// APPROX: NAOqi es cerrado y no se sabe cuánto tarda cada tramo: aquí, el motor más exigido a la fracción `speed` de su
// velocidad máxima (URDF) por el speedCoefficient del tramo.
// window.__speeds = [0.5, 0.8], window.__configs = [{ label, hulls, self, plastic }], window.__only = ['Sit>Stand', …]
// (plastic = μ de la carcasa, mjcf.ts shellFriction; la física fiel de la app usa SHELL_FRICTION)
async () => {
  const { LabSim } = await import('/src/lab/labSim.ts');
  const { postureJoints } = await import('/src/naoqi/postures.ts');
  const { JOINT_BY_NAME } = await import('/src/robot/naoV6.ts');
  const graph = await (await fetch('/motions/naoqi28/postures-h25.json')).json();
  const P = graph.postures;
  const named = Object.fromEntries(Object.entries(P).filter(([, p]) => p.name).map(([id, p]) => [p.name, id]));
  const path = (from, to) => {
    const [a, b] = [named[from], named[to]];
    const dist = { [a]: 0 };
    const prev = {};
    const open = new Set([a]);
    while (open.size) {
      let u = null;
      for (const v of open) if (u === null || dist[v] < dist[u]) u = v;
      open.delete(u);
      if (u === b) break;
      for (const [v, cost, anti, speed] of P[u].neighbours) {
        const d = dist[u] + cost;
        if (P[v] && d < (dist[v] ?? Infinity)) {
          dist[v] = d;
          prev[v] = [u, speed, anti];
          open.add(String(v));
        }
      }
    }
    // speed de cada nodo = speedCoefficient del tramo que llega a él
    const nodes = [];
    for (let u = b; u !== a; ) {
      const [from, speed, anti] = prev[u];
      nodes.unshift({ id: u, speed, anti });
      u = String(from);
    }
    nodes.unshift({ id: a, speed: 1 });
    return nodes;
  };
  const joints = graph.joints;
  const used = joints.map((j, i) => [j, i]).filter(([j]) => j !== 'RHipYawPitch');
  const plan = (nodes, f) => {
    const names = used.map(([j]) => j);
    const angles = names.map(() => []);
    const times = names.map(() => []);
    let t = 0;
    for (let k = 1; k < nodes.length; k++) {
      const [p0, p1] = [P[nodes[k - 1].id].angles, P[nodes[k].id].angles];
      let need = 0;
      for (const [j, i] of used) need = Math.max(need, Math.abs(p1[i] - p0[i]) / JOINT_BY_NAME.get(j).maxVelocity);
      // window.__ballistic = fracción de los tramos sin anticolisión (enableAntiCollision 0); si no, la misma f
      // window.__ballisticNext: también el tramo que sale del último nodo de la cadena
      const fast = nodes[k].anti === 0 || (window.__ballisticNext && nodes[k - 1].anti === 0);
      const fk = fast && window.__ballistic ? window.__ballistic : f;
      t += Math.max(need / (fk * nodes[k].speed), 0.05);
      used.forEach(([, i], n) => {
        angles[n].push(p1[i]);
        times[n].push(t);
      });
    }
    return { names, angles, times, duration: t };
  };
  const CASES = [
    ['Sit', 'Stand', 'Standing'],
    ['LyingBack', 'StandInit', 'Standing'],
    ['LyingBelly', 'StandInit', 'Standing'],
    ['Crouch', 'StandInit', 'Standing'],
    ['Crouch', 'Sit', 'Sitting'],
    ['StandInit', 'Sit', 'Sitting'],
    ['StandInit', 'LyingBelly', 'LyingBelly'],
    ['Sit', 'LyingBack', 'LyingBack'],
  ].filter(([a, b]) => !window.__only || window.__only.includes(`${a}>${b}`));
  const speeds = window.__speeds ?? [0.5, 0.8];
  const configs = window.__configs ?? [{ label: 'física actual' }];
  const { urdf, bootRoot } = window.nao;
  let hulls;
  if (configs.some((c) => c.hulls)) {
    const { collisionHulls } = await import('/src/sim/officialMeshes.ts');
    hulls = collisionHulls(new Map(window.nao.model.official.filter((o) => o.name.startsWith('mesh:')).map((o) => [o.name.slice(5), o])));
  }
  const out = [];
  const t0 = performance.now();
  for (const cfg of configs) {
    // cfg.hullLinks = 'torso|Hip': envolvente oficial solo en esos links, formas simples en el resto
    const only = cfg.hullLinks ? new Map([...hulls].filter(([link]) => new RegExp(cfg.hullLinks).test(link))) : hulls;
    const lab = await LabSim.create(urdf, bootRoot, postureJoints('Crouch'), { hulls: cfg.hulls ? only : undefined, selfCollision: !!cfg.self, shellFriction: cfg.plastic });
    // Diagnóstico (no es un arreglo): cfg.torque = { re: 'Head|Shoulder', k: 1.5 } multiplica el torque de esos motores
    if (cfg.torque) for (const s of lab.physics.joints) if (new RegExp(cfg.torque.re).test(s.name)) s.stallTorque *= cfg.torque.k;
    // Diagnóstico: cfg.rotor = { '22NT Z13': g·cm², … } → armadura de cada articulación = inercia del rotor × reducción²
    // (en vez del 0.005 kg·m² común del MJCF)
    if (cfg.rotor) {
      const m = lab.physics.model;
      for (const s of lab.physics.joints) if (cfg.rotor[s.motor] !== undefined) m.dof_armature[s.dof] = cfg.rotor[s.motor] * 1e-7 * s.ratio ** 2;
    }
    const motion = () => lab.session.service('ALMotion');
    const posture = () => lab.session.service('ALRobotPosture');
    const hold0 = () => {
      const names = motion().getBodyNames('Body').filter((j) => !j.endsWith('Hand') && j !== 'RHipYawPitch');
      motion().setAngles(names, motion().getAngles(names, true), 0.2);
      motion().setStiffnesses('Body', 1);
    };
    // Cada partida se arma colocando la postura del grafo (no la de qiBullet) y dejándola asentarse
    const starts = {};
    const place = async (name) => {
      const id = named[name];
      const pose = Object.fromEntries(joints.map((j, i) => [j, P[id].angles[i]]));
      const lyingSign = { LyingBack: -1, LyingBelly: 1 }[name];
      const [w, x, y, z] = bootRoot.quaternion;
      let root = bootRoot;
      if (lyingSign) {
        const [c, s] = [Math.SQRT1_2, lyingSign * Math.SQRT1_2];
        root = { position: [bootRoot.position[0], bootRoot.position[1], 0.08], quaternion: [c * w - s * y, c * x + s * z, c * y + s * w, c * z - s * x] };
      }
      if (name === 'Sit' || (name === 'LyingBack' && window.__lyingFromSit)) {
        lab.physics.reset(bootRoot, postureJoints('Crouch'));
        lab.restore({ ...lab.snapshot(), angles: postureJoints('Crouch') });
        hold0();
        await lab.drive(posture().goToPosture('Sit', 1), 12);
        // window.__lyingFromSit: boca arriba como llega el robot, por la ruta de NAOqi desde Sit (no colocado de golpe)
        if (name === 'LyingBack') {
          await lab.hold(0.8);
          const p = plan(path('Sit', 'LyingBack'), 0.5);
          await lab.drive(motion().angleInterpolation(p.names, p.angles, p.times, true), p.duration + 1);
          await lab.hold(1);
        }
      } else {
        lab.physics.reset(root, pose);
        lab.restore({ ...lab.snapshot(), angles: pose });
        motion().setStiffnesses('Body', lyingSign ? 0 : 1);
        if (lyingSign) await lab.hold(1.2);
        hold0();
      }
      await lab.hold(0.8);
      starts[name] = { snap: lab.snapshot(), family: posture().getPostureFamily() };
    };
    for (const name of new Set(CASES.map(([a]) => a))) await place(name);
    for (const f of speeds) {
      let passed = 0;
      const lines = [];
      for (const [from, to, expected] of CASES) {
        const st = starts[from];
        lab.restore(st.snap);
        const nodes = path(from, to);
        const p = plan(nodes, f);
        const samples = [];
        // Por muestra: motor más saturado (torque / torque de bloqueo) y peor error comando − sensor
        const probe = (s) => {
          let sat = [0, ''];
          for (const m of lab.physics.telemetry()) {
            const r = Math.abs(m.torque) / m.stallTorque;
            if (r > sat[0]) sat = [r, m.name];
          }
          const cmd = motion().getAngles(p.names, false);
          const sen = motion().getAngles(p.names, true);
          let err = [0, ''];
          cmd.forEach((c, i) => Math.abs(c - sen[i]) > err[0] && (err = [Math.abs(c - sen[i]), p.names[i]]));
          // window.__watch = ['LHipPitch', …]: comando y sensor de esas articulaciones en cada muestra
          const watch = (window.__watch ?? []).map((j) => [j, cmd[p.names.indexOf(j)], sen[p.names.indexOf(j)]]);
          // Altura (cm) del efector de cada mano sobre el suelo (getPosition FRAME_WORLD, sensores)
          if (window.__watch) for (const arm of ['LArm', 'RArm']) watch.push([`${arm[0]}mano z`, null, motion().getPosition(arm, 1, true)[2] * 100]);
          samples.push({ ...s, sat, err, watch });
        };
        await lab.drive(motion().angleInterpolation(p.names, p.angles, p.times, true), p.duration + 1, probe);
        await lab.hold(1.5);
        const family = posture().getPostureFamily();
        const ok = family === expected;
        passed += ok ? 1 : 0;
        lines.push(`${ok ? '✓' : '✗'} ${from}>${to} (${st.family} → ${family}, ${nodes.length - 1} tramos, ${p.duration.toFixed(1)} s)`);
        // window.__trace = true: inclinación del torso en cada nodo, medida contra la registrada en el archivo (grados)
        if (window.__trace) {
          const deg = (r) => ((r * 180) / Math.PI).toFixed(0).padStart(4);
          const t0s = samples[0]?.t ?? 0;
          const at = (t) => samples.reduce((a, s) => (Math.abs(s.t - t0s - t) < Math.abs(a.t - t0s - t) ? s : a), samples[0]);
          nodes.forEach((n, k) => {
            const [ta, tb] = [k <= 1 ? 0 : p.times[0][k - 2], k === 0 ? 0 : p.times[0][k - 1]];
            const s = at(tb);
            const seg = samples.filter((x) => x.t - t0s >= ta && x.t - t0s <= tb + 1e-6);
            const sat = seg.reduce((a, x) => (x.sat[0] > a[0] ? x.sat : a), [0, '']);
            const err = seg.reduce((a, x) => (x.err[0] > a[0] ? x.err : a), [0, '']);
            const [rx, ry] = P[n.id].inertial;
            lines.push(`    ${n.id.padStart(7)} ${P[n.id].family.padEnd(10)} archivo pitch ${deg(ry)} roll ${deg(rx)} · medido pitch ${deg(s.pitch)} roll ${deg(s.roll)} z ${s.z.toFixed(2)} · sat ${(sat[0] * 100).toFixed(0)}% ${sat[1]} · error ${deg(err[0])}° ${err[1]}`);
            // window.__segment = '1005': el tramo que llega a ese nodo, muestra a muestra (cada 40 ms)
            if (window.__segment === n.id)
              seg.filter((_, i) => i % 2 === 0).forEach((x) => lines.push(`      t ${(x.t - t0s).toFixed(2)} pitch ${deg(x.pitch)} z ${x.z.toFixed(3)} · sat ${(x.sat[0] * 100).toFixed(0)}% ${x.sat[1]} · ${x.watch.map(([j, c, v]) => (c === null ? `${j} ${v.toFixed(1)}` : `${j} ${deg(c)}/${deg(v)}`)).join(' ')}`));
          });
        }
      }
      out.push(`[${cfg.label} · vel ${f}] ${passed}/${CASES.length}\n  ${lines.join('\n  ')}`);
    }
  }
  out.push(`${((performance.now() - t0) / 1000).toFixed(1)} s`);
  return out.join('\n');
};
