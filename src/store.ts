import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import type { ArtifactDelivery, BotProfile, BridgeConfig, ChatMessage, CompletionNotification, Conversation, GroupMessage, InboundMessage, LogEntry, Operation } from './types.js';
import { conversationKey, DEFAULT_BOT_ID, parseRoute } from './routing.js';
import { normalizeGroupWorkspace, planGroupContext, type GroupContextPlan } from './group-context.js';

type PendingActor = { actorId: string; chatId: string; botId?: string; lastSeenAt: string };
type PendingGroup = { botId: string; chatId: string; actorId: string; lastSeenAt: string; title?: string };
type BotIdentity = { appId: string; openId: string; name: string };
type GroupActorIdentity = {
  botId: string; appId: string; actorId: string; tenantKey?: string; unionId?: string; userId?: string;
  messageIds: string[]; updatedAt: string;
};
type SavedState = {
  version: 1; conversations: Record<string, Conversation>; history: Record<string, ChatMessage[]>;
  pendingActors: PendingActor[]; seen: Record<string, number>; logs: LogEntry[];
  totalTurns: number; dailyMessages: Record<string, number>;
  operations: Record<string, Operation>; deliveries: Record<string, { status: 'sending' | 'sent' | 'uncertain'; at: string }>;
  completedTurns: Record<string, string>;
  groupContextReceipts: Record<string, { seen: Record<string, number>; updatedAt: string }>;
  notifications: Record<string, CompletionNotification>;
  artifacts: Record<string, ArtifactDelivery>;
  pendingGroups: PendingGroup[]; groupMessages: Record<string, GroupMessage[]>; groupProjects: Record<string, string>;
  botIdentities: Record<string, BotIdentity>; groupActorIdentities: Record<string, GroupActorIdentity[]>;
  threadBindings: Record<string, { chatId: string; actorId: string; cwd: string; chatType: 'p2p' | 'group'; roleManaged?: boolean; roleInstructions?: string; groupHandoffPolicyVersion?: number }>;
};

export function defaultDataDir(): string {
  return process.env.FEISHU_CODEX_DATA_DIR || path.join(os.homedir(), '.feishu-codex');
}

export class Store {
  private listeners = new Set<() => void>();
  readonly dir: string;
  config: BridgeConfig;
  state: SavedState;
  constructor(dir = defaultDataDir()) {
    this.dir = path.resolve(dir);
    fs.mkdirSync(this.dir, { recursive: true });
    this.config = readJson(path.join(dir, 'config.json'), {
      appId: '', appSecret: '', enabled: false, allowedActors: [],
      defaultWorkspace: process.cwd(), model: '', effort: '', progress: true, autoNotifyDesktop: false,
      desktopNotificationMode: 'all', desktopNotificationMinMinutes: 1
    } satisfies BridgeConfig);
    this.state = readJson(path.join(dir, 'state.json'), {
      version: 1, conversations: {}, history: {}, pendingActors: [], seen: {},
      logs: [], totalTurns: 0, dailyMessages: {}, operations: {}, deliveries: {}, completedTurns: {}, notifications: {}, artifacts: {},
      pendingGroups: [], groupMessages: {}, groupProjects: {}, threadBindings: {}, botIdentities: {}, groupActorIdentities: {}, groupContextReceipts: {}
    } satisfies SavedState);
    for (const conversation of Object.values(this.state.conversations)) conversation.revision ??= 0;
    // A process restart cannot prove whether an in-flight mutation reached Codex.
    // Keep its message identity permanently claimed; recovery only reads history.
    for (const operation of Object.values(this.state.operations)) {
      if (operation.status === 'submitting' || operation.status === 'submitted') operation.status = 'uncertain';
      else if (operation.status === 'received') operation.status = 'failed';
    }
    for (const delivery of Object.values(this.state.deliveries)) if (delivery.status === 'sending') delivery.status = 'uncertain';
    this.state.notifications ??= {};
    this.state.artifacts ??= {};
    for (const artifact of Object.values(this.state.artifacts)) if (artifact.status === 'sending') artifact.status = 'uncertain';
  }
  saveConfig(patch: Partial<BridgeConfig>): void {
    const previousApps = new Map(this.bots().map(bot => [bot.id, bot.appId]));
    this.config = { ...this.config, ...patch };
    let identitiesChanged = false;
    for (const [botId, appId] of previousApps) if (this.bot(botId)?.appId !== appId) identitiesChanged = this.clearBotIdentities(botId) || identitiesChanged;
    this.atomicWrite('config.json', this.config);
    if (identitiesChanged) this.atomicWrite('state.json', this.state);
    this.emit();
  }
  save(): void { this.atomicWrite('state.json', this.state); this.emit(); }
  subscribe(listener: () => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  private emit(): void { for (const listener of this.listeners) { try { listener(); } catch { /* Persistence must not depend on a UI subscriber. */ } } }
  publicConfig() {
    const { appSecret, bots: _bots, ...safe } = this.config;
    return { ...safe, hasSecret: Boolean(appSecret) };
  }
  conversation(chatId: string, actorId = '', cwd = this.config.defaultWorkspace, chatType?: 'p2p' | 'group'): Conversation {
    const route = parseRoute(chatId);
    const group = chatType === 'group' || this.isGroup(chatId);
    let conversation = this.state.conversations[chatId];
    if (!conversation) {
      conversation = {
        chatId, actorId, cwd: group ? this.state.groupProjects[route.id] ?? cwd : cwd, title: '新会话', revision: 0,
        botId: route.botId, rawChatId: route.id, chatType: group ? 'group' : 'p2p',
        updatedAt: new Date().toISOString(), preview: ''
      };
      this.state.conversations[chatId] = conversation;
      this.save();
    }
    if (chatType && conversation.chatType !== chatType) { conversation.chatType = chatType; this.save(); }
    return conversation;
  }
  message(chatId: string, role: ChatMessage['role'], text: string, expectedRevision?: number): void {
    if (expectedRevision !== undefined && (this.state.conversations[chatId]?.revision ?? 0) !== expectedRevision) {
      if (role === 'user') { this.countInbound(); this.save(); }
      return;
    }
    const history = this.state.history[chatId] ??= [];
    const firstUserMessage = role === 'user' && !history.some((item) => item.role === 'user');
    history.push({ id: crypto.randomUUID(), role, text, at: new Date().toISOString() });
    if (history.length > 100) history.splice(0, history.length - 100);
    const conversation = this.state.conversations[chatId];
    if (conversation) {
      conversation.updatedAt = new Date().toISOString();
      if (role === 'user') {
        conversation.preview = text.slice(0, 140);
        if (!conversation.threadId && firstUserMessage) conversation.title = Array.from(text.replace(/\s+/g, ' ').trim()).slice(0, 80).join('') || '新会话';
      }
    }
    if (role === 'user') this.countInbound();
    this.save();
  }
  private countInbound(): void {
    const today = localDay();
    this.state.dailyMessages[today] = (this.state.dailyMessages[today] ?? 0) + 1;
    const days = Object.keys(this.state.dailyMessages).sort();
    for (const day of days.slice(0, -30)) delete this.state.dailyMessages[day];
  }
  claim(id: string): boolean {
    if (this.state.operations[id]) return false;
    const now = Date.now();
    if (this.state.seen[id] && now - this.state.seen[id] < 24 * 60 * 60_000) return false;
    this.state.seen[id] = now;
    this.state.seen = Object.fromEntries(Object.entries(this.state.seen)
      .filter(([, at]) => now - at < 24 * 60 * 60_000).sort((a, b) => b[1] - a[1]).slice(0, 10_000));
    this.save();
    return true;
  }
  operation(id: string, patch: Partial<Operation>): void {
    const existing = this.state.operations[id];
    const at = new Date().toISOString();
    const operation = this.state.operations[id] = { ...existing, ...patch, id, at: existing?.at ?? at, updatedAt: at } as Operation;
    if (operation.status === 'submitted' || operation.status === 'completed') this.mergeGroupContextReceipt(operation);
    this.save();
  }
  claimDelivery(key: string): boolean {
    if (this.state.deliveries[key]) return false;
    this.state.deliveries[key] = { status: 'sending', at: new Date().toISOString() };
    this.save();
    return true;
  }
  claimCompletion(key: string): boolean {
    if (this.state.completedTurns[key]) return false;
    this.state.completedTurns[key] = new Date().toISOString();
    this.save();
    return true;
  }
  finishDelivery(key: string, status: 'sent' | 'uncertain'): void {
    this.state.deliveries[key] = { status, at: new Date().toISOString() };
    this.save();
  }
  notification(id: string, patch: Partial<CompletionNotification>): CompletionNotification {
    const existing = this.state.notifications[id];
    this.state.notifications[id] = { ...existing, ...patch, id } as CompletionNotification;
    const ordered = Object.values(this.state.notifications).sort((a, b) => b.requestedAt.localeCompare(a.requestedAt));
    this.state.notifications = Object.fromEntries(ordered.slice(0, 300).map(item => [item.id, item]));
    this.save();
    return this.state.notifications[id]!;
  }
  artifact(id: string, patch: Partial<ArtifactDelivery>): ArtifactDelivery {
    const existing = this.state.artifacts[id];
    this.state.artifacts[id] = { ...existing, ...patch, id } as ArtifactDelivery;
    const ordered = Object.values(this.state.artifacts).sort((a, b) => b.requestedAt.localeCompare(a.requestedAt));
    this.state.artifacts = Object.fromEntries(ordered.slice(0, 300).map(item => [item.id, item]));
    this.save();
    return this.state.artifacts[id]!;
  }
  pendingActor(actorId: string, chatId: string, botId = parseRoute(chatId).botId): boolean {
    const old = this.state.pendingActors.find((item) => item.actorId === actorId && (item.botId ?? DEFAULT_BOT_ID) === botId);
    const notify = !old || Date.now() - Date.parse(old.lastSeenAt) > 5 * 60_000;
    if (old) Object.assign(old, { chatId, lastSeenAt: new Date().toISOString() });
    else this.state.pendingActors.push({ actorId, chatId, botId, lastSeenAt: new Date().toISOString() });
    this.state.pendingActors = this.state.pendingActors.slice(-100);
    this.save();
    return notify;
  }
  authorize(actorId: string, allow: boolean, botId = DEFAULT_BOT_ID): void {
    const bot = this.bot(botId);
    if (!bot) throw new Error('机器人不存在');
    const allowedActors = bot.allowedActors.filter((id) => id !== actorId);
    if (allow) allowedActors.push(actorId);
    this.saveBot(botId, { allowedActors });
    this.state.pendingActors = this.state.pendingActors.filter((actor) => actor.actorId !== actorId || (actor.botId ?? DEFAULT_BOT_ID) !== botId);
    this.save();
    this.log('info', `${allow ? '已授权' : '已撤销授权'} ${actorId}`);
  }
  log(level: LogEntry['level'], text: string): void {
    let safe = text;
    for (const bot of this.bots()) if (bot.appSecret) safe = safe.split(bot.appSecret).join('[已隐藏]');
    safe = safe.replace(/(Bearer\s+)[A-Za-z0-9._-]+/gi, '$1[已隐藏]');
    this.state.logs.unshift({ id: crypto.randomUUID(), at: new Date().toISOString(), level, text: safe.slice(0, 1500) });
    this.state.logs = this.state.logs.slice(0, 200);
    this.save();
    process.stdout.write(`[${new Date().toISOString()}] [${level}] ${safe.slice(0, 1500)}\n`);
  }
  private atomicWrite(name: string, value: unknown): void {
    const target = path.join(this.dir, name);
    const temporary = `${target}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(value, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(temporary, target);
  }

  bots(): BotProfile[] {
    return [{ id: DEFAULT_BOT_ID, name: this.config.botName || 'Codex', appId: this.config.appId, appSecret: this.config.appSecret,
      enabled: this.config.enabled, allowedActors: this.config.allowedActors, allowedGroups: this.config.allowedGroups ?? [],
      roleInstructions: this.config.roleInstructions ?? '', model: this.config.model, effort: this.config.effort }, ...(this.config.bots ?? [])];
  }
  bot(id = DEFAULT_BOT_ID): BotProfile | undefined { return this.bots().find(bot => bot.id === id); }
  botForChat(chatId: string): BotProfile | undefined { return this.bot(parseRoute(chatId).botId); }
  publicBots() { return this.bots().map(({ appSecret, ...bot }) => ({ ...bot, hasSecret: Boolean(appSecret) })); }
  saveBot(id: string, patch: Partial<BotProfile>): void {
    const previous = this.bot(id);
    const next: BotProfile = { name: 'Codex', appId: '', appSecret: '', enabled: false, allowedActors: [], allowedGroups: [],
      roleInstructions: '', model: '', effort: '', ...previous, ...patch, id };
    if (!/^[a-zA-Z0-9_-]{1,80}$/.test(id)) throw new Error('无效的机器人编号');
    if (next.appId && this.bots().some(bot => bot.id !== id && bot.appId === next.appId)) throw new Error('这个飞书应用已经配置过，每个应用只能连接一次');
    if (id === DEFAULT_BOT_ID) {
      this.saveConfig({ botName: next.name, appId: next.appId, appSecret: next.appSecret, enabled: next.enabled,
        allowedActors: next.allowedActors, allowedGroups: next.allowedGroups, roleInstructions: next.roleInstructions, model: next.model, effort: next.effort });
    } else this.saveConfig({ bots: [...(this.config.bots ?? []).filter(bot => bot.id !== id), next] });
  }
  removeBot(id: string): void {
    if (id === DEFAULT_BOT_ID) throw new Error('默认机器人不能删除，可以关闭连接');
    this.saveConfig({ bots: (this.config.bots ?? []).filter(bot => bot.id !== id) });
    this.state.pendingActors = this.state.pendingActors.filter(actor => actor.botId !== id);
    this.state.pendingGroups = this.state.pendingGroups.filter(group => group.botId !== id);
    this.save();
  }
  resetBotBindings(botId: string): void {
    this.clearBotIdentities(botId);
    for (const [key] of Object.entries(this.state.conversations)) if (key !== 'local-preview' && parseRoute(key).botId === botId) {
      delete this.state.conversations[key]; delete this.state.history[key];
    }
    this.state.pendingActors = this.state.pendingActors.filter(item => (item.botId ?? DEFAULT_BOT_ID) !== botId);
    this.state.pendingGroups = this.state.pendingGroups.filter(item => item.botId !== botId);
    for (const key of Object.keys(this.state.groupMessages)) {
      if (this.state.groupMessages[key]!.some(item => item.botId === botId)) delete this.state.groupMessages[key];
    }
    for (const notification of Object.values(this.state.notifications)) if (parseRoute(notification.chatId).botId === botId && notification.status === 'registered') notification.status = 'cancelled';
    for (const artifact of Object.values(this.state.artifacts)) if (parseRoute(artifact.chatId).botId === botId && artifact.status === 'registered') artifact.status = 'failed';
    this.save();
  }
  rememberThread(conversation: Conversation, roleInstructions?: string): void {
    if (!conversation.threadId) return;
    const previous = this.state.threadBindings[conversation.threadId];
    this.state.threadBindings[conversation.threadId] = { chatId: conversation.chatId, actorId: conversation.actorId, cwd: conversation.cwd,
      chatType: this.isGroup(conversation.chatId) ? 'group' : 'p2p',
      roleManaged: previous?.roleManaged || roleInstructions !== undefined,
      roleInstructions: previous?.roleInstructions ?? roleInstructions,
      ...(previous?.groupHandoffPolicyVersion !== undefined ? { groupHandoffPolicyVersion: previous.groupHandoffPolicyVersion } : {}) };
  }
  isGroup(chatId: string): boolean {
    const route = parseRoute(chatId);
    return this.state.conversations[chatId]?.chatType === 'group'
      || this.bot(route.botId)?.allowedGroups.includes(route.id) === true
      || this.state.pendingGroups.some(group => group.botId === route.botId && group.chatId === route.id);
  }
  isAuthorized(chatId: string, actorId: string, chatType?: 'p2p' | 'group'): boolean {
    if (chatId === 'local-preview') return true;
    const route = parseRoute(chatId);
    const bot = this.bot(route.botId);
    return Boolean(bot?.allowedActors.includes(actorId) && (!(chatType === 'group' || this.isGroup(chatId)) || bot.allowedGroups.includes(route.id)));
  }
  pendingGroup(botId: string, chatId: string, actorId: string): boolean {
    const old = this.state.pendingGroups.find(group => group.botId === botId && group.chatId === chatId);
    const notify = !old || Date.now() - Date.parse(old.lastSeenAt) > 5 * 60_000;
    if (old) Object.assign(old, { actorId, lastSeenAt: new Date().toISOString() });
    else this.state.pendingGroups.push({ botId, chatId, actorId, lastSeenAt: new Date().toISOString() });
    this.state.pendingGroups = this.state.pendingGroups.slice(-100);
    this.save(); return notify;
  }
  authorizeGroup(botId: string, chatId: string, allow: boolean): void {
    const bot = this.bot(botId);
    if (!bot) throw new Error('机器人不存在');
    const allowedGroups = bot.allowedGroups.filter(id => id !== chatId);
    if (allow) allowedGroups.push(chatId);
    this.saveBot(botId, { allowedGroups });
    this.state.pendingGroups = this.state.pendingGroups.filter(group => group.botId !== botId || group.chatId !== chatId);
    this.save();
  }
  observeGroup(message: InboundMessage): void {
    if (message.localOnly || message.chatType !== 'group' || !this.isAuthorized(message.chatId, message.actorId, 'group')) return;
    const identityChanged = this.recordActorIdentity(message);
    const route = parseRoute(message.chatId);
    const persisted = this.rememberGroup({ id: message.id, chatId: route.id, botId: route.botId, sender: message.senderName || message.actorId,
      role: 'user', text: message.text, at: message.at || new Date().toISOString(), replyTo: message.replyTo,
      cwd: this.state.groupProjects[route.id] ?? this.state.conversations[message.chatId]?.cwd ?? this.config.defaultWorkspace });
    if (identityChanged && !persisted) this.save();
  }
  rememberGroup(message: GroupMessage): boolean {
    if (!message.text.trim()) return false;
    const journal = this.state.groupMessages[message.chatId] ??= [];
    // A human message may be delivered to every configured bot. Store the shared event once.
    const id = message.role === 'user' ? parseRoute(message.id).id : message.id;
    if (journal.some(item => item.id === id)) return false;
    journal.push({ ...message, id, text: message.text.slice(0, 12000) });
    if (journal.length > 100) journal.splice(0, journal.length - 100);
    const groups = Object.entries(this.state.groupMessages).sort((a, b) => (b[1].at(-1)?.at ?? '').localeCompare(a[1].at(-1)?.at ?? ''));
    for (const [key] of groups.slice(100)) delete this.state.groupMessages[key];
    let characters = Object.values(this.state.groupMessages).reduce((total, items) => total + items.reduce((sum, item) => sum + item.text.length, 0), 0);
    for (const [key, items] of groups.reverse()) {
      if (!this.state.groupMessages[key]) continue;
      while (characters > 2_000_000 && items.length) characters -= items.shift()!.text.length;
      if (!items.length) delete this.state.groupMessages[key];
    }
    this.save();
    return true;
  }
  groupContextKey(chatId: string, cwd: string, threadId: string): string {
    const route = parseRoute(chatId);
    return JSON.stringify([route.botId, this.bot(route.botId)?.appId ?? '', route.id, normalizeGroupWorkspace(cwd), threadId]);
  }
  planGroupContext(message: InboundMessage, cwd: string, threadId?: string): GroupContextPlan {
    if (!this.isGroup(message.chatId) || !this.isAuthorized(message.chatId, message.actorId)) return { text: '', seen: {} };
    const known = threadId ? this.state.groupContextReceipts[this.groupContextKey(message.chatId, cwd, threadId)]?.seen : undefined;
    return planGroupContext(this.state.groupMessages[parseRoute(message.chatId).id] ?? [], message, cwd, known, threadId);
  }
  groupContext(message: InboundMessage, cwd: string, threadId?: string): string {
    return this.planGroupContext(message, cwd, threadId).text;
  }
  confirmGroupContext(operationId: string): void {
    const operation = this.state.operations[operationId];
    if (operation && this.mergeGroupContextReceipt(operation)) this.save();
  }
  private mergeGroupContextReceipt(operation: Operation): boolean {
    const receipt = operation.groupContext;
    if (!receipt || receipt.confirmed || !operation.threadId
      || receipt.key !== this.groupContextKey(operation.chatId, operation.cwd, operation.threadId)) return false;
    const current = this.state.groupContextReceipts[receipt.key] ?? { seen: {}, updatedAt: '' };
    for (const [id, offset] of Object.entries(receipt.seen)) current.seen[id] = Math.max(current.seen[id] ?? 0, offset);
    // The source journal is bounded; receipts for evicted messages are no longer useful.
    const retained = new Set((this.state.groupMessages[parseRoute(operation.chatId).id] ?? []).map(item => item.id));
    current.seen = Object.fromEntries(Object.entries(current.seen).filter(([id]) => retained.has(id)));
    current.updatedAt = new Date().toISOString();
    this.state.groupContextReceipts[receipt.key] = current;
    receipt.confirmed = true;
    receipt.seen = {}; // The merged per-thread receipt owns confirmed offsets.
    return true;
  }

  rememberBotIdentity(botId: string, identity: { openId: string; name: string }): void {
    const bot = this.bot(botId);
    const openId = identityText(identity.openId);
    if (!bot?.appId || !openId) return;
    const value: BotIdentity = { appId: bot.appId, openId, name: identity.name.trim().slice(0, 100) };
    const previous = this.state.botIdentities[botId];
    if (previous?.appId === value.appId && previous.openId === value.openId && previous.name === value.name) return;
    this.state.botIdentities[botId] = value;
    this.save();
  }
  botIdentity(botId: string): BotIdentity | undefined {
    const value = this.state.botIdentities[botId];
    return value && this.bot(botId)?.appId === value.appId ? { ...value } : undefined;
  }
  /** Only the authenticated Feishu event path may supply actor identity evidence. */
  rememberActorIdentity(message: InboundMessage): void {
    if (this.recordActorIdentity(message)) this.save();
  }
  resolveGroupActor(sourceChatId: string, sourceActorId: string, targetBotId: string): string | undefined {
    if (!this.isGroup(sourceChatId) || !this.isAuthorized(sourceChatId, sourceActorId, 'group')) return;
    const sourceRoute = parseRoute(sourceChatId);
    const sourceBot = this.bot(sourceRoute.botId);
    const targetBot = this.bot(targetBotId);
    if (!sourceBot?.appId || !targetBot?.appId || !targetBot.allowedGroups.includes(sourceRoute.id)) return;
    const identities = this.state.groupActorIdentities[sourceRoute.id] ?? [];
    const sources = identities.filter(value => value.botId === sourceRoute.botId && value.actorId === sourceActorId && value.appId === sourceBot.appId);
    if (sources.length !== 1) return;
    const source = sources[0]!;
    const matches = identities.filter(value => value.botId === targetBotId && value.appId === targetBot.appId
      && this.isAuthorized(conversationKey(targetBotId, sourceRoute.id), value.actorId, 'group') && sameActor(source, value));
    return matches.length === 1 ? matches[0]!.actorId : undefined;
  }
  private recordActorIdentity(message: InboundMessage): boolean {
    if (message.localOnly || message.chatType !== 'group' || !this.isAuthorized(message.chatId, message.actorId, 'group')) return false;
    const route = parseRoute(message.chatId);
    const bot = this.bot(route.botId);
    const eventId = parseRoute(message.id).id;
    // Synthetic handoffs, menus and card callbacks cannot create identity links.
    if (!bot?.appId || !/^om_[a-zA-Z0-9_-]{1,180}$/.test(eventId)) return false;
    const tenantKey = identityText(message.actorTenantKey);
    const unionId = identityText(message.actorUnionId);
    const userId = identityText(message.actorUserId);
    const identities = this.state.groupActorIdentities[route.id] ??= [];
    const previous = identities.find(value => value.botId === route.botId && value.actorId === message.actorId && value.appId === bot.appId);
    const changedPrincipal = previous && ((tenantKey && previous.tenantKey && tenantKey !== previous.tenantKey)
      || (unionId && previous.unionId && unionId !== previous.unionId) || (userId && previous.userId && userId !== previous.userId));
    const evidence = changedPrincipal ? undefined : previous;
    const oldEvents = evidence?.messageIds ?? [];
    const sharedEvents = oldEvents.filter(id => identities.some(other => other.botId !== route.botId
      && other.appId === this.bot(other.botId)?.appId && other.messageIds.includes(id))).slice(-4);
    const recentEvents = [...oldEvents.filter(id => id !== eventId && !sharedEvents.includes(id)), eventId].slice(-(8 - sharedEvents.length));
    const next = {
      botId: route.botId, appId: bot.appId, actorId: message.actorId,
      tenantKey: tenantKey ?? evidence?.tenantKey, unionId: unionId ?? evidence?.unionId, userId: userId ?? evidence?.userId,
      // Preserve a small amount of proven cross-app evidence while bounding
      // recent samples; normal one-bot conversation should not undo pairing.
      messageIds: [...new Set([...sharedEvents, ...recentEvents])],
    };
    if (previous && previous.tenantKey === next.tenantKey && previous.unionId === next.unionId && previous.userId === next.userId
      && previous.messageIds.length === next.messageIds.length && previous.messageIds.every(id => next.messageIds.includes(id))) return false;
    const remaining = identities.filter(value => value.botId !== route.botId || value.actorId !== message.actorId);
    remaining.push({ ...next, updatedAt: new Date().toISOString() });
    this.state.groupActorIdentities[route.id] = remaining.slice(-200);
    const groups = Object.entries(this.state.groupActorIdentities).sort((a, b) => (b[1].at(-1)?.updatedAt ?? '').localeCompare(a[1].at(-1)?.updatedAt ?? ''));
    for (const [groupId] of groups.slice(100)) delete this.state.groupActorIdentities[groupId];
    return true;
  }
  private clearBotIdentities(botId: string): boolean {
    let changed = Boolean(this.state.botIdentities[botId]);
    delete this.state.botIdentities[botId];
    for (const [groupId, identities] of Object.entries(this.state.groupActorIdentities)) {
      const next = identities.filter(value => value.botId !== botId);
      if (next.length === identities.length) continue;
      changed = true;
      if (next.length) this.state.groupActorIdentities[groupId] = next;
      else delete this.state.groupActorIdentities[groupId];
    }
    return changed;
  }
}

function identityText(value: string | undefined): string | undefined {
  return value && /^[a-zA-Z0-9_-]{1,200}$/.test(value) ? value : undefined;
}

function sameActor(source: GroupActorIdentity, target: GroupActorIdentity): boolean {
  if (source.tenantKey && target.tenantKey && source.tenantKey !== target.tenantKey) return false;
  const sameTenant = Boolean(source.tenantKey && source.tenantKey === target.tenantKey);
  if (sameTenant && source.userId && target.userId && source.userId !== target.userId) return false;
  if (sameTenant && source.unionId && source.unionId === target.unionId) return true;
  if (sameTenant && source.userId && source.userId === target.userId) return true;
  // A globally unique message received by both app sockets proves the sender
  // relationship without guessing from names or one-entry allowlists.
  if (source.unionId && target.unionId && source.unionId !== target.unionId) return false;
  return source.messageIds.some(id => target.messageIds.includes(id));
}

function readJson<T>(file: string, fallback: T): T {
  if (!fs.existsSync(file)) return structuredClone(fallback);
  try { return { ...fallback, ...JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')) }; }
  catch { throw new Error(`无法读取本地配置 ${file}。请修复 JSON 或恢复备份，服务不会覆盖原文件。`); }
}

export function localDay(): string {
  const date = new Date();
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}
