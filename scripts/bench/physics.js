// Banco de pruebas de la física. Se ejecuta en la página (consola del navegador o
// chrome-devtools evaluate_script con sourcePath) y devuelve un informe de texto.
// Cada línea debe coincidir con lo esperado (comentario al final de cada paso).
async () => {
  for (let i = 0; i < 60 && !window.nao.physics; i++) await new Promise((r) => setTimeout(r, 250));
  if (!window.nao.physics) return ['sin física (modo cinemático)'];
  const { session, state } = window.nao;
  const motion = session.service('ALMotion');
  const posture = session.service('ALRobotPosture');
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const ang = () => {
    const [w, x, y, z] = state.root.quaternion;
    const zx = 2 * (x * z + w * y), zy = 2 * (y * z - w * x), zz = 1 - 2 * (x * x + y * y);
    return `pitch ${Math.round(Math.atan2(zx, zz) * 57.3)}° roll ${Math.round(Math.atan2(-zy, zz) * 57.3)}° torso ${state.root.position[2].toFixed(2)} m`;
  };
  const reset = async () => { document.querySelector('.chip[title^="Vuelve"]').click(); await wait(1500); };
  const go = async (name) => {
    const ok = await posture.goToPosture(name, 0.6);
    await wait(800);
    return `goToPosture(${name}) → ${ok} · ${posture.getPosture()} · ${ang()}${ok ? '' : ' · ' + posture.lastFailure}`;
  };
  const out = [];
  await reset();
  out.push(`arranque en reposo: ${posture.getPosture()} · ${ang()}`); //               Crouch, ~3°, 0.22 m
  await motion.wakeUp(); await wait(800);
  out.push(`wakeUp: ${posture.getPosture()} · ${ang()}`); //                           StandInit, ~7°, 0.32 m
  out.push(await go('Stand')); //                                                      true, Stand, ~0°
  out.push(await go('Sit')); //                                                        true, Sit, ~-35°
  out.push(await go('LyingBack')); //                                                  true, LyingBack, ~-92°
  out.push(await go('StandInit')); //                                                  false: sin camino validado
  await reset(); await motion.wakeUp(); await wait(800);
  await motion.angleInterpolation(['LHipPitch', 'LKneePitch', 'LAnklePitch'], [-0.9, 1.6, -0.7], 1.0, true);
  await wait(1200);
  out.push(`levantar pie izquierdo sin pasar el peso: ${ang()}`); //                    se cae de lado (roll ~-85°)
  await motion.rest(); await reset();
  return out;
};
