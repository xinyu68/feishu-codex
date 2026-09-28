import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { Bridge } from '../src/bridge.js';
import { Store } from '../src/store.js';
import { conversationKey, namespaceMessage, parseRoute } from '../src/routing.js';
import { cleanBridgeText } from '../src/discovery.js';
import type { CodexRunInput, CodexRuntime, InboundMessage, MessageCard, RuntimeEvent } from '../src/types.js';

const tick = () => new Promise<void>(resolve => setImmediate(resolve));
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
function setup(t: test.TestContext) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'group-bridge-'));
  const store = new Store(dir);
  store.saveConfig({ appId: 'cli_1234567890abcdef', allowedActors: ['pm-user'], allowedGroups: ['oc_team'], defaultWorkspace: dir,
    roleInstructions: '澄清需求，整理验收标准', botName: '产品经理', progress: false });
  store.saveBot('dev', { name: '开发', appId: 'cli_abcdef1234567890', allowedActors: ['dev-user'], allowedGroups: ['oc_team'], roleInstructions: '根据需求实现功能', model: 'dev-model', effort: 'high' });
  const runs: CodexRunInput[] = [];
  const sent: Array<{ chatId: string; card: MessageCard; id: string }> = [];
  const stopped: string[] = [];
  let listener: ((event: RuntimeEvent) => void) | undefined;
  let runner: (input: CodexRunInput) => Promise<{ threadId: string; text: string; turnId?: string }> = async input => {
    const threadId = input.threadId || `thread-${runs.length}`;
    input.onThread?.(threadId);
    input.onSubmitted?.({ threadId, turnId: `turn-${runs.length}`, mode: 'start', status: 'submitted' });
    return { threadId, text: runs.length === 1 ? '登录需求：验证码五分钟有效，错误三次锁定。' : '开发已完成', turnId: `turn-${runs.length}` };
  };
  const runtime: CodexRuntime = {
    supportsSteering: true, run: input => { runs.push(input); return runner(input); },
    async stop(id) { stopped.push(id); }, async release() {}, async close() {}, async models() { return []; },
    async history() { return []; }, async status() { return { available: true }; },
    async threadInfo(threadId) { return { threadId, cwd: dir, title: '角色任务', isUserThread: true }; },
    subscribe(fn) { listener = fn; return () => { listener = undefined; }; },
  };
  const bridge = new Bridge(store, runtime, { projects: async () => [], threads: async cwd => Object.keys(store.state.threadBindings).map(id => ({ id, cwd, title: id, preview: '', updatedAt: '' })) });
  bridge.transport = {
    async start() {}, async close() {}, async startTyping() { return async () => {}; },
    async sendText(chatId, text) { const id = randomUUID(); sent.push({ chatId, id, card: { title: '', text } }); return id; },
    async sendCard(chatId, card) { const id = randomUUID(); sent.push({ chatId, card, id }); return id; },
    async sendImage() { return randomUUID(); }, async sendFile() { return randomUUID(); }, async updateCard() {},
  };
  const message = (botId: string, text: string, overrides: Partial<InboundMessage> = {}) => namespaceMessage(botId, {
    id: randomUUID(), chatId: 'oc_team', chatType: 'group', actorId: botId === 'default' ? 'pm-user' : 'dev-user', text, ...overrides,
  });
  const send = (botId: string, text: string, overrides: Partial<InboundMessage> = {}) => bridge.receive(message(botId, text, overrides));
  t.after(async () => { await bridge.close(); assert.equal(path.dirname(dir), os.tmpdir()); assert.ok(path.basename(dir).startsWith('group-bridge-')); fs.rmSync(dir, { recursive: true, force: true }); });
  return { dir, store, bridge, runs, sent, stopped, runtime, send, message, notify: (event: RuntimeEvent) => listener?.(event), runWith: (fn: typeof runner) => { runner = fn; } };
}

test('manual handoff shares public result while keeping bot threads, models and reply destinations separate', async t => {
  const h = setup(t);
  await h.send('default', '设计登录流程');
  const productReply = h.sent.find(item => item.card.text.includes('五分钟'))!;
  await h.send('dev', '按上面的方案实现', { replyTo: productReply.id });
  assert.equal(h.runs.length, 2);
  assert.match(h.runs[1]!.prompt, /验证码五分钟有效/);
  assert.match(h.runs[1]!.prompt, /明确引用/);
  assert.match(h.runs[1]!.roleInstructions!, /根据需求实现功能/);
  assert.equal(h.runs[1]!.model, 'dev-model');
  assert.equal(h.runs[1]!.effort, 'high');
  const pm = h.store.conversation('oc_team');
  const dev = h.store.conversation(conversationKey('dev', 'oc_team'));
  assert.notEqual(pm.threadId, dev.threadId);
  assert.equal(h.sent.at(-1)!.chatId, conversationKey('dev', 'oc_team'));
  await h.send('default', '补充验收标准');
  assert.equal(h.runs[2]!.threadId, pm.threadId);
  assert.equal(h.store.state.groupMessages.oc_team!.filter(item => item.role === 'assistant').length, 3);
});

test('same multi-mention message executes once per bot, and shared human background deduplicates', async t => {
  const h = setup(t);
  await h.send('default', '分别说一下看法', { id: 'om_same' });
  await h.send('dev', '分别说一下看法', { id: 'om_same' });
  await h.send('dev', '分别说一下看法', { id: 'om_same' });
  assert.equal(h.runs.length, 2);
  assert.equal(h.store.state.groupMessages.oc_team!.filter(item => item.id === 'om_same').length, 1);
});

test('group and actor authorization are both required and are not copied between applications', async t => {
  const h = setup(t);
  await h.send('dev', '陌生账号不能执行', { actorId: 'pm-user' });
  await h.send('dev', '未知群不能执行', { chatId: 'oc_unknown' });
  assert.equal(h.runs.length, 0);
  assert.equal(h.store.state.pendingActors[0]!.botId, 'dev');
  assert.equal(h.store.state.pendingGroups[0]!.chatId, 'oc_unknown');
  h.store.authorize('pm-user', true, 'dev');
  h.store.authorizeGroup('dev', 'oc_unknown', true);
  await h.send('dev', '现在可以执行', { chatId: 'oc_unknown', actorId: 'pm-user' });
  assert.equal(h.runs.length, 1);
});

test('observed public background never starts a run or exposes a private conversation', async t => {
  const h = setup(t);
  h.store.observeGroup(h.message('default', '普通讨论：先做邮箱登录'));
  h.store.observeGroup(h.message('default', '其他群秘密', { chatId: 'oc_other' }));
  await h.send('default', '这是私聊秘密', { chatId: 'oc_private', chatType: 'p2p' });
  assert.equal(h.runs.length, 1);
  await h.send('dev', '整理群里的讨论');
  assert.match(h.runs[1]!.prompt, /先做邮箱登录/);
  assert.doesNotMatch(h.runs[1]!.prompt, /私聊秘密|其他群秘密/);
  assert.equal(cleanBridgeText(h.runs[1]!.prompt), '整理群里的讨论');
});

test('each role has an independent /new and may not bind another role current or former thread', async t => {
  const h = setup(t);
  await h.send('default', '产品方案');
  const pmThread = h.store.conversation('oc_team').threadId!;
  await h.send('dev', '开发方案');
  const devKey = conversationKey('dev', 'oc_team');
  const devThread = h.store.conversation(devKey).threadId;
  await h.send('default', '/new');
  assert.equal(h.store.conversation('oc_team').threadId, undefined);
  assert.equal(h.store.conversation(devKey).threadId, devThread);
  await assert.rejects(h.bridge.bind(devKey, h.dir, pmThread), /独立会话/);
});

test('changing group project synchronizes all roles and excludes old-project context', async t => {
  const h = setup(t);
  await h.send('default', '旧项目需求');
  await h.send('dev', '旧项目开发');
  const next = path.join(h.dir, 'next'); fs.mkdirSync(next);
  await h.bridge.bind('oc_team', next);
  const devKey = conversationKey('dev', 'oc_team');
  assert.equal(h.store.conversation(devKey).cwd, next);
  assert.equal(h.store.conversation(devKey).threadId, undefined);
  await h.send('dev', '新项目开始');
  assert.doesNotMatch(h.runs[2]!.prompt, /旧项目|验证码五分钟/);
  assert.equal(h.runs[2]!.cwd, next);
});

test('same-project group roles wait instead of racing writes; queued work can be stopped', async t => {
  const h = setup(t); const finished = deferred();
  h.runWith(async input => { const id = input.threadId || 'thread-pm'; input.onThread?.(id); await finished.promise; return { threadId: id, text: '完成' }; });
  const pm = h.send('default', '先处理'); await tick();
  const dev = h.send('dev', '也要处理'); await tick();
  assert.equal(h.runs.length, 1);
  assert.ok(h.sent.some(item => item.card.title === '等待项目空闲'));
  await h.bridge.stop(conversationKey('dev', 'oc_team'));
  await dev;
  assert.equal(h.runs.length, 1);
  finished.resolve(); await pm;
});

test('a queued group request rechecks permissions before it reaches Codex', async t => {
  const h = setup(t); const finished = deferred();
  h.runWith(async input => { input.onThread?.('thread-pm'); await finished.promise; return { threadId: 'thread-pm', text: '完成' }; });
  const pm = h.send('default', '处理'); await tick();
  const dev = h.send('dev', '排队'); await tick();
  h.store.authorizeGroup('dev', 'oc_team', false);
  finished.resolve(); await Promise.all([pm, dev]);
  assert.equal(h.runs.length, 1);
});

test('approvals are restricted to the original bot, group and requesting person', async t => {
  const h = setup(t); let answer: unknown;
  h.runWith(async input => {
    input.onThread?.('thread-pm');
    answer = await input.onRequest!({ id: 'runtime-approval', kind: 'approval', title: '审批', text: '运行测试' });
    return { threadId: 'thread-pm', text: '已执行' };
  });
  const pending = h.send('default', '运行测试'); await tick();
  const request = h.bridge.pendingRequests()[0]!;
  await assert.rejects(h.bridge.answer(request.id, { decision: 'accept' }, { chatId: conversationKey('dev', 'oc_team'), actorId: 'pm-user' }), /不属于/);
  await assert.rejects(h.bridge.answer(request.id, { decision: 'accept' }, { chatId: 'oc_team', actorId: 'another-user' }), /不属于/);
  await h.bridge.answer(request.id, { decision: 'accept' }, { chatId: 'oc_team', actorId: 'pm-user' });
  await pending;
  assert.deepEqual(answer, { decision: 'accept' });
});

test('desktop completion follows a former group thread after /new and never falls back to private chat', async t => {
  const h = setup(t);
  await h.send('default', '群任务');
  const threadId = h.store.conversation('oc_team').threadId!;
  await h.send('default', '/new');
  h.store.conversation('oc_private', 'pm-user');
  const emit = () => h.notify({ method: 'turn/completed', threadId, turnId: 'desktop-turn', params: { turn: { status: 'completed', items: [
    { type: 'mcpToolCall', server: 'feishu_completion', tool: 'request_feishu_completion_notification', arguments: { summary: '桌面继续完成' } },
    { type: 'agentMessage', phase: 'final_answer', text: '结果' },
  ] } } });
  emit(); await tick(); await tick();
  const cards = h.sent.filter(item => item.card.title === '桌面任务已完成');
  assert.equal(cards.length, 1);
  assert.equal(cards[0]!.chatId, 'oc_team');
  assert.ok(cards[0]!.card.buttons?.some(button => button.command.startsWith('/notification ')));
  emit(); await tick(); assert.equal(h.sent.filter(item => item.card.title === '桌面任务已完成').length, 1);
});

test('role edits apply to new threads while existing threads retain their original role', async t => {
  const h = setup(t);
  await h.send('default', '开始', { chatId: 'oc_private', chatType: 'p2p' });
  assert.match(h.runs[0]!.roleInstructions!, /澄清需求/);
  h.store.saveBot('default', { roleInstructions: '' });
  await h.send('default', '继续', { chatId: 'oc_private', chatType: 'p2p' });
  assert.equal(h.runs[1]!.roleInstructions, h.runs[0]!.roleInstructions);
  await h.send('default', '/new', { chatId: 'oc_private', chatType: 'p2p' });
  await h.send('default', '新角色', { chatId: 'oc_private', chatType: 'p2p' });
  assert.equal(h.runs[2]!.roleInstructions, undefined);
});

test('context is bounded, captures only current project, and persists across a service restart', async t => {
  const h = setup(t);
  for (let i = 0; i < 110; i++) h.store.observeGroup(h.message('default', `${i}: ${'背景'.repeat(6000)}`));
  const other = h.message('dev', '现在总结');
  const context = h.store.groupContext(other, h.dir);
  assert.ok(context.length < 17000);
  assert.ok(h.store.state.groupMessages.oc_team!.length <= 100);
  const restored = new Store(h.dir);
  assert.equal(restored.groupContext(other, h.dir), context);
  assert.equal(parseRoute(other.chatId).botId, 'dev');
});
