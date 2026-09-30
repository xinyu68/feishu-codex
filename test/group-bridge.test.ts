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
import { parseMessageEvent } from '../src/feishu.js';
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
    input.prompt = await input.preparePrompt?.(threadId) ?? input.prompt;
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

test('bare mentions acknowledge each authorized bot once without starting or rebinding a conversation', async t => {
  const h = setup(t);
  await h.send('default', '', { id: 'om_ping', mentionOnly: true });
  await h.send('default', '', { id: 'om_ping', mentionOnly: true });
  await h.send('dev', '', { id: 'om_ping', mentionOnly: true });
  assert.equal(h.runs.length, 0);
  assert.equal(h.sent.length, 2);
  assert.ok(h.sent.every(item => item.card.text.startsWith('我在。')));
  assert.deepEqual(h.sent.map(item => item.chatId), ['oc_team', conversationKey('dev', 'oc_team')]);
  assert.deepEqual(Object.keys(h.store.state.conversations), []);
  assert.deepEqual(Object.keys(h.store.state.operations), []);
  assert.equal(h.bridge.hasActiveWork(), false);
});

test('bare mentions still require both group and actor authorization', async t => {
  const h = setup(t);
  await h.send('dev', '', { mentionOnly: true, chatId: 'oc_unknown' });
  await h.send('dev', '', { mentionOnly: true, actorId: 'ou_unknown' });
  assert.equal(h.runs.length, 0);
  assert.equal(h.sent.length, 2);
  assert.ok(h.sent.every(item => item.card.text.includes('授权')));
  assert.equal(h.store.state.pendingGroups[0]?.chatId, 'oc_unknown');
  assert.equal(h.store.state.pendingActors[0]?.actorId, 'ou_unknown');
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

test('one multi-mention /new resets both bot conversations without starting a model turn', async t => {
  const h = setup(t);
  h.store.authorize('pm-user', true, 'dev');
  await h.send('default', 'product work');
  await h.send('dev', 'development work', { actorId: 'pm-user' });
  assert.ok(h.store.conversation('oc_team').threadId);
  const devKey = conversationKey('dev', 'oc_team');
  assert.ok(h.store.conversation(devKey).threadId);
  const runsBefore = h.runs.length;
  const event = {
    sender: { sender_type: 'user', sender_id: { open_id: 'pm-user' } },
    message: {
      message_id: 'om_reset_both', chat_id: 'oc_team', chat_type: 'group', message_type: 'text',
      content: JSON.stringify({ text: '@_user_1 @_user_2 /new' }),
      mentions: [
        { key: '@_user_1', id: { open_id: 'ou_pm_bot' }, name: '产品经理' },
        { key: '@_user_2', id: { open_id: 'ou_dev_bot' }, name: '开发人员' },
      ],
    },
  };
  const product = parseMessageEvent(event, { botOpenId: 'ou_pm_bot' });
  const development = parseMessageEvent(event, { botOpenId: 'ou_dev_bot' });
  assert.ok(product && development);
  await Promise.all([
    h.bridge.receive(namespaceMessage('default', product.message)),
    h.bridge.receive(namespaceMessage('dev', development.message)),
  ]);
  assert.equal(h.store.conversation('oc_team').threadId, undefined);
  assert.equal(h.store.conversation(devKey).threadId, undefined);
  assert.equal(h.runs.length, runsBefore);
});

test('multi-mention status, session and stop act on both bots independently', async t => {
  const h = setup(t);
  h.store.authorize('pm-user', true, 'dev');
  await h.send('default', 'product work');
  await h.send('dev', 'development work', { actorId: 'pm-user' });
  const productThread = h.store.conversation('oc_team').threadId!;
  const devKey = conversationKey('dev', 'oc_team');
  const developerThread = h.store.conversation(devKey).threadId!;
  const runsBefore = h.runs.length;
  for (const command of ['status', 'session', 'stop']) {
    const event = {
      sender: { sender_type: 'user', sender_id: { open_id: 'pm-user' } },
      message: {
        message_id: `om_multi_${command}`, chat_id: 'oc_team', chat_type: 'group', message_type: 'text',
        content: JSON.stringify({ text: `@_user_1 @_user_2 /${command}` }),
        mentions: [
          { key: '@_user_1', id: { open_id: 'ou_pm_bot' }, name: '产品经理' },
          { key: '@_user_2', id: { open_id: 'ou_dev_bot' }, name: '开发人员' },
        ],
      },
    };
    const product = parseMessageEvent(event, { botOpenId: 'ou_pm_bot' });
    const development = parseMessageEvent(event, { botOpenId: 'ou_dev_bot' });
    assert.ok(product && development);
    const repliesBefore = h.sent.length;
    await Promise.all([
      h.bridge.receive(namespaceMessage('default', product.message)),
      h.bridge.receive(namespaceMessage('dev', development.message)),
    ]);
    assert.deepEqual(h.sent.slice(repliesBefore).map(item => item.chatId).sort(), ['oc_team', devKey].sort());
  }
  assert.equal(h.runs.length, runsBefore);
  assert.deepEqual(h.stopped.sort(), [productThread, developerThread].sort());
  assert.equal(h.store.conversation('oc_team').threadId, productThread);
  assert.equal(h.store.conversation(devKey).threadId, developerThread);
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

test('private role edits apply to new threads while existing threads retain their original role', async t => {
  const h = setup(t);
  h.store.saveBot('default', { privateRoleInstructions: '澄清需求，整理验收标准' });
  await h.send('default', '开始', { chatId: 'oc_private', chatType: 'p2p' });
  assert.match(h.runs[0]!.roleInstructions!, /澄清需求/);
  h.store.saveBot('default', { privateRoleInstructions: '' });
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

test('continued group threads receive only new public context and explicit quotes once', async t => {
  const h = setup(t);
  h.store.observeGroup(h.message('default', '背景唯一标记 ALPHA'));
  await h.send('default', '首轮用户问题');
  const first = h.sent.find(item => item.card.text.includes('五分钟'))!;
  h.store.observeGroup(h.message('default', '新增唯一标记 BETA'));
  await h.send('default', '继续用户问题');
  assert.match(h.runs[0]!.prompt, /ALPHA/);
  assert.match(h.runs[0]!.prompt, /批次：[a-f0-9]{32}\n\n新增群聊：\n/);
  assert.doesNotMatch(h.runs[0]!.prompt, /\"sender\":|\"role\":|\\n/);
  assert.match(h.runs[1]!.prompt, /BETA/);
  assert.doesNotMatch(h.runs[1]!.prompt, /ALPHA|首轮用户问题|验证码五分钟/);
  await h.send('default', '按这条进一步解释', { replyTo: first.id });
  assert.equal(h.runs[2]!.prompt.split('验证码五分钟有效').length - 1, 1);
  assert.doesNotMatch(h.runs[2]!.prompt, /ALPHA|BETA/);
  assert.equal(cleanBridgeText(h.runs[2]!.prompt), '按这条进一步解释');
  await h.send('dev', '独立开发会话');
  assert.match(h.runs[3]!.prompt, /ALPHA|BETA/);
});

test('a rejected submission retains background for the next accepted message', async t => {
  const h = setup(t);
  h.store.observeGroup(h.message('default', '拒绝后仍需送达的背景 REJECTED'));
  h.runWith(async input => {
    const threadId = input.threadId || 'rejected-thread'; input.onThread?.(threadId);
    input.prompt = await input.preparePrompt?.(threadId) ?? input.prompt;
    input.onSubmitted?.({ threadId, mode: 'start', status: 'submitting' });
    input.onSubmitted?.({ threadId, mode: 'start', status: 'rejected' });
    throw new Error('明确拒绝');
  });
  await h.send('default', '第一次提交');
  assert.equal(Object.keys(h.store.state.groupContextReceipts).length, 0);
  h.runWith(async input => {
    const threadId = input.threadId!; input.onThread?.(threadId);
    input.prompt = await input.preparePrompt?.(threadId) ?? input.prompt;
    input.onSubmitted?.({ threadId, turnId: 'accepted-turn', mode: 'start', status: 'submitted' });
    return { threadId, turnId: 'accepted-turn', text: '收到' };
  });
  await h.send('default', '重新提问');
  assert.match(h.runs[1]!.prompt, /REJECTED/);
  assert.equal(Object.keys(h.store.state.groupContextReceipts).length, 1);
});

test('uncertain submission is reconciled only by its exact native input, not turn existence', async t => {
  const h = setup(t);
  h.store.observeGroup(h.message('default', '不重复的公共背景 UNCERTAIN'));
  let submittedPrompt = '';
  h.runWith(async input => {
    const threadId = input.threadId || 'uncertain-thread'; input.onThread?.(threadId);
    input.prompt = await input.preparePrompt?.(threadId) ?? input.prompt;
    submittedPrompt = input.prompt;
    input.onSubmitted?.({ threadId, turnId: 'native-turn', mode: 'steer', status: 'submitting' });
    input.onSubmitted?.({ threadId, turnId: 'native-turn', mode: 'steer', status: 'uncertain' });
    throw new Error('响应丢失');
  });
  const first = h.message('default', '原任务只提交一次');
  await h.bridge.receive(first);
  assert.equal(Object.keys(h.store.state.groupContextReceipts).length, 0);
  h.runtime.history = async () => [{ role: 'user', text: submittedPrompt, turnId: 'native-turn' }];
  h.runWith(async input => {
    const threadId = input.threadId!; input.onThread?.(threadId);
    input.prompt = await input.preparePrompt?.(threadId) ?? input.prompt;
    input.onSubmitted?.({ threadId, turnId: 'next-turn', mode: 'start', status: 'submitted' });
    return { threadId, turnId: 'next-turn', text: '继续' };
  });
  await h.send('default', '后续问题');
  assert.doesNotMatch(h.runs[1]!.prompt, /UNCERTAIN|原任务只提交一次/);
  assert.equal(h.store.state.operations[first.id]!.groupContext?.confirmed, true);
  assert.equal(h.store.state.operations[first.id]!.status, 'uncertain');
  await h.bridge.receive(first);
  assert.equal(h.runs.length, 2);
});

test('unknown native history does not prematurely acknowledge group background', async t => {
  const h = setup(t);
  h.store.observeGroup(h.message('default', '背景必须补齐 MISSING'));
  h.runWith(async input => {
    const threadId = input.threadId || 'missing-thread'; input.onThread?.(threadId);
    input.prompt = await input.preparePrompt?.(threadId) ?? input.prompt;
    input.onSubmitted?.({ threadId, turnId: 'same-turn', mode: 'steer', status: 'submitting' });
    input.onSubmitted?.({ threadId, turnId: 'same-turn', mode: 'steer', status: 'uncertain' });
    throw new Error('响应丢失');
  });
  const first = h.message('default', '原消息');
  await h.bridge.receive(first);
  h.runtime.history = async () => [{ role: 'user', text: '另一条输入', turnId: 'same-turn' }];
  await h.send('default', '后续消息');
  assert.match(h.runs[1]!.prompt, /MISSING/);
  assert.notEqual(h.store.state.operations[first.id]!.groupContext?.confirmed, true);
});

test('acknowledged input remains known when the subsequent execution fails', async t => {
  const h = setup(t);
  h.store.observeGroup(h.message('default', '已经接收过的背景 KNOWN'));
  h.runWith(async input => {
    const threadId = input.threadId || 'failed-execution'; input.onThread?.(threadId);
    input.prompt = await input.preparePrompt?.(threadId) ?? input.prompt;
    input.onSubmitted?.({ threadId, turnId: 'accepted', mode: 'start', status: 'submitted' });
    throw new Error('执行过程中断线');
  });
  await h.send('default', '开始');
  await h.send('default', '继续');
  assert.doesNotMatch(h.runs[1]!.prompt, /KNOWN/);
});

test('identical user text still has distinct compact context batch markers', async t => {
  const h = setup(t);
  await h.send('default', '继续');
  await h.send('default', '继续');
  const first = /批次：([a-f0-9]{32})/.exec(h.runs[0]!.prompt)?.[1];
  const second = /批次：([a-f0-9]{32})/.exec(h.runs[1]!.prompt)?.[1];
  assert.ok(first && second);
  assert.notEqual(first, second);
  assert.equal(cleanBridgeText(h.runs[0]!.prompt), '继续');
  assert.equal(cleanBridgeText(h.runs[1]!.prompt), '继续');
});

test('disabling group supplementation preserves the active thread, current instruction and explicit quote', async t => {
  const h = setup(t);
  await h.send('default', 'Remember the existing task');
  const threadId = h.store.conversation('oc_team').threadId;
  const reply = h.sent.find(item => item.card.text.includes('五分钟'))!;
  h.store.saveBot('default', { includeGroupContext: false });
  h.store.observeGroup(h.message('default', 'Unrequested discussion while disabled'));
  await h.send('default', 'Continue using this explicit quote', { replyTo: reply.id });
  assert.equal(h.runs[1]!.threadId, threadId);
  assert.equal(cleanBridgeText(h.runs[1]!.prompt), 'Continue using this explicit quote');
  assert.match(h.runs[1]!.prompt, /明确引用[\s\S]*验证码五分钟有效/);
  assert.doesNotMatch(h.runs[1]!.prompt, /Unrequested discussion|Remember the existing task|新增群聊/);
  await h.send('default', 'Continue the same task without a quote');
  assert.equal(h.runs[2]!.threadId, threadId);
  assert.equal(cleanBridgeText(h.runs[2]!.prompt), 'Continue the same task without a quote');
  assert.doesNotMatch(h.runs[2]!.prompt, /Unrequested discussion|验证码五分钟有效|新增群聊/);
  assert.equal(h.store.conversation('oc_team').threadId, threadId);
  assert.deepEqual(h.stopped, []);
  assert.ok(h.store.state.history.oc_team!.some(item => item.text === 'Remember the existing task'));
});


test('private chats start without bot names or group personas for every bot', async t => {
  const h = setup(t);
  for (const botId of ['default', 'dev']) {
    await h.send(botId, 'Private request', { chatId: 'oc_private', chatType: 'p2p' });
    assert.equal(h.runs.at(-1)!.roleInstructions, undefined);
    h.store.saveBot(botId, { privateRoleInstructions: 'New private instructions' });
    await h.send(botId, 'Continue private request', { chatId: 'oc_private', chatType: 'p2p' });
    assert.equal(h.runs.at(-1)!.roleInstructions, undefined);
    await h.send(botId, '/new', { chatId: 'oc_private', chatType: 'p2p' });
    await h.send(botId, 'New private request', { chatId: 'oc_private', chatType: 'p2p' });
    assert.equal(h.runs.at(-1)!.roleInstructions, 'New private instructions');
  }
});

test('private and group instructions stay separate while model preferences are shared', async t => {
  const h = setup(t);
  h.store.saveBot('dev', { privateRoleInstructions: '  Independent private assistant  ' });
  await h.send('dev', 'Private request', { chatId: 'oc_private', chatType: 'p2p' });
  assert.equal(h.runs[0]!.roleInstructions, 'Independent private assistant');
  assert.equal(h.runs[0]!.model, 'dev-model');
  assert.equal(h.runs[0]!.effort, 'high');
  await h.send('dev', 'Group request');
  assert.match(h.runs[1]!.roleInstructions!, /根据需求实现功能/);
  assert.doesNotMatch(h.runs[1]!.roleInstructions!, /Independent private assistant/);
  const groupRole = h.runs[1]!.roleInstructions;
  h.store.saveBot('dev', { roleInstructions: 'Updated group responsibility' });
  await h.send('dev', 'Continue group request');
  assert.equal(h.runs[2]!.roleInstructions, groupRole);
  await h.send('dev', '/new');
  await h.send('dev', 'New group request');
  assert.match(h.runs[3]!.roleInstructions!, /Updated group responsibility/);
  assert.doesNotMatch(h.runs[3]!.roleInstructions!, /Independent private assistant/);
});

test('legacy private threads retain their original role snapshot', async t => {
  const h = setup(t);
  const conversation = h.store.conversation('oc_private', 'pm-user', h.dir, 'p2p');
  conversation.threadId = 'legacy-private-thread';
  h.store.rememberThread(conversation, 'Legacy product manager persona');
  h.store.save();
  h.store.saveBot('default', { privateRoleInstructions: 'New private assistant' });
  await h.send('default', 'Continue legacy request', { chatId: 'oc_private', chatType: 'p2p' });
  assert.equal(h.runs[0]!.roleInstructions, 'Legacy product manager persona');
  assert.equal(h.runs[0]!.threadId, 'legacy-private-thread');
});

test('native desktop threads receive no configured private persona', async t => {
  const h = setup(t);
  h.store.saveBot('default', { privateRoleInstructions: 'Configured private assistant' });
  const conversation = h.store.conversation('oc_private', 'pm-user', h.dir, 'p2p');
  conversation.threadId = 'native-desktop-thread';
  h.store.save();
  await h.send('default', 'Continue native request', { chatId: 'oc_private', chatType: 'p2p' });
  assert.equal(h.runs[0]!.roleInstructions, undefined);
  assert.equal(h.store.state.threadBindings['native-desktop-thread']!.roleManaged, false);
});

test('reusing a private thread from another bot retains the original persona', async t => {
  const h = setup(t);
  h.store.saveBot('default', { privateRoleInstructions: 'Original private persona' });
  h.store.saveBot('dev', { privateRoleInstructions: 'Different private persona' });
  await h.send('default', 'Start private request', { chatId: 'oc_private', chatType: 'p2p' });
  const threadId = h.store.conversation('oc_private').threadId!;
  const devChat = conversationKey('dev', 'oc_private');
  h.store.conversation(devChat, 'dev-user', h.dir, 'p2p');
  await h.bridge.bind(devChat, h.dir, threadId);
  await h.send('dev', 'Continue same thread', { chatId: 'oc_private', chatType: 'p2p' });
  assert.equal(h.runs[1]!.threadId, threadId);
  assert.equal(h.runs[1]!.roleInstructions, 'Original private persona');
});

test('private entry cannot rebind or replace a group thread role', async t => {
  const h = setup(t);
  await h.send('default', 'Start group request');
  const threadId = h.store.conversation('oc_team').threadId!;
  const role = h.store.state.threadBindings[threadId]!.roleInstructions;
  h.store.conversation('oc_private', 'pm-user', h.dir, 'p2p');
  h.store.saveBot('default', { privateRoleInstructions: 'Private assistant' });
  await assert.rejects(h.bridge.bind('oc_private', h.dir, threadId), /独立会话/);
  await h.send('default', 'Continue group request');
  assert.equal(h.runs[1]!.roleInstructions, role);
});

test('/new excludes old group background while another bot keeps its independent context', async t => {
  const h = setup(t);
  h.store.observeGroup(h.message('default', 'OLD-PUBLIC-BACKGROUND'));
  await h.send('default', 'OLD-PRODUCT-TASK');
  const oldThread = h.store.conversation('oc_team').threadId;
  await h.send('default', '/new');
  const boundary = h.store.conversation('oc_team').groupContextBoundary!;
  assert.ok(boundary);
  assert.ok(h.sent.at(-1)!.card.text.includes('此前的群聊背景不再自动带入'));
  h.store.observeGroup(h.message('default', 'FRESH-PUBLIC-BACKGROUND'));
  await h.send('default', 'Start fresh');
  assert.doesNotMatch(h.runs.at(-1)!.prompt, /OLD-PUBLIC|OLD-PRODUCT|验证码五分钟/);
  assert.match(h.runs.at(-1)!.prompt, /FRESH-PUBLIC-BACKGROUND/);
  assert.match(h.runs.at(-1)!.roleInstructions!, /澄清需求/);
  assert.notEqual(h.store.conversation('oc_team').threadId, oldThread);
  assert.deepEqual(h.store.state.threadBindings[h.store.conversation('oc_team').threadId!]!.groupContextBoundary, boundary);
  await h.send('dev', 'Continue developer');
  assert.match(h.runs.at(-1)!.prompt, /OLD-PUBLIC-BACKGROUND/);
  assert.equal(h.store.conversation(conversationKey('dev', 'oc_team')).groupContextBoundary, undefined);
  assert.ok(h.store.state.groupMessages.oc_team!.some(item => item.text === 'OLD-PUBLIC-BACKGROUND'));
  await h.send('dev', '/new');
  await h.send('dev', 'Start fresh developer');
  assert.doesNotMatch(h.runs.at(-1)!.prompt, /OLD-PUBLIC|OLD-PRODUCT|FRESH-PUBLIC|Start fresh\n/);
});

test('management switching resumes native threads with new background boundaries that survive restart', async t => {
  const h = setup(t);
  await h.send('default', 'Original conversation');
  const original = h.store.conversation('oc_team').threadId!;
  const originalRole = h.store.state.threadBindings[original]!.roleInstructions;
  h.store.observeGroup(h.message('default', 'PENDING-BEFORE-RESET'));
  await h.bridge.newConversation('oc_team');
  const boundary = h.store.conversation('oc_team').groupContextBoundary!;
  await h.send('default', 'Reset conversation');
  const fresh = h.store.conversation('oc_team').threadId!;
  assert.doesNotMatch(h.runs.at(-1)!.prompt, /PENDING-BEFORE-RESET/);
  const restored = new Store(h.dir);
  assert.deepEqual(restored.conversation('oc_team').groupContextBoundary, boundary);
  assert.deepEqual(restored.state.threadBindings[fresh]!.groupContextBoundary, boundary);
  await h.bridge.bind('oc_team', h.dir, original);
  const originalBoundary = h.store.conversation('oc_team').groupContextBoundary!;
  assert.ok(originalBoundary.afterSequence > boundary.afterSequence);
  assert.deepEqual(h.store.state.threadBindings[original]!.groupContextBoundary, originalBoundary);
  h.store.observeGroup(h.message('default', 'PUBLIC-AFTER-RETURN'));
  await h.send('default', 'Continue original conversation');
  assert.equal(h.runs.at(-1)!.threadId, original);
  assert.equal(h.runs.at(-1)!.roleInstructions, originalRole);
  assert.doesNotMatch(h.runs.at(-1)!.prompt, /PENDING-BEFORE-RESET|Reset conversation/);
  assert.match(h.runs.at(-1)!.prompt, /PUBLIC-AFTER-RETURN/);
  await h.bridge.bind('oc_team', h.dir, fresh);
  const freshBoundary = h.store.conversation('oc_team').groupContextBoundary!;
  assert.ok(freshBoundary.afterSequence > originalBoundary.afterSequence);
  const restarted = new Store(h.dir);
  assert.deepEqual(restarted.conversation('oc_team').groupContextBoundary, freshBoundary);
  assert.deepEqual(restarted.state.threadBindings[fresh]!.groupContextBoundary, freshBoundary);
  await h.send('default', 'Continue reset conversation');
  assert.equal(h.runs.at(-1)!.threadId, fresh);
  assert.doesNotMatch(h.runs.at(-1)!.prompt, /PENDING-BEFORE-RESET|PUBLIC-AFTER-RETURN|Continue original conversation/);
});

test('new-session retains an explicit quote without automatically restoring other old discussion', async t => {
  const h = setup(t);
  await h.send('default', 'Discuss old requirements');
  const oldReply = h.sent.find(item => item.card.text.includes('五分钟'))!;
  h.store.observeGroup(h.message('default', 'UNRELATED-OLD-BACKGROUND'));
  await h.send('default', '/new');
  await h.send('default', 'Use this particular specification', { replyTo: oldReply.id });
  assert.match(h.runs.at(-1)!.prompt, /明确引用[\s\S]*验证码五分钟有效/);
  assert.doesNotMatch(h.runs.at(-1)!.prompt, /UNRELATED-OLD-BACKGROUND|Discuss old requirements/);
  await h.send('default', 'Continue');
  assert.doesNotMatch(h.runs.at(-1)!.prompt, /UNRELATED-OLD-BACKGROUND|验证码五分钟有效/);
});

test('a delayed onThread from before /new cannot replace the new pending background boundary', async t => {
  const h = setup(t);
  const entered = deferred(), finish = deferred();
  t.after(() => finish.resolve());
  h.store.observeGroup(h.message('default', 'OLD-WHILE-CREATING'));
  let index = 0;
  h.runWith(async input => {
    const current = ++index;
    if (current === 1) { entered.resolve(); await finish.promise; }
    const threadId = `delayed-${current}`;
    input.onThread?.(threadId);
    input.prompt = await input.preparePrompt?.(threadId) ?? input.prompt;
    input.onSubmitted?.({ threadId, turnId: `turn-${current}`, mode: 'start', status: 'submitted' });
    return { threadId, turnId: `turn-${current}`, text: 'Done' };
  });
  const previous = h.send('default', 'Start previous task');
  await entered.promise;
  await h.send('default', '/new');
  const boundary = h.store.conversation('oc_team').groupContextBoundary!;
  finish.resolve();
  await previous;
  assert.equal(h.store.conversation('oc_team').threadId, undefined);
  assert.deepEqual(h.store.conversation('oc_team').groupContextBoundary, boundary);
  assert.equal(h.store.state.threadBindings['delayed-1']!.groupContextBoundary, undefined);
  await h.send('default', 'Start another task');
  assert.match(h.runs[0]!.prompt, /OLD-WHILE-CREATING/);
  assert.doesNotMatch(h.runs[1]!.prompt, /OLD-WHILE-CREATING|Start previous task/);
  assert.deepEqual(h.store.state.threadBindings['delayed-2']!.groupContextBoundary, boundary);
});

test('/session selection skips discussion from the other session while retaining explicit quotes', async t => {
  const h = setup(t);
  await h.send('default', 'ORIGINAL-TASK');
  const original = h.store.conversation('oc_team').threadId!;
  await h.send('default', '/new');
  await h.send('default', 'OTHER-SESSION-TASK');
  const other = h.store.conversation('oc_team').threadId!;
  const quote = h.message('default', 'SPECIFIC-OLD-SPECIFICATION');
  h.store.observeGroup(quote);
  h.store.observeGroup(h.message('default', 'UNRELATED-WHILE-AWAY'));
  await h.send('default', `/session id ${original}`);
  h.store.observeGroup(h.message('default', 'DISCUSSION-AFTER-SWITCH'));
  await h.send('default', 'Continue with quoted requirements', { replyTo: quote.id });
  assert.equal(h.runs.at(-1)!.threadId, original);
  assert.match(h.runs.at(-1)!.prompt, /明确引用[\s\S]*SPECIFIC-OLD-SPECIFICATION/);
  assert.match(h.runs.at(-1)!.prompt, /DISCUSSION-AFTER-SWITCH/);
  assert.doesNotMatch(h.runs.at(-1)!.prompt, /OTHER-SESSION-TASK|UNRELATED-WHILE-AWAY/);
  await h.send('default', 'Continue again');
  assert.doesNotMatch(h.runs.at(-1)!.prompt, /SPECIFIC-OLD-SPECIFICATION|DISCUSSION-AFTER-SWITCH|UNRELATED-WHILE-AWAY/);
  await h.send('default', `/session id ${other}`);
  await h.send('default', 'Continue second session');
  assert.equal(h.runs.at(-1)!.threadId, other);
  assert.doesNotMatch(h.runs.at(-1)!.prompt, /Continue with quoted requirements|Continue again|UNRELATED-WHILE-AWAY/);
});

test('listing, reselecting and failed switches leave pending group background intact', async t => {
  const h = setup(t);
  await h.send('default', '/new');
  await h.send('default', 'Current task');
  const current = h.store.conversation('oc_team');
  const threadId = current.threadId!;
  const boundary = structuredClone(current.groupContextBoundary!);
  h.store.observeGroup(h.message('default', 'PENDING-WITHOUT-A-SWITCH'));
  await h.send('default', '/session');
  await h.send('default', `/session id ${threadId}`);
  await h.bridge.bind('oc_team', h.dir, threadId);
  await h.send('default', '/session id missing-thread');
  await assert.rejects(h.bridge.bind('oc_team', h.dir, 'missing-thread'), /群聊角色需要专属会话/);
  await assert.rejects(h.bridge.bind('oc_team', h.dir, threadId, current.revision! - 1), /其他入口切换/);
  assert.deepEqual(current.groupContextBoundary, boundary);
  assert.deepEqual(h.store.state.threadBindings[threadId]!.groupContextBoundary, boundary);
  await h.send('default', 'Continue current task');
  assert.match(h.runs.at(-1)!.prompt, /PENDING-WITHOUT-A-SWITCH/);
});

test('reselecting an existing legacy group session does not start a new background boundary', async t => {
  const h = setup(t);
  await h.send('default', 'Legacy task');
  const threadId = h.store.conversation('oc_team').threadId!;
  h.store.observeGroup(h.message('default', 'PENDING-LEGACY-BACKGROUND'));
  await h.send('default', `/session id ${threadId}`);
  assert.equal(h.store.conversation('oc_team').groupContextBoundary, undefined);
  await h.send('default', 'Continue legacy task');
  assert.match(h.runs.at(-1)!.prompt, /PENDING-LEGACY-BACKGROUND/);
});

test('late callbacks retain their captured background but cannot roll back a newer switch boundary', async t => {
  const h = setup(t);
  await h.send('default', 'Session A');
  const first = h.store.conversation('oc_team').threadId!;
  await h.send('default', '/new');
  await h.send('default', 'Session B');
  const second = h.store.conversation('oc_team').threadId!;
  await h.bridge.bind('oc_team', h.dir, first);
  const oldBoundary = h.store.conversation('oc_team').groupContextBoundary!;
  h.store.observeGroup(h.message('default', 'CAPTURED-BEFORE-SWITCH'));
  const entered = deferred(), finish = deferred();
  t.after(() => finish.resolve());
  h.runWith(async input => {
    entered.resolve();
    await finish.promise;
    input.onThread?.(first);
    input.prompt = await input.preparePrompt?.(first) ?? input.prompt;
    input.onSubmitted?.({ threadId: first, turnId: 'late-turn', mode: 'start', status: 'submitted' });
    return { threadId: first, turnId: 'late-turn', text: 'Late result' };
  });
  const pending = h.send('default', 'Already accepted task');
  await entered.promise;
  await h.bridge.bind('oc_team', h.dir, second);
  h.store.observeGroup(h.message('default', 'DISCUSSION-WHILE-AWAY'));
  await h.bridge.bind('oc_team', h.dir, first);
  const newBoundary = structuredClone(h.store.conversation('oc_team').groupContextBoundary!);
  assert.ok(newBoundary.afterSequence > oldBoundary.afterSequence);
  finish.resolve();
  await pending;
  assert.match(h.runs.at(-1)!.prompt, /CAPTURED-BEFORE-SWITCH/);
  assert.deepEqual(h.store.conversation('oc_team').groupContextBoundary, newBoundary);
  assert.deepEqual(h.store.state.threadBindings[first]!.groupContextBoundary, newBoundary);
  const restarted = new Store(h.dir);
  assert.deepEqual(restarted.state.threadBindings[first]!.groupContextBoundary, newBoundary);
  const probe = h.message('default', 'Next task');
  assert.doesNotMatch(restarted.planGroupContext(probe, h.dir, first, newBoundary).text, /CAPTURED-BEFORE-SWITCH|DISCUSSION-WHILE-AWAY/);
});

test('private session switches preserve native bindings without adding group boundaries', async t => {
  const h = setup(t);
  const privateChat = { chatId: 'oc_private', chatType: 'p2p' as const };
  await h.send('default', 'Private A', privateChat);
  const first = h.store.conversation('oc_private').threadId!;
  await h.send('default', '/new', privateChat);
  await h.send('default', 'Private B', privateChat);
  await h.bridge.bind('oc_private', h.dir, first);
  assert.equal(h.store.conversation('oc_private').groupContextBoundary, undefined);
  assert.equal(h.store.state.threadBindings[first]!.groupContextBoundary, undefined);
  await h.send('default', 'Continue private A', privateChat);
  assert.equal(h.runs.at(-1)!.threadId, first);
  assert.doesNotMatch(h.runs.at(-1)!.prompt, /feishu_group_context/);
});
