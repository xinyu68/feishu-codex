import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import type { ArtifactDelivery, BridgeConfig, ChatMessage, CompletionNotification, Conversation, LogEntry, Operation } from './types.js';

type PendingActor = { actorId: string; chatId: string; lastSeenAt: string };
type SavedState = {
  version: 1; conversations: Record<string, Conversation>; history: Record<string, ChatMessage[]>;
  pendingActors: PendingActor[]; seen: Record<string, number>; logs: LogEntry[];
  totalTurns: number; dailyMessages: Record<string, number>;
  operations: Record<string, Operation>; deliveries: Record<string, { status: 'sending' | 'sent' | 'uncertain'; at: string }>;
  completedTurns: Record<string, string>;
  notifications: Record<string, CompletionNotification>;
  artifacts: Record<string, ArtifactDelivery>;
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
      logs: [], totalTurns: 0, dailyMessages: {}, operations: {}, deliveries: {}, completedTurns: {}, notifications: {}, artifacts: {}
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
    this.config = { ...this.config, ...patch };
    this.atomicWrite('config.json', this.config);
    this.emit();
  }
  save(): void { this.atomicWrite('state.json', this.state); this.emit(); }
  subscribe(listener: () => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  private emit(): void { for (const listener of this.listeners) { try { listener(); } catch { /* Persistence must not depend on a UI subscriber. */ } } }
  publicConfig() {
    const { appSecret, ...safe } = this.config;
    return { ...safe, hasSecret: Boolean(appSecret) };
  }
  conversation(chatId: string, actorId = '', cwd = this.config.defaultWorkspace): Conversation {
    let conversation = this.state.conversations[chatId];
    if (!conversation) {
      conversation = {
        chatId, actorId, cwd, title: '新会话', revision: 0,
        updatedAt: new Date().toISOString(), preview: ''
      };
      this.state.conversations[chatId] = conversation;
      this.save();
    }
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
    this.state.operations[id] = { ...existing, ...patch, id, at: existing?.at ?? at, updatedAt: at } as Operation;
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
  pendingActor(actorId: string, chatId: string): boolean {
    const old = this.state.pendingActors.find((item) => item.actorId === actorId);
    const notify = !old || Date.now() - Date.parse(old.lastSeenAt) > 5 * 60_000;
    if (old) Object.assign(old, { chatId, lastSeenAt: new Date().toISOString() });
    else this.state.pendingActors.push({ actorId, chatId, lastSeenAt: new Date().toISOString() });
    this.state.pendingActors = this.state.pendingActors.slice(-100);
    this.save();
    return notify;
  }
  authorize(actorId: string, allow: boolean): void {
    const allowedActors = this.config.allowedActors.filter((id) => id !== actorId);
    if (allow) allowedActors.push(actorId);
    this.saveConfig({ allowedActors });
    this.state.pendingActors = this.state.pendingActors.filter((actor) => actor.actorId !== actorId);
    this.save();
    this.log('info', `${allow ? '已授权' : '已撤销授权'} ${actorId}`);
  }
  log(level: LogEntry['level'], text: string): void {
    let safe = text;
    if (this.config.appSecret) safe = safe.split(this.config.appSecret).join('[已隐藏]');
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
