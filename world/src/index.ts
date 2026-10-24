// Sala del mundo compartido de NAO Web (docs/PLAN.md F16): un Durable Object de Cloudflare que solo reenvía. Cada
// navegador simula la física de su NAO y manda su estado; la sala lo pasa a los demás. Vive cerca del primero que
// entra (Miami para Colombia: ~40–90 ms entre personas, contra ~200 ms hasta el servidor en Francia) y usa la API de
// hibernación de WebSocket: sin mensajes no se cobra duración, y los "ping" los contesta Cloudflare sin despertarla.
//
// Entrada: GET /world?pass=<pase de nao-api> (server/world.go: HMAC-SHA256 con WORLD_SECRET, dura unos minutos). La sala
// no tiene base de datos ni sabe de usuarios: confía en la cápsula que trae el pase.
//
// Protocolo (el mismo del plan B en server/world.go):
//   cliente → sala: binario = estado del NAO (byte 0 = 1, byte 1 = cápsula: la sala pone la del pase)
//                   texto {t:'hi', robot, shell, eyes} (apariencia; al entrar y al cambiar) · {t:'say', text, voice}
//                   (lo que dice el NAO) · "ping"
//   sala → cliente: el binario de los demás · {t:'peers', pods} al entrar · {t:'join', pod} · {t:'leave', pod} ·
//                   {t:'hi', pod, …} · {t:'say', pod, text, voice} · "pong"

import { DurableObject } from 'cloudflare:workers';

interface Env {
  WORLD: DurableObjectNamespace<WorldRoom>;
  WORLD_SECRET: string;
  ALLOWED_ORIGINS: string;
}

interface Attachment {
  pod: number;
  /** Último {t:'hi'} (con su cápsula), para quien entre después */
  hi: string | null;
}

const MAX_STATE = 512;
const MAX_TEXT = 1024;
/** Cubeta de mensajes por conexión (el cliente manda ~15 estados/s) */
const PER_SECOND = 40;
const BURST = 80;

const b64url = (s: string) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));

/** Verifica el pase de nao-api → la cápsula, o null */
async function verifyPass(pass: string, secret: string): Promise<number | null> {
  const [body64, sig64] = pass.split('.');
  if (!body64 || !sig64 || !secret) return null;
  try {
    const body = b64url(body64);
    const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
    if (!(await crypto.subtle.verify('HMAC', key, b64url(sig64), body))) return null;
    const p = JSON.parse(new TextDecoder().decode(body)) as { p?: unknown; x?: unknown };
    if (typeof p.p !== 'number' || p.p < 0 || p.p > 255 || typeof p.x !== 'number' || Date.now() / 1000 > p.x) return null;
    return p.p;
  } catch {
    return null;
  }
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname !== '/world') return new Response('not found', { status: 404 });
    if (req.headers.get('Upgrade') !== 'websocket') return new Response('websocket', { status: 426 });
    // Solo nuestras páginas (como NAO_ALLOWED_ORIGINS en nao-api)
    let host = '';
    try {
      host = new URL(req.headers.get('Origin') ?? '').hostname;
    } catch {
      /* sin Origin */
    }
    if (!env.ALLOWED_ORIGINS.split(',').map((h) => h.trim()).includes(host)) return new Response('origin', { status: 403 });
    const pod = await verifyPass(url.searchParams.get('pass') ?? '', env.WORLD_SECRET);
    if (pod === null) return new Response('pase inválido', { status: 401 });
    // Una sola sala por ahora: el mundo 1
    const headers = new Headers(req.headers);
    headers.set('X-Pod', String(pod));
    return env.WORLD.getByName('mundo1').fetch(new Request(req, { headers }));
  },
} satisfies ExportedHandler<Env>;

export class WorldRoom extends DurableObject<Env> {
  /** Cubeta por conexión (en memoria: si la sala hiberna empieza llena, no importa) */
  private readonly buckets = new WeakMap<WebSocket, { tokens: number; at: number }>();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
  }

  async fetch(req: Request): Promise<Response> {
    const pod = Number(req.headers.get('X-Pod'));
    const [client, server] = Object.values(new WebSocketPair());
    // La misma persona desde otra pestaña: la nueva se queda con la cápsula
    for (const old of this.ctx.getWebSockets(String(pod))) old.close(4000, 'replaced');
    const others = this.ctx.getWebSockets().filter((ws) => this.pod(ws) !== pod);
    this.ctx.acceptWebSocket(server, [String(pod)]);
    server.serializeAttachment({ pod, hi: null } satisfies Attachment);
    server.send(JSON.stringify({ t: 'peers', pods: others.map((ws) => this.pod(ws)) }));
    for (const ws of others) {
      const { hi } = ws.deserializeAttachment() as Attachment;
      if (hi) server.send(hi);
      ws.send(JSON.stringify({ t: 'join', pod }));
    }
    return new Response(null, { status: 101, webSocket: client });
  }

  webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): void {
    if (!this.allow(ws)) return;
    const pod = this.pod(ws);
    if (message instanceof ArrayBuffer) {
      const bytes = new Uint8Array(message);
      if (bytes.length < 2 || bytes.length > MAX_STATE || bytes[0] !== 1) return;
      bytes[1] = pod;
      this.broadcast(pod, message);
      return;
    }
    if (message.length > MAX_TEXT) return;
    let m: Record<string, unknown>;
    try {
      m = JSON.parse(message);
    } catch {
      return;
    }
    // Lo que dice un NAO: se reenvía (no se guarda)
    if (m.t === 'say' && typeof m.text === 'string') {
      this.broadcast(pod, JSON.stringify({ t: 'say', pod, text: m.text.slice(0, 500), voice: m.voice }));
      return;
    }
    if (m.t !== 'hi') return;
    const hi = JSON.stringify({ ...m, pod });
    ws.serializeAttachment({ pod, hi } satisfies Attachment);
    this.broadcast(pod, hi);
  }

  webSocketClose(ws: WebSocket, code: number, reason: string): void {
    this.leave(ws);
    try {
      ws.close(code === 1005 ? 1000 : code, reason);
    } catch {
      /* ya cerrado */
    }
  }

  webSocketError(ws: WebSocket): void {
    this.leave(ws);
  }

  private leave(ws: WebSocket): void {
    const pod = this.pod(ws);
    // Reemplazada por otra pestaña de la misma persona: no avisar que se fue
    if (this.ctx.getWebSockets(String(pod)).some((o) => o !== ws && o.readyState === WebSocket.OPEN)) return;
    this.broadcast(pod, JSON.stringify({ t: 'leave', pod }), ws);
  }

  private pod(ws: WebSocket): number {
    return (ws.deserializeAttachment() as Attachment).pod;
  }

  private broadcast(from: number, data: string | ArrayBuffer, skip?: WebSocket): void {
    for (const ws of this.ctx.getWebSockets()) {
      if (ws === skip || this.pod(ws) === from) continue;
      try {
        ws.send(data);
      } catch {
        /* se está cerrando */
      }
    }
  }

  private allow(ws: WebSocket): boolean {
    const now = Date.now() / 1000;
    const b = this.buckets.get(ws) ?? { tokens: BURST, at: now };
    b.tokens = Math.min(BURST, b.tokens + (now - b.at) * PER_SECOND);
    b.at = now;
    this.buckets.set(ws, b);
    if (b.tokens < 1) return false;
    b.tokens--;
    return true;
  }
}
