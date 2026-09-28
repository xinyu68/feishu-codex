import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Store } from './store.js';
import { cleanBridgeText } from './discovery.js';
import { formatUsage } from './usage.js';
import { readTurnTiming, turnDuration } from './turn-timing.js';
import { isThreadInitializationRace, isThreadWriterConflict, THREAD_WRITER_MESSAGE } from './codex-errors.js';
import type { ArtifactDeliveryResult, CodexRuntime, InboundMessage, FeishuTransport, MessageCard, RuntimeRequest, RuntimeAnswer, Project, ThreadSummary, ChatMessage, Conversation, BridgeEvent, CompletionNotification, RuntimeEvent } from './types.js';

type Work = { message: InboundMessage; target: Conversation; resolve: () => void };
type Queue = { active: boolean; cancelled: boolean; threadId?: string; items: Work[]; current?: Promise<void> };
type PendingRequest = RuntimeRequest & {
  chatId: string; actorId: string; createdAt: string; messageId?: string; localOnly?: boolean; operationId?: string;
  resolve: (answer: RuntimeAnswer) => void; timer: ReturnType<typeof setTimeout>;
};
type Discover = { projects: () => Promise<Project[]>; threads: (cwd: string) => Promise<ThreadSummary[]>; assertCanWrite?: () => void | Promise<void> };
const STREAM_MAX_THREADS = 32;
const STREAM_MAX_ITEMS = 48;
const STREAM_MAX_CHARACTERS = 256 * 1024;
const NOTIFICATION_SERVER = 'feishu_completion';
const NOTIFICATION_TOOL = 'request_feishu_completion_notification';
const ARTIFACT_TOOL = 'send_artifact_to_feishu';
const ARTIFACT_IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp']);
const MAX_ARTIFACTS = 5;
const MAX_ARTIFACT_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_ARTIFACT_FILE_BYTES = 30 * 1024 * 1024;
type RuntimeActivity = { busy: boolean; turnId?: string; startedAt?: string; lastActivityAt?: string; progress?: string };

function activityText(event: RuntimeEvent): string | undefined {
  const item = event.params?.item as Record<string, unknown> | undefined;
  if (event.method === 'item/completed' && item?.type === 'agentMessage' && item.phase === 'commentary' && typeof item.text === 'string') {
    return item.text.replace(/\s+/g, ' ').trim().slice(0, 180) || undefined;
  }
  if (event.method !== 'item/started' && event.method !== 'item/completed') return undefined;
  const action = event.method === 'item/started' ? '正在' : '已完成';
  switch (item?.type) {
    case 'commandExecution': return event.method === 'item/started' ? '正在运行命令' : '命令运行完成，继续处理';
    case 'fileChange': return event.method === 'item/started' ? '正在修改文件' : '文件修改完成，继续处理';
    case 'mcpToolCall': return event.method === 'item/started' ? '正在使用工具' : '工具调用完成，继续处理';
    case 'webSearch': return event.method === 'item/started' ? '正在搜索资料' : '资料搜索完成，继续处理';
    case 'agentMessage': return item.phase === 'final_answer' ? '正在整理回复' : undefined;
    case 'reasoning': return `${action}分析问题`;
    default: return undefined;
  }
}

export class UserError extends Error {
  constructor(message: string, readonly status = 400) { super(message); }
}

export class Bridge {
  transport?: FeishuTransport;
  private queues = new Map<string, Queue>();
  private threadOwners = new Map<string, string>();
  private requests = new Map<string, PendingRequest>();
  private finishedRequests = new Map<string, { chatId: string; actorId: string; text: string }>();
  private projectChoices = new Map<string, Project[]>();
  private sessionChoices = new Map<string, ThreadSummary[]>();
  private modelChoices = new Map<string, string[]>();
  private changingContext = new Set<string>();
  private historyCache = new Map<string, { key: string; until: number; promise: Promise<{ messages: ChatMessage[]; source: string; threadId?: string }> }>();
  private closing = false;
  private flights = new Map<string, { message: InboundMessage; target: Conversation; queue: Queue }>();
  private creatingThreads = new Map<string, Promise<string | undefined>>();
  private pendingNewThreads = new Set<string>();
  private listeners = new Set<(event: BridgeEvent) => void>();
  private runtimeStates = new Map<string, RuntimeActivity>();
  private streamed = new Map<string, Map<string, ChatMessage>>();
  private discontinuousStreams = new Set<string>();
  private submissionPromises = new Map<string, Promise<void>>();
  private accepting = new Map<string, { resolve: () => void; reject: (error: unknown) => void }>();
  private notificationEvents = new Map<string, Promise<void>>();
  private automaticNotificationsSince = Date.now();
  private automaticNotificationsEnabled = false;
  private unsubscribeRuntime?: () => void;
  private unsubscribeStore?: () => void;
  constructor(readonly store: Store, readonly codex: CodexRuntime, private discovery: Discover) {
    this.automaticNotificationsEnabled = store.config.autoNotifyDesktop === true;
    this.unsubscribeStore = store.subscribe(() => {
      if (store.config.autoNotifyDesktop && !this.automaticNotificationsEnabled) this.automaticNotificationsSince = Date.now();
      this.automaticNotificationsEnabled = store.config.autoNotifyDesktop === true;
      this.emit({ type: 'state' });
    });
    this.unsubscribeRuntime = codex.subscribe?.(event => {
      this.observeNotificationEvent(event);
      let delta: BridgeEvent['delta'];
      if (event.threadId) {
        if (event.method === 'stream/reset' || event.method === 'connection/lost') {
          this.streamed.delete(event.threadId);
          this.discontinuousStreams.add(event.threadId);
        }
        if (event.method === 'turn/started' || event.method === 'turn/completed') this.discontinuousStreams.delete(event.threadId);
        const current = this.runtimeStates.get(event.threadId) ?? { busy: false };
        const now = new Date().toISOString();
        const turn = event.params?.turn as Record<string, unknown> | undefined;
        const snapshotActive = event.method === 'turn/snapshot' && current.busy && ['inProgress', 'in_progress', 'active'].includes(String(turn?.status ?? ''));
        if (event.method === 'turn/started' || snapshotActive) {
          const startedAt = typeof turn?.startedAt === 'string' && !Number.isNaN(Date.parse(turn.startedAt)) ? turn.startedAt : now;
          if (!current.busy || current.turnId !== event.turnId) Object.assign(current, { busy: true, turnId: event.turnId, startedAt, lastActivityAt: now, progress: '已接收任务，等待 Codex 更新' });
        } else if (event.method === 'turn/completed' && (!current.turnId || current.turnId === event.turnId)) {
          Object.assign(current, { busy: false, turnId: undefined, startedAt: undefined, lastActivityAt: undefined, progress: undefined });
        }
        if (event.method === 'thread/status/changed') {
          const active = (event.params?.status as { type?: string } | undefined)?.type === 'active';
          if (active && !current.busy) Object.assign(current, { busy: true, startedAt: now, lastActivityAt: now, progress: '正在等待 Codex 更新' });
          if (!active) Object.assign(current, { busy: false, turnId: undefined, startedAt: undefined, lastActivityAt: undefined, progress: undefined });
        }
        if (event.method === 'connection/lost' && current.busy) Object.assign(current, { lastActivityAt: now, progress: '连接中断，正在恢复进度' });
        if (current.busy && (!event.turnId || !current.turnId || current.turnId === event.turnId)) {
          const progress = activityText(event);
          if (progress) Object.assign(current, { progress, lastActivityAt: now });
          else if (event.method.startsWith('item/') && Date.now() - Date.parse(current.lastActivityAt ?? '0') >= 4000) current.lastActivityAt = now;
        }
        this.runtimeStates.set(event.threadId, current);
        while (this.runtimeStates.size > 256) this.runtimeStates.delete(this.runtimeStates.keys().next().value!);
        while (this.discontinuousStreams.size > STREAM_MAX_THREADS) this.discontinuousStreams.delete(this.discontinuousStreams.values().next().value!);
        const item = event.params?.item as Record<string, unknown> | undefined;
        const itemId = typeof item?.id === 'string' ? item.id : typeof event.params?.itemId === 'string' ? event.params.itemId : '';
        if (event.method === 'turn/started' || event.method === 'turn/completed') this.streamed.delete(event.threadId);
        if (!this.discontinuousStreams.has(event.threadId) && event.turnId && itemId && (event.method === 'item/agentMessage/delta' || (item?.type === 'agentMessage' && ['item/started', 'item/completed'].includes(event.method)))) {
          let items = this.streamed.get(event.threadId);
          if (!items) { items = new Map(); this.streamed.set(event.threadId, items); }
          while (this.streamed.size > STREAM_MAX_THREADS) this.streamed.delete(this.streamed.keys().next().value!);
          const previous = items.get(itemId);
          const text = event.method === 'item/agentMessage/delta' ? (previous?.text ?? '') + String(event.params?.delta ?? '') : typeof item?.text === 'string' ? item.text : previous?.text ?? '';
          const phase = typeof item?.phase === 'string' ? item.phase : previous?.phase;
          items.set(itemId, { id: itemId, role: 'assistant', text, at: previous?.at ?? new Date().toISOString(), streaming: event.method !== 'item/completed', phase, turnId: event.turnId });
          const characters = [...items.values()].reduce((sum, entry) => sum + entry.text.length, 0);
          if (items.size > STREAM_MAX_ITEMS || characters > STREAM_MAX_CHARACTERS) {
            this.streamed.delete(event.threadId);
            this.discontinuousStreams.add(event.threadId);
          } else delta = { threadId: event.threadId, turnId: event.turnId, itemId, text, phase };
        }
        for (const item of Object.values(store.state.conversations)) if (item.threadId === event.threadId) this.historyCache.delete(item.chatId);
      }
      this.emit({ type: 'runtime', threadId: event.threadId, event: { method: event.method, threadId: event.threadId, turnId: event.turnId }, delta });
    });
  }
  async startNotificationTracking(): Promise<void> {
    await this.codex.watchLoaded?.();
    const threads = new Set([
      ...Object.values(this.store.state.notifications).filter(item => item.status === 'registered').map(item => item.threadId),
      ...Object.values(this.store.state.artifacts).filter(item => item.status === 'registered').map(item => item.threadId),
    ]);
    for (const threadId of threads) await this.codex.watch?.(threadId).catch(() => undefined);
  }
  async deliverPendingNotifications(): Promise<void> {
    for (const notification of Object.values(this.store.state.notifications).filter(item => item.status === 'registered')) {
      const status = await this.codex.turnStatus?.(notification.threadId, notification.turnId).catch(() => 'unknown' as const);
      if (status && ['completed', 'failed', 'interrupted'].includes(status)) await this.deliverCompletionNotification(notification, status as 'completed' | 'failed' | 'interrupted');
    }
  }
  async deliverPendingArtifacts(): Promise<void> {
    for (const artifact of Object.values(this.store.state.artifacts).filter(item => item.status === 'registered')) {
      await this.deliverArtifactCall(artifact.threadId, artifact.turnId, {
        id: artifact.itemId, arguments: { paths: artifact.paths }, status: 'completed',
      });
    }
  }
  private observeNotificationEvent(event: RuntimeEvent): void {
    if (!event.threadId || !event.turnId) return;
    const key = `${event.threadId}:${event.turnId}`;
    const previous = this.notificationEvents.get(key) ?? Promise.resolve();
    const autoSince = this.store.config.autoNotifyDesktop && this.codex.supportsSteering ? this.automaticNotificationsSince : undefined;
    const observedAt = Date.now();
    const next = previous.then(() => this.processNotificationEvent(event, autoSince, observedAt)).catch(error => this.store.log('warn', `飞书通知或成品处理失败：${errorText(error)}`));
    this.notificationEvents.set(key, next);
    void next.finally(() => { if (this.notificationEvents.get(key) === next) this.notificationEvents.delete(key); });
  }
  private async processNotificationEvent(event: RuntimeEvent, autoSince?: number, observedAt = Date.now()): Promise<void> {
    const threadId = event.threadId!;
    const turnId = event.turnId!;
    const turn = event.params?.turn as Record<string, unknown> | undefined;
    const directItem = event.params?.item as Record<string, unknown> | undefined;
    const items = [directItem, ...(Array.isArray(turn?.items) ? turn.items as Record<string, unknown>[] : [])].filter(Boolean) as Record<string, unknown>[];
    const call = items.find(item => item.type === 'mcpToolCall' && item.server === NOTIFICATION_SERVER && item.tool === NOTIFICATION_TOOL);
    const artifactCalls = [...new Map(items
      .filter(item => item.type === 'mcpToolCall' && item.server === NOTIFICATION_SERVER && item.tool === ARTIFACT_TOOL && item.status === 'completed')
      .map(item => [String(item.id ?? ''), item])).values()];
    for (const artifactCall of artifactCalls) await this.deliverArtifactCall(threadId, turnId, artifactCall);
    let notification = Object.values(this.store.state.notifications).find(item => item.threadId === threadId && item.turnId === turnId);
    if (call && !notification) notification = await this.registerCompletionNotification(threadId, turnId, call);
    else if (call && notification?.automatic && ['registered', 'skipped'].includes(notification.status)) {
      const args = call.arguments as { summary?: unknown } | undefined;
      notification = this.store.notification(notification.id, { automatic: false, status: 'registered', skipReason: undefined,
        ...(typeof args?.summary === 'string' && args.summary.trim() ? { title: args.summary.trim().slice(0, 200) } : {}) });
    }
    const status = typeof turn?.status === 'string' ? turn.status : '';
    const freshSnapshot = event.method === 'turn/snapshot' && (status === 'inProgress'
      || (typeof turn?.completedAt === 'number' && turn.completedAt * 1000 >= (autoSince ?? Infinity)));
    if (!notification && autoSince !== undefined && this.store.config.autoNotifyDesktop
      && (event.method === 'turn/started' || event.method === 'turn/completed' || freshSnapshot)) {
      notification = await this.registerCompletionNotification(threadId, turnId, {}, true);
    }
    if (notification?.status === 'registered') {
      const timing = readTurnTiming(turn);
      // Only live start/end events can supply observation-time fallbacks.
      // A snapshot or reconnect must not turn delivery delay into task duration.
      if (event.method === 'turn/started' && timing.startedAtMs === undefined && notification.timing?.startedAtMs === undefined) timing.startedAtMs = observedAt;
      if (event.method === 'turn/completed' && timing.completedAtMs === undefined && notification.timing?.completedAtMs === undefined) timing.completedAtMs = observedAt;
      if (Object.keys(timing).length) notification = this.store.notification(notification.id, { timing: { ...notification.timing, ...timing } });
      const answer = items.filter(item => item.type === 'agentMessage' && item.phase === 'final_answer' && typeof item.text === 'string').map(item => item.text).join('\n');
      if (answer) notification = this.store.notification(notification.id, { result: cleanBridgeText(answer).slice(0, 600) });
    }
    const outcome = status || (call ? notification?.outcome : undefined);
    if (notification && outcome && ['completed', 'failed', 'interrupted'].includes(outcome)) await this.deliverCompletionNotification(notification, outcome as 'completed' | 'failed' | 'interrupted');
  }
  private async deliverArtifactCall(threadId: string, turnId: string, call: Record<string, unknown>): Promise<void> {
    const itemId = typeof call.id === 'string' && call.id ? call.id : '';
    if (!itemId) { this.store.log('warn', 'Codex 请求发送飞书成品，但工具调用缺少标识。'); return; }
    const deliveryId = `${threadId}:${turnId}:${itemId}`;
    const argumentsValue = call.arguments && typeof call.arguments === 'object' && !Array.isArray(call.arguments) ? call.arguments as Record<string, unknown> : {};
    const requested = Array.isArray(argumentsValue.paths) ? argumentsValue.paths : [];
    let delivery = this.store.state.artifacts[deliveryId];
    if (delivery && delivery.status !== 'registered') return;
    if (!delivery) {
      const conversations = Object.values(this.store.state.conversations)
        .filter(item => item.chatId.startsWith('oc_') && this.store.config.allowedActors.includes(item.actorId))
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
      const operation = Object.values(this.store.state.operations).find(item => item.threadId === threadId && item.turnId === turnId);
      const recipient = (operation ? conversations.find(item => item.chatId === operation.chatId) : undefined)
        ?? conversations.find(item => item.threadId === threadId) ?? conversations[0];
      if (!recipient) { this.store.log('warn', 'Codex 请求发送飞书成品，但当前没有已授权的飞书私聊。'); return; }
      delivery = this.store.artifact(deliveryId, {
        threadId, turnId, itemId, chatId: recipient.chatId, actorId: recipient.actorId,
        requestedAt: new Date().toISOString(), paths: requested.filter((item): item is string => typeof item === 'string').slice(0, MAX_ARTIFACTS + 1), status: 'registered',
      });
    }
    if (!this.transport) return;
    if (!this.store.config.allowedActors.includes(delivery.actorId)) {
      this.store.artifact(deliveryId, { status: 'failed', results: [] });
      this.store.log('warn', '飞书成品未发送：接收账号的授权已经撤销。');
      return;
    }
    this.store.artifact(deliveryId, { status: 'sending' });
    const recipient = { chatId: delivery.chatId, actorId: delivery.actorId };
    const deliveryPaths: unknown[] = delivery.paths;
    const results: ArtifactDeliveryResult[] = [];
    const seen = new Set<string>();
    if (deliveryPaths.length < 1 || deliveryPaths.length > MAX_ARTIFACTS) {
      results.push({ path: '', name: '文件列表', kind: 'file', status: 'failed', error: `一次只能发送 1 到 ${MAX_ARTIFACTS} 个文件` });
    } else for (const value of deliveryPaths) {
      let filePath = typeof value === 'string' ? value.trim() : '';
      let name = filePath ? path.basename(filePath) : '无效路径';
      let kind: 'image' | 'file' = ARTIFACT_IMAGE_EXTENSIONS.has(path.extname(filePath).toLowerCase()) ? 'image' : 'file';
      try {
        if (!filePath || /[*?]/.test(filePath) || !path.isAbsolute(filePath)) throw new Error('必须使用不含通配符的绝对文件路径');
        const linkInfo = await fs.promises.lstat(filePath);
        if (!linkInfo.isFile() || linkInfo.isSymbolicLink()) throw new Error('不是可发送的普通文件');
        filePath = await fs.promises.realpath(filePath);
        name = path.basename(filePath);
        kind = ARTIFACT_IMAGE_EXTENSIONS.has(path.extname(filePath).toLowerCase()) ? 'image' : 'file';
        if (seen.has(filePath.toLowerCase())) continue;
        seen.add(filePath.toLowerCase());
        const info = await fs.promises.stat(filePath);
        const limit = kind === 'image' ? MAX_ARTIFACT_IMAGE_BYTES : MAX_ARTIFACT_FILE_BYTES;
        if (info.size <= 0) throw new Error('文件为空');
        if (info.size > limit) throw new Error(`超过 ${limit / 1024 / 1024} MB 上限`);
        const messageId = kind === 'image'
          ? await this.transport.sendImage(recipient.chatId, filePath)
          : await this.transport.sendFile(recipient.chatId, filePath);
        results.push({ path: filePath, name, kind, status: 'sent', messageId });
      } catch (error) {
        results.push({ path: filePath, name, kind, status: 'failed', error: errorText(error).slice(0, 200) });
      }
    }
    const sent = results.filter(item => item.status === 'sent').length;
    const failed = results.length - sent;
    const status = failed === 0 ? 'sent' as const : sent === 0 ? 'failed' as const : 'partial' as const;
    this.store.artifact(deliveryId, { status, results });
    const detail = results.map(item => `${item.status === 'sent' ? '✓' : '✗'} ${item.name}${item.error ? `：${item.error}` : ''}`).join('\n');
    try {
      const summaryMessageId = await this.transport.sendCard(recipient.chatId, {
        title: status === 'sent' ? '成品已发送' : status === 'partial' ? '部分成品发送失败' : '成品发送失败',
        tone: status === 'sent' ? 'green' : status === 'partial' ? 'orange' : 'red',
        text: `${detail}\n\n共 ${results.length} 个，成功 ${sent} 个，失败 ${failed} 个。`,
      });
      this.store.artifact(deliveryId, { summaryMessageId });
      this.store.log(status === 'sent' ? 'info' : 'warn', `飞书成品发送完成 · 成功 ${sent} · 失败 ${failed} · ${threadId.slice(0, 8)}`);
    } catch (error) {
      this.store.artifact(deliveryId, { status: 'uncertain' });
      throw error;
    }
  }
  private isBridgeTurn(threadId: string, turnId: string): boolean {
    return Object.values(this.store.state.operations).some(operation => operation.threadId === threadId
      && (operation.turnId === turnId || (!operation.turnId && this.flights.has(operation.id))));
  }
  private async registerCompletionNotification(threadId: string, turnId: string, call: Record<string, unknown>, automatic = false): Promise<CompletionNotification | undefined> {
    if (this.isBridgeTurn(threadId, turnId) || this.store.state.deliveries[`desktop-notification:${threadId}:${turnId}`]) return;
    const conversations = Object.values(this.store.state.conversations)
      .filter(item => item.chatId.startsWith('oc_') && this.store.config.allowedActors.includes(item.actorId))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    const recipient = conversations.find(item => item.threadId === threadId) ?? conversations[0];
    if (!recipient) { this.store.log('warn', 'Codex 请求了飞书完成通知，但当前没有已授权的飞书私聊。'); return; }
    const argumentsValue = call.arguments && typeof call.arguments === 'object' && !Array.isArray(call.arguments) ? call.arguments as Record<string, unknown> : {};
    const summary = typeof argumentsValue.summary === 'string' ? argumentsValue.summary.trim().slice(0, 200) : '';
    let cwd = recipient.cwd;
    let sessionTitle = recipient.title;
    try {
      const info = await this.codex.threadInfo?.(threadId);
      if (automatic && (!info || info.isUserThread === false)) return;
      if (info) { cwd = info.cwd; sessionTitle = info.title; }
    } catch (error) {
      if (automatic) { this.store.log('warn', `桌面自动通知暂时无法读取会话信息：${errorText(error)}`); return; }
      this.store.log('warn', `完成通知暂时无法读取会话信息，将使用已有绑定：${errorText(error)}`);
    }
    if (this.isBridgeTurn(threadId, turnId) || (automatic && !this.store.config.autoNotifyDesktop)) return;
    if (!cwd || !path.isAbsolute(cwd)) { this.store.log('warn', 'Codex 请求了飞书完成通知，但无法确认任务所属项目。'); return; }
    const notification = this.store.notification(crypto.randomUUID(), {
      threadId, turnId, chatId: recipient.chatId, actorId: recipient.actorId, cwd,
      title: summary || sessionTitle || `会话 ${threadId.slice(0, 8)}`, sessionTitle, automatic,
      requestedAt: new Date().toISOString(), status: 'registered',
    });
    this.store.log('info', `已登记桌面任务完成通知 · ${path.basename(cwd)} · ${threadId.slice(0, 8)}`);
    return notification;
  }
  private async deliverCompletionNotification(notification: CompletionNotification, outcome: 'completed' | 'failed' | 'interrupted'): Promise<void> {
    if (notification.status !== 'registered') return;
    if (this.isBridgeTurn(notification.threadId, notification.turnId) || (notification.automatic && !this.store.config.autoNotifyDesktop)) {
      this.store.notification(notification.id, { status: 'cancelled', outcome });
      return;
    }
    if (!this.transport) return;
    if (!this.store.config.allowedActors.includes(notification.actorId)) return;
    if (!notification.result) {
      const history = await this.codex.history(notification.threadId).catch(() => []);
      const answers = history.filter(item => item.turnId === notification.turnId && item.role === 'assistant');
      const final = answers.filter(item => item.phase === 'final_answer');
      const text = (final.length ? final : answers.filter(item => item.phase !== 'commentary')).map(item => item.text).join('\n');
      if (text) notification = this.store.notification(notification.id, { result: cleanBridgeText(text).slice(0, 600) });
    }
    if (this.isBridgeTurn(notification.threadId, notification.turnId) || (notification.automatic && !this.store.config.autoNotifyDesktop)) {
      this.store.notification(notification.id, { status: 'cancelled', outcome }); return;
    }
    if (!this.transport || !this.store.config.allowedActors.includes(notification.actorId)) return;
    if (notification.automatic && this.store.config.desktopNotificationMode === 'long' && notification.timing?.durationMs === undefined) {
      const timing = await this.codex.turnTiming?.(notification.threadId, notification.turnId).catch(() => undefined);
      if (timing && Object.keys(timing).length) notification = this.store.notification(notification.id, { timing: { ...notification.timing, ...timing } });
    }
    if (this.isBridgeTurn(notification.threadId, notification.turnId) || (notification.automatic && !this.store.config.autoNotifyDesktop)) {
      this.store.notification(notification.id, { status: 'cancelled', outcome }); return;
    }
    if (!this.transport || !this.store.config.allowedActors.includes(notification.actorId)) return;
    if (notification.automatic && this.store.config.desktopNotificationMode === 'long') {
      const duration = turnDuration(notification.timing);
      if (duration === undefined || duration <= this.store.config.desktopNotificationMinMinutes * 60_000) {
        this.store.notification(notification.id, { status: 'skipped', skipReason: duration === undefined ? 'timing-unavailable' : 'short', outcome });
        if (duration === undefined) this.store.log('warn', `未发送桌面自动通知：无法确认本轮任务耗时 · ${notification.threadId.slice(0, 8)}`);
        return;
      }
    }
    const deliveryKey = `desktop-notification:${notification.threadId}:${notification.turnId}`;
    if (!this.store.claimDelivery(deliveryKey)) return;
    const labels = outcome === 'completed'
      ? { title: '桌面任务已完成', state: '已完成', tone: 'green' as const }
      : outcome === 'failed' ? { title: '桌面任务未完成', state: '执行失败', tone: 'red' as const }
        : { title: '桌面任务已停止', state: '已停止', tone: 'orange' as const };
    try {
      const messageId = await this.transport.sendCard(notification.chatId, {
        title: labels.title, tone: labels.tone,
        text: `任务：${notification.title}\n项目：${path.basename(notification.cwd)}${notification.sessionTitle && notification.sessionTitle !== notification.title ? `\n会话：${notification.sessionTitle}` : ''}\n状态：${labels.state}${notification.result ? `\n\n${notification.result}` : ''}`,
        buttons: [{ label: '切换到此会话', command: `/notification ${notification.id}`, primary: true }],
      });
      this.store.finishDelivery(deliveryKey, 'sent');
      this.store.notification(notification.id, { status: 'sent', outcome, completedAt: new Date().toISOString(), messageId });
      this.store.log('info', `桌面任务完成通知已发送 · ${path.basename(notification.cwd)} · ${notification.threadId.slice(0, 8)}`);
    } catch (error) {
      this.store.finishDelivery(deliveryKey, 'uncertain');
      this.store.notification(notification.id, { status: 'uncertain', outcome, completedAt: new Date().toISOString() });
      throw error;
    }
  }
  subscribe(listener: (event: BridgeEvent) => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  private emit(event: BridgeEvent): void { for (const listener of this.listeners) { try { listener(event); } catch { /* Views cannot stop work. */ } } }
  async watch(chatId: string): Promise<void> {
    const conversation = this.store.state.conversations[chatId];
    if (conversation && this.pendingNewThreads.has(`${chatId}:${conversation.revision ?? 0}`)) return;
    const threadId = conversation?.threadId;
    if (threadId) await this.codex.watch?.(threadId);
  }
  submit(message: InboundMessage): Promise<void> {
    const pending = this.submissionPromises.get(message.id);
    if (pending) return pending;
    const promise = new Promise<void>((resolve, reject) => {
      const finish = () => { this.accepting.delete(message.id); this.submissionPromises.delete(message.id); resolve(); };
      const fail = (error: unknown) => { this.accepting.delete(message.id); this.submissionPromises.delete(message.id); reject(error); };
      this.accepting.set(message.id, { resolve: finish, reject: fail });
      queueMicrotask(() => { void this.receive(message).then(finish, fail); });
    });
    this.submissionPromises.set(message.id, promise);
    return promise;
  }
  hasActiveWork(): boolean { return this.notificationEvents.size > 0 || this.flights.size > 0 || [...this.queues.values()].some(queue => queue.active) || this.conversations().some(item => item.busy); }
  async stopActor(actorId: string): Promise<void> {
    const targets = new Set<string>();
    for (const flight of this.flights.values()) if (flight.message.actorId === actorId) {
      flight.queue.cancelled = true;
      if (flight.target.threadId) targets.add(flight.target.threadId);
    }
    for (const item of Object.values(this.store.state.conversations)) if (item.actorId === actorId && this.queues.has(item.chatId)) await this.stop(item.chatId);
    for (const request of this.requests.values()) if (request.actorId === actorId) this.resolveRequest(request, { decision: 'decline', answers: {} }, '账号授权已撤销');
    await Promise.all([...targets].map(id => this.codex.stop(id)));
  }
  private async assertMessageMayWrite(message: InboundMessage): Promise<void> {
    const checkActor = () => { if (message.chatId !== 'local-preview' && !this.store.config.allowedActors.includes(message.actorId)) throw new UserError('这个飞书账号的授权已撤销，消息没有发送。', 403); };
    checkActor(); await this.discovery.assertCanWrite?.(); checkActor();
  }
  private boundBusy(conversation: Conversation): boolean {
    return Boolean(this.queues.get(conversation.chatId)?.active || (conversation.threadId && this.runtimeStates.get(conversation.threadId)?.busy)
      || [...this.flights.values()].some(flight => flight.target.chatId === conversation.chatId && flight.target.revision === conversation.revision && flight.target.threadId === conversation.threadId));
  }

  conversations() {
    return Object.values(this.store.state.conversations).map((item) => ({
      ...item, revision: item.revision ?? 0, busy: this.boundBusy(item), queued: this.queues.get(item.chatId)?.items.length ?? 0,
      activeTurnId: item.threadId ? this.runtimeStates.get(item.threadId)?.turnId : undefined,
      progress: item.threadId && this.runtimeStates.get(item.threadId)?.busy ? this.runtimeStates.get(item.threadId)?.progress : undefined,
      startedAt: item.threadId && this.runtimeStates.get(item.threadId)?.busy ? this.runtimeStates.get(item.threadId)?.startedAt : undefined,
      lastActivityAt: item.threadId && this.runtimeStates.get(item.threadId)?.busy ? this.runtimeStates.get(item.threadId)?.lastActivityAt : undefined
    })).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }
  pendingRequests() {
    return [...this.requests.values()].map(({ resolve, timer, ...item }) => item);
  }
  async history(chatId: string): Promise<{ messages: ChatMessage[]; source: string; threadId?: string }> {
    const conversation = this.store.state.conversations[chatId];
    const messages = [...(this.store.state.history[chatId] ?? [])];
    if (conversation?.threadId) for (const item of this.streamed.get(conversation.threadId)?.values() ?? []) {
      const index = messages.findIndex(message => message.id === item.id);
      if (index >= 0) messages[index] = item;
      else if (item.text) messages.push(item);
    }
    const fallback = { messages, source: 'bridge', threadId: conversation?.threadId };
    if (!conversation?.threadId) return fallback;
    if (this.pendingNewThreads.has(`${chatId}:${conversation.revision ?? 0}`)) return fallback;
    const threadId = conversation.threadId;
    const key = `${threadId}:${conversation.updatedAt}`;
    const cached = this.historyCache.get(chatId);
    if (cached?.key === key && cached.until > Date.now()) return cached.promise;
    const entry = { key, until: Date.now() + 1_000, promise: undefined as unknown as Promise<{ messages: ChatMessage[]; source: string; threadId?: string }> };
    const promise = this.codex.history(threadId).then((history) => {
      const messages: ChatMessage[] = history.map((item, index) => ({
        id: item.id ?? `${threadId}:${index}`, role: item.role, turnId: item.turnId, phase: item.phase,
        text: item.role === 'user' ? cleanBridgeText(item.text) : item.text,
        at: item.at || ''
      }));
      if (!messages.length) messages.push(...fallback.messages);
      for (const item of this.streamed.get(threadId)?.values() ?? []) {
        const index = messages.findIndex(message => message.id === item.id);
        if (index >= 0) messages[index] = item;
        else if (item.text) messages.push(item);
      }
      return { messages, source: 'codex', threadId };
    }).catch((error) => {
      if (isThreadInitializationRace(errorText(error))) entry.until = Date.now() + 100;
      return fallback;
    });
    entry.promise = promise;
    this.historyCache.set(chatId, entry);
    return promise;
  }
  async receive(message: InboundMessage): Promise<void> {
    if (this.closing) return;
    if (message.localOnly && message.chatId !== 'local-preview') {
      const current = this.store.state.conversations[message.chatId];
      if (!current) throw new UserError('这条飞书对话不存在，请刷新页面。', 404);
      if (current.actorId !== message.actorId || !this.store.config.allowedActors.includes(current.actorId)) throw new UserError('这条飞书对话的账号尚未授权。', 403);
    }
    if (message.chatId === message.actorId) {
      const saved = Object.values(this.store.state.conversations).filter((item) => item.actorId === message.actorId && item.chatId.startsWith('oc_')).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
      if (saved) message = { ...message, chatId: saved.chatId };
    } else if (message.chatId.startsWith('oc_') && !this.store.state.conversations[message.chatId]) {
      const menuConversation = this.store.state.conversations[message.actorId];
      if (menuConversation) {
        this.store.state.conversations[message.chatId] = { ...menuConversation, chatId: message.chatId };
        this.store.state.history[message.chatId] = this.store.state.history[message.actorId] ?? [];
        delete this.store.state.conversations[message.actorId];
        delete this.store.state.history[message.actorId];
        this.store.save();
      }
    }
    const initial = this.store.state.conversations[message.chatId];
    if (initial) this.checkRevision(initial, message.expectedRevision);
    if (message.expectedThreadId !== undefined && initial?.threadId !== message.expectedThreadId) throw new UserError('当前任务已切换，请刷新后重新发送。', 409);
    const allowed = message.chatId === 'local-preview' || this.store.config.allowedActors.includes(message.actorId);
    const receiptTarget = allowed ? { ...this.store.conversation(message.chatId, message.actorId) } : undefined;
    if (allowed && !/^\/[a-z]+(?:\s|$)/i.test(message.text.trim())) {
      try { await this.assertMessageMayWrite(message); }
      catch (error) {
        if (message.localOnly || message.chatId === 'local-preview') throw error;
        await this.reply(message.chatId, errorText(error), '暂时无法发送');
        return;
      }
      // UI writes carry the displayed revision; reject a stale view after a slow guard.
      this.checkRevision(this.store.conversation(message.chatId), message.expectedRevision);
    }
    if (!this.store.claim(message.id)) return;
    if (message.chatId !== 'local-preview' && !this.store.config.allowedActors.includes(message.actorId)) {
      if (this.store.pendingActor(message.actorId, message.chatId)) {
        await this.transport?.sendText(message.chatId, `请先在本机管理页授权这个飞书账号。\n账号：${message.actorId}`);
        this.store.log('warn', `收到待授权账号的访问请求：${message.actorId}`);
      }
      return;
    }
    this.store.conversation(message.chatId, message.actorId);
    try {
      const command = /^\/([a-z]+)(?:\s+([\s\S]*))?\s*$/i.exec(message.text.trim());
      if (command) {
        await this.command(message, command[1]!.toLowerCase(), command[2]?.trim() ?? '');
        return;
      }
      if (!message.text.trim() && !message.images?.length && !message.files?.length) return;
      if (this.changingContext.has(message.chatId)) throw new UserError('正在切换项目或会话，请稍后重新发送。');
      const target = receiptTarget ?? { ...this.store.conversation(message.chatId) };
      this.validateWorkspace(target.cwd);
      this.store.operation(message.id, { chatId: message.chatId, actorId: message.actorId, cwd: target.cwd, threadId: target.threadId, revision: target.revision ?? 0, source: message.localOnly || message.chatId === 'local-preview' ? 'management' : 'feishu', status: 'received' });
      this.accepting.get(message.id)?.resolve();
      if (this.codex.supportsSteering) {
        this.store.message(message.chatId, 'user', message.text || '[附件]', target.revision ?? 0);
        await this.runConcurrent(message, target);
        return;
      }
      const queue = this.queues.get(message.chatId) ?? { active: false, cancelled: false, items: [] };
      this.queues.set(message.chatId, queue);
      if (queue.items.length >= 5) throw new UserError('当前排队消息较多，请等回复后继续，或发送 /stop 停止。');
      this.store.message(message.chatId, 'user', message.text || '[附件]', target.revision ?? 0);
      const completion = new Promise<void>((resolve) => queue.items.push({ message, target, resolve }));
      if (queue.active) await this.reply(message.chatId, '消息已排队，会在当前回复完成后继续。', undefined, undefined, message.localOnly);
      else void this.drain(message.chatId, queue);
      await completion;
    } catch (error) {
      this.accepting.get(message.id)?.reject(error);
      if (this.store.state.operations[message.id]?.status === 'received') this.store.operation(message.id, { status: 'failed', error: errorText(error) });
      await this.reply(message.chatId, errorText(error), '操作未完成', undefined, message.localOnly);
      this.store.log('warn', errorText(error));
    }
  }
  private async drain(chatId: string, queue: Queue): Promise<void> {
    queue.active = true;
    while (queue.items.length && !this.closing) {
      const work = queue.items.shift()!;
      queue.cancelled = false;
      // Legacy standalone runtimes serialize because each turn owns an app-server.
      if (!work.target.threadId && work.target.revision === this.store.conversation(chatId).revision) work.target.threadId = this.store.conversation(chatId).threadId;
      queue.current = this.run(work.message, queue, work.target);
      try { await queue.current; } catch (error) { this.store.log('error', errorText(error)); }
      finally { work.resolve(); queue.current = undefined; queue.threadId = undefined; }
    }
    queue.active = false;
    this.queues.delete(chatId);
  }
  private async runConcurrent(message: InboundMessage, target: Conversation): Promise<void> {
    const queue: Queue = { active: true, cancelled: false, items: [] };
    const key = `${message.chatId}:${target.revision ?? 0}`;
    const creating = !target.threadId ? this.creatingThreads.get(key) : undefined;
    const initializesThread = !target.threadId && !creating;
    let ready!: (threadId: string | undefined) => void;
    const threadReady = new Promise<string | undefined>(resolve => { ready = resolve; });
    if (initializesThread) {
      this.creatingThreads.set(key, threadReady);
      this.pendingNewThreads.add(key);
    }
    this.flights.set(message.id, { message, target, queue });
    this.emit({ type: 'state', chatId: message.chatId });
    try {
      if (creating) {
        target.threadId = await creating;
        if (!target.threadId) throw new UserError('上一条消息未能建立任务，本条消息未发送，请重新发送。');
      }
      queue.current = this.run(message, queue, target, ready);
      await queue.current;
    } finally {
      ready(target.threadId);
      if (this.creatingThreads.get(key) === threadReady) this.creatingThreads.delete(key);
      if (initializesThread) this.pendingNewThreads.delete(key);
      this.flights.delete(message.id);
      this.emit({ type: 'state', chatId: message.chatId });
    }
  }
  private async run(message: InboundMessage, queue: Queue, conversation: Conversation, ready?: (threadId: string | undefined) => void): Promise<void> {
    const chatId = message.chatId;
    const transport = message.localOnly || chatId === 'local-preview' ? undefined : this.transport;
    let progressId: string | undefined;
    let lastProgress = 0;
    let progressChain = Promise.resolve();
    let ownedThread: string | undefined;
    const typing = transport?.startTyping(message.id).catch(() => async () => {});
    const startedAt = Date.now();
    const closeProgress = async (card: MessageCard): Promise<void> => {
      if (!progressId || !transport) return;
      try { await transport.updateCard(progressId, card); }
      catch (error) { this.store.log('warn', `进度卡片收尾失败：${errorText(error)}`); }
    };
    try {
      await this.assertMessageMayWrite(message);
      if (conversation.threadId && !this.codex.supportsSteering) {
        if (this.threadOwners.has(conversation.threadId)) throw new UserError('这个 Codex 会话正在另一条飞书对话中执行，请等它完成后重试。');
        this.threadOwners.set(conversation.threadId, chatId);
        ownedThread = conversation.threadId;
      }
      if (transport && this.store.config.progress) {
        progressId = await transport.sendCard(chatId, { title: 'Codex 正在处理', text: '已收到消息，正在接续会话。', buttons: [{ label: '停止', command: `/stop rev ${conversation.revision ?? 0}` }] }).catch(() => undefined);
      }
      this.store.log('info', `开始处理 · ${path.basename(conversation.cwd)} · ${chatId}`);
      const result = await this.codex.run({
        cwd: conversation.cwd, threadId: conversation.threadId,
        prompt: buildPrompt(message), images: message.images,
        model: conversation.model || this.store.config.model || undefined,
        effort: conversation.effort || this.store.config.effort || undefined,
        onThread: (threadId) => {
          conversation.threadId = threadId;
          ready?.(threadId);
          queue.threadId = threadId;
          ownedThread = threadId;
          if (!this.codex.supportsSteering) this.threadOwners.set(threadId, chatId);
          if (this.isCurrentTarget(conversation)) this.store.conversation(chatId).threadId = threadId;
          this.store.operation(message.id, { threadId });
          this.store.save();
          if (queue.cancelled) void this.codex.stop(threadId).catch(() => {});
        },
        onBeforeSubmit: () => this.assertMessageMayWrite(message),
        onSubmitted: (event) => {
          this.store.operation(message.id, { threadId: event.threadId, turnId: event.turnId, mode: event.mode, status: event.status === 'rejected' ? 'failed' : event.status });
          this.emit({ type: 'state', chatId, threadId: event.threadId });
        },
        onProgress: (text) => {
          if (!progressId || !transport || !this.store.config.allowedActors.includes(message.actorId) || Date.now() - lastProgress < 4000 || queue.cancelled) return;
          lastProgress = Date.now();
          const cardId = progressId;
          progressChain = progressChain.then(() => transport.updateCard(cardId, {
            title: 'Codex 正在处理', text: text.slice(0, 2500), buttons: [{ label: '停止', command: `/stop rev ${conversation.revision ?? 0}` }]
          })).catch(() => {});
        },
        onRequest: (request) => this.requestUser(message, request)
      });
      conversation.threadId = result.threadId;
      const completedKey = `${result.threadId}:${result.turnId ?? message.id}`;
      if (this.store.claimCompletion(`turn:${completedKey}`)) this.store.state.totalTurns++;
      this.store.save();
      await progressChain;
      const text = result.text.trim() || (queue.cancelled ? '已停止当前任务。' : '本轮已完成，没有文本回复。');
      this.store.operation(message.id, { threadId: result.threadId, turnId: result.turnId, status: 'completed' });
      if (this.store.claimCompletion(`chat:${chatId}:${completedKey}`) && this.isCurrentTarget(conversation)) this.store.message(chatId, 'assistant', text);
      this.historyCache.delete(chatId);
      this.emit({ type: 'history', chatId, threadId: result.threadId });
      if (transport && this.store.config.allowedActors.includes(message.actorId)) {
        const deliveryKey = `${chatId}:${result.threadId}:${result.turnId ?? message.id}`;
        if (!this.store.claimDelivery(deliveryKey)) {
          await closeProgress({ title: '本轮已结束', text: '补充消息已合并到本轮回复。', tone: 'green' });
          return;
        }
        try {
          const chunks = splitReply(text);
          const first: MessageCard = { title: queue.cancelled ? '已停止' : 'Codex', text: chunks.shift()!, tone: queue.cancelled ? 'orange' : 'green' };
          await transport.sendCard(chatId, first);
          for (const chunk of chunks) await transport.sendCard(chatId, { title: 'Codex · 续', text: chunk });
          for (const image of result.images ?? []) await transport.sendImage(chatId, image);
          this.store.finishDelivery(deliveryKey, 'sent');
        } catch (error) {
          this.store.finishDelivery(deliveryKey, 'uncertain');
          const notice = `任务已完成，但飞书回复的送达状态不确定，未自动重发。${errorText(error)}`;
          this.store.log('warn', notice);
          if (this.isCurrentTarget(conversation)) this.store.message(chatId, 'system', notice);
          await closeProgress({ title: '回复送达未确认', text: '本轮已结束，回复送达状态不确定。可在本机管理页查看结果。', tone: 'orange' });
          return;
        }
        await closeProgress({ title: queue.cancelled ? '已停止' : '已完成', text: '本轮回复已发送，请查看下方新消息。', tone: queue.cancelled ? 'orange' : 'green' });
      }
      this.store.log('info', `完成回复 · ${Math.round((Date.now() - startedAt) / 1000)} 秒 · ${chatId}`);
    } catch (error) {
      await progressChain;
      const text = queue.cancelled ? '已停止当前任务。' : errorText(error);
      const operation = this.store.state.operations[message.id];
      this.store.operation(message.id, { status: operation?.status === 'submitting' || operation?.status === 'submitted' || operation?.status === 'uncertain' ? 'uncertain' : operation?.status === 'completed' ? 'completed' : 'failed', error: text });
      if (this.isCurrentTarget(conversation)) this.store.message(chatId, 'system', text);
      this.store.log(queue.cancelled ? 'info' : 'error', text);
      if (transport && this.store.config.allowedActors.includes(message.actorId)) {
        const card: MessageCard = { title: queue.cancelled ? '已停止' : '本轮未完成', text, tone: queue.cancelled ? 'orange' : 'red' };
        const deliveryKey = `error:${chatId}:${conversation.threadId ?? ''}:${operation?.turnId ?? message.id}`;
        if (this.store.claimDelivery(deliveryKey)) {
          try {
            await transport.sendCard(chatId, card);
            this.store.finishDelivery(deliveryKey, 'sent');
          } catch (deliveryError) {
            this.store.finishDelivery(deliveryKey, 'uncertain');
            this.store.log('warn', `终态消息送达未确认，未自动重发：${errorText(deliveryError)}`);
          }
        }
        const delivered = this.store.state.deliveries[deliveryKey]?.status === 'sent';
        await closeProgress({
          title: card.title, tone: card.tone,
          text: delivered ? '本轮已结束，请查看下方新消息。' : '本轮已结束，通知送达状态未确认。可在本机管理页查看详情。'
        });
      }
    } finally {
      if (ownedThread) this.threadOwners.delete(ownedThread);
      this.finishRequests(chatId, '本轮已结束', message.id);
      if (typing) void typing.then((clear) => clear()).catch(() => {});
    }
  }
  private isCurrentTarget(target: Conversation): boolean {
    const current = this.store.state.conversations[target.chatId];
    return Boolean(current && current.cwd === target.cwd && (current.revision ?? 0) === (target.revision ?? 0));
  }
  private checkRevision(conversation: Conversation, revision?: number): void {
    if (revision !== undefined && revision !== (conversation.revision ?? 0)) throw new UserError('项目或任务已在其他入口切换，请刷新后重试。', 409);
  }
  async bind(chatId: string, cwd: string, threadId?: string, expectedRevision?: number): Promise<void> {
    this.checkRevision(this.store.conversation(chatId), expectedRevision);
    if (this.changingContext.has(chatId)) throw new UserError('正在切换上下文，请稍后重试。', 409);
    this.changingContext.add(chatId);
    try {
      cwd = this.validateWorkspace(cwd);
      let selected: ThreadSummary | undefined;
      if (threadId) {
        selected = (await this.discovery.threads(cwd)).find((session) => session.id === threadId);
        if (!selected) throw new UserError('该会话不属于所选项目，请刷新列表后重试。');
      }
      const conversation = this.store.conversation(chatId);
      this.checkRevision(conversation, expectedRevision);
      const previousThreadId = conversation.threadId;
      // Each runtime process is released after its turn. An idle chat must not release
      // a shared thread that another chat may currently be using.
      if (!threadId || conversation.threadId !== threadId || conversation.cwd !== cwd) this.store.state.history[chatId] = [];
      Object.assign(conversation, {
        cwd, threadId, revision: (conversation.revision ?? 0) + 1, title: selected?.title || (threadId ? `会话 ${threadId.slice(0, 8)}` : '新会话'),
        preview: selected?.preview || '', updatedAt: new Date().toISOString()
      });
      this.historyCache.delete(chatId);
      this.store.save();
      this.store.log('info', `切换上下文 · ${path.basename(cwd)} · ${threadId?.slice(0, 8) ?? '新会话'}`);
      if (previousThreadId && previousThreadId !== threadId && !Object.values(this.store.state.conversations).some(item => item.threadId === previousThreadId)) void this.codex.unwatch?.(previousThreadId).catch(() => {});
      void this.watch(chatId).catch(() => {});
    } finally { this.changingContext.delete(chatId); }
  }
  async newConversation(chatId: string, cwd?: string, expectedRevision?: number): Promise<void> {
    await this.bind(chatId, cwd || this.store.conversation(chatId).cwd, undefined, expectedRevision);
  }
  async stop(chatId: string, expectedRevision?: number): Promise<void> {
    const conversation = this.store.conversation(chatId);
    this.checkRevision(conversation, expectedRevision);
    if (this.codex.supportsSteering) {
      for (const flight of this.flights.values()) if (flight.target.chatId === chatId && this.isCurrentTarget(flight.target)) flight.queue.cancelled = true;
      for (const request of this.requests.values()) {
        const operation = request.operationId ? this.store.state.operations[request.operationId] : undefined;
        if (operation && request.chatId === chatId && operation.threadId === conversation.threadId && operation.revision === (conversation.revision ?? 0)) this.resolveRequest(request, { decision: 'decline', answers: {} }, '已停止');
      }
      if (conversation.threadId) await this.codex.stop(conversation.threadId);
      return;
    }
    const queue = this.queues.get(chatId);
    if (!queue) return;
    queue.cancelled = true;
    for (const work of queue.items.splice(0)) work.resolve();
    this.finishRequests(chatId, '已停止');
    if (queue.threadId) await this.codex.stop(queue.threadId);
  }
  async answer(id: string, answer: RuntimeAnswer, actor?: { chatId: string; actorId: string }): Promise<void> {
    const request = this.requests.get(id);
    if (!request) {
      const resolved = this.finishedRequests.get(id);
      if (resolved && (!actor || (resolved.chatId === actor.chatId && resolved.actorId === actor.actorId))) return;
      throw new UserError('这个请求已经失效，请以最新卡片为准。');
    }
    if (actor && (request.actorId !== actor.actorId || request.chatId !== actor.chatId)) throw new UserError('这个请求不属于当前账号或对话。', 403);
    if (request.kind === 'question') {
      if (!request.questions?.every((question) => answer.answers?.[question.id]?.answers.some((text) => text.trim()))) throw new UserError('请填写所有问题的回答。');
    } else if (!answer.decision) throw new UserError('请选择同意或拒绝。');
    this.resolveRequest(request, answer, request.kind === 'question' ? '已提交回答' : answer.decision === 'accept' ? '已同意' : '已拒绝');
  }
  private resolveRequest(request: PendingRequest, answer: RuntimeAnswer, title: string): void {
    this.requests.delete(request.id);
    clearTimeout(request.timer);
    this.finishedRequests.set(request.id, { chatId: request.chatId, actorId: request.actorId, text: title });
    if (this.finishedRequests.size > 200) this.finishedRequests.delete(this.finishedRequests.keys().next().value!);
    request.resolve(answer);
    if (request.messageId && !request.localOnly && request.chatId !== 'local-preview') {
      void this.transport?.updateCard(request.messageId, { title, text: request.text, tone: 'green' }).catch((error) => this.store.log('warn', `卡片更新失败：${errorText(error)}`));
    }
    this.store.log('info', `${title} · ${request.chatId}`);
  }
  private finishRequests(chatId: string, title: string, operationId?: string) {
    for (const request of this.requests.values()) if (request.chatId === chatId && (!operationId || request.operationId === operationId)) this.resolveRequest(request, { decision: 'decline', answers: {} }, title);
  }
  private async requestUser(message: InboundMessage, raw: RuntimeRequest): Promise<RuntimeAnswer> {
    if (message.chatId !== 'local-preview' && !this.store.config.allowedActors.includes(message.actorId)) return { decision: 'decline', answers: {} };
    const id = crypto.randomUUID();
    return new Promise<RuntimeAnswer>((resolve) => {
      const request: PendingRequest = {
        ...raw, id, chatId: message.chatId, actorId: message.actorId, operationId: message.id, localOnly: message.localOnly, createdAt: new Date().toISOString(), resolve,
        timer: setTimeout(() => this.resolveRequest(request, { decision: 'decline', answers: {} }, '请求已超时'), 10 * 60_000)
      };
      this.requests.set(id, request);
      const questionText = raw.questions?.map((question) => `${question.question}${question.options?.length ? '\n' + question.options.map((option) => `• ${option.label}`).join('\n') : ''}`).join('\n\n') ?? '';
      const text = [raw.text, questionText, raw.kind === 'question' ? `回复 /answer ${id} 你的回答（多题请在管理页填写）` : ''].filter(Boolean).join('\n\n');
      if (!message.localOnly && message.chatId !== 'local-preview') {
        void this.transport?.sendCard(message.chatId, {
          title: raw.title, text, tone: 'orange',
          ...(raw.kind === 'approval' ? { buttons: [{ label: '同意', command: `/approve ${id}`, primary: true }, { label: '拒绝', command: `/reject ${id}` }] } : {})
        }).then((messageId) => {
          request.messageId = messageId;
          if (!this.requests.has(id)) return this.transport?.updateCard(messageId, { title: '请求已处理', text: raw.text });
        }).catch((error) => this.store.log('warn', `请求卡片发送失败，可在管理页处理：${errorText(error)}`));
      }
    });
  }
  private async command(message: InboundMessage, name: string, arg: string): Promise<void> {
    if (message.localOnly) throw new UserError('本地试聊请直接发送文字；切换项目、会话、新建和停止请使用页面按钮。');
    const { chatId } = message;
    const conversation = this.store.conversation(chatId);
    switch (name) {
      case 'help':
        return this.reply(chatId, '/project 选择项目\n/session 选择历史会话\n/new 新建会话\n/stop 停止当前任务\n/model 切换模型\n/effort 切换推理强度\n/usage 查看套餐余量\n/status 当前状态\n\n直接发送消息即可与 Codex 对话。', '飞书里的 Codex', message.actionMessageId);
      case 'usage': {
        if (arg) throw new UserError('直接发送 /usage 即可查看套餐余量，此命令不执行额度重置或购买。');
        if (!this.codex.usage) throw new UserError('当前 Codex 后端暂不支持查询套餐余量。');
        const usage = await this.codex.usage();
        return this.card(chatId, {
          title: 'Codex 套餐余量', text: formatUsage(usage),
          buttons: [{ label: '刷新余量', command: '/usage' }],
        }, message.actionMessageId);
      }
      case 'notification': {
        const notification = this.store.state.notifications[arg];
        if (!notification || notification.chatId !== chatId || notification.actorId !== message.actorId) throw new UserError('这个通知不属于当前账号或对话。', 403);
        if (!this.store.config.allowedActors.includes(message.actorId)) throw new UserError('这个飞书账号的授权已撤销。', 403);
        await this.bind(chatId, notification.cwd, notification.threadId);
        return this.reply(chatId, `${notification.title}\n项目：${path.basename(notification.cwd)}\n下一条消息会接着这个会话继续。`, '已切换到通知对应的会话', message.actionMessageId);
      }
      case 'status': {
        let selected: ThreadSummary | undefined;
        if (conversation.threadId) {
          try { selected = (await this.discovery.threads(conversation.cwd)).find((session) => session.id === conversation.threadId); }
          catch { /* Status still reports the saved human-readable summary when discovery is temporarily unavailable. */ }
          if (selected && (conversation.title !== selected.title || conversation.preview !== selected.preview)) {
            conversation.title = selected.title;
            conversation.preview = selected.preview;
            this.store.save();
          }
        }
        const sessionTitle = conversation.threadId ? selected?.title || conversation.title || '未命名会话' : '新会话（下一条消息会创建）';
        const sessionPreview = (selected?.preview || conversation.preview || '').trim();
        const updatedAt = selected?.updatedAt ? formatStatusTime(selected.updatedAt) : '';
        const details = [
          `项目：${path.basename(conversation.cwd)}`,
          `目录：${conversation.cwd}`,
          `会话：${sessionTitle}`,
          ...(sessionPreview && sessionPreview !== sessionTitle ? [`最近内容：${sessionPreview.slice(0, 120)}`] : []),
          ...(updatedAt ? [`最近更新：${updatedAt}`] : []),
          `模型：${conversation.model || this.store.config.model || '沿用本机设置'}`,
          `推理强度：${conversation.effort || this.store.config.effort || '沿用本机设置'}`,
          `状态：${this.boundBusy(conversation) ? '正在处理' : '空闲'}`,
        ];
        return this.reply(chatId, details.join('\n'), '当前对话', message.actionMessageId);
      }
      case 'project': {
        const pageMatch = /^page\s+(\d+)$/.exec(arg);
        if (arg && !pageMatch) {
          const stablePath = arg.startsWith('path ') ? decodeURIComponent(arg.slice(5)) : undefined;
          const choice = stablePath
            ? (await this.discovery.projects()).find((project) => path.resolve(project.path).toLowerCase() === path.resolve(stablePath).toLowerCase())
            : this.projectChoices.get(chatId)?.[Number(arg.replace(/^P/i, '')) - 1];
          if (!choice) throw new UserError('请先发送 /project，再选择列表中的项目。');
          await this.bind(chatId, choice.path);
          return this.reply(chatId, `${choice.name}\n${choice.path}\n\n发送 /session 续接已有会话，或直接发消息开始新会话。`, '已切换项目', message.actionMessageId);
        }
        const choices = await this.discovery.projects();
        this.projectChoices.set(chatId, choices);
        const page = Math.max(0, Number(pageMatch?.[1] ?? 1) - 1);
        const visible = choices.slice(page * 8, (page + 1) * 8);
        return this.card(chatId, { title: '选择项目', text: visible.length ? visible.map((project, index) => `**P${page * 8 + index + 1} · ${project.name}**\n${project.path}`).join('\n\n') : '没有发现项目。可在管理页设置默认工作目录。', buttons: [
          ...visible.map((project, index) => ({ label: `P${page * 8 + index + 1} ${project.name}`.slice(0, 35), command: `/project path ${encodeURIComponent(project.path)}` })),
          ...(page > 0 ? [{ label: '上一页', command: `/project page ${page}` }] : []),
          ...(choices.length > (page + 1) * 8 ? [{ label: '下一页', command: `/project page ${page + 2}` }] : [])
        ] }, message.actionMessageId);
      }
      case 'session': case 'sessions': {
        const pageMatch = /^page\s+(\d+)$/.exec(arg);
        if (arg && !pageMatch) {
          const choice = arg.startsWith('id ')
            ? (await this.discovery.threads(conversation.cwd)).find((session) => session.id === arg.slice(3))
            : this.sessionChoices.get(chatId)?.[Number(arg.replace(/^S/i, '')) - 1];
          if (!choice) throw new UserError('请先发送 /session，再选择列表中的会话。');
          await this.bind(chatId, conversation.cwd, choice.id);
          return this.reply(chatId, `${choice.title}\n下一条消息会接着这个会话继续。`, '已切换会话', message.actionMessageId);
        }
        const choices = await this.discovery.threads(conversation.cwd);
        this.sessionChoices.set(chatId, choices);
        const page = Math.max(0, Number(pageMatch?.[1] ?? 1) - 1);
        const visible = choices.slice(page * 8, (page + 1) * 8);
        return this.card(chatId, { title: `${path.basename(conversation.cwd)} · 选择会话`, text: visible.length ? visible.map((session, index) => `**S${page * 8 + index + 1} · ${session.title}**\n${session.preview.slice(0, 100)}`).join('\n\n') : '当前项目还没有历史会话。', buttons: [
          ...visible.map((session, index) => ({ label: `S${page * 8 + index + 1} ${session.title}`.slice(0, 35), command: `/session id ${session.id}` })),
          { label: '新建会话', command: '/new', primary: true },
          ...(page > 0 ? [{ label: '上一页', command: `/session page ${page}` }] : []),
          ...(choices.length > (page + 1) * 8 ? [{ label: '下一页', command: `/session page ${page + 2}` }] : [])
        ] }, message.actionMessageId);
      }
      case 'new':
        await this.newConversation(chatId);
        return this.reply(chatId, `项目：${path.basename(conversation.cwd)}\n下一条消息将开始新的 Codex 会话。`, '新会话已就绪', message.actionMessageId);
      case 'stop':
        if (arg && !/^rev \d+$/.test(arg)) throw new UserError('停止按钮无效，请发送 /stop 停止当前任务。');
        await this.stop(chatId, arg ? Number(arg.slice(4)) : undefined);
        return this.reply(chatId, '已请求停止当前绑定的任务。', '停止请求已提交', message.actionMessageId);
      case 'model': {
        this.requireIdle(chatId);
        if (arg) {
          const stableId = arg.startsWith('id ') ? decodeURIComponent(arg.slice(3)) : undefined;
          const choice = arg === 'default' ? '' : stableId
            ? (await this.codex.models()).find((model) => model.id === stableId)?.id
            : this.modelChoices.get(chatId)?.[Number(arg.replace(/^M/i, '')) - 1];
          if (choice === undefined) throw new UserError('请先发送 /model，并选择列表中的模型。');
          conversation.model = choice;
          conversation.effort = '';
          this.store.save();
          return this.reply(chatId, choice || '沿用本机 Codex 配置', '已切换模型', message.actionMessageId);
        }
        const models = await this.codex.models();
        this.modelChoices.set(chatId, models.map((model) => model.id));
        return this.card(chatId, { title: '选择模型', text: `当前：${conversation.model || this.store.config.model || '沿用本机配置'}`, buttons: [...models.slice(0, 12).map((model) => ({ label: model.name, command: `/model id ${encodeURIComponent(model.id)}` })), { label: '沿用本机配置', command: '/model default' }] }, message.actionMessageId);
      }
      case 'effort': {
        this.requireIdle(chatId);
        const efforts = ['minimal', 'low', 'medium', 'high', 'xhigh'];
        if (arg) {
          if (arg !== 'default' && !efforts.includes(arg)) throw new UserError('请选择列表中的推理强度。');
          conversation.effort = arg === 'default' ? '' : arg;
          this.store.save();
          return this.reply(chatId, conversation.effort || '沿用本机配置', '已设置推理强度', message.actionMessageId);
        }
        return this.card(chatId, { title: '推理强度', text: '模型会校验支持的强度。', buttons: [...efforts.map((effort) => ({ label: effort, command: `/effort ${effort}` })), { label: '默认', command: '/effort default' }] }, message.actionMessageId);
      }
      case 'approve': case 'reject': case 'deny':
        if (!this.requests.has(arg) && message.actionMessageId) {
          await this.card(chatId, { title: '请求已处理或失效', text: '这个按钮已经不可用，请以最新请求为准。' }, message.actionMessageId);
          return;
        }
        await this.answer(arg, { decision: name === 'approve' ? 'accept' : 'decline' }, message);
        return;
      case 'answer': {
        const space = arg.indexOf(' ');
        const id = arg.slice(0, space);
        const request = this.requests.get(id);
        if (!request || space < 1) throw new UserError('请按照最新问题卡片中的格式回复。');
        if (request.questions?.length !== 1) throw new UserError('这次有多个问题，请在本机管理页填写回答。');
        await this.answer(id, { answers: { [request.questions[0]!.id]: { answers: [arg.slice(space + 1)] } } }, message);
        return;
      }
      default:
        return this.reply(chatId, '没有这个命令。发送 /help 查看项目、会话和停止等操作；普通问题直接发送即可。');
    }
  }
  private async reply(chatId: string, text: string, title = 'Feishu Codex', messageId?: string, localOnly = false): Promise<void> {
    this.store.message(chatId, 'system', text);
    if (localOnly) return;
    await this.card(chatId, { title, text }, messageId);
  }
  private async card(chatId: string, card: MessageCard, messageId?: string): Promise<void> {
    if (chatId === 'local-preview') {
      if (card.buttons?.length) this.store.message(chatId, 'system', [card.text, ...card.buttons.map((button) => `${button.label}：${button.command}`)].join('\n'));
      return;
    }
    if (!this.transport) throw new UserError('飞书连接尚未启动。');
    if (messageId) await this.transport.updateCard(messageId, card);
    else await this.transport.sendCard(chatId, card);
  }
  private requireIdle(chatId: string): void {
    if (this.boundBusy(this.store.conversation(chatId))) throw new UserError('当前会话正在处理消息，请等回复完成，或先发送 /stop 再切换。', 409);
  }
  private validateWorkspace(cwd: string): string {
    if (!cwd || !path.isAbsolute(cwd) || !fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) throw new UserError('项目目录不存在，请在管理页选择一个有效的本机目录。');
    return path.resolve(cwd);
  }
  async close(): Promise<void> {
    this.closing = true;
    this.unsubscribeRuntime?.(); this.unsubscribeStore?.();
    await Promise.allSettled([...this.notificationEvents.values()]);
    for (const chatId of this.queues.keys()) await this.stop(chatId).catch(() => {});
    await this.codex.close();
    await Promise.allSettled([...this.queues.values()].map((queue) => queue.current));
    await Promise.allSettled([...this.flights.values()].map(flight => flight.queue.current));
  }
}

export function buildPrompt(message: InboundMessage): string {
  const context = message.localOnly || message.chatId === 'local-preview' ? '【本地预览】仅在管理页回复；' : '【飞书消息】回复自动转发；';
  return `${context}请遵循 feishu-codex Skill。\n\n${message.text}${message.files?.length ? '\n\n用户随消息附带的本地文件：\n' + message.files.map((file) => JSON.stringify(file)).join('\n') : ''}`;
}

export function splitReply(text: string, limit = 4500): string[] {
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > limit) {
    let cut = remaining.lastIndexOf('\n', limit);
    if (cut < limit / 2) cut = limit;
    if (/^[\uDC00-\uDFFF]$/.test(remaining[cut] ?? '')) cut--;
    chunks.push(remaining.slice(0, cut)); remaining = remaining.slice(cut);
  }
  if (remaining || !chunks.length) chunks.push(remaining);
  return chunks;
}

export function errorText(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (isThreadWriterConflict(message)) return THREAD_WRITER_MESSAGE;
  if (/already.*(?:running|active)|thread.*busy/i.test(message)) return '这个 Codex 会话正在处理另一条消息，请等待完成或先停止。';
  return message.slice(0, 1800);
}

function formatStatusTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(date).replace('/', '-');
}
