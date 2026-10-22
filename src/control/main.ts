// Control desde el teléfono (se entra escaneando el QR del escritorio: control.html#r=<sala>).
// Patrón de hv.bukivo.com (src/control.js): inclinación relativa a una posición de "centro", permiso de iOS
// para el sensor de orientación, reconexión. Además: la vista del NAO en vivo y la entrada de voz y video
// (por ahora solo se piden los permisos y se muestra el nivel: la conversación con IA llega en F8).

import './control.css';
import { ICONS } from '../ui/icons';
import { wsUrl } from '../net/api';

const TILT_HZ = 30;
const RANGE = { x: 30, y: 25 }; // grados de inclinación para llegar a ±1
const RETRY_MS = 1500;

const room = new URLSearchParams(location.hash.slice(1)).get('r') ?? '';
// Escanear otro QR con esta página abierta solo cambia el "#r=…" (no recarga): se recarga para usar la sala nueva
window.addEventListener('hashchange', () => location.reload());
const root = document.getElementById('control')!;
root.innerHTML = `
  <header class="c-top">
    <div class="c-brand"><img src="/brand/logo-libertadores.png" alt="" /><div><b>NAO Web</b><span class="c-owner">Control</span></div></div>
    <span class="c-status" data-state="connecting">Conectando…</span>
  </header>
  <section class="c-card c-view">
    <div class="c-title"><span>Vista del <span class="c-robot">NAO</span></span></div>
    <div class="c-screens">
      <figure class="c-screen" data-camera="0"><img alt="Cámara de la frente" hidden /><p>Esperando…</p><figcaption>Frente</figcaption></figure>
      <figure class="c-screen" data-camera="1"><img alt="Cámara de la boca" hidden /><p>Esperando…</p><figcaption>Boca</figcaption></figure>
    </div>
  </section>
  <section class="c-card c-move" data-active="false">
    <div class="c-title"><span>Mover el mundo</span>
      <div class="c-tools">
        <button type="button" class="c-icon c-motion" aria-pressed="false">${ICONS.move}</button>
        <button type="button" class="c-icon c-center" title="Centrar" aria-label="Centrar" disabled>${ICONS.center}</button>
      </div>
    </div>
    <p class="c-hint"></p>
    <div class="c-pad" aria-hidden="true"><i></i></div>
  </section>
  <section class="c-card">
    <div class="c-title">Voz y video</div>
    <p class="c-hint">Para hablarle al NAO y mostrarle cosas (muy pronto).</p>
    <div class="c-row">
      <button type="button" class="c-btn c-media">${ICONS.mic}<span>Activar micrófono y cámara</span></button>
    </div>
    <div class="c-media-box" hidden>
      <video playsinline muted autoplay></video>
      <div class="c-level"><span></span></div>
    </div>
  </section>`;

const $ = <T extends HTMLElement>(sel: string) => root.querySelector<T>(sel)!;
const status = $('.c-status');
const moveCard = $('.c-move');
const hint = $('.c-move .c-hint');
const motionBtn = $<HTMLButtonElement>('.c-motion');
const centerBtn = $<HTMLButtonElement>('.c-center');
const pad = $('.c-pad i');
const mediaBtn = $<HTMLButtonElement>('.c-media');

const setStatus = (state: 'connecting' | 'online' | 'offline', text: string) => {
  status.dataset.state = state;
  status.textContent = text;
};

// ─── Conexión ───────────────────────────────────────────────────────────────
let ws: WebSocket | null = null;
let stopped = false;
/** Las dos cámaras a la vez: Frente (0) a la izquierda, Boca (1) a la derecha */
const CAMERAS = [0, 1];
const send = (m: object) => ws?.readyState === WebSocket.OPEN && ws.send(JSON.stringify(m));

function connect() {
  if (!/^[A-Za-z0-9_-]{22}$/.test(room)) {
    setStatus('offline', 'Enlace inválido');
    hint.textContent = 'Escanea de nuevo el código QR del computador.';
    return;
  }
  const sock = new WebSocket(wsUrl(room, 'phone'));
  sock.binaryType = 'arraybuffer';
  ws = sock;
  sock.onopen = () => send({ t: 'view', on: true, cameras: CAMERAS });
  sock.onmessage = (e) => {
    if (e.data instanceof ArrayBuffer) return showFrame(e.data);
    const m = JSON.parse(e.data);
    if (m.t === 'welcome') {
      $('.c-owner').textContent = `de ${m.name}`;
      root.querySelectorAll('.c-robot').forEach((el) => (el.textContent = m.robot));
      setStatus('online', 'Conectado');
    } else if (m.t === 'peers') {
      if (m.screen) setStatus('online', 'Conectado');
    } else if (m.t === 'gone' || m.t === 'replaced') {
      stopped = true;
      setStatus('offline', m.t === 'gone' ? 'El computador se desconectó' : 'Otro teléfono tomó el control');
    }
  };
  sock.onclose = (e) => {
    if (ws !== sock) return;
    if (e.reason === 'no screen' || e.reason === 'no room') {
      stopped = true;
      setStatus('offline', 'La sala ya no existe');
      root.querySelectorAll('.c-screen p').forEach((p) => (p.textContent = 'Escanea el QR nuevo'));
      hint.textContent = 'Abre "Conectar móvil" en el computador y escanea el código nuevo.';
    }
    if (stopped) return;
    setStatus('connecting', 'Reconectando…');
    setTimeout(connect, RETRY_MS);
  };
}

// Un recuadro por cámara; el primer byte de cada cuadro dice de cuál es
const screens = CAMERAS.map((c) => {
  const fig = $(`.c-screen[data-camera="${c}"]`);
  return { img: fig.querySelector('img')!, waiting: fig.querySelector('p')!, shown: '' };
});
function showFrame(buf: ArrayBuffer) {
  const bytes = new Uint8Array(buf);
  const screen = screens[bytes[0]];
  if (!screen) return;
  const url = URL.createObjectURL(new Blob([bytes.subarray(1)], { type: 'image/jpeg' }));
  const prev = screen.shown;
  screen.shown = url;
  screen.img.onload = () => prev && URL.revokeObjectURL(prev); // libera el cuadro anterior cuando ya se ve el nuevo
  screen.img.src = url;
  screen.img.hidden = false;
  screen.waiting.hidden = true;
}
document.addEventListener('visibilitychange', () => send({ t: 'view', on: !document.hidden, cameras: CAMERAS }));

// ─── Inclinación (como hv: relativa al "centro", recortada a ±1) ─────────────
let base: { beta: number; gamma: number } | null = null;
let tilt = { x: 0, y: 0 };
let lastSent = 0;
let gotEvent = false;

const onOrientation = (e: DeviceOrientationEvent) => {
  if (e.beta === null || e.gamma === null) return;
  gotEvent = true;
  base ??= { beta: e.beta, gamma: e.gamma };
  const clamp = (v: number) => Math.min(Math.max(v, -1), 1);
  tilt = { x: clamp((e.gamma - base.gamma) / RANGE.x), y: clamp((e.beta - base.beta) / RANGE.y) };
  pad.style.transform = `translate(${tilt.x * 34}px, ${tilt.y * 34}px)`;
  // A lo sumo TILT_HZ envíos por segundo, pero el último valor siempre sale (si no, al enderezar el teléfono
  // el "0" podía perderse y la vista seguía girando)
  const now = performance.now();
  clearTimeout(trailing);
  if (now - lastSent > 1000 / TILT_HZ) sendTilt();
  else trailing = window.setTimeout(sendTilt, 1000 / TILT_HZ);
};
let trailing = 0;
const sendTilt = () => {
  lastSent = performance.now();
  send({ t: 'tilt', x: +tilt.x.toFixed(3), y: +tilt.y.toFixed(3) });
};

// Un solo ícono activa y pausa el movimiento; el de la mira toma la posición actual como "centro"
let moving = false;
const paintMotion = (note?: string) => {
  moveCard.dataset.active = String(moving);
  motionBtn.innerHTML = moving ? ICONS.pause : ICONS.move;
  motionBtn.setAttribute('aria-pressed', String(moving));
  motionBtn.title = moving ? 'Pausar movimiento' : 'Activar movimiento';
  motionBtn.setAttribute('aria-label', motionBtn.title);
  centerBtn.disabled = !moving;
  hint.textContent = note ?? (moving ? 'Inclina el teléfono para girar la vista alrededor del NAO.' : 'Toca el ícono para activar el movimiento.');
};

motionBtn.addEventListener('click', async () => {
  if (moving) {
    moving = false;
    window.removeEventListener('deviceorientation', onOrientation);
    clearTimeout(trailing);
    tilt = { x: 0, y: 0 };
    sendTilt();
    pad.style.transform = '';
    return paintMotion();
  }
  // iOS 13+: el permiso del sensor solo se puede pedir desde un toque
  const DOE = DeviceOrientationEvent as unknown as { requestPermission?: () => Promise<string> };
  if (typeof DOE.requestPermission === 'function') {
    try {
      if ((await DOE.requestPermission()) !== 'granted') return paintMotion('Sin permiso para el sensor de movimiento.');
    } catch {
      return;
    }
  }
  moving = true;
  base = null;
  window.addEventListener('deviceorientation', onOrientation);
  paintMotion();
  setTimeout(() => {
    if (moving && !gotEvent) paintMotion('Este teléfono no tiene sensor de movimiento.');
  }, 1500);
});
centerBtn.addEventListener('click', () => {
  base = null;
  send({ t: 'tilt', x: 0, y: 0 });
});
paintMotion();

// ─── Micrófono y cámara (solo permisos y vista previa por ahora) ─────────────
mediaBtn.addEventListener('click', async () => {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: { facingMode: 'environment' } });
    const box = $('.c-media-box');
    box.hidden = false;
    $<HTMLVideoElement>('.c-media-box video').srcObject = stream;
    mediaBtn.disabled = true;
    mediaBtn.querySelector('span')!.textContent = 'Micrófono y cámara listos';
    send({ t: 'media', mic: true, cam: true });
    // Nivel del micrófono, para ver que escucha
    const ctx = new AudioContext();
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 512;
    ctx.createMediaStreamSource(stream).connect(analyser);
    const data = new Uint8Array(analyser.fftSize);
    const level = $('.c-level span');
    const tick = () => {
      analyser.getByteTimeDomainData(data);
      let peak = 0;
      for (const v of data) peak = Math.max(peak, Math.abs(v - 128));
      level.style.width = `${Math.min(100, (peak / 128) * 160)}%`;
      requestAnimationFrame(tick);
    };
    tick();
  } catch (e) {
    mediaBtn.querySelector('span')!.textContent = 'Sin permiso (actívalo en el navegador)';
    console.warn(e);
  }
});

connect();
