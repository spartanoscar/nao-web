// Banco de pruebas: las animaciones originales (.motion de Webots) tal cual, con la física completa.
// Cada una arranca igual (Reiniciar → wakeUp → StandInit quieto 1 s) y se mide si el robot se cae
// (inclinación del torso > 50° en algún momento), cuánto se desplaza y cuánto gira.
// Uso: pegar en la consola (o evaluate_script) y llamar con los nombres: run(['HandWave', 'TaiChi']).
async (names) => {
  const { session, state } = window.nao;
  const { MOTIONS, playMotion } = await import('/src/naoqi/motionFile.ts');
  const motion = session.service('ALMotion');
  const wait = (ms) => window.nao.wait(ms); // reloj del motor: igual a ×1 que a ×10
  const pose = () => {
    const [w, x, y, z] = state.root.quaternion;
    const tilt = Math.acos(Math.min(1, Math.max(-1, 1 - 2 * (x * x + y * y)))) * 57.3;
    const yaw = Math.atan2(2 * (w * z + x * y), 1 - 2 * (y * y + z * z)) * 57.3;
    return { tilt, yaw, p: [...state.root.position] };
  };
  const out = [];
  for (const name of names) {
    const clip = MOTIONS.find((m) => m.name === name);
    window.nao.reset();
    await wait(1500);
    await motion.wakeUp();
    await wait(1000);
    const start = pose();
    let maxTilt = 0;
    const stopTick = window.nao.onTick(() => (maxTilt = Math.max(maxTilt, pose().tilt)));
    const t0 = window.nao.clock() * 1000;
    await playMotion(motion, clip);
    await wait(1500);
    stopTick();
    const end = pose();
    const moved = Math.hypot(end.p[0] - start.p[0], end.p[1] - start.p[1]) * 100;
    let turned = end.yaw - start.yaw;
    turned = ((turned + 540) % 360) - 180;
    out.push(`${name}: ${maxTilt > 50 ? 'SE CAE' : 'de pie'} · inclinación máx ${Math.round(maxTilt)}° · final ${Math.round(end.tilt)}° · se movió ${moved.toFixed(0)} cm · giró ${Math.round(turned)}° · ${((window.nao.clock() * 1000 - t0) / 1000).toFixed(1)} s`);
  }
  return out;
}
