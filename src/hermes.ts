import { randomUUID } from 'node:crypto';
import { access } from 'node:fs/promises';
import WebSocket from 'ws';
import { discoverHermesDashboard, type HermesDashboardEndpoint } from './hermes-discovery.js';
import { ensureHermesSkill, type HermesSkillResult } from './hermes-skill.js';
import { ensureHermesMcp } from './hermes-mcp.js';
import { recordManagedHermesHome } from './hermes-cleanup.js';
import { GROUP_HANDOFF_TOOL_NAME, validateGroupHandoffRequest } from './group-handoff-request.js';
import { collectHermesHandoffReceipts } from './hermes-handoff-receipts.js';
import { consultationAborted, consultationInstructions, declineConsultationRequest } from './runtime-consult.js';
import { cleanBridgeText } from './discovery.js';
import type { CodexRunInput, CodexRuntime, HistoryMessage, ModelInfo, RuntimeConsultInput, RuntimeEvent, RuntimeThreadInfo, TurnTiming } from './types.js';

type Json = Record<string, unknown>;
type Session = { liveId: string; threadId: string; cwd: string; title: string; model: string };
type TurnState = 'inProgress' | 'completed' | 'failed' | 'interrupted' | 'unknown';
type Active = {
  session: Session; input: CodexRunInput; turnId: string; submitted: boolean; acknowledged: boolean;
  delta: string; final?: { text: string; status: string }; requests: Set<string>; idleSince?: number;
  resolve: (value: { threadId: string; turnId: string; text: string }) => void;
  reject: (error: Error) => void; poll?: NodeJS.Timeout; timeout?: NodeJS.Timeout; checking: boolean;
  submittedPrompt: string; toolStarts: Set<string>; toolReceipts: Set<string>;
  liveReceipts: Map<string, { args: unknown; result: unknown }>;
  consultation?: boolean;
};
type Options = {
  baseUrl?: string;
  /** Retained for configuration compatibility; Desktop uses its own short-lived bootstrap token. */
  apiKey?: string;
  requestTimeoutMs?: number; runTimeoutMs?: number; pollIntervalMs?: number; completionSettleMs?: number;
  discover?: () => Promise<HermesDashboardEndpoint>;
  bundleRoot?: string;
  integrationDataDir?: string;
  ensureMcp?: typeof ensureHermesMcp;
  bridgePort?: () => number;
};

const HERMES_HANDOFF_TOOL = `mcp_feishu_completion_${GROUP_HANDOFF_TOOL_NAME}`;

class RpcError extends Error {
  constructor(readonly method: string, readonly code: number) { super(`Hermes 操作失败（${method}，${code}）。`); }
}

/** A client of the local Hermes runtime; process lifetime belongs to the server, never a consultation client. */
export class HermesClient implements CodexRuntime {
  readonly supportsSteering = false;
  private socket?: WebSocket;
  private connecting?: Promise<void>;
  private endpoint?: HermesDashboardEndpoint;
  private nextId = 0;
  private pending = new Map<number, { resolve: (value: Json) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
  private sessions = new Map<string, Session>();
  private active = new Map<string, Active>();
  private reservations = new Set<string>();
  private turns = new Map<string, { state: TurnState; timing: TurnTiming }>();
  private closed = false;
  private listeners = new Set<(event: RuntimeEvent) => void>();
  private integration?: Promise<void>;
  private consultationClients = new Set<HermesClient>();

  constructor(private options: Options = {}) {}

  subscribe(listener: (event: RuntimeEvent) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  async status(): Promise<{ available: boolean; version?: string; authenticated?: boolean; error?: string }> {
    try {
      const endpoint = await this.discover();
      return { available: true, version: endpoint.version };
    } catch (error) {
      return { available: false, error: error instanceof Error ? error.message : 'Hermes 尚未启动。' };
    }
  }

  async models(): Promise<ModelInfo[]> {
    const model = [...this.sessions.values()].find(session => session.model)?.model;
    return [{ id: model || 'hermes-default', name: model || 'Hermes 当前默认模型', efforts: [], defaultEffort: '' }];
  }

  async run(input: CodexRunInput): Promise<{ threadId: string; text: string; turnId?: string }> {
    return this.runSession(input);
  }

  private async runSession(input: CodexRunInput, consultation?: RuntimeConsultInput): Promise<{ threadId: string; text: string; turnId?: string }> {
    if (input.threadId) storedId(input.threadId);
    if (!consultation && (input.model || input.effort)) throw new Error('请在 Hermes 中设置模型和推理强度。');
    const reservation = input.threadId || randomUUID();
    if (this.reservations.has(reservation) || (input.threadId && this.findActive(input.threadId))) {
      throw new Error('这个 Hermes 会话正在处理任务，请完成或停止后再发送。');
    }
    this.reservations.add(reservation);
    let active: Active | undefined;
    try {
      // Validate every attachment before touching a live session or submitting a prompt.
      for (const image of input.images || []) await access(image);
      await this.connect();
      if (consultation?.signal.aborted) throw consultationAborted();
      // Consultation must not write/reload global Skills or MCP while its source is running.
      const skill = consultation ? undefined : await this.prepareIntegration(input.roleInstructions);
      const session = await this.openSession(input, Boolean(consultation), Boolean(consultation?.persistent));
      input.onThread?.(session.threadId);
      if (consultation?.signal.aborted) throw consultationAborted();
      await this.assertIdle(session);
      const prompt = await input.preparePrompt?.(session.threadId, { compactChannelHeader: true }) ?? input.prompt;
      await input.onBeforeSubmit?.();
      await this.assertIdle(session);
      if (consultation?.signal.aborted) throw consultationAborted();
      const attachments: string[] = [];
      try {
        for (const image of input.images || []) {
          const attached = await this.rpc('image.attach', { session_id: session.liveId, path: image });
          if (attached.attached !== true) throw new Error('Hermes 未确认图片附件，消息尚未提交。');
          attachments.push(string(attached.path) || image);
        }
      } catch (error) {
        // Do not leave known attached files queued for an unrelated later prompt.
        for (const image of attachments) await this.rpc('image.detach', { session_id: session.liveId, path: image }).catch(() => undefined);
        throw error;
      }
      const turnId = `hermes-turn:${randomUUID()}`;
      let resolve!: Active['resolve'];
      let reject!: Active['reject'];
      const completed = new Promise<{ threadId: string; turnId: string; text: string }>((yes, no) => { resolve = yes; reject = no; });
      // A transport error can arrive while prompt.submit's acknowledgement is still pending.
      void completed.catch(() => undefined);
      active = { session, input, turnId, submitted: false, acknowledged: false, delta: '', requests: new Set(), resolve, reject, checking: false,
        submittedPrompt: skill ? this.promptWithPolicy(prompt, skill, turnId) : prompt, toolStarts: new Set(), toolReceipts: new Set(), liveReceipts: new Map(), consultation: Boolean(consultation) };
      this.active.set(session.liveId, active);
      this.turns.set(turnId, { state: 'inProgress', timing: { startedAtMs: Date.now() } });
      active.timeout = setTimeout(() => {
        if (consultation) void this.rpc('session.interrupt', { session_id: session.liveId }).catch(() => undefined);
        this.fail(active!, new Error(consultation ? 'Hermes 咨询等待超时。' : 'Hermes 本轮等待超时，状态尚未确认；请在 Hermes 查看，不要重复发送。'), 'unknown');
      }, this.options.runTimeoutMs ?? 7_200_000);
      input.onSubmitted?.({ threadId: session.threadId, turnId, mode: 'start', status: 'submitting' });
      active.submitted = true;
      try {
        const result = await this.rpc('prompt.submit', { session_id: session.liveId, text: active.submittedPrompt });
        if (result.status !== 'streaming') throw new Error('Hermes 未确认启动状态，消息可能已提交，请先核对会话。');
        active.acknowledged = true;
        input.onSubmitted?.({ threadId: session.threadId, turnId, mode: 'start', status: 'submitted' });
      } catch (error) {
        const rejected = error instanceof RpcError;
        input.onSubmitted?.({ threadId: session.threadId, turnId, mode: 'start', status: rejected ? 'rejected' : 'uncertain' });
        this.fail(active, error instanceof Error ? error : new Error('Hermes 提交失败。'), rejected ? 'failed' : 'unknown');
      }
      if (this.active.has(session.liveId)) {
        active.poll = setInterval(() => void this.checkCompletion(active!), this.options.pollIntervalMs ?? 1_000);
        if (active.final) void this.checkCompletion(active);
      }
      return await completed;
    } finally {
      this.reservations.delete(reservation);
    }
  }

  async history(threadId: string): Promise<HistoryMessage[]> {
    const result = await this.get(`/api/sessions/${encodeURIComponent(storedId(threadId))}/messages`);
    return array(result.messages).flatMap((entry, index) => {
      const row = object(entry);
      if (row.role !== 'user' && row.role !== 'assistant') return [];
      const text = contentText(row.content ?? row.text);
      if (!text.trim()) return [];
      return [{ role: row.role, text: row.role === 'user' ? stripPolicy(text) : text, id: string(row.id) || `hermes-${index}` } satisfies HistoryMessage];
    });
  }

  async threadInfo(threadId: string): Promise<RuntimeThreadInfo> {
    const info = await this.get(`/api/sessions/${encodeURIComponent(storedId(threadId))}`);
    const row = object(info.session || info);
    const session = this.sessions.get(threadId);
    return { threadId, cwd: string(row.cwd) || session?.cwd || '', title: string(row.title) || session?.title || 'Hermes 会话', isUserThread: true };
  }

  async turnStatus(threadId: string, turnId: string): Promise<TurnState> {
    storedId(threadId);
    return this.turns.get(turnId)?.state || 'unknown';
  }

  async turnTiming(threadId: string, turnId: string): Promise<TurnTiming> {
    storedId(threadId);
    return this.turns.get(turnId)?.timing || {};
  }

  async stop(threadId: string): Promise<void> {
    storedId(threadId);
    const active = this.findActive(threadId);
    if (!active) return;
    await this.rpc('session.interrupt', { session_id: active.session.liveId });
    const deadline = Date.now() + Math.max(this.options.requestTimeoutMs ?? 30_000, 1_000);
    while (this.active.has(active.session.liveId)) {
      if (await this.isIdle(active.session)) {
        active.final = { text: '', status: 'interrupted' };
        this.finish(active);
        return;
      }
      if (Date.now() >= deadline) throw new Error('Hermes 已收到停止请求，但任务尚未退出，请稍后检查。');
      await new Promise(resolve => setTimeout(resolve, 150));
    }
  }

  async release(threadId: string): Promise<void> {
    storedId(threadId);
    // Switching Feishu conversations must never close or interrupt a Hermes turn.
  }

  async close(): Promise<void> {
    this.closed = true;
    await Promise.all([...this.consultationClients].map(client => client.close()));
    // This client owns temporary consultations, while normal desktop turns keep running.
    await Promise.all([...this.active.values()].filter(active => active.consultation).map(async active => {
      await this.rpc('session.interrupt', { session_id: active.session.liveId }).catch(() => undefined);
      await this.rpc('session.close', { session_id: active.session.liveId }).catch(() => undefined);
    }));
    const socket = this.socket;
    this.socket = undefined;
    this.disconnected(new Error('Hermes 桥接连接已关闭；已提交任务请在 Hermes 查看。'));
    socket?.close();
  }

  private promptWithPolicy(prompt: string, skill: HermesSkillResult, turnId: string): string {
    const marker = /^(【(?:飞书消息|本地预览)】[^\n]*)(?:\n|$)/.exec(prompt)?.[1];
    const content = marker ? prompt.slice(marker.length).replace(/^\n/, '') : prompt;
    return `${marker ? `${marker}\n` : ''}<feishu_bridge_context>\n请遵循 feishu-codex Skill。角色：${skill.roleReference || '无自定义角色'}\n本轮：${turnId}\n</feishu_bridge_context>\n\n${content}`;
  }

  private async prepareIntegration(roleInstructions?: string): Promise<HermesSkillResult> {
    const endpoint = this.endpoint!;
    if (!endpoint.hermesHome) throw new Error('Hermes 未提供本机 Skill 目录，消息尚未提交。');
    const skill = await ensureHermesSkill({ hermesHome: endpoint.hermesHome, bundleRoot: this.options.bundleRoot, roleInstructions });
    if (this.options.integrationDataDir) await recordManagedHermesHome(this.options.integrationDataDir, endpoint.hermesHome);
    if (!this.integration) {
      this.integration = (async () => {
        await (this.options.ensureMcp ?? ensureHermesMcp)({ endpoint, ...(this.options.bridgePort ? { bridgePort: this.options.bridgePort() } : {}) });
        const list = await this.rpc('session.active_list', {});
        if (array(list.sessions).some(row => object(row).status !== 'idle')) {
          throw new Error('Hermes 正在处理其他任务，待其结束后重试以加载内置 Skill 和 MCP；消息尚未提交。');
        }
        await this.rpc('skills.reload', {});
        const loaded = await this.rpc('reload.mcp', { confirm: true });
        if (loaded.status !== 'reloaded') throw new Error('Hermes 尚未确认加载 MCP，消息尚未提交。');
      })().catch(error => { this.integration = undefined; throw error; });
    }
    await this.integration;
    return skill;
  }

  private async openSession(input: CodexRunInput, consultation = false, persistentConsultation = false): Promise<Session> {
    const existing = input.threadId && this.sessions.get(input.threadId);
    if (existing) return existing;
    if (input.threadId) {
      // Unlike resume, active_list is read-only and does not take the Desktop's
      // event transport away from a task which is already running.
      const list = await this.rpc('session.active_list', {});
      const row = array(list.sessions).map(object).find(row => row.session_key === storedId(input.threadId!));
      if (row && row.status !== 'idle') throw new Error('这个 Hermes 会话正在处理任务，请完成或停止后再发送。');
    }
    const result = input.threadId
      ? await this.rpc('session.resume', { session_id: storedId(input.threadId) })
      : await this.rpc('session.create', {
        cwd: input.cwd, title: consultation ? '飞书角色咨询' : '飞书会话', source: consultation ? 'tool' : 'feishu-codex',
        close_on_disconnect: consultation && !persistentConsultation,
        ...(consultation && input.model ? { model: input.model } : {}), ...(consultation && input.effort ? { reasoning_effort: input.effort } : {}),
      });
    const liveId = string(result.session_id);
    const stored = string(result.stored_session_id || result.session_key || result.resumed);
    if (!liveId || !stored) throw new Error('Hermes 未返回可恢复的会话编号，消息尚未提交。');
    if (result.running === true || object(result.info).running === true) throw new Error('这个 Hermes 会话正在处理任务，请完成或停止后再发送。');
    if (input.threadId && !consultation) {
      const list = await this.rpc('session.active_list', {});
      if (array(list.sessions).some(row => object(row).status !== 'idle')) throw new Error('Hermes 正在处理其他任务，暂不能刷新当前会话工具，请稍后重试。');
      const loaded = await this.rpc('reload.mcp', { session_id: liveId, confirm: true });
      if (loaded.status !== 'reloaded') throw new Error('Hermes 尚未确认当前会话的 MCP 工具，消息尚未提交。');
    }
    const info = object(result.info);
    const session = { liveId, threadId: `hermes:${stored}`, cwd: string(info.cwd) || input.cwd, title: string(info.title) || 'Hermes 会话', model: string(info.model) };
    this.sessions.set(session.threadId, session);
    if (input.threadId) this.sessions.set(input.threadId, session);
    return session;
  }

  private async assertIdle(session: Session): Promise<void> {
    if (!await this.isIdle(session)) throw new Error('这个 Hermes 会话正在处理任务，请完成或停止后再发送。');
  }

  private async isIdle(session: Session): Promise<boolean> {
    const result = await this.rpc('session.status', { session_id: session.liveId });
    // This Desktop build exposes a text status, not a structured running flag.
    if (typeof result.running === 'boolean') return !result.running;
    const match = /^Agent Running:\s*(Yes|No)\s*$/m.exec(string(result.output));
    if (!match) throw new Error('Hermes 暂时无法确认会话状态，消息尚未提交。');
    return match[1] === 'No';
  }

  private async checkCompletion(active: Active): Promise<void> {
    if (!active.acknowledged || !active.final || active.checking || this.active.get(active.session.liveId) !== active) return;
    active.checking = true;
    try {
      const final = active.final;
      if (await this.isIdle(active.session) && active.final === final) {
        // Desktop briefly clears running before a goal/queued continuation.
        // Require a second quiet observation, not that transient false flag.
        active.idleSince ??= Date.now();
        if (Date.now() - active.idleSince < (this.options.completionSettleMs ?? 800)) return;
        const list = await this.rpc('session.active_list', {});
        const live = array(list.sessions).map(object).find(row => row.id === active.session.liveId);
        if (live && live.status !== 'idle') return;
        const currentStored = string(live?.session_key);
        if (currentStored && `hermes:${currentStored}` !== active.session.threadId) {
          active.session.threadId = `hermes:${currentStored}`;
          this.sessions.set(active.session.threadId, active.session);
          active.input.onThread?.(active.session.threadId);
        }
        if (await this.reconcileHandoffReceipts(active) && active.final === final && this.active.get(active.session.liveId) === active) this.finish(active);
      } else active.idleSince = undefined;
    } catch (error) {
      this.fail(active, error instanceof Error ? error : new Error('Hermes 状态查询失败。'), 'unknown');
    } finally { active.checking = false; }
  }

  private handoffReceipt(active: Active, id: string, args: unknown, rawResult: unknown): void {
    if (!id || active.toolReceipts.has(id) || this.active.get(active.session.liveId) !== active) return;
    active.toolReceipts.add(id);
    let result = object(rawResult);
    if (typeof rawResult === 'string') {
      try { result = object(JSON.parse(rawResult)); } catch { result = {}; }
    }
    let valid = false;
    let structuredContent: unknown;
    try {
      const request = validateGroupHandoffRequest(args);
      const receipt = validateGroupHandoffRequest(result.structuredContent);
      valid = !result.error && result.isError !== true && request.target === receipt.target && request.task === receipt.task;
      structuredContent = receipt;
    } catch { /* Invalid, failed and incomplete tool results cannot dispatch. */ }
    const item = { id, type: 'mcpToolCall', server: 'feishu_completion', tool: GROUP_HANDOFF_TOOL_NAME, arguments: args };
    for (const event of [
      { method: 'item/started', params: { item: { ...item, status: 'inProgress' } } },
      { method: 'item/completed', params: { item: { ...item, status: valid ? 'completed' : 'failed', result: { isError: !valid, structuredContent } } } },
    ]) {
      for (const listener of this.listeners) {
        try { listener({ ...event, threadId: active.session.threadId, turnId: active.turnId }); } catch { /* Isolate subscribers. */ }
      }
    }
  }

  private async reconcileHandoffReceipts(active: Active): Promise<boolean> {
    if (active.consultation) return true;
    // Tool progress can be disabled in Hermes. Only this client's acknowledged,
    // still-active submission may reconcile its own native persisted receipts.
    // A random turn marker makes repeated user prompts distinct across turns.
    if (!active.acknowledged || this.active.get(active.session.liveId) !== active) return false;
    if (!active.submittedPrompt.includes('<feishu_group_collaboration>')) return true;
    let result: Json | undefined;
    let receipts: ReturnType<typeof collectHermesHandoffReceipts> = [];
    let unverified = false;
    try {
      result = await this.get(`/api/sessions/${encodeURIComponent(storedId(active.session.threadId))}/messages`);
      receipts = collectHermesHandoffReceipts({ messages: result.messages, submittedPrompt: active.submittedPrompt,
        sessionId: storedId(active.session.threadId), responseSessionId: string(result.session_id) });
    } catch {
      // A goal continuation or compaction can remove the exact anchor. That
      // invalidates a handoff, not the already-completed normal answer.
      unverified = true;
    }
    if (this.active.get(active.session.liveId) !== active || !await this.isIdle(active.session)) return false;
    if (unverified) {
      const mayHaveCall = !result || active.liveReceipts.size > 0 || array(result.messages).some(value => {
        const row = object(value);
        return row.role === 'assistant' && array(row.tool_calls).some(call => object(object(call).function).name === HERMES_HANDOFF_TOOL);
      });
      if (mayHaveCall) this.handoffReceipt(active, `unverified:${active.turnId}`, {}, { error: 'Current handoff receipt could not be verified' });
      return true;
    }
    // Emit only after the final stored identity is known. Hermes compaction can
    // replace the stored thread ID while the live execution keeps the same sid.
    const combined = new Map(active.liveReceipts);
    for (const receipt of receipts) combined.set(receipt.id, receipt);
    for (const [id, receipt] of combined) this.handoffReceipt(active, id, receipt.args, receipt.result);
    return true;
  }

  private finish(active: Active): void {
    if (this.active.get(active.session.liveId) !== active || !active.final) return;
    const state = active.final.status === 'interrupted' ? 'interrupted' : active.final.status === 'error' ? 'failed' : 'completed';
    this.cleanup(active, state);
    if (state === 'interrupted') active.reject(new Error('已停止当前任务。'));
    else if (state === 'failed') active.reject(new Error(active.final.text || 'Hermes 本轮任务执行失败。'));
    else active.resolve({ threadId: active.session.threadId, turnId: active.turnId, text: active.final.text });
  }

  private fail(active: Active, error: Error, state: TurnState): void {
    if (this.active.get(active.session.liveId) !== active) return;
    this.cleanup(active, state);
    active.reject(error);
  }

  private cleanup(active: Active, state: TurnState): void {
    this.active.delete(active.session.liveId);
    clearInterval(active.poll); clearTimeout(active.timeout);
    const startedAtMs = this.turns.get(active.turnId)?.timing.startedAtMs;
    const completedAtMs = Date.now();
    this.turns.set(active.turnId, { state, timing: { startedAtMs, completedAtMs, durationMs: startedAtMs ? completedAtMs - startedAtMs : undefined } });
    if (this.turns.size > 500) this.turns.delete(this.turns.keys().next().value!);
  }

  private event(params: Json): void {
    const active = this.active.get(string(params.session_id));
    if (!active) return;
    const type = string(params.type);
    const payload = object(params.payload);
    if (type === 'message.delta') { active.delta += string(payload.text); active.idleSince = undefined; }
    else if (type === 'tool.start') {
      const text = active.delta.trim(); active.delta = '';
      if (text) active.input.onProgress?.(text);
      if (!active.consultation && payload.name === HERMES_HANDOFF_TOOL && string(payload.tool_id) && !string(payload.tool_id).startsWith('submirror:')) active.toolStarts.add(string(payload.tool_id));
    } else if (type === 'tool.complete') {
      if (payload.name === HERMES_HANDOFF_TOOL && active.toolStarts.has(string(payload.tool_id))) {
        const id = string(payload.tool_id);
        if (!active.liveReceipts.has(id) && active.liveReceipts.size < 32) active.liveReceipts.set(id, { args: payload.args, result: payload.result });
      }
    } else if (type === 'message.start') {
      // Goals can continue after message.complete: only the last completion of
      // the still-running conversation may become a final Feishu reply.
      if (active.final?.text) active.input.onProgress?.(active.final.text);
      active.final = undefined; active.delta = ''; active.idleSince = undefined;
    } else if (type === 'message.complete') {
      active.final = { text: string(payload.text), status: string(payload.status) || 'complete' };
      active.delta = ''; active.idleSince = undefined;
    } else if (type === 'error') {
      active.final = { text: string(payload.message) || 'Hermes 执行失败。', status: 'error' };
    } else if (type === 'session.info') {
      active.session.model = string(payload.model) || active.session.model;
      active.session.title = string(payload.title) || active.session.title;
      // Do not finish on this event: Hermes may immediately start a goal continuation.
    } else if (type === 'approval.request' || type === 'clarify.request') {
      void this.request(active, type, payload);
    } else if (type === 'secret.request' || type === 'sudo.request') {
      if (!active.consultation) active.input.onProgress?.('Hermes 需要在本机处理敏感凭据请求，请到 Hermes 窗口操作。');
    }
    // reasoning/thinking, tool arguments, tool results and terminal output are
    // intentionally not forwarded as public progress.
  }

  private async request(active: Active, type: string, payload: Json): Promise<void> {
    const id = string(payload.request_id) || `${type}:${string(payload.command)}`;
    if (active.requests.has(id)) return;
    active.requests.add(id);
    try {
      if (type === 'approval.request') {
        const answer = await active.input.onRequest?.({ id: `hermes:${id}`, kind: 'approval', title: 'Hermes 请求审批', text: string(payload.command) || string(payload.reason) || '请确认是否允许本次操作。' });
        if (this.active.get(active.session.liveId) !== active) return;
        await this.rpc('approval.respond', { session_id: active.session.liveId, choice: answer?.decision === 'accept' ? 'once' : 'deny' });
      } else {
        const question = string(payload.question) || 'Hermes 需要补充信息。';
        const choices = array(payload.choices).map(value => ({ label: typeof value === 'string' ? value : string(object(value).label) })).filter(value => value.label);
        if (!active.input.onRequest) { if (!active.consultation) active.input.onProgress?.('Hermes 需要补充信息，请到 Hermes 窗口回答。'); return; }
        const answer = await active.input.onRequest({ id: `hermes:${id}`, kind: 'question', title: 'Hermes 需要补充信息', text: question, questions: [{ id, question, options: choices }] });
        if (this.active.get(active.session.liveId) !== active) return;
        await this.rpc('clarify.respond', { request_id: id, answer: answer.answers?.[id]?.answers.join('\n') || '' });
      }
    } catch {
      if (!active.consultation) active.input.onProgress?.('Hermes 的审批或补充信息未能提交，请在 Hermes 中检查。');
    } finally { active.requests.delete(id); }
  }

  private findActive(threadId: string): Active | undefined {
    const session = this.sessions.get(threadId);
    return session ? this.active.get(session.liveId) : undefined;
  }

  private async discover(): Promise<HermesDashboardEndpoint> {
    if (this.closed) throw new Error('Hermes 连接已关闭。');
    return this.options.discover ? this.options.discover() : discoverHermesDashboard({ baseUrl: this.options.baseUrl });
  }

  private async get(route: string): Promise<Json> {
    const endpoint = await this.discover();
    const response = await fetch(`${endpoint.baseUrl}${route}`, {
      headers: { 'X-Hermes-Session-Token': endpoint.token },
      signal: AbortSignal.timeout(this.options.requestTimeoutMs ?? 30_000), redirect: 'error',
    });
    if (!response.ok) throw new Error(`无法读取 Hermes 会话（HTTP ${response.status}）。`);
    return object(await response.json());
  }

  private async connect(): Promise<void> {
    if (this.closed) throw new Error('Hermes 连接已关闭。');
    if (this.socket?.readyState === WebSocket.OPEN) return;
    if (this.connecting) return this.connecting;
    this.connecting = (async () => {
      const endpoint = await this.discover();
      if (this.closed) throw new Error('Hermes 连接已关闭。');
      this.endpoint = endpoint;
      const url = `${endpoint.baseUrl.replace(/^http/, 'ws')}/api/ws?token=${encodeURIComponent(endpoint.token)}`;
      const socket = new WebSocket(url, { handshakeTimeout: this.options.requestTimeoutMs ?? 30_000, maxPayload: 16 * 1024 * 1024 });
      this.socket = socket;
      socket.on('message', data => {
        for (const line of data.toString().split('\n')) {
          if (!line.trim()) continue;
          let message: Json;
          try { message = object(JSON.parse(line)); } catch { continue; }
          if (message.method === 'event') this.event(object(message.params));
          else if (typeof message.id === 'number') {
            const pending = this.pending.get(message.id);
            if (!pending) continue;
            this.pending.delete(message.id); clearTimeout(pending.timer);
            if (message.error) pending.reject(new RpcError(string(object(message.error).method), Number(object(message.error).code)));
            else pending.resolve(object(message.result));
          }
        }
      });
      socket.on('close', () => {
        if (this.socket !== socket) return;
        this.socket = undefined;
        this.disconnected(new Error('与 Hermes 的连接已断开；消息可能已执行，请先查看会话，不要重复发送。'));
      });
      // Never include ws's raw URL/error text: the URL contains a session token.
      socket.on('error', () => undefined);
      await new Promise<void>((resolve, reject) => {
        socket.once('open', resolve);
        socket.once('error', () => reject(new Error('无法连接 Hermes 桌面服务，请确认 Hermes 已启动。')));
        socket.once('close', () => reject(new Error('Hermes 桌面连接已关闭。')));
      });
    })().finally(() => { this.connecting = undefined; });
    return this.connecting;
  }

  private async rpc(method: string, params: Json): Promise<Json> {
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) throw new Error('Hermes 连接不可用，请先检查当前会话状态。');
    const id = ++this.nextId;
    return new Promise<Json>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Hermes 响应超时（${method}），已提交操作不会自动重发。`));
      }, this.options.requestTimeoutMs ?? 30_000);
      this.pending.set(id, { resolve, reject: error => reject(error instanceof RpcError ? new RpcError(method, error.code) : error), timer });
      socket.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }), error => {
        if (!error) return;
        const pending = this.pending.get(id);
        if (!pending) return;
        this.pending.delete(id); clearTimeout(timer);
        reject(new Error('Hermes 请求发送状态不确定，请先核对会话。'));
      });
    });
  }

  private disconnected(error: Error): void {
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error); }
    this.pending.clear();
    for (const active of [...this.active.values()]) {
      if (active.submitted) active.input.onSubmitted?.({ threadId: active.session.threadId, turnId: active.turnId, mode: 'start', status: 'uncertain' });
      this.fail(active, error, 'unknown');
    }
    this.sessions.clear();
    this.integration = undefined;
  }

  async consult(input: RuntimeConsultInput): Promise<{ threadId: string; text: string }> {
    if (this.closed) throw new Error('Hermes 连接已关闭。');
    if (input.signal.aborted) throw consultationAborted();
    // A private socket also releases a newly created session whose response was lost.
    const client = new HermesClient(this.options);
    this.consultationClients.add(client);
    try { return await client.consultSession(input); }
    finally {
      this.consultationClients.delete(client);
      await client.close();
    }
  }

  private async consultSession(input: RuntimeConsultInput): Promise<{ threadId: string; text: string }> {
    if (input.signal.aborted) throw consultationAborted();
    let session: Session | undefined;
    let completed = false;
    let cancelling: Promise<void> | undefined;
    const cancel = (): Promise<void> => {
      if (!session) return cancelling ??= this.close();
      const ownSession = session;
      return cancelling ??= (async () => {
        const active = this.active.get(ownSession.liveId);
        if (active) {
          await this.rpc('session.interrupt', { session_id: ownSession.liveId }).catch(() => undefined);
          this.fail(active, consultationAborted(), 'interrupted');
        }
      })();
    };
    const abort = () => { void cancel(); };
    input.signal.addEventListener('abort', abort, { once: true });
    try {
      const result = await this.runSession({
        cwd: input.cwd, threadId: input.threadId, model: input.model, effort: input.effort,
        prompt: `${consultationInstructions(input)}\n\n<consultation_material>\n${input.prompt}\n</consultation_material>`,
        onProgress: input.onProgress, onRequest: input.onRequest ?? declineConsultationRequest,
        onThread: id => { session = this.sessions.get(id); },
        onBeforeSubmit: async () => {
          if (input.signal.aborted) throw consultationAborted();
          await input.onBeforeSubmit?.();
          if (input.signal.aborted) throw consultationAborted();
        },
      }, input);
      if (input.signal.aborted) throw consultationAborted();
      completed = true;
      return { threadId: result.threadId, text: result.text };
    } catch (error) {
      throw input.signal.aborted ? consultationAborted() : error;
    } finally {
      input.signal.removeEventListener('abort', abort);
      await cancelling;
      if (session && (!input.persistent || (!input.threadId && !completed))) {
        // Discard one-off and cancelled consultations; durable consultations retain their own session.
        await this.rpc('session.close', { session_id: session.liveId }).catch(() => undefined);
        for (const [id, value] of this.sessions) if (value === session) this.sessions.delete(id);
      }
    }
  }
}

function storedId(threadId: string): string {
  if (!threadId.startsWith('hermes:') || !threadId.slice(7) || /[\r\n\0]/.test(threadId)) throw new Error('这不是 Hermes 会话，不能把 Codex 会话直接交给 Hermes。');
  return threadId.slice(7);
}
function object(value: unknown): Json { return value && typeof value === 'object' && !Array.isArray(value) ? value as Json : {}; }
function array(value: unknown): unknown[] { return Array.isArray(value) ? value : []; }
function string(value: unknown): string { return typeof value === 'string' ? value : ''; }
function contentText(value: unknown): string { return typeof value === 'string' ? value : array(value).map(part => string(object(part).text)).filter(Boolean).join('\n'); }
function stripPolicy(value: string): string {
  const content = value.replace(/^((?:【(?:飞书消息|本地预览)】[^\n]*\n)?)<(feishu_bridge_instructions|feishu_bridge_context)>\n[\s\S]*?\n<\/\2>\n\n/, '$1');
  return cleanBridgeText(content.replace(/^【(?:飞书消息|本地预览)】\r?\n(?!\r?\n)/, header => `${header}\n`));
}
