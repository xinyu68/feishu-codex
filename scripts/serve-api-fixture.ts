import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { startServer } from '../src/server.js';
import { Store } from '../src/store.js';
import type { CodexRuntime, HistoryMessage, RuntimeEvent, ThreadSummary } from '../src/types.js';

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'feishu-codex-api-ui-'));
const first = path.join(directory, 'fixture-project');
const second = path.join(directory, 'second-project');
fs.mkdirSync(first); fs.mkdirSync(second);
const now = new Date().toISOString();
const sessions: ThreadSummary[] = [{ id: 'fixture-task', cwd: first, title: 'API 集成测试任务', preview: '隔离测试记录', updatedAt: now }];
const histories = new Map<string, HistoryMessage[]>([['fixture-task', [{ id: 'initial', role: 'assistant', text: '这是隔离后台的测试任务。' }]]]);
const listeners = new Set<(event: RuntimeEvent) => void>();
const watched = new Set<string>();
const seed = new Store(directory);
seed.saveConfig({ defaultWorkspace: first, enabled: false, allowedActors: ['ou_fixture'] });
Object.assign(seed.conversation('oc_fixture', 'ou_fixture'), { threadId: 'fixture-task', title: 'API 集成测试任务', revision: 1 });
seed.save();
const emit = (method: string, threadId: string, turnId: string, params: Record<string, unknown> = {}) => {
  for (const listener of listeners) listener({ method, threadId, turnId, params: { threadId, turnId, ...params } });
};
const runtime: CodexRuntime = {
  supportsSteering: true,
  subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
  async watch(threadId) {
    if (watched.has(threadId)) return;
    watched.add(threadId);
    emit('thread/status/changed', threadId, '', { status: { type: 'idle' } });
  },
  async run(input) {
    await input.onBeforeSubmit?.();
    const threadId = input.threadId || randomUUID();
    const turnId = randomUUID(); const itemId = randomUUID();
    if (!input.threadId) sessions.push({ id: threadId, cwd: input.cwd, title: '新的测试任务', preview: '', updatedAt: now });
    input.onThread?.(threadId);
    input.onSubmitted?.({ threadId, turnId, mode: 'start', status: 'submitted' });
    const history = histories.get(threadId) || [];
    histories.set(threadId, history);
    history.push({ id: randomUUID(), role: 'user', text: input.prompt, turnId });
    emit('turn/started', threadId, turnId, { turn: { id: turnId } });
    await new Promise(resolve => setTimeout(resolve, 250));
    emit('item/started', threadId, turnId, { item: { id: 'fixture-command', type: 'commandExecution', command: 'fixture-only' } });
    await new Promise(resolve => setTimeout(resolve, 800));
    emit('item/completed', threadId, turnId, { item: { id: 'fixture-command', type: 'commandExecution' } });
    emit('item/agentMessage/delta', threadId, turnId, { itemId, delta: '正在通过真实 API 检查实时回复…' });
    await new Promise(resolve => setTimeout(resolve, 1200));
    const text = 'API 与 SSE 已连通，收到你的测试消息。';
    history.push({ id: itemId, role: 'assistant', text, turnId });
    emit('item/completed', threadId, turnId, { item: { id: itemId, type: 'agentMessage', text, phase: 'final_answer' } });
    emit('turn/completed', threadId, turnId, { turn: { id: turnId, status: 'completed' } });
    return { threadId, turnId, text };
  },
  async stop() {}, async release() {}, async close() {},
  async history(threadId) { return structuredClone(histories.get(threadId) || []); },
  async models() { return []; }, async status() { return { available: true, authenticated: true, version: 'isolated-fixture' }; },
};
const app = await startServer({ port: 8796, dataDir: directory, codex: runtime, staticDir: path.resolve('build/ui'), feishu: {
  async verifyCredentials() {},
  createTransport(options) { return {
    async start() { options.onStatus('connected'); }, async close() { options.onStatus('stopped'); },
    async sendText() { return ''; }, async sendCard() { return ''; }, async sendImage() { return ''; }, async sendFile() { return ''; },
    async updateCard() {}, async startTyping() { return async () => {}; },
  }; },
}, discovery: {
  async projects() { return [first, second].map(cwd => ({ path: cwd, name: path.basename(cwd), threadCount: sessions.filter(item => item.cwd === cwd).length, lastActiveAt: now })); },
  async threads(cwd) { return sessions.filter(item => item.cwd === cwd); },
} });
let closing = false;
const close = async () => {
  if (closing) return; closing = true;
  await app.close();
  if (path.dirname(directory) === os.tmpdir() && path.basename(directory).startsWith('feishu-codex-api-ui-')) fs.rmSync(directory, { recursive: true, force: true });
};
process.once('SIGINT', () => { void close(); }); process.once('SIGTERM', () => { void close(); });
