// Íconos del HUD en SVG en línea (trazo de 2 px, 24×24, color = currentColor). Sin fuentes de íconos externas:
// el aislamiento COOP/COEP bloquearía recursos de otros dominios sin CORS.

const svg = (body: string) =>
  `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;

export const ICONS = {
  volume: svg('<path d="M11 5 6 9H3v6h3l5 4z"/><path d="M15.5 8.5a5 5 0 0 1 0 7"/><path d="M18.5 5.5a9 9 0 0 1 0 13"/>'),
  volumeLow: svg('<path d="M11 5 6 9H3v6h3l5 4z"/><path d="M15.5 8.5a5 5 0 0 1 0 7"/>'),
  mute: svg('<path d="M11 5 6 9H3v6h3l5 4z"/><path d="m16 9 5 6"/><path d="m21 9-5 6"/>'),
  phone: svg('<rect x="7" y="2.5" width="10" height="19" rx="2.5"/><path d="M11 18.5h2"/>'),
  qr: svg('<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><path d="M14 14h3v3h-3zM20 14v.01M14 20h.01M17 20h4v-3"/>'),
  logout: svg('<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><path d="m16 17 5-5-5-5"/><path d="M21 12H9"/>'),
  robot: svg('<rect x="5" y="7" width="14" height="11" rx="4"/><path d="M12 7V4"/><circle cx="12" cy="3" r="1"/><path d="M9.5 12.5h.01M14.5 12.5h.01"/>'),
  close: svg('<path d="M6 6l12 12M18 6 6 18"/>'),
  mic: svg('<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/>'),
  check: svg('<path d="m5 12 5 5 9-10"/>'),
  move: svg('<path d="m5 9-3 3 3 3M9 5l3-3 3 3M15 19l-3 3-3-3M19 9l3 3-3 3M2 12h20M12 2v20"/>'),
  pause: svg('<rect x="6" y="4" width="4" height="16" rx="1"/><rect x="14" y="4" width="4" height="16" rx="1"/>'),
  token: svg('<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5.5"/><path d="M12 9.5v5"/>'),
  flip: svg('<path d="M4 7h11a5 5 0 0 1 0 10H9"/><path d="m7 4-3 3 3 3"/><path d="M8 20h.01"/>'),
  settings: svg('<path d="M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>'),
  camera: svg('<path d="M4 8h3l2-3h6l2 3h3a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V9a1 1 0 0 1 1-1z"/><circle cx="12" cy="13" r="3.5"/>'),
  upload: svg('<path d="M12 16V4M7 9l5-5 5 5"/><path d="M4 16v3a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-3"/>'),
  trash: svg('<path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13"/>'),
  download: svg('<path d="M12 4v12M7 11l5 5 5-5"/><path d="M4 20h16"/>'),
  library: svg('<path d="M4 4h4v16H4zM10 4h4v16h-4z"/><path d="m16 5 3.5-1 2.5 15.5-3.5 1z"/>'),
  center: svg('<circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="2"/><path d="M12 1v4M12 19v4M1 12h4M19 12h4"/>'),
  chat: svg('<path d="M4 5h16v11H9l-5 4z"/><path d="M8 9.5h8M8 12.5h5"/>'),
  power: svg('<path d="M12 3v8"/><path d="M6.3 6.8a8 8 0 1 0 11.4 0"/>'),
  /** Posturas: una figura de pie */
  posture: svg('<circle cx="12" cy="4.5" r="2"/><path d="M12 7.5v7M7.5 10.5 12 9l4.5 1.5M9 21l3-6.5 3 6.5"/>'),
  /** Animaciones: una figura saludando */
  animation: svg('<circle cx="11" cy="4.5" r="2"/><path d="M11 7.5 10 14l3 2-1 5M10 14l-3.5 2.5M11 9l5-3.5 1.5-2.5"/>'),
  send: svg('<path d="M4 12 20 4l-6 16-3-7z"/><path d="m11 13 9-9"/>'),
};

/** Íconos de archivo de la biblioteca (a color, 40×48): PDF rojo, Excel verde, documento azul, imagen morada */
const fileIcon = (color: string, mark: string) =>
  `<svg viewBox="0 0 40 48" width="40" height="48" aria-hidden="true"><path d="M6 2h20l10 10v32a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2z" fill="${color}"/><path d="M26 2v8a2 2 0 0 0 2 2h8" fill="rgba(255,255,255,.35)"/>${mark}</svg>`;

export const FILE_ICONS = {
  pdf: fileIcon('#e5484d', '<text x="20" y="35" text-anchor="middle" font-size="10" font-weight="800" fill="#fff" font-family="system-ui,sans-serif">PDF</text>'),
  excel: fileIcon('#1f9d55', '<path d="M11 22h18v16H11zM11 30h18M20 22v16" fill="none" stroke="#fff" stroke-width="2"/>'),
  word: fileIcon('#3a7bff', '<path d="M11 24h18M11 30h18M11 36h12" stroke="#fff" stroke-width="2.4" stroke-linecap="round"/>'),
  text: fileIcon('#5b6b85', '<path d="M11 24h18M11 30h18M11 36h12" stroke="#fff" stroke-width="2.4" stroke-linecap="round"/>'),
  image: fileIcon('#8b5cf6', '<circle cx="15" cy="27" r="3" fill="#fff"/><path d="m10 39 7-8 5 5 4-4 5 7z" fill="#fff"/>'),
};
