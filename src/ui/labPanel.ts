// Laboratorio de movimientos (panel oculto): busca con CMA-ES un movimiento equilibrado para una tarea (sentarse,
// levantarse) probando miles de variantes en una física aparte (src/lab/), muestra el progreso y deja ver el mejor en
// el robot cargándolo en el grabador de poses. El mejor de cada tarea se recuerda en este navegador.

import type { RootPose } from '../robot/state';
import type { UrdfRobot } from '../robot/urdf';
import type { Progress, Result } from '../lab/search';
import type { PoseOrigin, PoseRecorder } from './poseRecorder';

const STORAGE_KEY = 'nao.lab';
/** Desde dónde se prueba cada tarea en el grabador */
const ORIGIN: Record<string, PoseOrigin> = { 'sit-down': 'stand', 'stand-up': 'sit' };
const IMITATE = 'imitate';

type Saved = Result & { origin?: PoseOrigin };

export function attachLabPanel(host: HTMLElement, urdf: UrdfRobot, root: RootPose, recorder: PoseRecorder): void {
  const section = document.createElement('details');
  section.className = 'chain lab-panel';
  section.innerHTML = `
    <summary>Laboratorio de movimientos</summary>
    <p class="joint-note">Busca un movimiento equilibrado probando miles de variantes en una física aparte (CMA-ES). Cada
      intento se reproduce con angleInterpolation, como en el robot real. La página sigue usable mientras busca.</p>
    <div class="lab-row">
      <select class="lab-task"></select>
      <label>Generaciones <input class="lab-gens" type="number" min="1" max="2000" value="60" /></label>
    </div>
    <div class="chips lab-buttons"></div>
    <canvas class="lab-chart" width="280" height="80"></canvas>
    <div class="activity lab-status"></div>`;
  host.append(section);
  const $ = <T extends HTMLElement>(sel: string) => section.querySelector<T>(sel)!;
  const select = $<HTMLSelectElement>('.lab-task');
  const gens = $<HTMLInputElement>('.lab-gens');
  const status = $('.lab-status');
  const chart = $<HTMLCanvasElement>('.lab-chart');

  let running = false;
  let stop = false;
  let history: number[] = [];
  const results: Record<string, Saved> = (() => {
    try {
      return JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}');
    } catch {
      return {};
    }
  })();

  const describe = (p: Progress) => {
    const m = p.bestMetrics;
    return (
      `Gen ${p.generation} · ${p.episodes} intentos · ${Math.round(p.seconds)} s\n` +
      `Mejor: costo ${p.best.toFixed(1)} (semilla ${p.seed.cost.toFixed(1)}) · ${m.posture}` +
      ` · bajada máx ${m.maxDrop.toFixed(2)} m/s (semilla ${p.seed.metrics.maxDrop.toFixed(2)})` +
      ` · giro máx ${m.maxSpin.toFixed(1)} rad/s · torso ${Math.round(m.endPitch ?? 0)}° atrás/adelante, ${Math.round(m.endRoll ?? 0)}° de lado` +
      ` · ${m.duration.toFixed(1)} s${m.fell ? ' · se cae' : ''}`
    );
  };
  const draw = () => {
    const ctx = chart.getContext('2d')!;
    ctx.clearRect(0, 0, chart.width, chart.height);
    if (history.length < 2) return;
    const max = Math.max(...history);
    const min = Math.min(...history);
    ctx.strokeStyle = '#f5a524';
    ctx.lineWidth = 2;
    ctx.beginPath();
    history.forEach((c, i) => {
      const x = (i / (history.length - 1)) * (chart.width - 4) + 2;
      const y = chart.height - 4 - ((c - min) / (max - min || 1)) * (chart.height - 8);
      if (i) ctx.lineTo(x, y);
      else ctx.moveTo(x, y);
    });
    ctx.stroke();
  };

  void import('../lab/tasks').then((m) => {
    for (const t of [...m.TASKS, { id: IMITATE, label: 'Imitar lo grabado (poses del grabador o del modo animador)' }]) {
      const o = document.createElement('option');
      o.value = t.id;
      o.textContent = t.label;
      select.append(o);
    }
    show();
  });
  const show = () => {
    const r = results[select.value];
    status.textContent = r ? `Guardado: ${describe(r.progress)}` : 'Sin resultados para esta tarea todavía';
  };
  select.addEventListener('change', show);

  const chip = (label: string, title: string, fn: () => void) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'chip';
    b.textContent = label;
    b.title = title;
    b.addEventListener('click', fn);
    $('.lab-buttons').append(b);
    return b;
  };
  chip('Buscar', 'Empieza la búsqueda para la tarea elegida', async () => {
    if (running) return;
    running = true;
    stop = false;
    history = [];
    status.textContent = 'Preparando la física del laboratorio…';
    try {
      const [{ searchMotion }, { TASKS: tasks, imitationTask }] = await Promise.all([import('../lab/search'), import('../lab/tasks')]);
      let origin = ORIGIN[select.value];
      let task = tasks.find((t) => t.id === select.value);
      if (select.value === IMITATE) {
        const frames = recorder.frames();
        if (frames.length < 2) throw new Error('graba al menos 2 poses en el grabador (o con el modo animador)');
        origin = recorder.origin;
        task = imitationTask(frames, origin);
        status.textContent = `Referencia: ${task.label}…`;
      }
      if (!task) throw new Error('tarea desconocida');
      const result = await searchMotion(urdf, root, task, {
        generations: Math.max(1, Math.min(2000, Number(gens.value) || 60)),
        seed: Date.now() % 100000,
        cancelled: () => stop,
        onProgress: (p) => {
          history.push(p.best);
          draw();
          status.textContent = describe(p);
        },
      });
      const prev = results[task.id];
      // Imitar: cada búsqueda es de una referencia nueva, se guarda siempre la última
      if (!prev || result.cost < prev.cost || task.id === IMITATE) {
        results[task.id] = { ...result, origin };
        try {
          localStorage.setItem(STORAGE_KEY, JSON.stringify(results));
        } catch {
          /* sin almacenamiento */
        }
      }
      status.textContent = `${stop ? 'Detenido' : 'Terminado'}: ${describe(result.progress)}${prev && result.cost >= prev.cost && task.id !== IMITATE ? '\n(el guardado anterior era mejor: se conserva)' : ''}`;
    } catch (e) {
      status.textContent = `Error: ${e instanceof Error ? e.message : String(e)}`;
    } finally {
      running = false;
    }
  });
  chip('Detener', 'Termina después del intento en curso y conserva el mejor', () => {
    stop = true;
  });
  chip('Ver en el robot', 'Carga el mejor movimiento en el grabador y lo reproduce desde su postura de partida', async () => {
    const r = results[select.value];
    if (!r) return void (status.textContent = 'Primero busca un movimiento');
    recorder.load(r.frames, r.origin ?? ORIGIN[r.task]);
    status.textContent = '▶ Reproduciendo el mejor movimiento…';
    const t = await recorder.play();
    status.textContent = t === null ? 'Hace falta la física (MuJoCo)' : `Listo (${t.toFixed(1)} s). Está en el grabador: puedes afinarlo o copiarlo.`;
  });
}
