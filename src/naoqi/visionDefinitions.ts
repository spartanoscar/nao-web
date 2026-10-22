// Definiciones de visión de NAOqi con sus IDs oficiales (doc family_nao_technical_video_naov6, "Supported
// colorspaces", "Supported Format" y "Camera parameters"): resoluciones, espacios de color y parámetros de
// cámara, más la conversión de la imagen RGBA de la escena a cada espacio de color.

export interface Resolution {
  name: string;
  width: number;
  height: number;
  maxFps: number;
}

/**
 * Resolución → tamaño. Tabla del V6: k16VGA (solo la cámara de arriba, 1–15 fps), k4VGA, kVGA, kQVGA (1–30 fps).
 * APPROX: kQQVGA, kQQQVGA y kQQQQVGA no están en la tabla del V6 pero sí en las definiciones de NAOqi; la doc dice
 * que por debajo de 320x240 la imagen se reduce ("scale down is performed"), así que se aceptan.
 */
export const RESOLUTIONS: Record<number, Resolution> = {
  4: { name: 'k16VGA', width: 2560, height: 1920, maxFps: 15 },
  3: { name: 'k4VGA', width: 1280, height: 960, maxFps: 30 },
  2: { name: 'kVGA', width: 640, height: 480, maxFps: 30 },
  1: { name: 'kQVGA', width: 320, height: 240, maxFps: 30 },
  0: { name: 'kQQVGA', width: 160, height: 120, maxFps: 30 },
  7: { name: 'kQQQVGA', width: 80, height: 60, maxFps: 30 },
  8: { name: 'kQQQQVGA', width: 40, height: 30, maxFps: 30 },
};
export const K16VGA = 4;

/** Espacio de color → capas (bytes por píxel; YUV422 y YYCbCr: 2 bytes por píxel, 4 por cada par) */
export const COLOR_SPACES: Record<number, { name: string; layers: number }> = {
  0: { name: 'kYuvColorSpace', layers: 1 },
  1: { name: 'kyUvColorSpace', layers: 1 },
  2: { name: 'kyuVColorSpace', layers: 1 },
  3: { name: 'kRgbColorSpace', layers: 1 },
  4: { name: 'krGbColorSpace', layers: 1 },
  5: { name: 'krgBColorSpace', layers: 1 },
  6: { name: 'kHsyColorSpace', layers: 1 },
  7: { name: 'khSyColorSpace', layers: 1 },
  8: { name: 'khsYColorSpace', layers: 1 },
  9: { name: 'kYUV422ColorSpace', layers: 2 },
  10: { name: 'kYUVColorSpace', layers: 3 },
  11: { name: 'kRGBColorSpace', layers: 3 },
  12: { name: 'kHSYColorSpace', layers: 3 },
  13: { name: 'kBGRColorSpace', layers: 3 },
  14: { name: 'kYYCbCrColorSpace', layers: 2 },
  15: { name: 'kH2RGBColorSpace', layers: 3 },
  16: { name: 'kHSMixedColorSpace', layers: 3 },
};
/** Formato nativo de la cámara */
export const NATIVE_COLOR_SPACE = 9;

export interface CameraParameter {
  name: string;
  min: number;
  max: number;
  /** null: solo lectura sin valor por defecto (AverageLuminance) */
  default: number | null;
}

/** Parámetros de cámara (ID → rango y defecto), tabla "Hardware parameters" + "Software parameters" */
export const CAMERA_PARAMETERS: Record<number, CameraParameter> = {
  0: { name: 'kCameraBrightnessID', min: -255, max: 255, default: 0 },
  1: { name: 'kCameraContrastID', min: 0, max: 255, default: 32 },
  2: { name: 'kCameraSaturationID', min: 0, max: 255, default: 64 },
  3: { name: 'kCameraHueID', min: -180, max: 180, default: 0 },
  6: { name: 'kCameraGainID', min: 0, max: 1023, default: 16 },
  7: { name: 'kCameraHFlipID', min: 0, max: 1, default: 0 },
  8: { name: 'kCameraVFlipID', min: 0, max: 1, default: 0 },
  11: { name: 'kCameraAutoExpositionID', min: 0, max: 1, default: 1 },
  12: { name: 'kCameraAutoWhiteBalanceID', min: 0, max: 1, default: 1 },
  17: { name: 'kCameraExposureID', min: 0, max: 65535, default: 32 },
  24: { name: 'kCameraSharpnessID', min: 0, max: 9, default: 4 },
  34: { name: 'kCameraBacklightCompensationID', min: 0, max: 1, default: 0 },
  35: { name: 'kCameraKeepAliveID', min: 0, max: 1, default: 0 },
  39: { name: 'kCameraAverageLuminanceID', min: 0, max: 255, default: null },
  40: { name: 'kCameraAutoFocusID', min: 0, max: 1, default: 0 },
  43: { name: 'kCameraFocusID', min: 0, max: 250, default: 0 },
};
export const PARAM = {
  brightness: 0, contrast: 1, saturation: 2, hue: 3, gain: 6, hFlip: 7, vFlip: 8, autoExposition: 11,
  exposure: 17, averageLuminance: 39, autoFocus: 40, focus: 43,
} as const;

const clamp8 = (v: number) => (v < 0 ? 0 : v > 255 ? 255 : Math.round(v));

/**
 * Ajustes de imagen de la cámara sobre RGBA, en el sitio: volteos (exactos) y brillo/contraste/saturación.
 * APPROX: la doc da rangos y defectos, no la curva; contraste y saturación se escalan respecto a su defecto
 * (32 y 64 = sin cambio) y el brillo se suma en niveles de 8 bits. Tono, ganancia, exposición, nitidez y foco
 * se guardan pero no cambian la imagen (la luz y el enfoque son los de la escena).
 */
export function adjustImage(rgba: Uint8Array, width: number, height: number, p: (id: number) => number): void {
  const brightness = p(PARAM.brightness);
  const contrast = p(PARAM.contrast) / 32;
  const saturation = p(PARAM.saturation) / 64;
  if (brightness !== 0 || contrast !== 1 || saturation !== 1) {
    for (let i = 0; i < rgba.length; i += 4) {
      const [r, g, b] = [rgba[i], rgba[i + 1], rgba[i + 2]];
      const y = 0.299 * r + 0.587 * g + 0.114 * b;
      for (let c = 0; c < 3; c++) {
        const v = y + (rgba[i + c] - y) * saturation;
        rgba[i + c] = clamp8((v - 128) * contrast + 128 + brightness);
      }
    }
  }
  const h = p(PARAM.hFlip) === 1;
  const v = p(PARAM.vFlip) === 1;
  if (!h && !v) return;
  const src = rgba.slice();
  for (let y = 0; y < height; y++) {
    const sy = v ? height - 1 - y : y;
    for (let x = 0; x < width; x++) {
      const sx = h ? width - 1 - x : x;
      rgba.set(src.subarray((sy * width + sx) * 4, (sy * width + sx) * 4 + 4), (y * width + x) * 4);
    }
  }
}

/**
 * RGBA (8 bits, filas de arriba abajo) → buffer del espacio de color pedido, con el orden de bytes de la doc
 * (la doc escribe los tripletes como entero: kRGBColorSpace "0xBBGGRR" = bytes R, G, B).
 * APPROX: YUV con la matriz BT.601 de rango completo (la doc no la da). YUV422 como Y U Y' V (YUYV), el formato
 * nativo V4L2 del NAO; la notación "0xY'Y'VVYYUU" de la doc es ambigua. HSY: H en 0–255 (vuelta completa),
 * S = croma/máx, Y = luma. H2RGB: el tono en colores falsos (saturación y brillo al máximo).
 */
export function convertImage(rgba: Uint8Array, width: number, height: number, colorSpace: number): Uint8Array {
  const n = width * height;
  const { layers } = COLOR_SPACES[colorSpace];
  const out = new Uint8Array(n * layers);
  const yuv = (i: number): [number, number, number] => {
    const [r, g, b] = [rgba[i * 4], rgba[i * 4 + 1], rgba[i * 4 + 2]];
    return [
      clamp8(0.299 * r + 0.587 * g + 0.114 * b),
      clamp8(128 - 0.168736 * r - 0.331264 * g + 0.5 * b),
      clamp8(128 + 0.5 * r - 0.418688 * g - 0.081312 * b),
    ];
  };
  const hsy = (i: number): [number, number, number] => {
    const [r, g, b] = [rgba[i * 4], rgba[i * 4 + 1], rgba[i * 4 + 2]];
    const max = Math.max(r, g, b);
    const chroma = max - Math.min(r, g, b);
    let hue = 0;
    if (chroma > 0) {
      if (max === r) hue = ((g - b) / chroma + 6) % 6;
      else if (max === g) hue = (b - r) / chroma + 2;
      else hue = (r - g) / chroma + 4;
    }
    return [clamp8((hue / 6) * 255), max === 0 ? 0 : clamp8((chroma / max) * 255), clamp8(0.299 * r + 0.587 * g + 0.114 * b)];
  };
  switch (colorSpace) {
    case 0: case 1: case 2:
      for (let i = 0; i < n; i++) out[i] = yuv(i)[colorSpace];
      break;
    case 3: case 4: case 5:
      for (let i = 0; i < n; i++) out[i] = rgba[i * 4 + colorSpace - 3];
      break;
    case 6: case 7: case 8:
      for (let i = 0; i < n; i++) out[i] = hsy(i)[colorSpace - 6];
      break;
    case 9: case 14:
      // Dos píxeles en 4 bytes; la crominancia es el promedio de ambos (ancho siempre par)
      for (let i = 0; i < n; i += 2) {
        const [y0, u0, v0] = yuv(i);
        const [y1, u1, v1] = yuv(i + 1);
        const [u, v] = [(u0 + u1) >> 1, (v0 + v1) >> 1];
        out.set(colorSpace === 9 ? [y0, u, y1, v] : [y0, y1, u, v], i * 2);
      }
      break;
    case 10: case 12:
      for (let i = 0; i < n; i++) out.set(colorSpace === 10 ? yuv(i) : hsy(i), i * 3);
      break;
    case 11: case 13:
      for (let i = 0; i < n; i++) {
        const [r, g, b] = [rgba[i * 4], rgba[i * 4 + 1], rgba[i * 4 + 2]];
        out.set(colorSpace === 11 ? [r, g, b] : [b, g, r], i * 3);
      }
      break;
    case 15:
      for (let i = 0; i < n; i++) {
        const h = (hsy(i)[0] / 255) * 6;
        const x = 255 * (1 - Math.abs((h % 2) - 1));
        const rgb = h < 1 ? [255, x, 0] : h < 2 ? [x, 255, 0] : h < 3 ? [0, 255, x] : h < 4 ? [0, x, 255] : h < 5 ? [x, 0, 255] : [255, 0, x];
        out.set(rgb.map(clamp8), i * 3);
      }
      break;
    case 16:
      for (let i = 0; i < n; i++) {
        const [h, s] = hsy(i);
        out.set([h, s, (h + s) >> 1], i * 3);
      }
      break;
  }
  return out;
}

/** Luma media (0–255) de una imagen RGBA: el parámetro de solo lectura kCameraAverageLuminanceID */
export function averageLuminance(rgba: Uint8Array): number {
  let sum = 0;
  const n = rgba.length / 4;
  for (let i = 0; i < rgba.length; i += 4) sum += 0.299 * rgba[i] + 0.587 * rgba[i + 1] + 0.114 * rgba[i + 2];
  return n ? Math.round(sum / n) : 0;
}
