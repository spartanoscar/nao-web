// Cierres inesperados de la pestaña (Oscar, 2026-10-24: en el iPad Safari recargó la página dos veces con "ocurrió un
// problema repetidamente"). Cuando iOS cierra la pestaña por memoria, la página no se entera: no hay evento ni error.
// Por eso se van apuntando en localStorage la etapa (entró, voz cargando, cuántos NAO hay…) y los últimos errores; al
// cerrarse normal (pagehide) se marca limpia. Si al abrir la página la anterior no quedó limpia, se manda al servidor
// (POST /api/client-log, solo con sesión) y queda en el registro de nao-api.

const KEY = 'nao.trail';
const BEAT_MS = 5000;
const MAX_EVENTS = 12;

interface Trail {
  started: number;
  last: number;
  stage: string;
  events: string[];
  clean: boolean;
  device: string;
}

const read = (): Trail | null => {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? 'null');
  } catch {
    return null;
  }
};

export interface CrashLog {
  /** En qué va la página (se guarda al instante) */
  stage(text: string): void;
  /** Algo que vale la pena recordar (errores, avisos) */
  event(text: string): void;
  /** Con la sesión iniciada: manda lo de la vez anterior si se cerró sola */
  report(): void;
}

export function startCrashLog(): CrashLog {
  const previous = read();
  /** Ya llegó al servidor (si al abrir no había sesión, se reintenta al entrar) */
  let sent = false;
  const trail: Trail = {
    started: Date.now(),
    last: Date.now(),
    stage: 'cargando',
    events: [],
    clean: false,
    device: `${navigator.userAgent} · táctil ${navigator.maxTouchPoints} · pantalla ${screen.width}×${screen.height}@${devicePixelRatio} · núcleos ${navigator.hardwareConcurrency}`,
  };
  const save = () => {
    trail.last = Date.now();
    try {
      localStorage.setItem(KEY, JSON.stringify(trail));
    } catch {
      /* sin almacenamiento: no hay registro */
    }
  };
  save();
  setInterval(save, BEAT_MS);
  // Cierre normal (recargar, navegar, cerrar): no es una caída
  addEventListener('pagehide', () => {
    trail.clean = true;
    save();
  });
  const event = (text: string) => {
    trail.events.push(`${Math.round((Date.now() - trail.started) / 1000)} s: ${text.slice(0, 200)}`);
    trail.events.splice(0, Math.max(0, trail.events.length - MAX_EVENTS));
    save();
  };
  addEventListener('error', (e) => event(`error: ${e.message}`));
  addEventListener('unhandledrejection', (e) => event(`promesa: ${String((e.reason as Error)?.message ?? e.reason)}`));
  return {
    stage(text) {
      trail.stage = text;
      event(`etapa: ${text}`);
    },
    event,
    report() {
      if (!previous || previous.clean || sent) return;
      const body = { kind: 'cierre inesperado', duracion_s: Math.round((previous.last - previous.started) / 1000), ...previous };
      sent = true;
      void fetch('/api/client-log', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
        .then((r) => (sent = r.ok))
        .catch(() => (sent = false));
    },
  };
}
