import { createHash, randomBytes } from 'node:crypto';
import { validateGroupConsultRequest, type GroupConsultRequest, type GroupConsultResult } from './group-consult-request.js';

export class GroupConsultError extends Error {
  constructor(message: string, readonly status = 409) { super(message); }
}

type PreparedConsultation = {
  botId: string; target: string; valid: () => boolean;
  run: (signal: AbortSignal, answerReady: (text: string) => void) => Promise<{ text: string; groupReply?: GroupConsultResult['groupReply'] }>;
};
export type PreviousGroupConsultation = { botId: string; question: string; answer: string };
type Scope = {
  botId: string; valid: () => boolean;
  turnKey?: () => string;
  prepare: (request: GroupConsultRequest, previous: readonly PreviousGroupConsultation[]) => PreparedConsultation;
  previous: PreviousGroupConsultation[];
  calls: Map<string, { result: Promise<GroupConsultResult>; target: PreparedConsultation }>; disposed: boolean;
  key?: string;
};
type Pending = { scope: Scope; target: PreparedConsultation; controller: AbortController; task?: Promise<unknown> };

/** Capabilities live only as long as the accepted source operation, never in saved configuration. */
export class GroupConsultations {
  private port = 8790;
  private scopes = new Map<string, Scope>();
  private pending = new Set<Pending>();
  private budgets = new Map<string, number>();
  constructor(private readonly timeoutMs = 45_000, private readonly publicationTimeoutMs = 8_000) {}

  setPort(port: number): void {
    if (!Number.isSafeInteger(port) || port < 1 || port > 65535 || this.scopes.size) throw new Error('Invalid consultation listener change');
    this.port = port;
  }
  issue(input: Pick<Scope, 'botId' | 'valid' | 'prepare' | 'turnKey'>): { token: string; dispose: () => void } {
    if (this.scopes.size >= 256) throw new GroupConsultError('当前群聊任务较多，咨询暂不可用。', 429);
    const token = `fc1.${this.port}.${randomBytes(32).toString('hex')}`;
    const scope: Scope = { ...input, previous: [], calls: new Map(), disposed: false };
    this.scopes.set(token, scope);
    return { token, dispose: () => {
      scope.disposed = true; this.scopes.delete(token);
      for (const pending of this.pending) if (pending.scope === scope) pending.controller.abort(new GroupConsultError('发起任务已结束或停止，咨询已取消。'));
    } };
  }
  hasActiveWork(): boolean { return this.pending.size > 0; }
  hasBotWork(botId: string): boolean {
    return [...this.pending].some(item => item.scope.botId === botId || item.target.botId === botId);
  }
  cancelInvalid(): void {
    for (const item of this.pending) if (item.scope.disposed || !item.scope.valid() || !item.target.valid()) {
      item.controller.abort(new GroupConsultError('群聊授权、任务或角色配置已变化，咨询已取消。'));
    }
  }
  async execute(value: unknown, signal?: AbortSignal): Promise<GroupConsultResult> {
    let request: GroupConsultRequest;
    try { request = validateGroupConsultRequest(value); }
    catch { throw new GroupConsultError('咨询参数无效，请使用当前群轮提供的咨询凭据和准确角色名。', 400); }
    const scope = this.scopes.get(request.context_token);
    if (!scope || scope.disposed || !scope.valid()) throw new GroupConsultError('当前没有可用的群聊咨询上下文；请勿复用旧轮次或其他会话的凭据。', 403);
    if (signal?.aborted) throw new GroupConsultError('咨询请求已取消。');
    const fingerprint = createHash('sha256').update(JSON.stringify([request.target, request.question, request.context ?? ''])).digest('hex');
    const existing = scope.calls.get(fingerprint);
    if (existing) {
      if (!existing.target.valid()) throw new GroupConsultError('目标角色授权或上下文已变化，未返回缓存答复。', 403);
      return existing.result;
    }
    scope.key ??= scope.turnKey?.() ?? request.context_token;
    if ([...this.pending].some(item => item.scope.key === scope.key)) throw new GroupConsultError('本轮已有咨询正在进行，请等待其返回。');
    if ((this.budgets.get(scope.key) ?? 0) >= 3) throw new GroupConsultError('本轮最多咨询三次，请先整理已有答复。', 429);
    if (this.pending.size >= 8) throw new GroupConsultError('当前咨询较多，请稍后再安排。', 429);
    const target = scope.prepare(request, scope.previous.slice());
    if (!target.valid()) throw new GroupConsultError('目标角色当前不可咨询，请检查群聊授权和项目。', 403);
    const pending: Pending = { scope, target, controller: new AbortController() };
    this.budgets.set(scope.key, (this.budgets.get(scope.key) ?? 0) + 1);
    if (this.budgets.size > 512) for (const key of this.budgets.keys()) {
      if (![...this.scopes.values()].some(item => item.key === key)) this.budgets.delete(key);
      if (this.budgets.size <= 512) break;
    }
    this.pending.add(pending);
    const operation = this.run(pending, signal).then(result => {
      if (!scope.disposed) scope.previous.push({ botId: target.botId, question: request.question, answer: result.answer });
      return result;
    });
    // Cache successes and failures alike: an uncertain call must not start another model task.
    scope.calls.set(fingerprint, { result: operation, target });
    return operation;
  }
  private async run(pending: Pending, callerSignal?: AbortSignal): Promise<GroupConsultResult> {
    const { controller, target } = pending;
    const cancel = () => controller.abort(new GroupConsultError('发起方已取消等待，咨询已停止。'));
    callerSignal?.addEventListener('abort', cancel, { once: true });
    let readyAnswer: string | undefined;
    const publicationTimeout = new GroupConsultError('已取得咨询答复，但群消息送达未确认。', 504);
    let timeout = setTimeout(() => controller.abort(new GroupConsultError('咨询等待超时，已请求停止目标任务；请说明暂未取得答复，不要自动重复调用。', 504)), this.timeoutMs);
    const answerReady = (text: string) => {
      if (readyAnswer !== undefined || !text.trim() || controller.signal.aborted) return;
      readyAnswer = text.trim();
      clearTimeout(timeout);
      // Preserve an actual answer when only group delivery is slow. The caller's
      // 55-second budget leaves room for the 45-second model + 8-second publish limits.
      timeout = setTimeout(() => controller.abort(publicationTimeout), this.publicationTimeoutMs);
    };
    const check = setInterval(() => this.cancelInvalid(), 250);
    let abort!: () => void;
    const interrupted = new Promise<never>((_, reject) => {
      abort = () => reject(controller.signal.reason ?? new GroupConsultError('咨询已停止。'));
      controller.signal.addEventListener('abort', abort, { once: true });
    });
    pending.task = Promise.resolve().then(() => {
      this.cancelInvalid();
      controller.signal.throwIfAborted();
      return target.run(controller.signal, answerReady);
    }).finally(() => this.pending.delete(pending));
    try {
      const result = await Promise.race([pending.task, interrupted]) as { text: string; groupReply?: GroupConsultResult['groupReply'] };
      this.cancelInvalid();
      if (pending.scope.disposed || !pending.scope.valid() || !target.valid()) throw new GroupConsultError('咨询上下文已变化，未返回目标答复。', 403);
      controller.signal.throwIfAborted();
      const text = result.text.trim();
      if (!text) throw new GroupConsultError('目标角色未提供有效答复，请向用户说明。', 502);
      return { target: target.target, answer: text.slice(0, 30_000), truncated: text.length > 30_000,
        ...(result.groupReply ? { groupReply: result.groupReply } : {}) };
    } catch (error) {
      if (error === publicationTimeout && readyAnswer && !callerSignal?.aborted && !pending.scope.disposed
        && pending.scope.valid() && target.valid()) {
        return { target: target.target, answer: readyAnswer.slice(0, 30_000), truncated: readyAnswer.length > 30_000, groupReply: 'uncertain' };
      }
      if (error instanceof GroupConsultError) throw error;
      // Native transport errors may contain command lines or credentials.
      throw new GroupConsultError('目标角色咨询失败或被中断，未取得可确认的答复；请勿自动重试。', 502);
    } finally {
      clearTimeout(timeout); clearInterval(check);
      callerSignal?.removeEventListener('abort', cancel);
      controller.signal.removeEventListener('abort', abort);
    }
  }
  async close(): Promise<void> {
    for (const scope of this.scopes.values()) scope.disposed = true;
    this.scopes.clear();
    this.budgets.clear();
    for (const pending of this.pending) pending.controller.abort(new GroupConsultError('桥接正在关闭，咨询已停止。'));
    await Promise.allSettled([...this.pending].map(item => item.task));
  }
}
