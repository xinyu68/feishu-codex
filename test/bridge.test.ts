import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { Bridge, splitReply } from '../src/bridge.js';
import { Store } from '../src/store.js';
import type { CodexRunInput, CodexRuntime, FeishuTransport, MessageCard, RuntimeAnswer } from '../src/types.js';

function fixture(t: test.TestContext) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'feishu-codex-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = new Store(dir);
  store.saveConfig({ allowedActors: ['ou_alice', 'ou_bob'], defaultWorkspace: dir });
  const cards: Array<{ chatId?: string; messageId?: string; card: MessageCard }> = [];
  const runs: CodexRunInput[] = [];
  const runtime: CodexRuntime = {
    async run(input) { runs.push(input); input.onThread?.(input.threadId || 'thread-1'); return { threadId: input.threadId || 'thread-1', text: '完成' }; },
    async stop() {}, async release() {}, async close() {}, async models() { return []; }, async history() { return []; }, async status() { return { available: true }; }
  };
  const transport: FeishuTransport = {
    async start() {}, async close() {}, async sendText(chatId, text) { cards.push({ chatId, card: { title: '', text } }); return randomUUID(); },
    async sendCard(chatId, card) { cards.push({ chatId, card }); return `card-${cards.length}`; },
    async sendImage() { return randomUUID(); }, async sendFile() { return randomUUID(); },
    async updateCard(messageId, card) { cards.push({ messageId, card }); }, async startTyping() { return async () => {}; }
  };
  const bridge = new Bridge(store, runtime, { projects: async () => [{ path: dir, name: 'Demo', threadCount: 1, lastActiveAt: '' }], threads: async () => [{ id: 'thread-1', cwd: dir, title: '已有会话', preview: '', updatedAt: '' }] });
  bridge.transport = transport;
  const send = (text: string, extra = {}) => bridge.receive({ id: randomUUID(), actorId: 'ou_alice', chatId: 'oc_chat', text, ...extra });
  return { dir, store, cards, runtime, transport, runs, bridge, send };
}
const tick = () => new Promise<void>(resolve => setImmediate(resolve));

test('ordinary follow-up never invokes a workbench and resumes the same thread', async t => {
  const { send, runs, cards } = fixture(t);
  await send('看看今天有哪些@我的消息');
  await send('有没有需要我待处理的');
  assert.equal(runs.length, 2);
  assert.equal(runs[1]?.threadId, 'thread-1');
  assert.match(runs[1]!.prompt, /有没有需要我待处理的/);
  assert.equal(cards.some(item => /Taskboard|知识库/.test(item.card.text)), false);
});

test('duplicates survive restarts and unauthorized actors never reach Codex', async t => {
  const { send, store, dir, runs } = fixture(t);
  await send('你好', { id: 'duplicate' });
  await send('你好', { id: 'duplicate' });
  await send('执行任务', { actorId: 'ou_stranger' });
  assert.equal(runs.length, 1);
  assert.equal(store.state.pendingActors.length, 1);
  assert.equal(new Store(dir).claim('duplicate'), false);
});

test('legacy standalone serializes accepted snapshots while binding can switch', async t => {
  const { bridge, runtime, send, dir } = fixture(t);
  let finish!: () => void;
  let count = 0;
  runtime.run = async input => {
    count++; input.onThread?.('thread-1');
    if (count === 1) await new Promise<void>(resolve => { finish = resolve; });
    return { threadId: 'thread-1', text: String(count) };
  };
  const first = send('一'); await tick();
  const second = send('二'); await tick();
  assert.equal(count, 1);
  assert.equal(bridge.conversations()[0]?.queued, 1);
  await bridge.bind('oc_chat', dir);
  assert.equal(bridge.conversations()[0]?.revision, 1);
  finish(); await Promise.all([first, second]);
  assert.equal(count, 2);
  assert.equal(bridge.conversations()[0]?.busy, false);
});

test('approval is actor-scoped, single use, and its original card loses buttons', async t => {
  const { bridge, runtime, send, cards } = fixture(t);
  let result: RuntimeAnswer | undefined;
  runtime.run = async input => {
    input.onThread?.('thread-1');
    result = await input.onRequest!({ id: 'runtime-id', kind: 'approval', title: '确认', text: '执行操作' });
    return { threadId: 'thread-1', text: '继续执行' };
  };
  const turn = send('开始'); await tick();
  const id = bridge.pendingRequests()[0]!.id;
  await assert.rejects(bridge.answer(id, { decision: 'accept' }, { chatId: 'oc_chat', actorId: 'ou_bob' }), /不属于/);
  await bridge.answer(id, { decision: 'accept' }, { chatId: 'oc_chat', actorId: 'ou_alice' });
  await turn;
  await bridge.answer(id, { decision: 'accept' }, { chatId: 'oc_chat', actorId: 'ou_alice' });
  assert.deepEqual(result, { decision: 'accept' });
  assert.equal(bridge.pendingRequests().length, 0);
  assert.ok(cards.some(item => item.messageId && item.card.title === '已同意' && !item.card.buttons));
});

test('expired approval card after restart is patched without reusable buttons', async t => {
  const { send, cards, runs } = fixture(t);
  await send('/approve old-request', { actionMessageId: 'old-card' });
  assert.equal(runs.length, 0);
  assert.equal(cards.at(-1)?.messageId, 'old-card');
  assert.equal(cards.at(-1)?.card.buttons, undefined);
  assert.match(cards.at(-1)!.card.title, /失效/);
});

test('stop cancels queued work as well as the active owned thread', async t => {
  const { runtime, bridge, send } = fixture(t);
  let finish!: () => void;
  let stopped = '';
  let count = 0;
  runtime.run = async input => {
    count++; input.onThread?.('thread-1');
    await new Promise<void>(resolve => { finish = resolve; });
    throw new Error('interrupted');
  };
  runtime.stop = async id => { stopped = id; finish(); };
  const first = send('长任务'); await tick();
  const second = send('后续'); await tick();
  await bridge.stop('oc_chat'); await Promise.all([first, second]);
  assert.equal(count, 1);
  assert.equal(stopped, 'thread-1');
  assert.equal(bridge.conversations()[0]?.busy, false);
});

test('separate chats cannot write the same thread concurrently', async t => {
  const { runtime, store, send, runs } = fixture(t);
  store.conversation('oc_chat', 'ou_alice').threadId = 'thread-1';
  store.conversation('oc_second', 'ou_bob').threadId = 'thread-1';
  let finish!: () => void;
  runtime.run = async input => { runs.push(input); input.onThread?.('thread-1'); await new Promise<void>(resolve => { finish = resolve; }); return { threadId: 'thread-1', text: '完成' }; };
  const first = send('一'); await tick();
  await send('二', { chatId: 'oc_second', actorId: 'ou_bob' });
  assert.equal(runs.length, 1);
  assert.match(store.state.history.oc_second!.at(-1)!.text, /另一条飞书对话/);
  finish(); await first;
});

test('native menu uses the existing private conversation binding', async t => {
  const { store, send, cards, dir } = fixture(t);
  const conversation = store.conversation('oc_chat', 'ou_alice', dir);
  conversation.threadId = 'thread-1';
  conversation.title = '旧标题';
  conversation.effort = 'xhigh';
  await send('/status', { chatId: 'ou_alice' });
  assert.equal(store.state.conversations.ou_alice, undefined);
  assert.equal(cards.at(-1)?.chatId, 'oc_chat');
  assert.match(cards.at(-1)!.card.text, /会话：已有会话/);
  assert.doesNotMatch(cards.at(-1)!.card.text, /会话：thread-1/);
  assert.equal(conversation.title, '已有会话');
  assert.match(cards.at(-1)!.card.text, /推理强度：xhigh/);
});

test('status shows the current session preview and Beijing update time instead of a raw id', async t => {
  const { store, runtime, cards, dir } = fixture(t);
  const bridge = new Bridge(store, runtime, {
    projects: async () => [],
    threads: async () => [{ id: 'thread-human', cwd: dir, title: '修复启动闪窗', preview: '确认 PowerShell 窗口已经不再出现', updatedAt: '2026-09-25T15:30:00.000Z' }]
  });
  bridge.transport = {
    async start() {}, async close() {}, async sendText() { return 'text'; },
    async sendCard(chatId, card) { cards.push({ chatId, card }); return 'status-card'; },
    async sendImage() { return 'image'; }, async sendFile() { return 'file'; },
    async updateCard(messageId, card) { cards.push({ messageId, card }); }, async startTyping() { return async () => {}; }
  };
  const conversation = store.conversation('oc_chat', 'ou_alice', dir);
  conversation.threadId = 'thread-human';
  await bridge.receive({ id: randomUUID(), actorId: 'ou_alice', chatId: 'oc_chat', text: '/status' });
  assert.match(cards.at(-1)!.card.text, /会话：修复启动闪窗/);
  assert.match(cards.at(-1)!.card.text, /会话摘要：确认 PowerShell 窗口已经不再出现/);
  assert.match(cards.at(-1)!.card.text, /最近更新：09-25 23:30/);
  assert.doesNotMatch(cards.at(-1)!.card.text, /thread-human/);
});

test('project card uses stable paths and foreign thread binding is rejected', async t => {
  const { bridge, send, cards, dir } = fixture(t);
  await send('/project');
  const command = cards.at(-1)!.card.buttons![0]!.command;
  assert.equal(command, `/project path ${encodeURIComponent(dir)}`);
  await send(command);
  assert.equal(bridge.conversations()[0]?.cwd, dir);
  await assert.rejects(bridge.bind('oc_chat', dir, 'foreign-thread'), /不属于/);
});

test('long replies preserve every character and Unicode pairs', () => {
  const text = ('段落🙂\n'.repeat(1700));
  const chunks = splitReply(text, 101);
  assert.equal(chunks.join(''), text);
  assert.ok(chunks.every(chunk => chunk.length <= 101 && !/^[\uDC00-\uDFFF]/.test(chunk)));
});

test('an idle chat switching away never releases another chat using the same thread', async t => {
  const { runtime, bridge, store, send, dir } = fixture(t);
  store.conversation('oc_chat', 'ou_alice').threadId = 'thread-1';
  store.conversation('oc_idle', 'ou_bob').threadId = 'thread-1';
  let finish!: () => void;
  let released = false;
  runtime.release = async () => { released = true; };
  runtime.run = async input => { input.onThread?.('thread-1'); await new Promise<void>(resolve => { finish = resolve; }); return { threadId: 'thread-1', text: '完成' }; };
  const active = send('继续工作'); await tick();
  await bridge.bind('oc_idle', dir);
  assert.equal(released, false);
  assert.equal(bridge.conversations().find(item => item.chatId === 'oc_chat')?.busy, true);
  finish(); await active;
});

test('binding another thread clears prior chat transcript and history reads selected Codex thread', async t => {
  const { runtime, bridge, store, dir } = fixture(t);
  store.conversation('oc_chat', 'ou_alice');
  store.message('oc_chat', 'user', '旧会话内容');
  runtime.history = async id => [{ role: 'assistant', text: `所选 ${id} 的历史` }];
  await bridge.bind('oc_chat', dir, 'thread-1');
  const history = await bridge.history('oc_chat');
  assert.equal(history.source, 'codex');
  assert.equal(history.messages[0]?.text, '所选 thread-1 的历史');
  assert.equal(store.state.history.oc_chat?.length, 0);
  await bridge.newConversation('oc_chat');
  assert.equal((await bridge.history('oc_chat')).messages.length, 0);
});

test('project and session switches replace the visible summary and new conversations clear old content', async t => {
  const { store, runtime, dir } = fixture(t);
  const otherProject = path.join(dir, 'other-project');
  fs.mkdirSync(otherProject);
  const bridge = new Bridge(store, runtime, {
    projects: async () => [],
    threads: async cwd => [
      { id: 'thread-1', cwd, title: '排查接口超时', preview: '请求耗时为什么变长', updatedAt: '' },
      { id: 'thread-2', cwd, title: '整理项目结构', preview: '介绍这个项目的模块', updatedAt: '' }
    ]
  });
  store.conversation('oc_chat', 'ou_alice');
  store.message('oc_chat', 'user', '新桥接测试，只回复 FC8790');
  await bridge.bind('oc_chat', dir, 'thread-1');
  assert.equal(bridge.conversations()[0]?.title, '排查接口超时');
  assert.equal(bridge.conversations()[0]?.preview, '请求耗时为什么变长');
  await bridge.bind('oc_chat', dir, 'thread-2');
  assert.equal(bridge.conversations()[0]?.threadId, 'thread-2');
  assert.equal(bridge.conversations()[0]?.title, '整理项目结构');
  assert.equal(bridge.conversations()[0]?.preview, '介绍这个项目的模块');
  await bridge.bind('oc_chat', otherProject);
  assert.equal(bridge.conversations()[0]?.cwd, otherProject);
  assert.equal(bridge.conversations()[0]?.threadId, undefined);
  assert.equal(bridge.conversations()[0]?.title, '新会话');
  assert.equal(bridge.conversations()[0]?.preview, '');
  store.message('oc_chat', 'user', '未创建线程前的一条消息');
  await bridge.newConversation('oc_chat');
  assert.equal(bridge.conversations()[0]?.preview, '');
  assert.deepEqual((await bridge.history('oc_chat')).messages, []);
  const saved = new Store(dir).state.conversations.oc_chat!;
  assert.equal(saved.title, '新会话');
  assert.equal(saved.preview, '');
});

test('the first message names a new session while follow-ups preserve its identity', async t => {
  const { bridge, send, store } = fixture(t);
  await send('介绍这个项目');
  assert.equal(bridge.conversations()[0]?.title, '介绍这个项目');
  await send('继续说明');
  assert.equal(bridge.conversations()[0]?.title, '介绍这个项目');
  assert.equal(bridge.conversations()[0]?.preview, '继续说明');
  await bridge.newConversation('oc_chat');
  store.message('oc_chat', 'user', '新的问题');
  store.message('oc_chat', 'user', '线程建立前的排队追问');
  assert.equal(bridge.conversations()[0]?.title, '新的问题');
});

test('local preview uses the selected Feishu thread and shares new session state without external output', async t => {
  const { bridge, store, send, cards, transport, dir, runs } = fixture(t);
  let typingCalls = 0;
  transport.startTyping = async () => { typingCalls++; return async () => { typingCalls++; }; };
  store.conversation('oc_chat', 'ou_alice');
  await bridge.bind('oc_chat', dir, 'thread-1');
  await send('在后台继续原会话', { localOnly: true });
  assert.equal(runs[0]?.threadId, 'thread-1');
  assert.equal(bridge.conversations().length, 1);
  assert.equal(store.state.conversations['local-preview'], undefined);
  assert.deepEqual(cards, []);
  assert.equal(typingCalls, 0);
  await bridge.newConversation('oc_chat');
  await send('在后台开始新会话', { localOnly: true });
  assert.equal(runs[1]?.threadId, undefined);
  assert.equal(bridge.conversations()[0]?.threadId, 'thread-1');
  assert.equal(bridge.conversations()[0]?.title, '在后台开始新会话');
  assert.deepEqual(cards, []);
  await send('回到飞书继续');
  assert.equal(runs[2]?.threadId, 'thread-1');
  assert.ok(cards.some(item => item.card.text === '完成'));
  assert.ok(typingCalls > 0);
});

test('local preview queues on the real conversation and command or runtime errors stay local', async t => {
  const { bridge, store, runtime, send, cards } = fixture(t);
  store.conversation('oc_chat', 'ou_alice');
  let finish!: () => void;
  let runCount = 0;
  runtime.run = async input => {
    runCount++;
    input.onThread?.('thread-1');
    if (runCount === 1) await new Promise<void>(resolve => { finish = resolve; });
    if (runCount === 2) throw new Error('本地运行出错');
    return { threadId: 'thread-1', text: '本地完成' };
  };
  const first = send('本地一', { localOnly: true }); await tick();
  const second = send('本地二', { localOnly: true }); await tick();
  assert.equal(bridge.conversations()[0]?.busy, true);
  assert.equal(bridge.conversations()[0]?.queued, 1);
  assert.deepEqual(cards, []);
  await send('/status', { localOnly: true, actionMessageId: 'must-not-update' });
  finish(); await Promise.all([first, second]);
  assert.equal(runCount, 2);
  assert.deepEqual(cards, []);
  assert.ok(store.state.history.oc_chat?.some(item => /排队/.test(item.text)));
  assert.ok(store.state.history.oc_chat?.some(item => /页面按钮/.test(item.text)));
  assert.ok(store.state.history.oc_chat?.some(item => /本地运行出错/.test(item.text)));
});

test('local preview approval and questions are handled only by management UI', async t => {
  const { bridge, store, runtime, transport, send, cards } = fixture(t);
  store.conversation('oc_chat', 'ou_alice');
  let typingCalls = 0;
  transport.startTyping = async () => { typingCalls++; return async () => {}; };
  let approval: RuntimeAnswer | undefined;
  let answer: RuntimeAnswer | undefined;
  runtime.run = async input => {
    input.onThread?.('thread-1');
    input.onProgress?.('处理本地问题');
    approval = await input.onRequest!({ id: 'approval', kind: 'approval', title: '确认', text: '操作说明' });
    answer = await input.onRequest!({ id: 'question', kind: 'question', title: '请回答', text: '', questions: [{ id: 'q1', question: '选哪个？' }] });
    return { threadId: 'thread-1', text: '仅本机可见' };
  };
  const turn = send('需要确认', { localOnly: true }); await tick();
  const approvalRequest = bridge.pendingRequests()[0]!;
  assert.equal(approvalRequest.chatId, 'oc_chat');
  assert.equal(approvalRequest.localOnly, true);
  await bridge.answer(approvalRequest.id, { decision: 'accept' }); await tick();
  const questionRequest = bridge.pendingRequests()[0]!;
  await bridge.answer(questionRequest.id, { answers: { q1: { answers: ['选A'] } } });
  await turn;
  assert.deepEqual(approval, { decision: 'accept' });
  assert.deepEqual(answer, { answers: { q1: { answers: ['选A'] } } });
  assert.equal(bridge.pendingRequests().length, 0);
  assert.deepEqual(cards, []);
  assert.equal(typingCalls, 0);
});

test('local preview refuses unknown or unauthorized chats before state mutation', async t => {
  const { bridge, store, send, cards, runs } = fixture(t);
  await assert.rejects(send('未知会话', { localOnly: true }), /不存在/);
  assert.equal(store.state.conversations.oc_chat, undefined);
  store.conversation('oc_chat', 'ou_stranger');
  await assert.rejects(send('未授权', { localOnly: true, actorId: 'ou_stranger' }), /尚未授权/);
  await assert.rejects(send('错误身份', { localOnly: true }), /尚未授权/);
  assert.equal(runs.length, 0);
  assert.deepEqual(cards, []);
  assert.equal(store.state.pendingActors.length, 0);
  await bridge.close();
});

test('status exposes a completed but unconfirmed reply and preserves the saved answer after restart', async t => {
  const fx = fixture(t);
  const sendCard = fx.transport.sendCard.bind(fx.transport);
  fx.transport.sendCard = async (chatId, card) => {
    if (card.title === 'Codex') throw Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' });
    return sendCard(chatId, card);
  };
  await fx.send('Check lost reply', { id: 'lost-reply' });
  assert.equal(fx.store.state.operations['lost-reply']!.status, 'completed');
  assert.ok(fx.store.state.history.oc_chat!.some(item => item.role === 'assistant' && item.text === '完成'));
  await fx.send('/status');
  assert.match(fx.cards.at(-1)!.card.text, /状态：空闲[\s\S]*最近回复：送达未确认/);
  assert.match(fx.cards.at(-1)!.card.text, /本机工作台查看本轮结果/);
  assert.match(fx.cards.at(-1)!.card.text, /最近提问：Check lost reply/);
  const restarted = new Store(fx.dir);
  const bridge = new Bridge(restarted, fx.runtime, { projects: async () => [], threads: async () => [] });
  bridge.transport = fx.transport;
  t.after(() => bridge.close());
  await bridge.receive({ id: randomUUID(), chatId: 'oc_chat', actorId: 'ou_alice', text: '/status' });
  assert.match(fx.cards.at(-1)!.card.text, /最近回复：送达未确认/);
  await bridge.newConversation('oc_chat');
  await bridge.receive({ id: randomUUID(), chatId: 'oc_chat', actorId: 'ou_alice', text: '/status' });
  assert.doesNotMatch(fx.cards.at(-1)!.card.text, /最近回复|Check lost reply/);
});

test('status distinguishes an in-flight reply from a confirmed reply without running the task twice', async t => {
  const fx = fixture(t);
  let release!: () => void;
  const acknowledged = new Promise<void>(resolve => { release = resolve; });
  t.after(release);
  const sendCard = fx.transport.sendCard.bind(fx.transport);
  let sending = false;
  fx.transport.sendCard = async (chatId, card) => {
    if (card.title === 'Codex') { sending = true; await acknowledged; }
    return sendCard(chatId, card);
  };
  const pending = fx.send('Generate a reply');
  for (let i = 0; i < 50 && !sending; i++) await tick();
  assert.equal(sending, true);
  await fx.send('/status');
  assert.match(fx.cards.at(-1)!.card.text, /最近回复：发送中/);
  release(); await pending;
  await fx.send('/status');
  assert.match(fx.cards.at(-1)!.card.text, /状态：空闲[\s\S]*最近回复：已送达/);
  assert.equal(fx.runs.length, 1);
});

test('status scopes delivery to the current bot, chat, project and thread and orders by accepted task', async t => {
  const fx = fixture(t);
  Object.assign(fx.store.conversation('oc_chat', 'ou_alice'), { threadId: 'thread-1' });
  const base = { chatId: 'oc_chat', actorId: 'ou_alice', cwd: fx.dir, threadId: 'thread-1', revision: 0,
    source: 'feishu' as const, status: 'completed' as const };
  for (const [id, at, status] of [['old', '2026-09-29T11:00:00.000Z', 'uncertain'], ['new', '2026-09-29T11:01:00.000Z', 'sent']] as const) {
    fx.store.operation(id, { ...base, turnId: id, at });
    fx.store.finishDelivery(`oc_chat:thread-1:${id}`, status);
  }
  fx.store.operation('old', { error: 'Late old callback', updatedAt: '2026-09-29T23:00:00.000Z' });
  for (const [id, patch] of Object.entries({ bot: { chatId: 'bot:product:oc_chat' }, chat: { chatId: 'oc_other' },
    thread: { threadId: 'other-thread' }, project: { cwd: path.join(fx.dir, 'other') }, preview: { source: 'management' as const } })) {
    fx.store.operation(id, { ...base, ...patch, turnId: id, at: '2026-09-29T12:00:00.000Z' });
    const operation = fx.store.state.operations[id]!;
    fx.store.finishDelivery(`${operation.chatId}:${operation.threadId}:${id}`, 'uncertain');
  }
  fx.store.finishDelivery('desktop-notification:thread-1:desktop', 'uncertain');
  await fx.send('/status');
  assert.match(fx.cards.at(-1)!.card.text, /最近回复：已送达/);
  assert.doesNotMatch(fx.cards.at(-1)!.card.text, /送达未确认/);
});

test('error-notice delivery does not claim a successful answer and cannot mask an unconfirmed answer', async t => {
  const fx = fixture(t);
  Object.assign(fx.store.conversation('oc_chat', 'ou_alice'), { threadId: 'thread-1' });
  fx.store.operation('failed-task', { chatId: 'oc_chat', actorId: 'ou_alice', cwd: fx.dir, threadId: 'thread-1',
    turnId: 'failed-turn', revision: 0, source: 'feishu', status: 'failed' });
  fx.store.finishDelivery('error:oc_chat:thread-1:failed-turn', 'sent');
  await fx.send('/status');
  assert.match(fx.cards.at(-1)!.card.text, /最近异常提示：已送达/);
  assert.doesNotMatch(fx.cards.at(-1)!.card.text, /最近回复：已送达/);
  fx.store.finishDelivery('oc_chat:thread-1:failed-turn', 'uncertain');
  await fx.send('/status');
  assert.match(fx.cards.at(-1)!.card.text, /最近回复：送达未确认/);
  assert.doesNotMatch(fx.cards.at(-1)!.card.text, /最近异常提示/);
});

test('steered listeners share reply status and missing delivery never implies successful delivery', async t => {
  const fx = fixture(t);
  Object.assign(fx.store.conversation('oc_chat', 'ou_alice'), { threadId: 'thread-1' });
  const base = { chatId: 'oc_chat', actorId: 'ou_alice', cwd: fx.dir, threadId: 'thread-1', turnId: 'shared-turn',
    revision: 0, source: 'feishu' as const };
  fx.store.operation('first', { ...base, status: 'completed', at: '2026-09-29T11:00:00.000Z' });
  fx.store.operation('second', { ...base, status: 'uncertain', mode: 'steer', at: '2026-09-29T11:00:01.000Z' });
  await fx.send('/status');
  assert.doesNotMatch(fx.cards.at(-1)!.card.text, /最近回复：已送达/);
  fx.store.finishDelivery('oc_chat:thread-1:shared-turn', 'sent');
  fx.store.finishDelivery('error:oc_chat:thread-1:shared-turn', 'uncertain');
  await fx.send('/status');
  assert.match(fx.cards.at(-1)!.card.text, /最近回复：已送达/);
  assert.equal(fx.store.state.operations.second!.status, 'uncertain');
});

test('status retains the actual latest question instead of overwriting it with a native opening summary', async t => {
  const fx = fixture(t);
  await fx.send('The current question');
  const bridge = new Bridge(fx.store, fx.runtime, { projects: async () => [], threads: async () => [{ id: 'thread-1',
    cwd: fx.dir, title: 'Native title', preview: 'The very first question', updatedAt: '2026-01-01T00:00:00.000Z' }] });
  bridge.transport = fx.transport;
  t.after(() => bridge.close());
  await bridge.receive({ id: randomUUID(), actorId: 'ou_alice', chatId: 'oc_chat', text: '/status' });
  assert.match(fx.cards.at(-1)!.card.text, /会话：Native title[\s\S]*最近提问：The current question/);
  assert.doesNotMatch(fx.cards.at(-1)!.card.text, /The very first question/);
  assert.equal(fx.store.conversation('oc_chat').preview, 'The current question');
});
