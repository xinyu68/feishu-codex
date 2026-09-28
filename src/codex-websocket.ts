import WebSocket from 'ws';

export type RpcParams = Record<string, unknown>;
export type RpcMessage = { id?: string | number; method?: string; params?: RpcParams; result?: unknown; error?: { message?: string; code?: number } };
export const IGNORE_SERVER_REQUEST = Symbol('ignore-unowned-server-request');
export class CodexRpcError extends Error {
  constructor(message: string, readonly code?: number) { super(message); }
}
export interface CodexConnection {
  readonly shared: boolean;
  readonly exited: Promise<void>;
  readonly isClosed: boolean;
  initialized: RpcParams;
  onNotification?: (method: string, params: RpcParams) => void;
  onFailure?: (error: Error) => void;
  onRequest?: (method: string, params: RpcParams) => Promise<unknown>;
  initialize(): Promise<void>;
  request(method: string, params: RpcParams, timeoutMs?: number): Promise<unknown>;
  close(): Promise<void>;
}

export function validateCodexWebsocketUrl(value: string): string {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error('Codex 连接地址必须是 ws://127.0.0.1:端口'); }
  const port = Number(url.port);
  if (url.protocol !== 'ws:' || url.hostname !== '127.0.0.1' || !Number.isInteger(port) || port < 1024 || port > 65535 || url.pathname !== '/' || url.username || url.password || url.search || url.hash) {
    throw new Error('Codex 连接地址只允许 ws://127.0.0.1:1024..65535，不允许额外路径、远程地址或凭据');
  }
  return url.toString();
}

/** This transport owns only its socket. It never starts, stops or replaces the shared server. */
export class WebsocketCodexConnection implements CodexConnection {
  readonly shared = true;
  readonly exited: Promise<void>;
  initialized: RpcParams = {};
  onNotification?: (method: string, params: RpcParams) => void;
  onFailure?: (error: Error) => void;
  onRequest?: (method: string, params: RpcParams) => Promise<unknown>;
  private readonly socket: WebSocket;
  private readonly opened: Promise<void>;
  private closed = false;
  private closing?: Promise<void>;
  private sequence = 0;
  private readonly pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();

  constructor(url: string, private readonly requestTimeoutMs = 45_000) {
    this.socket = new WebSocket(validateCodexWebsocketUrl(url), { handshakeTimeout: requestTimeoutMs, perMessageDeflate: false, maxPayload: 32 * 1024 * 1024 });
    this.opened = new Promise((resolve, reject) => {
      this.socket.once('open', resolve);
      this.socket.once('error', () => reject(new Error('无法连接 Codex 服务，请在 Feishu Codex 中重试连接。')));
      this.socket.once('close', () => reject(new Error('本机 Codex 连接已关闭')));
    });
    void this.opened.catch(() => undefined);
    this.exited = new Promise(resolve => this.socket.once('close', () => {
      this.fail(new Error('本机 Codex 连接已断开。本轮不会自动重发，请检查会话记录后再决定是否重试。'));
      resolve();
    }));
    this.socket.on('error', () => this.fail(new Error('Codex 连接失败，本轮消息不会自动重发；请检查会话记录。')));
    this.socket.on('message', data => {
      let message: RpcMessage;
      try { message = JSON.parse(data.toString()) as RpcMessage; } catch { return; }
      if (!message || typeof message !== 'object') return;
      if (typeof message.method === 'string') {
        if (message.id !== undefined) void this.serverRequest(message);
        else this.onNotification?.(message.method, asRecord(message.params));
        return;
      }
      if (typeof message.id !== 'number') return;
      const pending = this.pending.get(message.id);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pending.delete(message.id);
      if (message.error) pending.reject(new CodexRpcError(message.error.message || '本机 Codex 请求失败', message.error.code));
      else pending.resolve(message.result);
    });
  }

  get isClosed(): boolean { return this.closed; }

  async initialize(): Promise<void> {
    await this.opened;
    this.initialized = asRecord(await this.request('initialize', {
      clientInfo: { name: 'feishu_codex', title: 'Feishu Codex', version: '0.1.0' },
      capabilities: { experimentalApi: true },
    }));
    this.write({ method: 'initialized', params: {} });
  }

  request(method: string, params: RpcParams, timeoutMs = this.requestTimeoutMs): Promise<unknown> {
    if (this.closed) return Promise.reject(new Error('本机 Codex 连接已关闭'));
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`本机 Codex 请求超时：${method}。未自动重发，请检查会话记录。`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try { this.write({ id, method, params }); }
      catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error instanceof Error ? error : new Error(String(error))); }
    });
  }

  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closing = (async () => {
      this.fail(new Error('本机 Codex 客户端连接已关闭'));
      if (this.socket.readyState === WebSocket.CLOSED) return;
      const timer = setTimeout(() => this.socket.terminate(), 1_000);
      try {
        if (this.socket.readyState === WebSocket.CONNECTING) this.socket.terminate();
        else this.socket.close(1000);
        await this.exited;
      } finally { clearTimeout(timer); }
    })();
    return this.closing;
  }

  private write(message: RpcMessage): void {
    if (this.closed || this.socket.readyState !== WebSocket.OPEN) throw new Error('本机 Codex 连接尚未就绪或已经关闭');
    this.socket.send(JSON.stringify(message));
  }

  private fail(error: Error): void {
    if (this.closed) return;
    this.closed = true;
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error); }
    this.pending.clear();
    this.onFailure?.(error);
  }

  private async serverRequest(message: RpcMessage): Promise<void> {
    try {
      // Unrelated requests can be broadcast to other subscribed clients. Do not approve,
      // decline or send errors for them; only the run that owns the turn may answer.
      const result = message.method === 'currentTime/read' ? { currentTimeAt: Math.floor(Date.now() / 1_000) }
        : this.onRequest ? await this.onRequest(message.method!, asRecord(message.params)) : IGNORE_SERVER_REQUEST;
      if (!this.closed && result !== IGNORE_SERVER_REQUEST) this.write({ id: message.id, result });
    } catch (error) {
      if (!this.closed && this.socket.readyState === WebSocket.OPEN) this.write({ id: message.id, error: { code: -32603, message: error instanceof Error ? error.message : String(error) } });
    }
  }
}

function asRecord(value: unknown): RpcParams { return value && typeof value === 'object' && !Array.isArray(value) ? value as RpcParams : {}; }
