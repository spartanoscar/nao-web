// Texturas del mundo 1 (sim/rooms.ts), dibujadas en memoria con canvas: papel de colgar, pisos, alfombras y el cielo
// de las ventanas. Diseño propio, sin archivos externos. Estética de "juguete en una casa de verdad": colores
// cálidos y saturados, bordes suaves.
//
// Papel de colgar: 1 m de ancho (se repite a lo largo de la pared) × la altura completa de la pared (no se repite: así
// el zócalo, la moldura o la franja quedan a su altura real). Pisos: 1 m × 1 m, repetidos.

import * as THREE from 'three';
import { type FloorStyle, WALL_HEIGHT, type WallStyle } from './rooms';

/** Píxeles por metro */
const PPM = 256;

/** Generador pseudoaleatorio fijo: el mismo dibujo en cada carga */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}

const css = (hex: number) => `#${hex.toString(16).padStart(6, '0')}`;
/** Mezcla un color con blanco (t > 0) o con negro (t < 0) */
function shade(hex: number, t: number): string {
  const c = new THREE.Color(hex);
  c.lerp(new THREE.Color(t > 0 ? 0xffffff : 0x000000), Math.abs(t));
  return `#${c.getHexString()}`;
}

function canvasTexture(w: number, h: number, draw: (g: CanvasRenderingContext2D, w: number, h: number) => void, repeatV = true): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  draw(c.getContext('2d')!, w, h);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = repeatV ? THREE.RepeatWrapping : THREE.ClampToEdgeWrapping;
  tex.anisotropy = 8;
  return tex;
}

/** Altura en la pared (m) → fila del canvas (la v de la pared va de 0 abajo a 1 arriba) */
const row = (z: number, h: number) => h - (z / WALL_HEIGHT) * h;

function star(g: CanvasRenderingContext2D, x: number, y: number, r: number) {
  g.beginPath();
  for (let i = 0; i < 10; i++) {
    const a = (i / 10) * Math.PI * 2 - Math.PI / 2;
    const rr = i % 2 ? r * 0.45 : r;
    g.lineTo(x + Math.cos(a) * rr, y + Math.sin(a) * rr);
  }
  g.closePath();
  g.fill();
}

/** Zócalo (blanco o madera) y moldura del techo, comunes a todos los papeles */
function trims(g: CanvasRenderingContext2D, w: number, h: number, base: string) {
  g.fillStyle = base;
  g.fillRect(0, row(0.1, h), w, h - row(0.1, h));
  g.fillStyle = 'rgba(0,0,0,0.18)';
  g.fillRect(0, row(0.1, h) - 2, w, 3);
  g.fillStyle = '#f6f1e7';
  g.fillRect(0, 0, w, row(WALL_HEIGHT - 0.06, h));
  g.fillStyle = 'rgba(0,0,0,0.12)';
  g.fillRect(0, row(WALL_HEIGHT - 0.06, h), w, 3);
}

export function wallpaper(style: WallStyle, paint: number, seed = 1): THREE.CanvasTexture {
  return canvasTexture(PPM, Math.round(WALL_HEIGHT * PPM), (g, w, h) => {
    const r = rng(seed);
    g.fillStyle = css(paint);
    g.fillRect(0, 0, w, h);
    switch (style) {
      case 'stars': {
        // Estrellas pequeñas y dispersas, en dos tonos
        for (let i = 0; i < 26; i++) {
          g.fillStyle = i % 3 ? 'rgba(255,255,255,0.55)' : shade(paint, -0.18);
          star(g, r() * w, r() * row(0.4, h), 5 + r() * 8);
        }
        trims(g, w, h, '#f7f3ea');
        break;
      }
      case 'dado': {
        // Mitad de abajo más oscura y una moldura a 0.9 m
        g.fillStyle = shade(paint, -0.22);
        g.fillRect(0, row(0.9, h), w, h - row(0.9, h));
        g.fillStyle = '#fbf6ee';
        g.fillRect(0, row(0.93, h), w, row(0.87, h) - row(0.93, h));
        trims(g, w, h, '#fbf6ee');
        break;
      }
      case 'wainscot': {
        // Rayas suaves arriba; abajo, paneles de madera hasta 0.9 m
        for (let x = 0; x < w; x += w / 8) {
          g.fillStyle = shade(paint, 0.12);
          g.fillRect(x, 0, w / 16, row(0.9, h));
        }
        const top = row(0.9, h);
        g.fillStyle = '#8a5a35';
        g.fillRect(0, top, w, h - top);
        for (let x = 0; x < w; x += w / 2) {
          g.strokeStyle = 'rgba(0,0,0,0.25)';
          g.lineWidth = 4;
          g.strokeRect(x + 18, top + 24, w / 2 - 36, row(0.16, h) - top - 30);
          g.strokeStyle = 'rgba(255,255,255,0.12)';
          g.lineWidth = 2;
          g.strokeRect(x + 22, top + 28, w / 2 - 44, row(0.16, h) - top - 38);
        }
        g.fillStyle = '#6d4426';
        g.fillRect(0, top - 6, w, 12);
        trims(g, w, h, '#6d4426');
        break;
      }
      case 'band': {
        // Franja azul a la altura de la mesa y una línea fina encima
        g.fillStyle = '#3aa0ff';
        g.fillRect(0, row(1.12, h), w, row(1.0, h) - row(1.12, h));
        g.fillStyle = '#1d6fd1';
        g.fillRect(0, row(1.18, h), w, row(1.15, h) - row(1.18, h));
        trims(g, w, h, '#d7dde4');
        break;
      }
      case 'tiles': {
        // Azulejo blanco hasta 1.3 m (15 cm), con una cenefa de color
        const top = row(1.3, h);
        g.fillStyle = '#eef5f5';
        g.fillRect(0, top, w, h - top);
        g.strokeStyle = '#c7d6d6';
        g.lineWidth = 2;
        const step = 0.15 * PPM;
        for (let y = h; y > top; y -= step) {
          g.beginPath();
          g.moveTo(0, y);
          g.lineTo(w, y);
          g.stroke();
        }
        for (let x = 0; x <= w; x += step) {
          g.beginPath();
          g.moveTo(x, top);
          g.lineTo(x, h);
          g.stroke();
        }
        g.fillStyle = '#2f9e8f';
        g.fillRect(0, top - 10, w, 14);
        trims(g, w, h, '#e9f1f1');
        break;
      }
      case 'hazard': {
        // Sala de pruebas: franjas amarillas y negras abajo, como en un taller
        const top = row(0.22, h);
        g.save();
        g.beginPath();
        g.rect(0, top, w, h - top);
        g.clip();
        g.fillStyle = '#1b1d21';
        g.fillRect(0, top, w, h - top);
        g.fillStyle = '#f5b301';
        for (let x = -h; x < w + h; x += 48) {
          g.beginPath();
          g.moveTo(x, h);
          g.lineTo(x + 24, h);
          g.lineTo(x + 24 + (h - top), top);
          g.lineTo(x + (h - top), top);
          g.fill();
        }
        g.restore();
        g.fillStyle = '#f6f1e7';
        g.fillRect(0, 0, w, row(WALL_HEIGHT - 0.06, h));
        break;
      }
    }
  }, false);
}

export function floorTexture(style: FloorStyle, seed = 7): THREE.CanvasTexture {
  return canvasTexture(PPM * 2, PPM * 2, (g, w, h) => {
    const r = rng(seed);
    switch (style) {
      case 'wood':
      case 'darkwood': {
        // Tablas de 12.5 cm con uniones desfasadas y vetas
        const base = style === 'wood' ? [0xc89160, 0xb98252, 0xd19b6a] : [0x8b5a36, 0x7a4d2d, 0x95633d];
        const plank = h / 16;
        for (let i = 0; i < 16; i++) {
          let x = -r() * w;
          while (x < w) {
            const len = w * (0.35 + r() * 0.4);
            g.fillStyle = css(base[Math.floor(r() * base.length)]);
            g.fillRect(x, i * plank, len, plank);
            g.strokeStyle = 'rgba(60,30,10,0.12)';
            g.lineWidth = 1;
            for (let k = 0; k < 4; k++) {
              const y = i * plank + r() * plank;
              g.beginPath();
              g.moveTo(x, y);
              g.bezierCurveTo(x + len * 0.3, y + (r() - 0.5) * 6, x + len * 0.6, y + (r() - 0.5) * 6, x + len, y);
              g.stroke();
            }
            g.fillStyle = 'rgba(40,20,5,0.35)';
            g.fillRect(x, i * plank, 2, plank);
            x += len;
          }
          g.fillStyle = 'rgba(40,20,5,0.3)';
          g.fillRect(0, i * plank, w, 2);
        }
        break;
      }
      case 'tile': {
        // Baldosa blanca de 25 cm, con algunas en turquesa
        const n = 8;
        const s = w / n;
        for (let i = 0; i < n; i++) {
          for (let j = 0; j < n; j++) {
            g.fillStyle = (i + j) % 5 === 0 ? '#7fd3c6' : r() < 0.5 ? '#f4f8f8' : '#eaf1f1';
            g.fillRect(i * s, j * s, s, s);
          }
        }
        g.strokeStyle = '#b9c9c9';
        g.lineWidth = 4;
        for (let k = 0; k <= n; k++) {
          g.beginPath();
          g.moveTo(k * s, 0);
          g.lineTo(k * s, h);
          g.moveTo(0, k * s);
          g.lineTo(w, k * s);
          g.stroke();
        }
        break;
      }
      case 'vinyl': {
        // Cuadros de 50 cm gris claro y blanco
        const s = w / 4;
        for (let i = 0; i < 4; i++) {
          for (let j = 0; j < 4; j++) {
            g.fillStyle = (i + j) % 2 ? '#dfe5ec' : '#f3f6f9';
            g.fillRect(i * s, j * s, s, s);
          }
        }
        break;
      }
      case 'concrete': {
        g.fillStyle = '#9ca3ab';
        g.fillRect(0, 0, w, h);
        for (let i = 0; i < 2600; i++) {
          g.fillStyle = `rgba(${r() < 0.5 ? '255,255,255' : '0,0,0'},${0.04 + r() * 0.06})`;
          g.fillRect(r() * w, r() * h, 1 + r() * 3, 1 + r() * 3);
        }
        // Líneas de cinta cada metro (referencia de distancia en la sala de pruebas; la textura mide 2 m)
        g.fillStyle = 'rgba(245,179,1,0.75)';
        for (const k of [0, w / 2]) {
          g.fillRect(0, k, w, 3);
          g.fillRect(k, 0, 3, h);
        }
        break;
      }
    }
  });
}

/** Alfombras: redonda de anillos (casa) y de pasillo con borde */
export function rugTexture(kind: 'round' | 'runner'): THREE.CanvasTexture {
  if (kind === 'round') {
    return canvasTexture(512, 512, (g, w) => {
      const colors = ['#f2a65a', '#f7d774', '#7cc6a4', '#5aa9e6', '#f2a65a', '#fbf3e4'];
      colors.forEach((c, i) => {
        g.fillStyle = c;
        g.beginPath();
        g.arc(w / 2, w / 2, (w / 2) * (1 - i / colors.length), 0, Math.PI * 2);
        g.fill();
      });
    }, false);
  }
  return canvasTexture(256, 256, (g, w, h) => {
    g.fillStyle = '#b8443a';
    g.fillRect(0, 0, w, h);
    g.fillStyle = '#e9c46a';
    g.fillRect(14, 0, 10, h);
    g.fillRect(w - 24, 0, 10, h);
    g.fillStyle = '#7a2b25';
    for (let y = 0; y < h; y += 32) {
      g.beginPath();
      g.moveTo(w / 2, y + 4);
      g.lineTo(w / 2 + 40, y + 16);
      g.lineTo(w / 2, y + 28);
      g.lineTo(w / 2 - 40, y + 16);
      g.closePath();
      g.fill();
    }
  });
}

/** Cielo de día detrás de una ventana: degradado y algunas nubes (redondeadas, propias) */
export function skyTexture(): THREE.CanvasTexture {
  return canvasTexture(512, 512, (g, w, h) => {
    const sky = g.createLinearGradient(0, 0, 0, h);
    sky.addColorStop(0, '#5fb3f0');
    sky.addColorStop(0.75, '#bfe3ff');
    sky.addColorStop(1, '#e8f6ff');
    g.fillStyle = sky;
    g.fillRect(0, 0, w, h);
    const r = rng(3);
    g.fillStyle = 'rgba(255,255,255,0.9)';
    for (let i = 0; i < 5; i++) {
      const [cx, cy, s] = [r() * w, h * (0.15 + r() * 0.5), 30 + r() * 30];
      for (let k = 0; k < 4; k++) {
        g.beginPath();
        g.arc(cx + (k - 1.5) * s * 0.8, cy + (k % 2 ? -s * 0.3 : 0), s * (0.7 + (k % 2) * 0.3), 0, Math.PI * 2);
        g.fill();
      }
    }
  }, false);
}
