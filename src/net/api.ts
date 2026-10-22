// Cliente de nao-api (server/): login, sesión y salas del teléfono. Mismo origen (/api), cookie HttpOnly.

export interface User {
  username: string;
  displayName: string;
  role: 'admin' | 'teacher' | 'student';
  robotName: string;
  dailyLimitUsd: number;
  spentTodayUsd: number;
  /** Instrucciones propias para su NAO (se suman al prompt base cuando llegue la IA) */
  prompt: string;
  /** URL de la foto de perfil, o "" si no tiene */
  avatarUrl: string;
  /** Apariencia de su NAO: "#rrggbb" o "" (la original de fábrica) */
  shellColor: string;
  eyeColor: string;
}

/** Cambios del modal de ajustes: solo los campos que cambiaron. avatar: data URL JPEG o "" para quitarla */
export interface UserPatch {
  displayName?: string;
  robotName?: string;
  prompt?: string;
  avatar?: string;
  shellColor?: string;
  eyeColor?: string;
}

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    credentials: 'same-origin',
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, (data as { error?: string }).error ?? `error ${res.status}`);
  return data as T;
}

export class ApiError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

/** Usuario de la sesión actual, o null si no hay sesión */
export async function me(): Promise<User | null> {
  try {
    return await call<User>('GET', '/api/me');
  } catch (e) {
    if (e instanceof ApiError && e.status === 401) return null;
    throw e;
  }
}

export const login = (username: string, password: string) => call<User>('POST', '/api/auth/login', { username, password });
export const logout = () => call<{ ok: boolean }>('POST', '/api/auth/logout');
export const updateMe = (patch: UserPatch) => call<User>('PATCH', '/api/me', patch);
/** Archivo de la biblioteca. status: pending/processing = guardando, ready = guardado, error = no se pudo */
export interface LibraryDoc {
  id: number;
  title: string;
  kind: 'image' | 'pdf' | 'excel' | 'word' | 'text';
  mime: string;
  size: number;
  status: 'pending' | 'processing' | 'ready' | 'error';
  error?: string;
  hasThumb: boolean;
  createdAt: string;
}

export const listDocuments = () => call<LibraryDoc[]>('GET', '/api/documents');
export const deleteDocument = (id: number) => call<{ ok: boolean }>('DELETE', `/api/documents/${id}`);
export const documentUrl = (id: number, download = false) => `/api/documents/${id}/file${download ? '?download=1' : ''}`;
export const thumbUrl = (id: number) => `/api/documents/${id}/thumb`;

export async function uploadDocument(file: File, thumb?: Blob): Promise<LibraryDoc> {
  const form = new FormData();
  form.append('file', file);
  if (thumb) form.append('thumb', thumb, 'thumb.jpg');
  const res = await fetch('/api/documents', { method: 'POST', body: form, credentials: 'same-origin' });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, (data as { error?: string }).error ?? `error ${res.status}`);
  return data as LibraryDoc;
}

/** Sala nueva para el teléfono (cierra la anterior del mismo usuario) */
export const createRoom = () => call<{ room: string }>('POST', '/api/rooms');

export function wsUrl(room: string, role: 'screen' | 'phone'): string {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  return `${proto}://${location.host}/api/ws?room=${encodeURIComponent(room)}&role=${role}`;
}
