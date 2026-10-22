// Banco del cerebro: reinicia el mundo, le da una orden al NAO y registra lo que dice y hace (con tiempos), dónde
// quedaron él y la caja gris. Requiere sesión y nao-api con GEMINI_API_KEY. La orden sale de window.__order.
// Uso: window.__order = '…' y luego evaluar este archivo (chrome-devtools evaluate_script con sourcePath).
async () => {
  const order = window.__order || 'NAO, ve hasta la caja gris, empújala un metro, luego vuelve y siéntate';
  const { session, world, brain } = window.nao;
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  document.querySelector('.chip[title^="Vuelve"]').click();
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
  const box = () => world.objects.get('box_d').position;
  const [bx, by] = [box().x, box().y];
  try {
    await brain.ask(order, 'texto');
  } finally {
    console.info = info;
    tts.onSay = onSay;
  }
  const [x, y] = session.service('ALMotion').getRobotPosition(true);
  out.push(`total ${at()} · robot (${x.toFixed(2)}, ${y.toFixed(2)}) ${session.service('ALRobotPosture').getPosture()} · caja gris movida ${(Math.hypot(box().x - bx, box().y - by) * 100).toFixed(0)} cm`);
  out.push(...[...document.querySelectorAll('#transcript .notice')].map((l) => `aviso: ${l.innerText}`));
  return out;
};
