// Control desde el teléfono (se entra escaneando el QR del escritorio: control.html#r=<sala>).
// Patrón de hv.bukivo.com (src/control.js): inclinación relativa a una posición de "centro", permiso de iOS
// para el sensor de orientación, reconexión. Además: la vista del NAO en vivo y la entrada de voz y video
// (por ahora solo se piden los permisos y se muestra el nivel: la conversación con IA llega en F8).

import './control.css';
import { ICONS } from '../ui/icons';
import { wsUrl } from '../net/api';
import { type VoiceSender, startVoice } from './voice';

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
    <div class="c-title"><span>Voz y video</span>
      <div class="c-tools">
        <button type="button" class="c-icon c-mic" aria-pressed="true" hidden>${ICONS.mic}</button>
        <button type="button" class="c-icon c-flip" title="Cambiar a la cámara de selfies" aria-label="Cambiar de cámara" hidden>${ICONS.flip}</button>
      </div>
    </div>
    <p class="c-hint">Habla y verás tus palabras en la pantalla del computador. Pronto el NAO te responderá.</p>
    <div class="c-row">
      <button type="button" class="c-btn c-media">${ICONS.mic}<span>Activar micrófono y cámara</span></button>
    </div>
    <div class="c-media-box" hidden>
      <video playsinline muted autoplay></video>
      <div class="c-level"><span></span></div>
      <p class="c-caption">Escuchando…</p>
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
const flipBtn = $<HTMLButtonElement>('.c-flip');
const micBtn = $<HTMLButtonElement>('.c-mic');
const caption = $('.c-caption');

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
    } else if (m.t === 'caption') {
      caption.textContent = m.text;
      caption.classList.toggle('c-final', Boolean(m.final));
    } else if (m.t === 'caption-error') {
      caption.textContent = m.error;
      caption.classList.add('c-error');
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

// ─── Micrófono y cámara ──────────────────────────────────────────────────────
/**
 * Lo que ve la cámara del teléfono va a la pantalla (binario [PHONE_FRAME] + JPEG, el relay lo reenvía: los bytes 1–3
 * son la voz): ahí se buscan rostros (src/ai/faces.ts) y se suma a la imagen que ve el NAO. ≤ 320 px, 2 por segundo,
 * solo con la página visible.
 */
const PHONE_FRAME = 4;
const FRAME_MS = 500;
const FRAME_SIDE = 320;
const shot = document.createElement('canvas');
const sendCameraFrame = () => {
  if (!stream || document.hidden || !ws || ws.readyState !== WebSocket.OPEN || ws.bufferedAmount > 256 << 10) return;
  const { videoWidth: w, videoHeight: h } = preview;
  if (!w || !h) return;
  const k = FRAME_SIDE / Math.max(w, h);
  [shot.width, shot.height] = [Math.round(w * k), Math.round(h * k)];
  shot.getContext('2d')!.drawImage(preview, 0, 0, shot.width, shot.height);
  shot.toBlob((jpeg) => jpeg && ws?.readyState === WebSocket.OPEN && ws.send(new Blob([Uint8Array.of(PHONE_FRAME), jpeg])), 'image/jpeg', 0.7);
};
let stream: MediaStream | null = null;
let facing: 'environment' | 'user' = 'environment';
const preview = $<HTMLVideoElement>('.c-media-box video');

const showPreview = () => {
  preview.srcObject = null;
  preview.srcObject = stream;
  preview.classList.toggle('c-mirror', facing === 'user'); // la de selfies se ve como un espejo
  flipBtn.title = facing === 'user' ? 'Cambiar a la cámara de atrás' : 'Cambiar a la cámara de selfies';
};

// Cambiar de cámara: se suelta la actual antes de pedir la otra (varios teléfonos no abren dos a la vez)
flipBtn.addEventListener('click', async () => {
  if (!stream) return;
  const next = facing === 'user' ? 'environment' : 'user';
  for (const t of stream.getVideoTracks()) {
    t.stop();
    stream.removeTrack(t);
  }
  try {
    const video = await navigator.mediaDevices.getUserMedia({ video: { facingMode: next } });
    facing = next;
    for (const t of video.getVideoTracks()) stream.addTrack(t);
  } catch (e) {
    console.warn('No se pudo cambiar de cámara:', e);
    const back = await navigator.mediaDevices.getUserMedia({ video: { facingMode: facing } }).catch(() => null);
    for (const t of back?.getVideoTracks() ?? []) stream.addTrack(t);
  }
  showPreview();
});

let voice: VoiceSender | null = null;
let listening = true;
const paintMic = () => {
  micBtn.setAttribute('aria-pressed', String(listening));
  micBtn.title = listening ? 'Pausar el micrófono' : 'Activar el micrófono';
  micBtn.setAttribute('aria-label', micBtn.title);
  if (!listening) caption.textContent = 'Micrófono en pausa';
};
micBtn.addEventListener('click', () => {
  listening = !listening;
  voice?.setEnabled(listening);
  caption.classList.remove('c-error');
  if (listening) caption.textContent = 'Escuchando…';
  paintMic();
});

mediaBtn.addEventListener('click', async () => {
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: { facingMode: facing } });
    const box = $('.c-media-box');
    box.hidden = false;
    showPreview();
    flipBtn.hidden = false;
    mediaBtn.disabled = true;
    mediaBtn.querySelector('span')!.textContent = 'Micrófono y cámara listos';
    send({ t: 'media', mic: true, cam: true });
    setInterval(sendCameraFrame, FRAME_MS);
    // Voz → transcripción en el servidor: solo se manda lo que se habla
    voice = await startVoice(stream, (data) => ws?.readyState === WebSocket.OPEN && ws.send(data));
    const level = $('.c-level span');
    voice.onLevel = (v, speaking) => {
      level.style.width = `${Math.round(v * 100)}%`;
      level.classList.toggle('c-speaking', speaking);
    };
    micBtn.hidden = false;
    paintMic();
  } catch (e) {
    mediaBtn.querySelector('span')!.textContent = 'Sin permiso (actívalo en el navegador)';
    console.warn(e);
  }
});

connect();
