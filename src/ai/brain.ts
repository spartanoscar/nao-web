// Cerebro del NAO en el navegador: lleva cada frase al servidor (POST /api/brain → Gemini), dice lo que responde
// y ejecuta las habilidades que pide, devolviendo sus resultados hasta que el turno termina. La clave de Gemini
// nunca sale del servidor.
//
// Ahorro: con voz solo responde si lo llaman por su nombre (o "NAO") o si la conversación sigue abierta (hasta
// CONVERSATION_WINDOW después de su última respuesta); lo escrito en el chat siempre le llega. Sin conversación no
// se manda nada: capturar imágenes es local y gratis, enviarlas es lo que cuesta.

import { ApiError } from '../net/api';
import type { Session } from '../naoqi/session';
import { robotPose } from '../naoqi/moveTo';
import type { RobotState } from '../robot/state';
import { runSkill } from './skills';
import type { Snapshot, Vision } from './vision';

const CONVERSATION_WINDOW = 20_000;
const DEG = 180 / Math.PI;

interface BrainCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

interface BrainReply {
  turn: string;
  say: string;
  calls: BrainCall[] | null;
  done: boolean;
  spentTodayUsd: number;
}

export interface BrainHooks {
  /** Nombre actual del robot (cambia en Ajustes) */
  robotName(): string;
  thinking(on: boolean): void;
  spent(usd: number): void;
  error(message: string): void;
  /** Para depurar: cada habilidad que ejecuta y su resultado */
  action?(name: string, args: Record<string, unknown>, response: Record<string, unknown>): void;
}

/** Sin tildes y en minúsculas, para buscar el nombre del robot en lo que se dijo */
const plain = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

export class Brain {
  private run = 0;
  private lastReply = 0;
  private speech: Promise<void> = Promise.resolve();
  /** Quieto desde (ms): para "quieto_seg" en el estado (si lleva mucho, se puede aburrir) */
  private stillSince = performance.now();
  private lastPose = '';

  constructor(
    private readonly session: Session,
    private readonly state: RobotState,
    private readonly vision: Vision,
    private readonly hooks: BrainHooks,
  ) {
    setInterval(() => this.trackStillness(), 1000);
  }

  /** ¿Esta frase dicha en voz alta va para el NAO? */
  addressed(text: string): boolean {
    if (performance.now() - this.lastReply < CONVERSATION_WINDOW) return true;
    const t = plain(text);
    return [plain(this.hooks.robotName()), 'nao'].some((n) => n && new RegExp(`\\b${n}\\b`).test(t));
  }

  /** Lo que la persona dijo (voz) o escribió (texto). Cancela el turno anterior si seguía. */
  async ask(text: string, source: 'voz' | 'texto'): Promise<void> {
    const run = ++this.run;
    const cancelled = () => run !== this.run;
    const motion = this.session.service('ALMotion');
    if (motion.moveIsActive()) void motion.stopMove();
    const pose = robotPose(this.state);
    const origin = pose && { x: round(pose.x), y: round(pose.y), rumbo_grados: Math.round(pose.theta * DEG) };
    this.hooks.thinking(true);
    try {
      let reply = await this.post({ text, source, state: this.snapshotState(origin), image: this.vision.view().jpeg });
      while (!cancelled()) {
        this.hooks.spent(reply.spentTodayUsd);
        if (reply.say) this.say(reply.say);
        if (reply.done || !reply.calls?.length) break;
        this.hooks.thinking(false);
        const results = [];
        let image: Snapshot | undefined;
        for (const call of reply.calls) {
          if (cancelled()) return;
          const r = await runSkill(call.name, call.args ?? {}, { session: this.session, vision: this.vision, cancelled }).catch(
            (e: unknown) => ({ response: { ok: false, error: e instanceof Error ? e.message : String(e) } as Record<string, unknown>, image: undefined }),
          );
          this.hooks.action?.(call.name, call.args ?? {}, r.response);
          results.push({ id: call.id, name: call.name, response: r.response });
          if (r.image) image = r.image;
        }
        if (cancelled()) return;
        this.hooks.thinking(true);
        reply = await this.post({ turn: reply.turn, results, state: this.snapshotState(origin), image: image?.jpeg });
      }
    } catch (e) {
      if (!cancelled()) this.hooks.error(e instanceof ApiError ? e.message : 'No hay conexión con el servidor');
    } finally {
      if (!cancelled()) {
        this.hooks.thinking(false);
        this.lastReply = performance.now();
      }
    }
  }

  /** Las frases se dicen en orden, sin cortarse entre sí; el movimiento sigue mientras habla */
  private say(text: string): void {
    const tts = this.session.service('ALTextToSpeech');
    this.speech = this.speech
      .then(() => tts.say(text))
      .catch((e) => console.warn('Voz:', e))
      .then(() => {
        this.lastReply = performance.now();
      });
  }

  private async post(body: Record<string, unknown>): Promise<BrainReply> {
    const res = await fetch('/api/brain', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new ApiError(res.status, (data as { error?: string }).error ?? `error ${res.status}`);
    return data as BrainReply;
  }

  /** Lo que el NAO sabe de sí mismo en cada mensaje (pocas decenas de tokens, nunca los 25 motores) */
  private snapshotState(origin: Record<string, number> | null): Record<string, unknown> {
    const motion = this.session.service('ALMotion');
    const posture = this.session.service('ALRobotPosture');
    const pose = robotPose(this.state);
    const [yaw, pitch] = motion.getAngles(['HeadYaw', 'HeadPitch'], true);
    return {
      postura: `${posture.getPostureFamily()} (${posture.getPosture()})`,
      motores: motion.robotIsWakeUp() ? 'encendidos' : 'apagados (en reposo)',
      caminando: motion.moveIsActive(),
      ...(pose ? { posicion: { x: round(pose.x), y: round(pose.y) }, rumbo_grados: Math.round(pose.theta * DEG) } : {}),
      cabeza: { yaw: Math.round(yaw * DEG), pitch: Math.round(pitch * DEG) },
      quieto_seg: Math.round((performance.now() - this.stillSince) / 1000),
      ...(origin ? { origen: origin } : {}),
    };
  }

  private trackStillness(): void {
    const pose = robotPose(this.state);
    const [yaw, pitch] = this.session.service('ALMotion').getAngles(['HeadYaw', 'HeadPitch'], true);
    const key = [pose?.x ?? 0, pose?.y ?? 0, pose?.theta ?? 0, yaw, pitch].map((v) => v.toFixed(2)).join();
    if (key !== this.lastPose || this.session.engine.busy) this.stillSince = performance.now();
    this.lastPose = key;
  }
}

const round = (v: number) => Math.round(v * 100) / 100;
