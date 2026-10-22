// Conectar el teléfono por QR (patrón de hv.bukivo.com, con sala creada por el servidor para el usuario logueado).
// El escritorio es la "pantalla" de la sala; el teléfono entra con el enlace del QR (control.html#r=<sala>).
//
// Mensajes (JSON con `t`, como hv):
//   teléfono → escritorio: {t:'tilt', x, y} (−1..1, ~30/s) · {t:'view', on, cameras: [0, 1]} · {t:'media', mic, cam}
//   escritorio → teléfono: binario = [cámara (1 byte)] + JPEG de la vista del NAO (ALVideoDevice, 320×240,
//   5/s por cámara)
//   servidor → ambos: {t:'peers', screen, phone} · {t:'replaced'} · {t:'gone'}

import qrcode from 'qrcode-generator';
import type { ALVideoDevice } from '../naoqi/ALVideoDevice';
import { createRoom, wsUrl } from '../net/api';
import type { Hud } from './hud';
import { ICONS } from './icons';

const RETRY_MS = 2000;
const VIEW_FPS = 5;
const K_QVGA = 1;
const K_RGB = 11;
/** No encolar más vista si el socket tiene esto pendiente (red lenta): mejor saltar cuadros */
const MAX_BUFFERED = 256 << 10;

export interface PhoneHooks {
  /** Inclinación del teléfono (−1..1): gira la cámara del mundo, no al robot */
  tilt(x: number, y: number): void;
}

export function attachPhoneLink(hud: Hud, video: ALVideoDevice, hooks: PhoneHooks): void {
  let room: string | null = null;
  let ws: WebSocket | null = null;
  let phone = false;
  let view: { cameras: number[]; timer: number } | null = null;
  /** Otra pestaña abrió su propia sala: esta deja de reconectar (si no, se quitarían la sala sin fin) */
  let displaced = false;
  const handles = new Map<number, string>();

  // ─── Diálogo con el QR ──────────────────────────────────────────────────────
  const modal = document.createElement('div');
  modal.className = 'phone-modal';
  modal.hidden = true;
  modal.innerHTML = `
    <div class="pm-card" role="dialog" aria-label="Conectar el teléfono">
      <button type="button" class="pm-close" title="Cerrar">${ICONS.close}</button>
      <h2>${ICONS.qr} Conecta tu teléfono</h2>
      <p class="pm-lead">Escanea el código con la cámara del teléfono. Desde allí mueves la vista del mundo, ves lo que
        ve tu NAO y, muy pronto, le hablas.</p>
      <div class="pm-qr" aria-label="Código QR"></div>
      <p class="pm-status"></p>
    </div>`;
  document.body.append(modal);
  const qrBox = modal.querySelector<HTMLElement>('.pm-qr')!;
  const status = modal.querySelector<HTMLElement>('.pm-status')!;
  const close = () => (modal.hidden = true);
  modal.querySelector('.pm-close')!.addEventListener('click', close);
  modal.addEventListener('click', (e) => e.target === modal && close());
  window.addEventListener('keydown', (e) => e.key === 'Escape' && close());

  const paint = () => {
    hud.setPhoneState(phone ? 'connected' : room ? 'waiting' : 'idle');
    status.innerHTML = phone
      ? `${ICONS.check} ¡Teléfono conectado!`
      : displaced
        ? 'El móvil se conectó desde otra pestaña. Vuelve a abrir este diálogo para usarlo aquí.'
        : room
          ? 'Esperando el teléfono…'
          : 'Preparando la sala…';
    status.classList.toggle('ok', phone);
  };

  const showQr = (code: string) => {
    const url = `${location.origin}/control.html#r=${code}`;
    const qr = qrcode(0, 'M');
    qr.addData(url);
    qr.make();
    qrBox.innerHTML = qr.createSvgTag({ cellSize: 6, margin: 2, scalable: true });
    qrBox.title = url;
  };

  // ─── Sala y socket ──────────────────────────────────────────────────────────
  const open = async () => {
    if (!room) {
      try {
        room = (await createRoom()).room;
      } catch (e) {
        status.textContent = `No se pudo crear la sala: ${(e as Error).message}`;
        return;
      }
      showQr(room);
    }
    connect(room);
    paint();
  };

  const connect = (code: string) => {
    if (ws && ws.readyState <= WebSocket.OPEN) return;
    const sock = new WebSocket(wsUrl(code, 'screen'));
    sock.binaryType = 'arraybuffer';
    ws = sock;
    sock.onmessage = (e) => {
      if (typeof e.data !== 'string') return;
      let m: Record<string, unknown>;
      try {
        m = JSON.parse(e.data);
      } catch {
        return;
      }
      if (m.t === 'peers') {
        const was = phone;
        phone = Boolean(m.phone);
        if (phone && !was) setTimeout(close, 1200);
        if (!phone) stopView();
        paint();
      } else if (m.t === 'replaced') {
        displaced = true;
        room = null;
      } else if (m.t === 'tilt') hooks.tilt(clamp(Number(m.x)), clamp(Number(m.y)));
      else if (m.t === 'view') {
        const cameras = (Array.isArray(m.cameras) ? m.cameras : [m.camera]).map(Number).filter((c) => c === 0 || c === 1);
        if (m.on && cameras.length) startView([...new Set(cameras)]);
        else stopView();
      }
    };
    sock.onclose = (e) => {
      if (ws !== sock) return;
      ws = null;
      phone = false;
      stopView();
      hooks.tilt(0, 0);
      // La sala ya no existe (el servidor se reinició o se abrió en otra pestaña): se crea otra con QR nuevo
      if (e.reason === 'no room' || e.reason === 'not yours') room = null;
      paint();
      if (!displaced) setTimeout(() => void open(), RETRY_MS);
    };
  };

  // ─── Vista del NAO hacia el teléfono ────────────────────────────────────────
  const canvas = document.createElement('canvas');
  canvas.width = 320;
  canvas.height = 240;
  const ctx = canvas.getContext('2d')!;
  const image = ctx.createImageData(320, 240);

  const sendFrame = (camera: number) => {
    if (!ws || ws.readyState !== WebSocket.OPEN || ws.bufferedAmount > MAX_BUFFERED || document.hidden) return;
    let handle = handles.get(camera);
    if (!handle) {
      handle = video.subscribeCamera('phone', camera, K_QVGA, K_RGB, VIEW_FPS);
      handles.set(camera, handle);
    }
    const img = video.getImageRemote(handle);
    if (!img) return;
    const [w, h, , , , , data] = img;
    for (let i = 0, j = 0; i < w * h; i++, j += 3) {
      image.data[i * 4] = data[j];
      image.data[i * 4 + 1] = data[j + 1];
      image.data[i * 4 + 2] = data[j + 2];
      image.data[i * 4 + 3] = 255;
    }
    ctx.putImageData(image, 0, 0);
    canvas.toBlob((jpeg) => jpeg && ws?.readyState === WebSocket.OPEN && ws.send(new Blob([Uint8Array.of(camera), jpeg])), 'image/jpeg', 0.6);
  };

  const startView = (cameras: number[]) => {
    stopView();
    view = { cameras, timer: window.setInterval(() => cameras.forEach(sendFrame), 1000 / VIEW_FPS) };
  };
  const stopView = () => {
    if (view) clearInterval(view.timer);
    view = null;
  };

  hud.phoneButton.addEventListener('click', () => {
    displaced = false;
    modal.hidden = false;
    paint();
    void open();
  });
  paint();
}

const clamp = (v: number) => (Number.isFinite(v) ? Math.min(Math.max(v, -1), 1) : 0);
