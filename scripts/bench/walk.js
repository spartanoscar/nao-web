// Banco de ALMotion.moveTo: cada meta relativa (x, y, theta) desde StandInit y el error al llegar.
// Se ejecuta en la página (consola o chrome-devtools evaluate_script). Esperado: true, error ≲ 8 cm y ≲ 12°.
// Delante del robot hay cubos (x ≈ 0.3 m): las rutas largas primero miran hacia −Y, que está despejado.
async () => {
  for (let i = 0; i < 60 && !window.nao.physics; i++) await new Promise((r) => setTimeout(r, 250));
  if (!window.nao.physics) return ['sin física (modo cinemático)'];
  const { session } = window.nao;
  const motion = session.service('ALMotion');
  const wait = (ms) => window.nao.wait(ms); // reloj del motor: igual a ×1 que a ×10
  const reset = async () => { document.querySelector('.chip[title^="Vuelve"]').click(); await wait(1500); };
  // [x, y, theta, girar antes hacia −Y]
  // La última era (0.5, −0.3): mirando a −Y queda sobre el borde de la pila de cajas (−0.5, −0.55); con la marcha segura
  // (sonares) un NAO real no llega ahí, y antes "llegaba" empujando la pila. Va al lado despejado.
  const goals = [[0, 0, Math.PI / 2], [0, 0, -Math.PI], [1, 0, 0, true], [0.6, 0.4, 0, true], [-0.25, 0, 0], [0, 0.15, 0], [0.5, 0.3, Math.PI / 2, true]];
  const out = [];
  for (const [x, y, th, face] of goals) {
    await reset(); await motion.wakeUp(); await wait(600);
    if (face) { await motion.moveTo(0, 0, -Math.PI / 2); await wait(300); }
    const [x0, y0, t0] = motion.getRobotPosition(true);
    const t = window.nao.clock() * 1000;
    const ok = await motion.moveTo(x, y, th);
    const secs = ((window.nao.clock() * 1000 - t) / 1000).toFixed(1);
    await wait(500);
    const [x1, y1, t1] = motion.getRobotPosition(true);
    const [c, s] = [Math.cos(t0), Math.sin(t0)];
    const gx = x0 + c * x - s * y, gy = y0 + s * x + c * y;
    const dAng = Math.atan2(Math.sin(t0 + th - t1), Math.cos(t0 + th - t1));
    out.push(`moveTo(${x}, ${y}, ${th.toFixed(2)}) → ${ok} en ${secs} s · error ${(Math.hypot(gx - x1, gy - y1) * 100).toFixed(1)} cm, ${(dAng * 57.3).toFixed(0)}°`);
  }
  await motion.rest(); await reset();
  return out;
};
