// Prueba del espejo (docs/PLAN.md F13): ¿el NAO se reconoce en el espejo? Dos condiciones con el mismo servidor:
//   A "sin-metodo": el prompt no dice cómo comprobar si algo es su reflejo (línea base).
//   B "con-metodo": el prompt trae CONOCERTE A TI MISMO (server/prompt.go selfCheckRule): moverse o cambiar los ojos y
//     mirar si el otro hace lo mismo a la vez. Ninguna dice que haya un espejo en el mundo.
// Cada ensayo: reiniciar el mundo, de pie a ~0.9 m del espejo, conversación nueva y las MISMAS dos preguntas (sin
// pistas). Se intercalan A, B, A, B… Necesita sesión de admin (las opciones de experimento solo valen para admin) y el
// cerebro (nao-api con la clave de Gemini). Consume IA (A ≈ US$0.0015, B ≈ US$0.01 por ensayo): 4–5 por condición
// bastan (Oscar). Corre sin bloquear: el avance queda en el objeto devuelto (y en window.__mirror).
// Uso: await (bench 'mirror')(5)  → 5 ensayos por condición; (bench 'mirror')(5, ['con-metodo']) solo B.
async (perCondition = 5, conditions = ['sin-metodo', 'con-metodo']) => {
  const nao = window.nao;
  for (let i = 0; i < 240 && !(nao?.physics && nao.brain && nao.sim); i++) await new Promise((r) => setTimeout(r, 250));
  const motion = nao.session.service('ALMotion');
  const posture = nao.session.service('ALRobotPosture');
  const brain = nao.brain;
  const QUESTIONS = ['¿Qué ves?', '¿Ese NAO que ves eres tú o es otro NAO?'];
  // Acciones con las que puede poner a prueba al otro NAO
  const PROBES = new Set(['arms', 'arm_joints', 'reach', 'leds', 'my_colors', 'gesture', 'animation']);
  const LOOKS = new Set(['look', 'look_at_point', 'scan', 'look_at']);
  const said = [];
  const actions = [];
  let spent = null;
  // Lo que dice se toma al llegar del servidor (Brain.say), no de la voz: la voz dice las frases en fila y la conclusión
  // llegaba cuando el ensayo ya había terminado
  const hooks = { say: brain.say, action: brain.hooks.action, spent: brain.hooks.spent };
  brain.say = (t) => { said.push(t); hooks.say.call(brain, t); };
  brain.hooks.action = (name, args, response) => { actions.push({ name, args, ok: response?.ok !== false }); hooks.action?.(name, args, response); };
  brain.hooks.spent = (usd) => { spent = usd; hooks.spent?.(usd); };

  // Veredicto por palabras sobre la conclusión: sin las frases del plan ("Voy a comprobar si es mi reflejo…" contenía "mi
  // reflejo" y contaba como reconocerse). Además se guarda el texto para revisarlo a mano.
  const verdict = (text) => {
    const t = text.split(/(?<=[.!?])\s+/).filter((s) => !/^voy a\b/i.test(s.trim())).join(' ').toLowerCase();
    if (!t.trim()) return 'sin conclusión';
    if (/no (lo )?s[eé]|no estoy segur|no puedo saber/.test(t)) return 'duda';
    if (/(soy yo|soy yo mismo|mi reflejo|mi propio reflejo|me veo reflejado|me estoy viendo|es un espejo|un espejo)/.test(t) && !/no (es|soy) (mi reflejo|yo)/.test(t)) return 'yo';
    if (/(otro nao|es otro|no soy yo|otro robot)/.test(t)) return 'otro';
    return 'duda';
  };
  const ask = async (q, experiment) => {
    said.length = 0;
    actions.length = 0;
    const t0 = performance.now();
    await brain.ask(q, 'texto', experiment);
    return { dijo: said.join(' '), ultimo: said[said.length - 1] ?? '', acciones: actions.map((a) => `${a.name}${a.ok ? '' : '✗'}`), s: Math.round((performance.now() - t0) / 1000), raw: [...actions] };
  };

  const R = { done: false, trial: 0, results: [], summary: null };
  window.__mirror = R;
  (async () => {
    try {
      for (let k = 0; k < perCondition * conditions.length; k++) {
        const variant = conditions[k % conditions.length];
        R.trial = k + 1;
        // Cada ensayo empieza de pie frente al espejo; si la preparación lo deja caído, se rehace (se anota)
        let setups = 0;
        do {
          setups++;
          nao.sim.setSpeed(10);
          nao.spawn('espejo'); // de pie a 1.5 m del espejo, mirándolo
          document.querySelector('.chip[title^="Vuelve"]').click();
          await nao.wait(1500);
          motion.setMoveArmsEnabled(true, true);
          await motion.wakeUp();
          await posture.goToPosture('StandInit', 0.5);
          await motion.moveTo(0.6, 0, 0); // de ~1.5 m a ~0.9 m del espejo
          await nao.wait(800);
        } while (posture.getPostureFamily() !== 'Standing' && setups < 3);
        nao.sim.setSpeed(1);
        // Distancia a la cara del espejo (environment.ts MIRROR: contra la pared sur del cuarto, mirando a +Y)
        const [, y] = motion.getRobotPosition(true);
        const mirrorFace = nao.rooms.espejo.y[0] + 0.04 + 0.03 + 0.025;
        const spent0 = spent;
        const q1 = await ask(QUESTIONS[0], { fresh: true, variant });
        const q2 = await ask(QUESTIONS[1], { variant });
        const names = q2.raw.map((a) => a.name);
        const probed = names.some((n) => PROBES.has(n)) && names.some((n, i) => LOOKS.has(n) && names.slice(0, i).some((m) => PROBES.has(m)));
        R.results.push({
          condicion: variant,
          distancia_m: +(y - mirrorFace).toFixed(2),
          preparaciones: setups,
          que_ves: q1.dijo,
          eres_tu: q2.dijo,
          veredicto: verdict(q2.dijo),
          comprobo: probed,
          acciones: q2.acciones,
          segundos: q1.s + q2.s,
          usd: spent !== null && spent0 !== null ? +(spent - spent0).toFixed(4) : null,
        });
      }
      const by = (c) => R.results.filter((r) => r.condicion === c);
      R.summary = Object.fromEntries(conditions.map((c) => {
        const rs = by(c);
        const count = (f) => rs.filter(f).length;
        return [c, {
          ensayos: rs.length,
          se_reconoce: count((r) => r.veredicto === 'yo'),
          dice_otro: count((r) => r.veredicto === 'otro'),
          duda: count((r) => r.veredicto === 'duda'),
          sin_conclusion: count((r) => r.veredicto === 'sin conclusión'),
          comprobo: count((r) => r.comprobo),
          usd_total: +rs.reduce((s, r) => s + (r.usd ?? 0), 0).toFixed(3),
        }];
      }));
    } catch (e) {
      R.error = String(e?.stack ?? e);
    } finally {
      brain.say = hooks.say;
      brain.hooks.action = hooks.action;
      brain.hooks.spent = hooks.spent;
      nao.sim.setSpeed(1);
      R.done = true;
    }
  })();
  return R;
};
