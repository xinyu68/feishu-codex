import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { Bridge } from '../src/bridge.js';
import { Store } from '../src/store.js';
import { RuntimeRouter } from '../src/runtime-router.js';
import { conversationKey } from '../src/routing.js';
import type { CodexRunInput, CodexRuntime, MessageCard, RuntimeEvent } from '../src/types.js';

function fixture(t: test.TestContext) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'feishu-runtime-routing-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = new Store(dir);
  store.saveConfig({ enabled: true, allowedActors: ['ou_alice'], allowedGroups: ['oc_group'], defaultWorkspace: dir, roleInstructions: '开发代码' });
  store.saveBot('product', { name: '产品经理', enabled: true, allowedActors: ['ou_alice'], allowedGroups: ['oc_group'], roleInstructions: '只做产品方案' });
  const calls: Array<{ engine: string; input: CodexRunInput }> = [];
  const stops: string[] = [];
  const historyReads: string[] = [];
  const cards: MessageCard[] = [];
  let sequence = 0;
  const runtime = (engine: 'codex' | 'hermes'): CodexRuntime => ({
    supportsSteering: engine === 'codex',
    async run(input) {
      await input.onBeforeSubmit?.();
      const threadId = input.threadId || `${engine === 'hermes' ? 'hermes:' : ''}thread-${++sequence}`;
      const turnId = `turn-${++sequence}`;
      input.onThread?.(threadId);
      input.prompt = await input.preparePrompt?.(threadId) ?? input.prompt;
      input.onSubmitted?.({ threadId, turnId, mode: 'start', status: 'submitted' });
      calls.push({ engine, input });
      return { threadId, turnId, text: `${engine} reply` };
    },
    async stop(id) { stops.push(id); }, async release() {}, async close() {},
    async models() { return []; }, async status() { return { available: true, authenticated: true }; },
    async history(id) { historyReads.push(`${engine}:${id}`); return [{ role: 'assistant', text: `${engine} history` }]; },
  });
  const codex = runtime('codex');
  const hermes = runtime('hermes');
  const routed = new RuntimeRouter(codex, hermes);
  let denyDesktop = false;
  const bridge = new Bridge(store, routed, {
    projects: async () => [{ path: dir, name: 'test', threadCount: 0, lastActiveAt: '' }],
    threads: async () => [{ id: 'desktop-thread', cwd: dir, title: '桌面会话', preview: '', updatedAt: '' }],
    assertCanWrite: () => { if (denyDesktop) throw new Error('desktop unavailable'); },
  });
  bridge.transport = {
    async start() {}, async close() {}, async sendText(_chatId, text) { cards.push({ title: '', text }); return randomUUID(); },
    async sendCard(_chatId, card) { cards.push(card); return randomUUID(); }, async updateCard(_id, card) { cards.push(card); },
    async sendImage() { return randomUUID(); }, async sendFile() { return randomUUID(); }, async startTyping() { return async () => {}; },
  };
  t.after(() => bridge.close());
  const productChat = conversationKey('product', 'oc_group');
  const send = (chatId: string, text: string) => bridge.receive({ id: randomUUID(), chatId, actorId: 'ou_alice', chatType: 'group', text });
  return { dir, store, codex, hermes, routed, bridge, productChat, send, calls, cards, stops, historyReads, setDenied(value: boolean) { denyDesktop = value; } };
}

test('Hermes /new resets automatic group background without changing the Codex bot', async t => {
  const h = fixture(t);
  await h.bridge.setBotEngine('product', 'hermes');
  await h.send(h.productChat, 'OLD-HERMES-REQUIREMENTS');
  const old = h.store.conversation(h.productChat).threadId!;
  await h.send(h.productChat, '/new');
  await h.send(h.productChat, 'New Hermes task');
  const fresh = h.store.conversation(h.productChat).threadId!;
  assert.notEqual(fresh, old);
  assert.doesNotMatch(h.calls.at(-1)!.input.prompt, /OLD-HERMES-REQUIREMENTS|hermes reply/);
  assert.match(h.calls.at(-1)!.input.roleInstructions!, /只做产品方案/);
  await h.send('oc_group', 'Codex keeps group discussion');
  assert.match(h.calls.at(-1)!.input.prompt, /OLD-HERMES-REQUIREMENTS/);
});

test('Hermes bot bypasses desktop write gate and retains its independent session and group role', async t => {
  const h = fixture(t);
  await h.bridge.setBotEngine('product', 'hermes');
  h.setDenied(true);
  await h.send(h.productChat, '记住代号 H731');
  await h.send(h.productChat, '刚才是什么');
  await h.send('oc_group', '开发工作');
  assert.equal(h.calls.length, 2);
  assert.deepEqual(h.calls.map(call => call.engine), ['hermes', 'hermes']);
  assert.equal(h.calls[1]!.input.threadId, h.store.conversation(h.productChat).threadId);
  assert.match(h.calls[1]!.input.roleInstructions!, /只做产品方案/);
  assert.doesNotMatch(h.calls[1]!.input.roleInstructions!, /Codex 桌面继续/);
  assert.equal(h.calls[1]!.input.model, undefined);
  assert.ok(h.cards.some(card => /desktop unavailable/.test(card.text)));
  const history = await h.bridge.history(h.productChat);
  assert.equal(history.messages[0]?.text, 'hermes history');
  assert.ok(h.historyReads.every(id => id.startsWith('hermes:hermes:')));
});

test('Hermes cannot bind Codex desktop sessions and Codex cannot bind Hermes sessions', async t => {
  const h = fixture(t);
  await h.bridge.setBotEngine('product', 'hermes');
  await h.send(h.productChat, '开始方案');
  const oldThread = h.store.conversation(h.productChat).threadId!;
  await assert.rejects(h.bridge.bind(h.productChat, h.dir, 'desktop-thread'), /独立会话/);
  await assert.rejects(h.bridge.bind('oc_group', h.dir, oldThread), /独立会话/);
  await h.bridge.newConversation(h.productChat);
  await h.send(h.productChat, '新方案');
  const sessions = await h.bridge.sessions(h.productChat, h.dir);
  assert.equal(sessions.length, 2);
  assert.ok(sessions.every(session => session.id.startsWith('hermes:')));
  await h.bridge.bind(h.productChat, h.dir, oldThread);
  assert.equal(h.store.conversation(h.productChat).threadId, oldThread);
  assert.equal((await h.bridge.sessions('oc_group', h.dir)).some(session => session.id.startsWith('hermes:')), false);
});

test('engine migration preserves previous bindings and authorization, resets only selected bot', async t => {
  const h = fixture(t);
  const product = h.store.conversation(h.productChat, 'ou_alice', h.dir, 'group');
  Object.assign(product, { threadId: 'old-product', model: 'gpt-model', effort: 'high', title: '旧方案' });
  const developer = h.store.conversation('oc_group', 'ou_alice', h.dir, 'group');
  Object.assign(developer, { threadId: 'old-developer', title: '开发任务' });
  h.store.message(h.productChat, 'assistant', '保留旧方案');
  h.store.save();
  await h.bridge.setBotEngine('product', 'hermes');
  assert.equal(product.threadId, undefined);
  assert.equal(product.model, '');
  assert.equal(developer.threadId, 'old-developer');
  assert.equal(h.store.state.threadBindings['old-product']?.title, '旧方案');
  assert.deepEqual(h.store.bot('product')!.allowedGroups, ['oc_group']);
  const backups = fs.readdirSync(path.join(h.dir, 'engine-migrations'));
  const backup = JSON.parse(fs.readFileSync(path.join(h.dir, 'engine-migrations', backups[0]!), 'utf8'));
  assert.equal(backup.history[h.productChat][0].text, '保留旧方案');
  assert.equal(h.store.bot('default')!.engine, 'codex');
});

test('Hermes rejects Codex-specific commands with an actionable explanation', async t => {
  const h = fixture(t);
  await h.bridge.setBotEngine('product', 'hermes');
  for (const command of ['/model', '/effort high', '/usage']) await h.send(h.productChat, command);
  assert.equal(h.calls.length, 0);
  assert.equal(h.cards.filter(card => /请在 Hermes/.test(card.text)).length, 3);
});

test('active product task blocks its engine switch and stop reaches Hermes only', async t => {
  const h = fixture(t);
  await h.bridge.setBotEngine('product', 'hermes');
  let complete!: () => void;
  h.hermes.run = async input => {
    input.onThread?.('hermes:running');
    await new Promise<void>(resolve => { complete = resolve; });
    return { threadId: 'hermes:running', text: 'done' };
  };
  const turn = h.send(h.productChat, '长任务');
  while (!complete) await new Promise<void>(resolve => setImmediate(resolve));
  await assert.rejects(h.bridge.setBotEngine('product', 'codex'), /仍有任务/);
  await h.bridge.stop(h.productChat);
  assert.deepEqual(h.stops, ['hermes:running']);
  complete(); await turn;
  await h.bridge.setBotEngine('product', 'codex');
  assert.equal(h.store.bot('product')!.engine, 'codex');
});

test('a different active Codex desktop turn does not block changing the idle product bot', async t => {
  const h = fixture(t);
  let complete!: () => void;
  h.codex.run = async input => {
    input.onThread?.('desktop-running');
    await new Promise<void>(resolve => { complete = resolve; });
    return { threadId: 'desktop-running', text: 'done' };
  };
  const turn = h.send('oc_group', '开发任务');
  while (!complete) await new Promise<void>(resolve => setImmediate(resolve));
  await h.bridge.setBotEngine('product', 'hermes');
  assert.equal(h.store.bot('product')!.engine, 'hermes');
  complete(); await turn;
});

test('Hermes product can hand off a public group result to the separate Codex developer session', async t => {
  const h = fixture(t);
  h.store.saveBot('default', { name: '开发人员', appId: 'cli_1234567890abcdef' });
  h.store.saveBot('product', { appId: 'cli_abcdef1234567890' });
  for (const chatId of ['oc_group', h.productChat]) h.store.observeGroup({ id: `om_${randomUUID()}`, chatId, actorId: 'ou_alice',
    chatType: 'group', actorTenantKey: 'tenant_test', actorUnionId: 'same_human', text: '授权群协作' });
  await h.bridge.setBotEngine('product', 'hermes');
  const original = h.hermes.run.bind(h.hermes);
  h.hermes.run = async input => ({ ...await original(input), text: '产品方案：验证码有效期五分钟。\n交接给 @开发人员：按方案实现并测试验证码过期。' });
  await h.send(h.productChat, '设计登录方案后交给开发');
  const deadline = Date.now() + 2000;
  while (h.bridge.hasActiveWork() && Date.now() < deadline) await new Promise<void>(resolve => setImmediate(resolve));
  assert.deepEqual(h.calls.map(call => call.engine), ['hermes', 'codex']);
  assert.match(h.calls[1]!.input.prompt, /验证码有效期五分钟/);
  assert.match(h.calls[1]!.input.prompt, /按方案实现并测试验证码过期/);
  assert.ok(h.store.conversation(h.productChat).threadId!.startsWith('hermes:'));
  assert.ok(!h.store.conversation('oc_group').threadId!.startsWith('hermes:'));
});

test('RuntimeRouter forwards live events from both runtimes and unsubscribes both listeners', async t => {
  const h = fixture(t);
  const listeners = { codex: new Set<(event: RuntimeEvent) => void>(), hermes: new Set<(event: RuntimeEvent) => void>() };
  h.codex.subscribe = listener => { listeners.codex.add(listener); return () => { listeners.codex.delete(listener); }; };
  h.hermes.subscribe = listener => { listeners.hermes.add(listener); return () => { listeners.hermes.delete(listener); }; };
  const events: RuntimeEvent[] = [];
  const unsubscribe = h.routed.subscribe(event => events.push(event));
  const codexEvent: RuntimeEvent = { method: 'item/started', threadId: 'codex-thread', turnId: 'codex-turn' };
  const hermesEvent: RuntimeEvent = { method: 'item/completed', threadId: 'hermes:session', turnId: 'hermes-turn' };
  for (const listener of listeners.codex) listener(codexEvent);
  for (const listener of listeners.hermes) listener(hermesEvent);
  assert.deepEqual(events, [codexEvent, hermesEvent]);
  unsubscribe();
  assert.equal(listeners.codex.size, 0);
  assert.equal(listeners.hermes.size, 0);
});

test('switching back to Hermes keeps native history and roles while restarting only its automatic group background', async t => {
  const h = fixture(t);
  await h.bridge.setBotEngine('product', 'hermes');
  await h.send(h.productChat, 'HERMES-NATIVE-HISTORY');
  const oldThread = h.store.conversation(h.productChat).threadId!;
  const originalRole = h.store.state.threadBindings[oldThread]!.roleInstructions;
  await h.send('oc_group', 'Start the independent Codex session');
  const developer = structuredClone(h.store.conversation('oc_group'));
  const developerReceiptKey = h.store.groupContextKey('oc_group', h.dir, developer.threadId!);
  const developerReceipt = structuredClone(h.store.state.groupContextReceipts[developerReceiptKey]);

  await h.send(h.productChat, '/new');
  await h.send(h.productChat, 'HERMES-OTHER-SESSION');
  h.store.observeGroup({ id: 'om_hermes_away', chatId: h.productChat, actorId: 'ou_alice', chatType: 'group', text: 'DISCUSSION-WHILE-HERMES-AWAY' });
  h.store.saveBot('product', { roleInstructions: '修改后的产品角色' });
  const beforeSwitch = h.store.state.groupMessageSequence;
  await h.bridge.bind(h.productChat, h.dir, oldThread);

  const resumed = h.store.conversation(h.productChat);
  assert.equal(resumed.threadId, oldThread);
  assert.equal(resumed.groupContextBoundary?.afterSequence, beforeSwitch);
  assert.equal(h.store.state.threadBindings[oldThread]!.roleInstructions, originalRole);
  assert.deepEqual(h.store.state.threadBindings[oldThread]!.groupContextBoundary, resumed.groupContextBoundary);
  assert.deepEqual(h.store.conversation('oc_group'), developer);
  assert.deepEqual(h.store.state.groupContextReceipts[developerReceiptKey], developerReceipt);
  assert.equal((await h.bridge.history(h.productChat)).messages[0]?.text, 'hermes history');
  assert.equal(h.historyReads.at(-1), `hermes:${oldThread}`);

  h.store.observeGroup({ id: 'om_hermes_returned', chatId: h.productChat, actorId: 'ou_alice', chatType: 'group', text: 'DISCUSSION-AFTER-HERMES-RETURNED' });
  const restarted = new Store(h.dir);
  assert.equal(restarted.conversation(h.productChat).threadId, oldThread);
  assert.deepEqual(restarted.conversation(h.productChat).groupContextBoundary, resumed.groupContextBoundary);
  assert.equal(restarted.state.threadBindings[oldThread]!.roleInstructions, originalRole);
  const backgroundAfterRestart = restarted.planGroupContext({ id: 'om_after_restart', chatId: h.productChat,
    actorId: 'ou_alice', chatType: 'group', text: 'Continue after restart' }, h.dir, oldThread,
    restarted.conversation(h.productChat).groupContextBoundary).text;
  assert.match(backgroundAfterRestart, /DISCUSSION-AFTER-HERMES-RETURNED/);
  assert.doesNotMatch(backgroundAfterRestart, /DISCUSSION-WHILE-HERMES-AWAY|HERMES-OTHER-SESSION/);

  await h.send(h.productChat, 'Continue the original Hermes session');
  const continued = h.calls.at(-1)!;
  assert.equal(continued.engine, 'hermes');
  assert.equal(continued.input.threadId, oldThread);
  assert.match(continued.input.prompt, /DISCUSSION-AFTER-HERMES-RETURNED/);
  assert.doesNotMatch(continued.input.prompt, /DISCUSSION-WHILE-HERMES-AWAY|HERMES-OTHER-SESSION/);
  assert.equal(continued.input.roleInstructions, originalRole);
  assert.doesNotMatch(continued.input.roleInstructions!, /修改后的产品角色/);

  await h.send('oc_group', 'Continue the independent Codex session');
  assert.equal(h.calls.at(-1)!.input.threadId, developer.threadId);
  assert.match(h.calls.at(-1)!.input.prompt, /DISCUSSION-WHILE-HERMES-AWAY/);
  assert.equal(h.store.conversation('oc_group').groupContextBoundary, developer.groupContextBoundary);
});

test('listing Hermes sessions, choosing the current session and rejected switches keep pending group background', async t => {
  const h = fixture(t);
  await h.bridge.setBotEngine('product', 'hermes');
  await h.send(h.productChat, 'First Hermes session');
  const originalThread = h.store.conversation(h.productChat).threadId!;
  await h.send(h.productChat, '/new');
  await h.send(h.productChat, 'Second Hermes session');
  await h.bridge.bind(h.productChat, h.dir, originalThread);
  const boundary = structuredClone(h.store.conversation(h.productChat).groupContextBoundary);
  assert.ok(boundary);
  h.store.observeGroup({ id: 'om_pending_hermes_background', chatId: h.productChat, actorId: 'ou_alice',
    chatType: 'group', text: 'PENDING-HERMES-BACKGROUND' });

  await h.send(h.productChat, '/session');
  assert.deepEqual(h.store.conversation(h.productChat).groupContextBoundary, boundary);
  assert.equal((await h.bridge.sessions(h.productChat, h.dir)).length, 2);
  await h.bridge.bind(h.productChat, h.dir, originalThread);
  assert.deepEqual(h.store.conversation(h.productChat).groupContextBoundary, boundary);
  await assert.rejects(h.bridge.bind(h.productChat, h.dir, 'hermes:missing-session'), /群聊角色需要专属会话/);
  assert.equal(h.store.conversation(h.productChat).threadId, originalThread);
  assert.deepEqual(h.store.conversation(h.productChat).groupContextBoundary, boundary);

  await h.send(h.productChat, 'Receive the pending discussion');
  assert.equal(h.calls.at(-1)!.input.threadId, originalThread);
  assert.match(h.calls.at(-1)!.input.prompt, /PENDING-HERMES-BACKGROUND/);
});
