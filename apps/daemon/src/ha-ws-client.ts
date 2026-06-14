/**
 * HA WebSocket client.
 *
 * HA 2024+ 持续把 dashboard 操作迁到 WebSocket；2026.6.0 已删除
 * REST /api/lovelace/* 端点。Dashboard 读写、列仪表板必须走这里。
 *
 * 单例 + 自动重连 + 命令排队：
 *   - 第一次 request() 触发 connect()
 *   - 收到 auth_required → 发 {type: auth, access_token}
 *   - 收到 auth_ok → 标记 ready，后续 request 直接发
 *   - 断线 → pending 全部 reject，下次 request 重新连接
 */

import { WebSocket } from 'ws';
import { EventEmitter } from 'node:events';
import { loadHaConfig } from './ha-client.js';
import { logger } from './logger.js';

interface WsRequest {
  id: number;
  type: string;
  [k: string]: unknown;
}

interface WsResult {
  id: number;
  type: 'result';
  success: boolean;
  result?: unknown;
  error?: { code: string; message: string };
}

interface WsMessage {
  id?: number;
  type: string;
  [k: string]: unknown;
}

interface PendingCall {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  intent: string;
}

class HaWsClient extends EventEmitter {
  private ws: WebSocket | null = null;
  private ready = false;
  private nextId = 1;
  private pending = new Map<number, PendingCall>();
  private connectingPromise: Promise<void> | null = null;
  /** Optional one-shot resolver for the auth_ok message. */
  private authResolver: (() => void) | null = null;

  private wsUrl(): string {
    const cfg = loadHaConfig();
    const u = new URL(cfg.baseUrl);
    const protocol = u.protocol === 'https:' ? 'wss:' : 'ws:';
    // Include u.pathname so any reverse-proxy path prefix on baseUrl is
    // preserved. Example: baseUrl "http://reverse-proxy.example/ha" with
    // pathname "/ha" → ws://reverse-proxy.example/ha/api/websocket. Dropping
    // the path would 404 the WebSocket upgrade.
    return `${protocol}//${u.host}${u.pathname}/api/websocket`;
  }

  private async connect(): Promise<void> {
    if (this.ready) return;
    if (this.connectingPromise) return this.connectingPromise;

    this.connectingPromise = new Promise<void>((resolve, reject) => {
      const url = this.wsUrl();
      // Don't log the URL with token (the URL itself has no token, but be safe).
      logger.info({ url }, 'HA WS connecting');

      this.authResolver = resolve;

      try {
        this.ws = new WebSocket(url);
      } catch (e) {
        this.connectingPromise = null;
        this.authResolver = null;
        reject(e instanceof Error ? e : new Error(String(e)));
        return;
      }

      this.ws.on('open', () => {
        logger.debug('HA WS socket open — waiting for auth_required');
      });

      this.ws.on('message', (data) => {
        let msg: WsMessage;
        try {
          msg = JSON.parse(data.toString()) as WsMessage;
        } catch (e) {
          logger.warn({ err: (e as Error).message }, 'HA WS invalid JSON message');
          return;
        }
        this.handleMessage(msg);
      });

      this.ws.on('close', (code, reason) => {
        const reasonStr = reason.toString();
        logger.warn({ code, reason: reasonStr }, 'HA WS closed');
        const wasReady = this.ready;
        this.ready = false;
        this.ws = null;
        this.connectingPromise = null;
        this.authResolver = null;
        // Reject any in-flight calls
        for (const [id, p] of this.pending) {
          p.reject(new Error(`HA WS disconnected before id=${id} (${p.intent})`));
        }
        this.pending.clear();
        if (wasReady) {
          this.emit('disconnected', { code, reason: reasonStr });
        }
      });

      this.ws.on('error', (err) => {
        logger.error({ err: err.message }, 'HA WS socket error');
        this.connectingPromise = null;
        if (this.authResolver) {
          this.authResolver = null;
          reject(err);
        }
        // The 'close' event will fire next and clean up.
      });
    });

    try {
      await this.connectingPromise;
    } finally {
      this.connectingPromise = null;
    }
  }

  private handleMessage(msg: WsMessage): void {
    switch (msg.type) {
      case 'auth_required': {
        const cfg = loadHaConfig();
        this.ws?.send(JSON.stringify({ type: 'auth', access_token: cfg.token }));
        return;
      }
      case 'auth_ok': {
        this.ready = true;
        logger.info('HA WS auth ok');
        const r = this.authResolver;
        this.authResolver = null;
        r?.();
        return;
      }
      case 'auth_invalid': {
        logger.error({ msg }, 'HA WS auth_invalid — token rejected');
        this.ws?.close();
        const r = this.authResolver;
        this.authResolver = null;
        r?.(); // resolve the connect promise so we don't hang; the close will reject in-flight
        return;
      }
      case 'result': {
        const id = msg.id;
        if (typeof id !== 'number') return;
        const p = this.pending.get(id);
        if (!p) {
          logger.debug({ id }, 'HA WS result for unknown id (already resolved?)');
          return;
        }
        this.pending.delete(id);
        const r = msg as unknown as WsResult;
        if (r.success) {
          p.resolve(r.result);
        } else {
          const errMsg = r.error?.message ?? 'unknown error';
          const errCode = r.error?.code ?? 'unknown';
          p.reject(new Error(`HA WS ${p.intent} → ${errCode}: ${errMsg}`));
        }
        return;
      }
      case 'event': {
        this.emit('event', msg);
        return;
      }
      default:
        // Other message types we don't handle — log at debug.
        logger.debug({ msg }, 'HA WS unhandled message type');
    }
  }

  /**
   * Send a command and wait for the matching result.
   * @param type  the HA command type, e.g. "lovelace/config"
   * @param args  additional fields merged into the request payload
   * @param intent short label used for logging / error messages
   */
  async request<T = unknown>(
    type: string,
    args: Record<string, unknown> = {},
    intent: string = type,
  ): Promise<T> {
    await this.connect();
    if (!this.ready || !this.ws) {
      throw new Error(`HA WS not ready (intent=${intent})`);
    }
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, {
        resolve: (v) => resolve(v as T),
        reject,
        intent,
      });
      const req: WsRequest = { id, type, ...args };
      try {
        this.ws!.send(JSON.stringify(req));
      } catch (e) {
        this.pending.delete(id);
        reject(e instanceof Error ? e : new Error(String(e)));
      }
    });
  }
}

/** Process-wide singleton. */
export const haWs = new HaWsClient();

/** Convenience: send a command and unwrap the result. */
export async function haWsRequest<T = unknown>(
  type: string,
  args: Record<string, unknown> = {},
  intent?: string,
): Promise<T> {
  return haWs.request<T>(type, args, intent);
}
