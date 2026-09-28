import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { Bridge } from '../src/bridge.js';
import { Store } from '../src/store.js';
import { conversationKey, namespaceMessage, parseRoute } from '../src/routing.js';
import type { CodexRunInput, CodexRuntime, InboundMessage, MessageCard, RuntimeAnswer } from '../src/types.js';

const tick = () => new Promise<void>(resolve => setImmediate(resolve));
async function until(predicate: () => boolean, description: string): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!predicate() && Date.now() < deadline) await tick();
  assert.ok(predicate(), `Timed out waiting for ${description}`);
}

type SentCard = { chatId: string; card: MessageCard; id: string };
function setup(t: test.TestContext, options: { linked?: boolean; progress?: boolean } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'group-handoff-bridge-'));
  const store = new Store(dir);
  store.saveConfig({ enabled: true, appId: 'cli_1234567890abcdef', allowedActors: ['pm-user'], allowedGroups: ['oc_team'],
    defaultWorkspace: dir, botName: '产品经理', roleInstructions: '澄清需求，整理验收标准', model: 'pm-model', effort: 'medium',
    progress: options.progress ?? false });
  store.saveBot('dev', { enabled: true, name: '开发人员', appId: 'cli_abcdef1234567890', allowedActors: ['dev-user'],
    allowedGroups: ['oc_team'], roleInstructions: '按照方案实现功能', model: 'dev-model', effort: 'high' });
  store.rememberBotIdentity('default', { openId: 'ou_pm_bot', name: '飞书产品机器人' });
  store.rememberBotIdentity('dev', { openId: 'ou_dev_bot', name: '飞书开发机器人' });
  const runs: CodexRunInput[] = [];
  const runThreads: string[] = [];
  const sent: SentCard[] = [];
  const attempts: SentCard[] = [];
  const stopped: string[] = [];
  const unavailable = new Set<string>();
  const pendingGates: Array<() => void> = [];
  let runner: (input: CodexRunInput, index: number) => Promise<string> = async (_input, index) => index === 1
    ? '登录方案：验证码五分钟有效。\n交接给 @开发人员：实现上述验证码登录，并验证过期场景。'
    : '登录功能已经实现，测试通过。';
  let deliver: (item: SentCard) => Promise<void> = async () => {};
  let submission = (index: number): { turnId: string; mode: 'start' | 'steer' } => ({ turnId: `turn-${index}`, mode: 'start' });
  const runtime: CodexRuntime = {
    supportsSteering: true,
    async run(input) {
      await input.onBeforeSubmit?.();
      runs.push(input);
      const index = runs.length;
      const threadId = input.threadId || `thread-role-${index}`;
      const { turnId, mode } = submission(index);
      runThreads.push(threadId);
      input.onThread?.(threadId);
      input.onSubmitted?.({ threadId, turnId, mode, status: 'submitted' });
      return { threadId, turnId, text: await runner(input, index) };
    },
    async stop(threadId) { stopped.push(threadId); },
    async release() {}, async close() {}, async updateGroupHandoffPolicy() {},
    async models() { return []; }, async history() { return []; }, async status() { return { available: true }; },
    async threadInfo(threadId) { return { threadId, cwd: dir, title: '独立角色会话', isUserThread: true }; },
  };
  const bridge = new Bridge(store, runtime, {
    projects: async () => [],
    threads: async cwd => Object.keys(store.state.threadBindings).map(id => ({ id, cwd, title: id, preview: '', updatedAt: '' })),
  });
  const sendCard = async (chatId: string, card: MessageCard) => {
    const item = { chatId, card, id: `om_reply_${randomUUID()}` };
    attempts.push(item);
    await deliver(item);
    sent.push(item);
    return item.id;
  };
  bridge.transport = {
    isAvailable: chatId => !unavailable.has(parseRoute(chatId).botId),
    async start() {}, async close() {}, async startTyping() { return async () => {}; },
    sendCard, sendText: (chatId, text) => sendCard(chatId, { title: '', text }),
    async sendImage() { return randomUUID(); }, async sendFile() { return randomUUID(); }, async updateCard() {},
  };
  const message = (botId: string, text: string, overrides: Partial<InboundMessage> = {}) => namespaceMessage(botId, {
    id: `om_human_${randomUUID()}`, chatId: 'oc_team', chatType: 'group', actorId: botId === 'default' ? 'pm-user' : 'dev-user',
    actorTenantKey: 'tenant_test', actorUnionId: 'on_same_human', text, ...overrides,
  });
  const send = (botId: string, text: string, overrides: Partial<InboundMessage> = {}) => bridge.receive(message(botId, text, overrides));
  if (options.linked !== false) {
    store.observeGroup(message('default', '我会在这个群里安排工作。'));
    store.observeGroup(message('dev', '我会在这个群里安排工作。'));
  }
  const gate = () => {
    let resolve!: () => void;
    const promise = new Promise<void>(done => { resolve = done; });
    pendingGates.push(resolve);
    return { promise, resolve };
  };
  const idle = async () => {
    // A relay is deliberately scheduled after the current run releases its workspace.
    await tick();
    await until(() => !bridge.hasActiveWork(), 'all relay work to finish');
    await tick();
    assert.equal(bridge.hasActiveWork(), false);
  };
  t.after(async () => {
    for (const resolve of pendingGates) resolve();
    await bridge.close();
    assert.equal(path.dirname(dir), os.tmpdir());
    assert.ok(path.basename(dir).startsWith('group-handoff-bridge-'));
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return { dir, store, bridge, runs, runThreads, sent, attempts, stopped, unavailable, message, send, gate, idle,
    runWith: (fn: typeof runner) => { runner = fn; }, deliverWith: (fn: typeof deliver) => { deliver = fn; },
    submitWith: (fn: typeof submission) => { submission = fn; } };
}

test('a confirmed group result relays to the linked user in the target role own thread', async t => {
  const h = setup(t);
  const delivered = h.gate();
  h.deliverWith(async item => { if (item.card.text.includes('验证码五分钟有效')) await delivered.promise; });
  const source = h.send('default', '设计并实现验证码登录。');
  await until(() => h.attempts.some(item => item.card.text.includes('验证码五分钟有效')), 'source final result');
  assert.equal(h.runs.length, 1, 'no target work before the source final result is delivered');
  delivered.resolve();
  await source;
  await until(() => h.runs.length === 2, 'developer handoff');
  await h.idle();
  assert.notEqual(h.runThreads[0], h.runThreads[1]);
  assert.equal(h.runs[1]!.cwd, h.dir);
  assert.equal(h.runs[1]!.model, 'dev-model');
  assert.equal(h.runs[1]!.effort, 'high');
  assert.match(h.runs[1]!.roleInstructions!, /开发人员/);
  assert.match(h.runs[1]!.prompt, /验证码登录/);
  assert.match(h.runs[1]!.prompt, /验证码五分钟有效/);
  const target = h.store.conversation(conversationKey('dev', 'oc_team'));
  assert.equal(target.actorId, 'dev-user');
  assert.equal(target.threadId, h.runThreads[1]);
  assert.ok(h.sent.some(item => item.chatId === 'oc_team' && item.card.title.includes('产品经理')));
  assert.ok(h.sent.some(item => item.chatId === conversationKey('dev', 'oc_team') && item.card.title.includes('开发人员')));
  assert.equal(h.runs.length, 2);
});

test('a target allowlist alone cannot link a user across applications', async t => {
  const h = setup(t, { linked: false });
  h.store.observeGroup(h.message('dev', '我是另一个人。', { actorUnionId: 'on_other_human' }));
  await h.send('default', '设计验证码登录。');
  await h.idle();
  assert.equal(h.runs.length, 1);
  assert.ok(h.sent.some(item => /身份|账号|关联/.test(item.card.text)));
  assert.equal(h.store.state.conversations[conversationKey('dev', 'oc_team')]?.threadId, undefined);
});

test('revoking target group access before source completion prevents the handoff', async t => {
  const h = setup(t);
  const finish = h.gate();
  h.runWith(async () => { await finish.promise; return '方案已经准备好。\n交接给 @开发人员：实现登录。'; });
  const source = h.send('default', '设计验证码登录。');
  await until(() => h.runs.length === 1, 'source run');
  h.store.authorizeGroup('dev', 'oc_team', false);
  finish.resolve(); await source; await h.idle();
  assert.equal(h.runs.length, 1);
});

test('disabled or disconnected target bots do not receive automatic work', async t => {
  for (const state of ['disabled', 'disconnected'] as const) {
    await t.test(state, async child => {
      const h = setup(child);
      if (state === 'disabled') h.store.saveBot('dev', { enabled: false });
      else h.unavailable.add('dev');
      await h.send('default', '设计验证码登录。'); await h.idle();
      assert.equal(h.runs.length, 1);
    });
  }
});

test('a single user task stops after six handoffs and keeps one thread per role', async t => {
  const h = setup(t);
  h.runWith(async input => input.model === 'pm-model'
    ? '需求评审完成。\n交接给 @开发人员：按照方案继续实现。'
    : '实现结果如下。\n交接给 @产品经理：核对验收标准。');
  await h.send('default', '把验证码登录开发并验收。');
  await until(() => h.runs.length >= 7, 'six handoffs');
  await h.idle();
  assert.equal(h.runs.length, 7, 'one original run plus at most six automatic handoffs');
  assert.equal(new Set(h.runThreads).size, 2);
  assert.ok(h.sent.some(item => /上限|最多|6|六/.test(item.card.text)));
});

test('a stop command to either participant stops the user relay and prevents another hop', async t => {
  const h = setup(t);
  const finishDeveloper = h.gate();
  h.runWith(async (_input, index) => {
    if (index === 1) return '方案完成。\n交接给 @开发人员：实现登录。';
    await finishDeveloper.promise;
    return '开发完成。\n交接给 @产品经理：验收登录。';
  });
  await h.send('default', '设计并开发登录。');
  await until(() => h.runs.length === 2, 'developer running');
  await h.send('default', '/stop');
  assert.ok(h.stopped.includes(h.runThreads[1]!), 'stopping the source bot must stop its active developer handoff');
  finishDeveloper.resolve(); await h.idle();
  assert.equal(h.runs.length, 2);
});

test('a new human assignment cancels the old relay continuation while keeping its current reply', async t => {
  const h = setup(t);
  const finishDeveloper = h.gate();
  h.runWith(async (_input, index) => {
    if (index === 1) return '原方案完成。\n交接给 @开发人员：实现旧需求。';
    if (index === 2) { await finishDeveloper.promise; return '旧任务已整理。\n交接给 @产品经理：验收旧需求。'; }
    return '已经改为按照新需求处理。';
  });
  await h.send('default', '先做旧需求。');
  await until(() => h.runs.length === 2, 'old developer work');
  const manual = h.send('default', '用户现在改成新需求，请只处理新需求。');
  await tick();
  finishDeveloper.resolve(); await manual; await h.idle();
  assert.equal(h.runs.length, 3);
  assert.match(h.runs[2]!.prompt, /用户现在改成新需求/);
  assert.ok(h.sent.some(item => item.card.text.includes('旧任务已整理')));
});

test('/new on a participant cancels an ongoing relay without creating another automatic turn', async t => {
  const h = setup(t);
  const finishDeveloper = h.gate();
  h.runWith(async (_input, index) => {
    if (index === 1) return '产品方案完成。\n交接给 @开发人员：实现登录。';
    await finishDeveloper.promise;
    return '实现完成。\n交接给 @产品经理：验收登录。';
  });
  await h.send('default', '做登录。');
  await until(() => h.runs.length === 2, 'developer work');
  await h.send('default', '/new');
  finishDeveloper.resolve(); await h.idle();
  assert.equal(h.runs.length, 2);
  assert.equal(h.store.conversation('oc_team').threadId, undefined);
});

test('private results and ordinary group mentions never dispatch another bot', async t => {
  for (const scope of ['private', 'ordinary-group-mention'] as const) {
    await t.test(scope, async child => {
      const h = setup(child);
      h.runWith(async () => scope === 'private'
        ? '交接给 @开发人员：实现登录。'
        : '这个方案可以让 @开发人员 看看，暂时先等用户确认。');
      await h.send('default', '先讨论方案。', scope === 'private' ? { chatId: 'oc_private', chatType: 'p2p' } : {});
      await h.idle();
      assert.equal(h.runs.length, 1);
    });
  }
});

test('a handoff appearing only in streaming progress never dispatches work', async t => {
  const h = setup(t, { progress: true });
  const finish = h.gate();
  h.runWith(async input => {
    input.onProgress?.('交接给 @开发人员：实现登录。');
    await finish.promise;
    return '讨论到这里，请先确认需求。';
  });
  const source = h.send('default', '先整理需求。');
  await until(() => h.runs.length === 1, 'streaming source');
  await tick(); assert.equal(h.runs.length, 1);
  assert.ok(h.sent.some(item => item.card.text === '交接给 @开发人员：实现登录。' && item.card.buttons?.some(button => button.command.startsWith('/stop'))));
  finish.resolve(); await source; await h.idle();
  assert.equal(h.runs.length, 1);
});

test('uncertain final delivery never relays or automatically resends the source result', async t => {
  const h = setup(t);
  h.deliverWith(async item => { if (item.card.text.includes('交接给 @开发人员')) throw new Error('simulated lost delivery acknowledgement'); });
  await h.send('default', '设计并开发登录。'); await h.idle();
  assert.equal(h.runs.length, 1);
  assert.equal(h.attempts.filter(item => item.card.text.includes('交接给 @开发人员')).length, 1);
  assert.ok(Object.values(h.store.state.deliveries).some(delivery => delivery.status === 'uncertain'));
});

test('a human takeover before the first handoff exists suppresses the old task future relay', async t => {
  const h = setup(t);
  const finishProduct = h.gate();
  h.runWith(async (_input, index) => {
    if (index === 1) {
      await finishProduct.promise;
      return '旧方案完成。\n交接给 @开发人员：继续实现已经被用户替换的旧需求。';
    }
    return '新需求已处理完成。';
  });
  const source = h.send('default', '设计旧需求。');
  await until(() => h.runs.length === 1, 'original product work');
  const manual = h.send('dev', '现在改成新需求，请只处理新需求。');
  await tick();
  finishProduct.resolve(); await Promise.all([source, manual]); await h.idle();
  assert.equal(h.runs.length, 2, 'the superseded first task must not create a relay after human takeover');
  assert.match(h.runs[1]!.prompt, /现在改成新需求/);
});

test('an old operation-scoped stop button cannot stop a newer relay at the same revision', async t => {
  const h = setup(t, { progress: true });
  const finishOld = h.gate();
  const finishDeveloper = h.gate();
  h.runWith(async (input, index) => {
    if (index === 1) { input.onProgress?.('正在处理旧任务'); await finishOld.promise; return '旧任务已完成。'; }
    if (index === 2) return '新任务方案完成。\n交接给 @开发人员：实现新任务。';
    if (index === 3) { await finishDeveloper.promise; return '新任务实现完成。\n交接给 @产品经理：验收新任务。'; }
    return '新任务验收通过。';
  });
  const oldTask = h.send('default', '完成旧任务。');
  await until(() => h.sent.some(item => item.card.buttons?.some(button => button.command.startsWith('/stop task '))), 'old task commentary creates its progress card');
  const oldProgress = h.sent.find(item => item.chatId === 'oc_team' && item.card.buttons?.some(button => button.command.startsWith('/stop task ')))!;
  assert.ok(oldProgress, 'source progress card must carry an operation-scoped stop button');
  const oldStop = oldProgress.card.buttons!.find(button => button.command.startsWith('/stop task '))!.command;
  finishOld.resolve(); await oldTask; await h.idle();
  const revision = h.store.conversation('oc_team').revision;
  await h.send('default', '开发并验收新任务。');
  await until(() => h.runs.length === 3, 'new developer relay');
  assert.equal(h.store.conversation('oc_team').revision, revision);
  await h.send('default', oldStop, { actionMessageId: oldProgress.id });
  assert.deepEqual(h.stopped, [], 'a completed operation button must not stop any newer task');
  finishDeveloper.resolve();
  await until(() => h.runs.length === 4, 'new relay to continue after stale button');
  await h.idle();
  assert.equal(h.runs.length, 4);
  assert.deepEqual(h.stopped, []);
});

test('a handoff instruction beginning with /new is model input rather than a bridge command', async t => {
  const h = setup(t);
  h.runWith(async (_input, index) => index === 2 ? '请判断这个命令的含义。\n交接给 @开发人员：/new' : '已完成分析。');
  await h.send('dev', '先建立开发会话。'); await h.idle();
  const targetKey = conversationKey('dev', 'oc_team');
  const original = { ...h.store.conversation(targetKey) };
  await h.send('default', '请让开发人员分析 /new 命令，不要真的切换会话。');
  await until(() => h.runs.length === 3, 'slash instruction to reach the model');
  await h.idle();
  assert.equal(h.runs[2]!.threadId, original.threadId);
  assert.equal(h.store.conversation(targetKey).threadId, original.threadId);
  assert.equal(h.store.conversation(targetKey).revision, original.revision);
  assert.match(h.runs[2]!.prompt, /^【飞书消息】[^\n]+\n\n\/new(?:\n|$)/);
  assert.equal(h.runs[2]!.allowSteering, false);
  assert.equal(h.sent.some(item => item.card.title === '新会话已就绪'), false);
});

test('revoking the origin user immediately declines target approvals despite target access remaining valid', async t => {
  const h = setup(t);
  let answer: RuntimeAnswer | undefined;
  h.runWith(async (input, index) => {
    if (index === 1) return '方案完成。\n交接给 @开发人员：运行开发检查。';
    answer = await input.onRequest!({ id: 'approval-target', kind: 'approval', title: '开发检查需要审批', text: '是否运行检查？' });
    return '已收到审批结果。\n交接给 @产品经理：核对结果。';
  });
  await h.send('default', '安排开发检查。');
  await until(() => h.bridge.pendingRequests().length === 1, 'target approval request');
  const targetKey = conversationKey('dev', 'oc_team');
  assert.equal(h.bridge.pendingRequests()[0]!.chatId, targetKey);
  assert.equal(h.store.isAuthorized(targetKey, 'dev-user', 'group'), true);
  h.store.authorize('pm-user', false, 'default');
  await until(() => answer !== undefined, 'origin revocation to decline target approval');
  assert.equal(answer!.decision, 'decline');
  assert.equal(h.bridge.pendingRequests().length, 0);
  assert.equal(h.store.isAuthorized(targetKey, 'dev-user', 'group'), true);
  assert.ok(h.stopped.includes(h.runThreads[1]!));
  await h.idle();
  assert.equal(h.runs.length, 2);
});

test('redelivery of the same real human message leaves an active relay intact', async t => {
  const h = setup(t);
  const finishDeveloper = h.gate();
  h.runWith(async (_input, index) => {
    if (index === 1) return '方案完成。\n交接给 @开发人员：实现登录。';
    if (index === 2) { await finishDeveloper.promise; return '开发完成。\n交接给 @产品经理：验收登录。'; }
    return '验收通过。';
  });
  const original = h.message('default', '设计、开发并验收登录。');
  await h.bridge.receive(original);
  await until(() => h.runs.length === 2, 'developer relay before duplicate');
  await h.bridge.receive({ ...original });
  assert.equal(h.runs.length, 2, 'the duplicate must not start a second human task');
  assert.deepEqual(h.stopped, []);
  finishDeveloper.resolve();
  await until(() => h.runs.length === 3, 'relay to continue after duplicate delivery');
  await h.idle();
  assert.equal(h.runs.length, 3);
  assert.deepEqual(h.stopped, []);
});

test('a human takeover in the target thread cancels future relay without stopping the shared thread', async t => {
  const h = setup(t);
  const finishDeveloper = h.gate();
  h.runWith(async (_input, index) => {
    if (index === 1) return '原任务方案完成。\n交接给 @开发人员：处理原任务。';
    if (index === 2) { await finishDeveloper.promise; return '原任务结果已整理。\n交接给 @产品经理：验收原任务。'; }
    return '已按用户补充处理。';
  });
  await h.send('default', '处理原任务。');
  await until(() => h.runs.length === 2, 'active target relay');
  const targetThread = h.runThreads[1];
  const manual = h.send('dev', '我来接着说明，请按我的补充修改，不要继续自动交接。');
  await until(() => h.runs.length === 3, 'human input in the same target thread');
  assert.equal(h.runThreads[2], targetThread);
  assert.equal(h.runs[1]!.allowSteering, false);
  assert.notEqual(h.runs[2]!.allowSteering, false, 'human continuation may use normal steering');
  assert.deepEqual(h.stopped, [], 'cancelling only the future handoff must not kill human work in that thread');
  finishDeveloper.resolve(); await manual; await h.idle();
  assert.equal(h.runs.length, 3);
  assert.deepEqual(h.stopped, []);
});

test('one native turn with a human followup delivers once and relays the latest human task', async t => {
  const h = setup(t);
  const firstFinished = h.gate();
  const latestFinished = h.gate();
  const latestTask = '补充要求：改为双因素登录，方案确定后交给开发人员实现。';
  const finalText = '已按用户补充更新为双因素登录方案。\n交接给 @开发人员：实现最新的双因素登录。';
  h.submitWith(index => ({ turnId: index <= 2 ? 'native-human-followup' : `turn-${index}`, mode: index === 2 ? 'steer' : 'start' }));
  h.runWith(async (_input, index) => {
    if (index === 1) { await firstFinished.promise; return finalText; }
    if (index === 2) { await latestFinished.promise; return finalText; }
    return '双因素登录已经实现。';
  });
  const first = h.message('default', '先设计普通验证码登录。');
  const source = h.bridge.receive(first);
  await until(() => h.runs.length === 1, 'initial human turn');
  const latest = h.message('default', latestTask);
  const followup = h.bridge.receive(latest);
  await until(() => h.runs.length === 2, 'human followup in the same native turn');
  assert.equal(h.runThreads[0], h.runThreads[1]);
  assert.equal(h.store.state.operations[first.id]!.turnId, h.store.state.operations[latest.id]!.turnId);
  firstFinished.resolve();
  await tick();
  latestFinished.resolve();
  await Promise.all([source, followup]);
  await until(() => h.runs.length === 3, 'latest human handoff');
  await h.idle();
  assert.equal(h.sent.filter(item => item.chatId === 'oc_team' && item.card.text === finalText).length, 1);
  assert.ok(h.runs[2]!.prompt.includes(`原始用户任务：${JSON.stringify(latestTask)}`));
  assert.equal(h.runs[2]!.model, 'dev-model');
  assert.equal(h.runs.length, 3);
  assert.deepEqual(h.stopped, []);
});

test('a human steering a native relay turn starts a new chain with its latest task and one final card', async t => {
  const h = setup(t);
  const relayFinished = h.gate();
  const humanFinished = h.gate();
  const latestTask = '用户追加：停止旧方案的后续交接，按新验收范围修改，再交给产品经理评审。';
  const finalText = '已经按用户的新验收范围修改。\n交接给 @产品经理：评审新的验收范围。';
  h.submitWith(index => ({ turnId: index === 2 || index === 3 ? 'native-relay-followup' : `turn-${index}`, mode: index === 3 ? 'steer' : 'start' }));
  h.runWith(async (_input, index) => {
    if (index === 1) return '旧需求方案完成。\n交接给 @开发人员：实现原来的验证码登录。';
    if (index === 2) { await relayFinished.promise; return finalText; }
    if (index === 3) { await humanFinished.promise; return finalText; }
    return '新的验收范围评审完成。';
  });
  await h.send('default', '请设计并实现原来的验证码登录。');
  await until(() => h.runs.length === 2, 'developer native relay turn');
  const oldRelay = Object.values(h.store.state.operations).find(operation => operation.id.startsWith('relay:'))!;
  assert.ok(oldRelay);
  const human = h.message('dev', latestTask);
  const followup = h.bridge.receive(human);
  await until(() => h.runs.length === 3, 'human steering the target native turn');
  assert.equal(h.runThreads[1], h.runThreads[2]);
  assert.equal(h.store.state.operations[oldRelay.id]!.turnId, h.store.state.operations[human.id]!.turnId);
  relayFinished.resolve();
  await tick();
  humanFinished.resolve();
  await followup;
  await until(() => h.runs.length === 4, 'human-owned new relay chain');
  await h.idle();
  const targetKey = conversationKey('dev', 'oc_team');
  assert.equal(h.sent.filter(item => item.chatId === targetKey && item.card.text === finalText).length, 1);
  assert.ok(h.runs[3]!.prompt.includes(`原始用户任务：${JSON.stringify(latestTask)}`));
  assert.match(h.runs[3]!.prompt, /第 1\/6 次/);
  const relays = Object.values(h.store.state.operations).filter(operation => operation.id.startsWith('relay:'));
  assert.equal(relays.length, 2);
  assert.equal(relays.every(operation => operation.id.endsWith(':1')), true);
  assert.notEqual(relays[0]!.id.split(':')[1], relays[1]!.id.split(':')[1]);
  assert.equal(h.runs.length, 4);
  assert.deepEqual(h.stopped, []);
});

test('a shared human multi-mention reuses the target queued task instead of dispatching another relay', async t => {
  const h = setup(t);
  const finishProduct = h.gate();
  const humanId = `om_shared_request_${randomUUID()}`;
  const humanText = '产品经理先整理方案，开发人员按方案实现登录。';
  h.runWith(async (_input, index) => {
    if (index === 1) {
      await finishProduct.promise;
      return '登录方案已经确定。\n交接给 @开发人员：按上述方案实现登录。';
    }
    return '登录功能已经完成。';
  });
  const source = h.send('default', humanText, { id: humanId });
  await until(() => h.runs.length === 1, 'product task to hold the project lock');
  const developerMessage = h.message('dev', humanText, { id: humanId });
  const developer = h.bridge.receive(developerMessage);
  await until(() => h.store.state.operations[developerMessage.id]?.status === 'received'
    && h.sent.some(item => item.chatId === developerMessage.chatId && item.card.title === '等待项目空闲'), 'same human message queued for the developer');
  assert.equal(h.runs.length, 1, 'developer must still be waiting for the shared project lock');
  finishProduct.resolve();
  await Promise.all([source, developer]);
  await h.idle();
  assert.equal(h.runs.length, 2, 'the explicit developer task must not receive an additional synthetic copy');
  assert.equal(h.runs[1]!.model, 'dev-model');
  assert.equal(h.runs[1]!.prompt.split('\n\n')[1], humanText);
  assert.match(h.runs[1]!.prompt, /登录方案已经确定/, 'the queued task sees the newly delivered source result');
  assert.equal(Object.values(h.store.state.operations).filter(operation => operation.id.startsWith('relay:')).length, 0);
});

test('two final handoff lines for the same target dispatch only the last instruction once', async t => {
  const h = setup(t);
  const instruction = '只实现最终确认的邮箱登录。';
  h.runWith(async (_input, index) => index === 1
    ? `方案修订如下。\n交接给 @开发人员：实现最初讨论的手机号登录。\n交接给 @开发人员：${instruction}`
    : '最终确认的邮箱登录已经实现。');
  await h.send('default', '整理最终登录方案后交给开发人员。');
  await until(() => h.runs.length === 2, 'the final handoff instruction');
  await h.idle();
  assert.equal(h.runs.length, 2);
  assert.equal(h.runs[1]!.prompt.split('\n\n')[1], instruction);
  assert.equal(Object.values(h.store.state.operations).filter(operation => operation.id.startsWith('relay:')).length, 1);
});
