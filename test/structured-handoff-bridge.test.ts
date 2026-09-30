import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { Bridge } from '../src/bridge.js';
import { Store } from '../src/store.js';
import { RuntimeRouter } from '../src/runtime-router.js';
import { conversationKey, namespaceMessage } from '../src/routing.js';
import type { CodexRunInput, CodexRuntime, InboundMessage, MessageCard, RuntimeEvent } from '../src/types.js';

const tick = () => new Promise<void>(resolve => setImmediate(resolve));
async function until(predicate: () => boolean, description: string): Promise<void> {
  const deadline = Date.now() + 2500;
  while (!predicate() && Date.now() < deadline) await tick();
  assert.ok(predicate(), `Timed out waiting for ${description}`);
}

type Run = { input: CodexRunInput; threadId: string; turnId: string };
type Sent = { chatId: string; card: MessageCard; id: string };
function setup(t: test.TestContext, sourceEngine: 'codex' | 'hermes' = 'codex') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'structured-handoff-'));
  const store = new Store(dir);
  store.saveConfig({ enabled: true, appId: 'cli_1234567890abcdef', allowedActors: ['pm-user'], allowedGroups: ['oc_team'],
    defaultWorkspace: dir, botName: '产品经理', roleInstructions: '整理需求', model: 'pm-model', progress: false });
  store.saveBot('dev', { enabled: true, appId: 'cli_abcdef1234567890', name: '开发人员', allowedActors: ['dev-user'],
    allowedGroups: ['oc_team'], roleInstructions: '实现功能', model: 'dev-model' });
  store.saveBot('qa', { enabled: true, appId: 'cli_abcdef0987654321', name: '测试人员', allowedActors: ['qa-user'],
    allowedGroups: ['oc_team'], roleInstructions: '验证功能', model: 'qa-model' });
  store.rememberBotIdentity('dev', { openId: 'ou_dev_bot', name: '开发助手' });
  if (sourceEngine === 'hermes') store.saveBot('default', { engine: 'hermes' });
  const runs: Run[] = [];
  const sent: Sent[] = [];
  const attempts: Sent[] = [];
  const stopped: string[] = [];
  const listeners = { codex: new Set<(event: RuntimeEvent) => void>(), hermes: new Set<(event: RuntimeEvent) => void>() };
  const releases: Array<() => void> = [];
  let runner = async (_run: Run, _index: number): Promise<string> => '本轮工作已完成。';
  let deliver = async (_item: Sent): Promise<void> => {};
  let submission = (index: number): { turnId: string; mode: 'start' | 'steer' } => ({ turnId: `turn-${index}`, mode: 'start' });
  let beforeSubmitted = async (_run: Run, _index: number): Promise<'submitted' | 'uncertain' | 'rejected'> => 'submitted';
  const runtime = (engine: 'codex' | 'hermes'): CodexRuntime => ({
    supportsSteering: engine === 'codex',
    subscribe(listener) { listeners[engine].add(listener); return () => listeners[engine].delete(listener); },
    async run(input) {
      await input.onBeforeSubmit?.();
      const index = runs.length;
      const { turnId, mode } = submission(index);
      const run = { input, threadId: input.threadId || `${engine === 'hermes' ? 'hermes:' : ''}thread-${index}`, turnId };
      runs.push(run);
      input.onThread?.(run.threadId);
      input.onSubmitted?.({ threadId: run.threadId, turnId: mode === 'steer' ? turnId : undefined, mode, status: 'submitting' });
      const status = await beforeSubmitted(run, index);
      input.onSubmitted?.({ threadId: run.threadId, turnId: status === 'submitted' || mode === 'steer' ? turnId : undefined, mode, status });
      if (status !== 'submitted') throw new Error(`Simulated ${status} submission`);
      return { threadId: run.threadId, turnId, text: await runner(run, index) };
    },
    async stop(threadId) { stopped.push(threadId); },
    async release() {}, async close() {}, async updateGroupHandoffPolicy() {},
    async models() { return []; }, async history() { return []; }, async status() { return { available: true }; },
    async threadInfo(threadId) { return { threadId, cwd: dir, title: '群角色会话', isUserThread: true }; },
  });
  const bridge = new Bridge(store, new RuntimeRouter(runtime('codex'), runtime('hermes')), {
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
    isAvailable: () => true, async start() {}, async close() {}, async startTyping() { return async () => {}; },
    sendCard, sendText: (chatId, text) => sendCard(chatId, { title: '', text }),
    async sendImage() { return randomUUID(); }, async sendFile() { return randomUUID(); }, async updateCard() {},
  };
  const message = (text: string, overrides: Partial<InboundMessage> = {}, botId = 'default') => namespaceMessage(botId, {
    id: `om_human_${randomUUID()}`, chatId: 'oc_team', chatType: 'group',
    actorId: botId === 'default' ? 'pm-user' : `${botId}-user`, actorTenantKey: 'tenant_test', actorUnionId: 'on_same_human', text, ...overrides,
  });
  for (const botId of ['default', 'dev', 'qa']) store.observeGroup(message('准备协作。', {}, botId));
  const emitRaw = (event: RuntimeEvent) => {
    for (const listener of listeners[event.threadId?.startsWith('hermes:') ? 'hermes' : 'codex']) listener(event);
  };
  const emit = (event: RuntimeEvent) => {
    if (event.method === 'item/completed') {
      const { result: _result, error: _error, ...item } = event.params!.item as Record<string, unknown>;
      emitRaw({ ...event, method: 'item/started', params: { ...event.params, item: { ...item, status: 'inProgress' } } });
    }
    emitRaw(event);
  };
  const event = (index: number, args: unknown = { target: '开发人员', task: '实现登录。' }, itemPatch: Record<string, unknown> = {}): RuntimeEvent => ({
    method: 'item/completed', threadId: runs[index]!.threadId, turnId: runs[index]!.turnId,
    params: { item: { id: `tool-${randomUUID()}`, type: 'mcpToolCall', server: 'feishu_completion', tool: 'request_feishu_group_handoff',
      arguments: args, status: 'completed', result: { content: [{ type: 'text', text: '申请已提交，尚未执行交接。' }], structuredContent: args, isError: false }, ...itemPatch } },
  });
  const gate = () => {
    let resolve!: () => void;
    const promise = new Promise<void>(done => { resolve = done; });
    releases.push(resolve);
    return { promise, resolve };
  };
  const idle = async () => { await tick(); await until(() => !bridge.hasActiveWork(), 'bridge idle'); await tick(); };
  const relays = () => Object.values(store.state.operations).filter(operation => operation.id.startsWith('relay:'));
  t.after(async () => {
    for (const release of releases) release();
    await bridge.close();
    assert.equal(path.dirname(dir), os.tmpdir());
    assert.ok(path.basename(dir).startsWith('structured-handoff-'));
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return { dir, store, bridge, runs, sent, attempts, stopped, message, emit, emitRaw, event, gate, idle, relays,
    send: (text: string, overrides: Partial<InboundMessage> = {}) => bridge.receive(message(text, overrides)),
    runWith: (fn: typeof runner) => { runner = fn; }, deliverWith: (fn: typeof deliver) => { deliver = fn; },
    submitWith: (fn: typeof submission) => { submission = fn; },
    beforeSubmitted: (fn: typeof beforeSubmitted) => { beforeSubmitted = fn; } };
}

test('structured handoff waits for the source reply and runs the selected role in its own thread', async t => {
  const h = setup(t);
  const finished = h.gate();
  const delivered = h.gate();
  const task = '核查登录为什么失败？\n参考 @测试人员 的公开结论。\n只分析，不改代码。';
  h.runWith(async (_run, index) => { if (index === 0) await finished.promise; return index === 0 ? '登录方案已整理。' : '登录失败原因已确认。'; });
  h.deliverWith(async item => { if (item.card.text === '登录方案已整理。') await delivered.promise; });
  const source = h.send('整理登录问题后请开发继续分析。');
  await until(() => h.runs.length === 1, 'source submitted');
  h.emit(h.event(0, { target: '开发助手', task }));
  await tick();
  assert.equal(h.runs.length, 1);
  finished.resolve();
  await until(() => h.attempts.some(item => item.card.text === '登录方案已整理。'), 'source delivery attempt');
  assert.equal(h.runs.length, 1, 'a submitted tool request cannot start work before source delivery');
  delivered.resolve();
  await source; await h.idle();
  assert.equal(h.runs.length, 2);
  assert.notEqual(h.runs[0]!.threadId, h.runs[1]!.threadId);
  assert.equal(h.runs[1]!.input.model, 'dev-model');
  assert.equal(h.runs[1]!.input.allowSteering, false);
  assert.equal(h.runs[1]!.input.cwd, h.dir);
  assert.ok(h.runs[1]!.input.prompt.includes(`\n\n${task}\n\n`));
  assert.equal(h.relays().length, 1);
  assert.equal(h.relays()[0]!.actorId, 'dev-user');
  assert.equal(h.relays()[0]!.chatId, conversationKey('dev', 'oc_team'));
});

test('duplicate events and repeated requests to the same role yield one handoff with the latest tool task', async t => {
  const h = setup(t);
  const done = h.gate();
  h.runWith(async (_run, index) => {
    if (index === 0) { await done.promise; return '方案完成。\n交接给 @开发人员：按最新任务实现。'; }
    return '实现完成。';
  });
  const source = h.send('请开发实现最终确认的方案。');
  await until(() => h.runs.length === 1, 'source');
  const first = h.event(0, { target: 'dev', task: '最初的任务。' });
  h.emit(first); h.emit(first);
  const latest = h.event(0, { target: '开发人员', task: '最新的任务？\n请说明实现结果。' });
  h.emit(latest); h.emit(latest);
  done.resolve(); await source; await h.idle();
  assert.equal(h.runs.length, 2);
  assert.equal(h.relays().length, 1);
  assert.equal(h.runs[1]!.input.prompt.split('\n\n')[1], '最新的任务？\n请说明实现结果。');
});

test('conflicting or unresolved structured recipients do not dispatch another role', async t => {
  for (const scenario of ['two-tools', 'tool-and-text', 'unknown', 'self', 'ambiguous'] as const) {
    await t.test(scenario, async child => {
      const h = setup(child);
      const done = h.gate();
      if (scenario === 'ambiguous') h.store.saveBot('qa', { name: '开发人员' });
      h.runWith(async () => { await done.promise; return scenario === 'tool-and-text' ? '交接给 @测试人员：验收登录。' : '方案整理完成。'; });
      const source = h.send('安排后续处理。');
      await until(() => h.runs.length === 1, 'source');
      const target = scenario === 'unknown' ? '未知角色' : scenario === 'self' ? '产品经理' : '开发人员';
      h.emit(h.event(0, { target, task: '处理登录。' }));
      if (scenario === 'two-tools') h.emit(h.event(0, { target: 'qa', task: '验收登录。' }));
      done.resolve(); await source; await h.idle();
      assert.equal(h.runs.length, 1);
      assert.equal(h.relays().length, 0);
      assert.equal(h.sent.filter(item => item.card.title === '交接未执行').length, 1);
    });
  }
});

test('non-live foreign failed and malformed MCP events cannot start group handoffs', async t => {
  const changes: Record<string, (event: RuntimeEvent) => void> = {
    snapshot: event => { event.method = 'turn/snapshot'; },
    started: event => { event.method = 'item/started'; },
    'old-turn': event => { event.turnId = 'old-turn'; },
    'other-thread': event => { event.threadId = 'other-thread'; },
    'failed-call': event => { (event.params!.item as any).status = 'failed'; },
    'transport-error': event => { (event.params!.item as any).error = { message: 'tool failed' }; },
    'error-result': event => { (event.params!.item as any).result.isError = true; },
    'missing-receipt': event => { delete (event.params!.item as any).result.structuredContent; },
    'mismatched-receipt': event => { (event.params!.item as any).result.structuredContent = { target: 'qa', task: 'different task' }; },
    'routing-argument': event => { (event.params!.item as any).arguments = { target: 'dev', task: '开发', chatId: 'oc_other' }; },
    'other-server': event => { (event.params!.item as any).server = 'untrusted_server'; },
    'completion-only': _event => {},
  };
  for (const engine of ['codex', 'hermes'] as const) for (const [name, change] of Object.entries(changes)) await t.test(`${engine}: ${name}`, async child => {
    const h = setup(child, engine);
    const done = h.gate();
    const blocksTextFallback = ['started', 'failed-call', 'transport-error', 'error-result', 'missing-receipt', 'mismatched-receipt', 'routing-argument'].includes(name);
    h.runWith(async () => { await done.promise; return blocksTextFallback ? '交接给 @开发人员：继续实现登录。' : '本轮完成，无后续任务。'; });
    const source = h.send('整理需求。');
    await until(() => h.runs.length === 1, 'source');
    const event = h.event(0);
    change(event);
    if (name === 'completion-only') h.emitRaw(event); else h.emit(event);
    done.resolve(); await source; await h.idle();
    assert.equal(h.runs.length, 1);
    assert.equal(h.relays().length, 0);
  });
});

test('private local-preview and desktop-only calls have no group handoff authority', async t => {
  for (const engine of ['codex', 'hermes'] as const) for (const scope of ['private', 'local-preview', 'desktop-only'] as const) await t.test(`${engine}: ${scope}`, async child => {
    const h = setup(child, engine);
    const done = h.gate();
    h.runWith(async () => { await done.promise; return '已完成整理。'; });
    if (scope === 'local-preview') h.store.conversation('oc_team', 'pm-user', h.dir, 'group');
    const source = h.send('整理需求。', scope === 'private' ? { chatId: 'oc_private', chatType: 'p2p' }
      : scope === 'local-preview' ? { localOnly: true } : {});
    await until(() => h.runs.length === 1, 'source');
    const event = h.event(0);
    if (scope === 'desktop-only') { done.resolve(); await source; await h.idle(); }
    h.emit(event);
    done.resolve(); await source; await h.idle();
    assert.equal(h.runs.length, 1);
    assert.equal(h.relays().length, 0);
  });
});

test('stop authorization changes and a new source conversation invalidate a pending structured handoff', async t => {
  for (const engine of ['codex', 'hermes'] as const) for (const change of ['stop', 'origin-revoked', 'target-revoked', 'new-conversation'] as const) await t.test(`${engine}: ${change}`, async child => {
    const h = setup(child, engine);
    const done = h.gate();
    h.runWith(async () => { await done.promise; return '当前方案整理完成。'; });
    const source = h.send('整理方案后继续开发。');
    await until(() => h.runs.length === 1, 'source');
    h.emit(h.event(0));
    if (change === 'stop') await h.send('/stop');
    else if (change === 'origin-revoked') h.store.authorize('pm-user', false, 'default');
    else if (change === 'target-revoked') h.store.authorizeGroup('dev', 'oc_team', false);
    else await h.send('/new');
    done.resolve(); await source; await h.idle();
    assert.equal(h.runs.length, 1);
    assert.equal(h.relays().length, 0);
  });
});

test('uncertain delivery and a failed source turn never dispatch a submitted structured request', async t => {
  for (const engine of ['codex', 'hermes'] as const) for (const failure of ['delivery', 'runtime'] as const) await t.test(`${engine}: ${failure}`, async child => {
    const h = setup(child, engine);
    const done = h.gate();
    h.runWith(async () => { await done.promise; if (failure === 'runtime') throw new Error('source runtime failure'); return '准备交接的方案。'; });
    h.deliverWith(async item => { if (failure === 'delivery' && item.card.text === '准备交接的方案。') throw new Error('delivery acknowledgement lost'); });
    const source = h.send('整理并开发方案。');
    await until(() => h.runs.length === 1, 'source');
    h.emit(h.event(0));
    done.resolve(); await source; await h.idle();
    assert.equal(h.runs.length, 1);
    assert.equal(h.relays().length, 0);
    if (failure === 'delivery') assert.equal(h.attempts.filter(item => item.card.text === '准备交接的方案。').length, 1);
  });
});

test('a same-turn human followup invalidates an earlier request including replay of its old tool event', async t => {
  const h = setup(t);
  const firstDone = h.gate();
  const secondDone = h.gate();
  h.submitWith(index => ({ turnId: index <= 1 ? 'shared-turn' : `turn-${index}`, mode: index === 1 ? 'steer' : 'start' }));
  h.runWith(async (_run, index) => { await (index === 0 ? firstDone.promise : secondDone.promise); return '已按最新要求处理完毕。'; });
  const source = h.send('原始任务：整理后交给开发。');
  await until(() => h.runs.length === 1, 'source');
  const old = h.event(0, { target: 'dev', task: '已经过期的旧任务。' });
  h.emit(old);
  const followup = h.send('取消后续交接，只整理结论。');
  await until(() => h.runs.length === 2, 'same-turn followup');
  assert.equal(h.runs[0]!.threadId, h.runs[1]!.threadId);
  h.emit(old);
  firstDone.resolve(); await tick(); secondDone.resolve();
  await Promise.all([source, followup]); await h.idle();
  assert.equal(h.runs.length, 2);
  assert.equal(h.relays().length, 0);
});

test('a tool request after a same-turn followup belongs to the latest human operation', async t => {
  const h = setup(t);
  const firstDone = h.gate();
  const secondDone = h.gate();
  const latestTask = '最新任务：改为双因素登录并交给开发人员。';
  h.submitWith(index => ({ turnId: index <= 1 ? 'shared-turn' : `turn-${index}`, mode: index === 1 ? 'steer' : 'start' }));
  h.runWith(async (_run, index) => {
    if (index === 0) await firstDone.promise;
    if (index === 1) await secondDone.promise;
    return index < 2 ? '已更新为双因素登录方案。' : '双因素登录已实现。';
  });
  const source = h.send('最初只需要验证码登录。');
  await until(() => h.runs.length === 1, 'source');
  h.emit(h.event(0, { target: 'qa', task: '过期的初步验收。' }));
  const followup = h.send(latestTask);
  await until(() => h.runs.length === 2, 'same-turn followup');
  h.emit(h.event(1, { target: 'dev', task: '实现最新双因素登录。' }));
  firstDone.resolve(); await tick(); secondDone.resolve();
  await Promise.all([source, followup]); await h.idle();
  assert.equal(h.runs.length, 3);
  assert.equal(h.relays().length, 1);
  assert.equal(h.runs[2]!.input.model, 'dev-model');
  assert.ok(h.runs[2]!.input.prompt.includes(`原始用户任务：${JSON.stringify(latestTask)}`));
  assert.equal(h.runs[2]!.input.prompt.split('\n\n')[1], '实现最新双因素登录。');
  assert.equal(h.sent.filter(item => item.chatId === 'oc_team' && item.card.text === '已更新为双因素登录方案。').length, 1);
});

test('a tool begun before a human followup cannot transfer its authority when completion arrives later', async t => {
  const h = setup(t);
  const firstDone = h.gate();
  const secondDone = h.gate();
  h.submitWith(index => ({ turnId: 'shared-turn', mode: index === 1 ? 'steer' : 'start' }));
  h.runWith(async (_run, index) => { await (index === 0 ? firstDone.promise : secondDone.promise); return '已按新要求结束本轮。'; });
  const source = h.send('先整理旧方案并交给开发。');
  await until(() => h.runs.length === 1, 'source');
  const old = h.event(0, { target: 'dev', task: '过期的旧开发任务。' });
  h.emitRaw({ ...old, method: 'item/started' });
  const followup = h.send('不再需要开发，只整理新结论。');
  await until(() => h.runs.length === 2, 'same-turn followup');
  h.emitRaw(old);
  firstDone.resolve(); await tick(); secondDone.resolve();
  await Promise.all([source, followup]); await h.idle();
  assert.equal(h.runs.length, 2);
  assert.equal(h.relays().length, 0);
});

test('a handoff completed before the start acknowledgement is dispatched only after that submission succeeds', async t => {
  const h = setup(t);
  const acknowledge = h.gate();
  h.beforeSubmitted(async (_run, index) => {
    if (index === 0) {
      h.emit(h.event(0, { target: 'dev', task: '处理提交响应前完成的申请。' }));
      await acknowledge.promise;
    }
    return 'submitted';
  });
  const source = h.send('整理方案后交给开发。');
  await until(() => h.runs.length === 1, 'source submitting');
  await tick();
  assert.equal(h.relays().length, 0, 'early MCP events do not prove the prompt was accepted');
  acknowledge.resolve();
  await source; await h.idle();
  assert.equal(h.runs.length, 2);
  assert.equal(h.relays().length, 1);
  assert.equal(h.runs[1]!.input.prompt.split('\n\n')[1], '处理提交响应前完成的申请。');
});

test('a handoff begun before the start acknowledgement can finish after submission confirmation', async t => {
  const h = setup(t);
  let early: RuntimeEvent | undefined;
  h.beforeSubmitted(async (_run, index) => {
    if (index === 0) {
      early = h.event(0, { target: 'dev', task: '处理跨提交响应的申请。' });
      h.emitRaw({ ...early, method: 'item/started' });
    }
    return 'submitted';
  });
  h.runWith(async (_run, index) => {
    if (index === 0) h.emitRaw(early!);
    return '方案已经完成。';
  });
  await h.send('整理并继续开发方案。'); await h.idle();
  assert.equal(h.runs.length, 2);
  assert.equal(h.relays().length, 1);
  assert.equal(h.runs[1]!.input.prompt.split('\n\n')[1], '处理跨提交响应的申请。');
});

test('early handoff events do not authorize a rejected or uncertain prompt submission', async t => {
  for (const engine of ['codex', 'hermes'] as const) for (const status of ['rejected', 'uncertain'] as const) await t.test(`${engine}: ${status}`, async child => {
    const h = setup(child, engine);
    h.beforeSubmitted(async (_run, index) => {
      if (index === 0) h.emit(h.event(0));
      return status;
    });
    await h.send('提交可能失败的任务。'); await h.idle();
    assert.equal(h.runs.length, 1);
    assert.equal(h.relays().length, 0);
  });
});

test('a handoff emitted while a same-turn steer awaits acknowledgement belongs to that new operation', async t => {
  const h = setup(t);
  const firstDone = h.gate();
  const latestDone = h.gate();
  const acknowledge = h.gate();
  const latestTask = '补充任务：改成新登录流程，交给开发完成。';
  h.submitWith(index => ({ turnId: index <= 1 ? 'pending-steer-turn' : `turn-${index}`, mode: index === 1 ? 'steer' : 'start' }));
  h.beforeSubmitted(async (_run, index) => {
    if (index === 1) {
      h.emit(h.event(1, { target: 'dev', task: '实现最新登录流程。' }));
      await acknowledge.promise;
    }
    return 'submitted';
  });
  h.runWith(async (_run, index) => {
    if (index === 0) await firstDone.promise;
    if (index === 1) await latestDone.promise;
    return index < 2 ? '已按最新要求完成方案。' : '最新登录流程已实现。';
  });
  const source = h.send('最初先研究验证码登录。');
  await until(() => h.runs.length === 1, 'source running');
  const latest = h.message(latestTask);
  const followup = h.bridge.receive(latest);
  await until(() => h.runs.length === 2, 'steer awaiting acknowledgement');
  assert.equal(h.store.state.operations[latest.id]!.status, 'submitting');
  assert.equal(h.relays().length, 0);
  acknowledge.resolve();
  await until(() => h.store.state.operations[latest.id]!.status === 'submitted', 'steer acknowledged');
  firstDone.resolve(); await tick(); latestDone.resolve();
  await Promise.all([source, followup]); await h.idle();
  assert.equal(h.runs.length, 3);
  assert.equal(h.relays().length, 1);
  assert.ok(h.runs[2]!.input.prompt.includes(`原始用户任务：${JSON.stringify(latestTask)}`));
  assert.equal(h.runs[2]!.input.prompt.split('\n\n')[1], '实现最新登录流程。');
});

test('a queued Hermes structured handoff waits for source delivery and dispatches once to Codex', async t => {
  const h = setup(t, 'hermes');
  const finished = h.gate();
  const delivered = h.gate();
  h.runWith(async (_run, index) => { if (index === 0) await finished.promise; return index === 0 ? 'Hermes 方案已完成。' : 'Codex 实现已完成。'; });
  h.deliverWith(async item => { if (item.card.text === 'Hermes 方案已完成。') await delivered.promise; });
  const source = h.send('整理方案后交给开发。');
  await until(() => h.runs.length === 1, 'Hermes source');
  const request = h.event(0, { target: 'dev', task: '实现 Hermes 整理的登录方案。' });
  h.emit(request); h.emit(request);
  finished.resolve();
  await until(() => h.attempts.some(item => item.card.text === 'Hermes 方案已完成。'), 'Hermes source delivery');
  assert.equal(h.runs.length, 1);
  assert.equal(h.relays().length, 0);
  delivered.resolve();
  await source; await h.idle();
  assert.equal(h.runs.length, 2);
  assert.equal(h.relays().length, 1);
  assert.match(h.runs[0]!.threadId, /^hermes:/);
  assert.doesNotMatch(h.runs[1]!.threadId, /^hermes:/);
  assert.equal(h.runs[1]!.input.model, 'dev-model');
  assert.equal(h.runs[1]!.input.prompt.split('\n\n')[1], '实现 Hermes 整理的登录方案。');
  assert.equal(h.relays()[0]!.actorId, 'dev-user');
  assert.equal(h.bridge['groupHandoffRequests'].size, 0, 'finished queued operations release their handoff requests');
  h.emit(request);
  await h.idle();
  assert.equal(h.relays().length, 1, 'replayed completed requests do not dispatch again');
});

test('Hermes buffers handoff events before prompt acknowledgement until the exact submission succeeds', async t => {
  const h = setup(t, 'hermes');
  const acknowledge = h.gate();
  h.beforeSubmitted(async (_run, index) => {
    if (index === 0) {
      h.emit(h.event(0, { target: 'dev', task: '实现提交确认前准备的方案。' }));
      await acknowledge.promise;
    }
    return 'submitted';
  });
  const source = h.send('准备方案并开发。');
  await until(() => h.runs.length === 1, 'Hermes submission pending');
  await tick();
  assert.equal(h.relays().length, 0);
  acknowledge.resolve(); await source; await h.idle();
  assert.equal(h.runs.length, 2);
  assert.equal(h.relays().length, 1);
  assert.equal(h.runs[1]!.input.prompt.split('\n\n')[1], '实现提交确认前准备的方案。');
});

test('a queued Hermes followup invalidates an earlier handoff and cannot adopt its replay', async t => {
  const h = setup(t, 'hermes');
  const firstDone = h.gate();
  const secondDone = h.gate();
  h.runWith(async (_run, index) => { await (index === 0 ? firstDone.promise : secondDone.promise); return '按当前要求整理完成。'; });
  const source = h.send('旧任务：整理后交给开发。');
  await until(() => h.runs.length === 1, 'first Hermes turn');
  const old = h.event(0, { target: 'dev', task: '已经取消的旧任务。' });
  h.emit(old);
  const followup = h.send('取消后续交接，只整理结论。');
  await tick();
  assert.equal(h.runs.length, 1, 'Hermes serializes the human followup');
  firstDone.resolve();
  await until(() => h.runs.length === 2, 'queued Hermes followup');
  assert.equal(h.runs[1]!.threadId, h.runs[0]!.threadId);
  assert.notEqual(h.runs[1]!.turnId, h.runs[0]!.turnId);
  h.emit(old);
  secondDone.resolve();
  await Promise.all([source, followup]); await h.idle();
  assert.equal(h.runs.length, 2);
  assert.equal(h.relays().length, 0);
  assert.equal(h.bridge['groupHandoffRequests'].size, 0);
});

test('an unowned Hermes call cannot gain authority when its events are later replayed into an active turn', async t => {
  const h = setup(t, 'hermes');
  const args = { target: 'dev', task: '不属于当前用户任务的历史申请。' };
  const replay: RuntimeEvent = {
    method: 'item/completed', threadId: 'hermes:thread-0', turnId: 'turn-0',
    params: { item: { id: 'unowned-tool', type: 'mcpToolCall', server: 'feishu_completion', tool: 'request_feishu_group_handoff',
      arguments: args, status: 'completed', result: { structuredContent: args } } },
  };
  h.emit(replay);
  const done = h.gate();
  h.runWith(async () => { await done.promise; return '本轮已完成。'; });
  const source = h.send('整理当前任务。');
  await until(() => h.runs.length === 1, 'live Hermes source');
  h.emit(replay);
  done.resolve(); await source; await h.idle();
  assert.equal(h.runs.length, 1);
  assert.equal(h.relays().length, 0);
});
