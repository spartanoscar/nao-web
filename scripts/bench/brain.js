// Banco del cerebro: reinicia el mundo, le da una orden al NAO y registra lo que dice y hace (con tiempos), si se cae,
// dónde quedó y qué pasó con la caja gris (box_d) y la caja de arriba de la pila (box_b: se vuelca si pasa de 45°).
// Requiere sesión y nao-api con GEMINI_API_KEY. La orden sale de window.__order.
// Uso: window.__order = '…' y luego evaluar este archivo (chrome-devtools evaluate_script con sourcePath).
async () => {
  const order = window.__order || 'NAO, ve hasta la caja gris, empújala un metro, luego vuelve y siéntate';
  const { session, world, brain } = window.nao;
  const posture = session.service('ALRobotPosture');
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  window.nao.spawn('laboratorio'); // la caja gris, la pila y los cubos están en el laboratorio
  window.nao.reset();
  await wait(1500);
  const t0 = performance.now();
  const at = () => `${((performance.now() - t0) / 1000).toFixed(0)}s`;
  const out = [];
  const info = console.info;
  console.info = (...a) => (a[0] === 'NAO ▶' ? out.push(`${at()} ${a[1]} ${JSON.stringify(a[2])} → ${JSON.stringify(a[4])}`) : info(...a));
  const tts = session.service('ALTextToSpeech');
  const onSay = tts.onSay;
  tts.onSay = (t) => {
    out.push(`${at()} dice: ${t}`);
    onSay?.(t);
  };
  const gray = world.objects.get('box_d').position;
  const top = world.objects.get('box_b');
  const [gx, gy] = [gray.x, gray.y];
  const tilt = () => {
    const q = top.quaternion;
    return (Math.acos(Math.min(1, 1 - 2 * (q.x * q.x + q.y * q.y))) * 180) / Math.PI;
  };
  let lying = false;
  let tipped = '';
  const watch = setInterval(() => {
    const now = posture.getPostureFamily().startsWith('Lying');
    if (now && !lying) out.push(`${at()} ⚠ el NAO se cayó (${posture.getPostureFamily()})`);
    lying = now;
    if (!tipped && tilt() > 45) {
      tipped = `${at()} con el NAO ${lying ? 'en el suelo' : 'de pie'}`;
      out.push(`${at()} ★ la caja de arriba se volcó (${tipped})`);
    }
  }, 200);
  try {
    await brain.ask(order, 'texto');
  } finally {
    clearInterval(watch);
    console.info = info;
    tts.onSay = onSay;
  }
  const [x, y] = session.service('ALMotion').getRobotPosition(true);
  out.push(
    `total ${at()} · robot (${x.toFixed(2)}, ${y.toFixed(2)}) ${posture.getPosture()} · caja gris movida ` +
      `${(Math.hypot(gray.x - gx, gray.y - gy) * 100).toFixed(0)} cm · caja de arriba ${tipped ? `volcada (${tipped})` : 'en su sitio'}`,
  );
  out.push(...[...document.querySelectorAll('#transcript .notice')].map((l) => `aviso: ${l.innerText}`));
  return out;
};
