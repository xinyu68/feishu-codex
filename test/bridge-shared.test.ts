import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { Bridge } from '../src/bridge.js';
import { Store } from '../src/store.js';
import type { CodexRunInput, CodexRuntime, MessageCard, RuntimeEvent } from '../src/types.js';

const tick = () => new Promise<void>(resolve => setImmediate(resolve));
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
function fixture(t: test.TestContext, assertCanWrite?: () => Promise<void>) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-shared-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = new Store(dir); store.saveConfig({ allowedActors: ['actor'], defaultWorkspace: dir });
  const cards: MessageCard[] = []; const images: string[] = []; const files: string[] = []; const runs: CodexRunInput[] = []; const stopped: string[] = []; let listener: ((event: RuntimeEvent) => void) | undefined;
  const finished = deferred();
  const runtime: CodexRuntime = {
    supportsSteering: true,
    async run(input) { runs.push(input); input.onThread?.(input.threadId ?? 'thread-a'); input.onSubmitted?.({ threadId: input.threadId ?? 'thread-a', turnId: 'turn-a', mode: runs.length === 1 ? 'start' : 'steer', status: 'submitted' }); await finished.promise; return { threadId: input.threadId ?? 'thread-a', turnId: 'turn-a', text: '唯一回复' }; },
    async stop(id) { stopped.push(id); }, async release() {}, async close() {}, async models() { return []; }, async history() { return []; }, async status() { return { available: true }; },
    subscribe(fn) { listener = fn; return () => { listener = undefined; }; }, async watch() {},
  };
  const bridge = new Bridge(store, runtime, { assertCanWrite, projects: async () => [], threads: async () => ['thread-a', 'thread-b'].map(id => ({ id, cwd: dir, title: id, preview: '', updatedAt: '' })) });
  const transport = { async start() {}, async close() {}, async startTyping() { return async () => {}; }, async sendText(_chat: string, text: string) { cards.push({ title: '', text }); return randomUUID(); }, async sendCard(_chat: string, card: MessageCard) { cards.push(card); return randomUUID(); }, async sendImage(_chat: string, file: string) { images.push(file); return randomUUID(); }, async sendFile(_chat: string, file: string) { files.push(file); return randomUUID(); }, async updateCard(_id: string, card: MessageCard) { cards.push(card); } };
  bridge.transport = transport;
  store.conversation('chat', 'actor');
  const send = (text: string, options: Record<string, unknown> = {}) => bridge.receive({ id: randomUUID(), chatId: 'chat', actorId: 'actor', text, ...options });
  return { dir, store, bridge, runtime, transport, cards, images, files, runs, stopped, finished, send, notify: (event: RuntimeEvent) => listener?.(event) };
}

test('shared input steers without queue; phone and local completion deduplicate independently', async t => {
  const fx = fixture(t);
  const local = fx.send('本机先发', { localOnly: true }); await tick();
  const phone = fx.send('飞书补充'); const phoneAgain = fx.send('再次补充'); await tick();
  assert.equal(fx.runs.length, 3); assert.equal(fx.runs[1]?.threadId, 'thread-a');
  assert.equal(fx.bridge.conversations()[0]?.queued, 0); assert.equal(fx.bridge.conversations()[0]?.busy, true);
  fx.finished.resolve(); await Promise.all([local, phone, phoneAgain]);
  assert.equal(fx.cards.filter(card => card.text === '唯一回复').length, 1);
  assert.equal(fx.store.state.history.chat!.filter(item => item.role === 'assistant').length, 1);
  assert.equal(fx.store.state.totalTurns, 1); assert.equal(Object.values(fx.store.state.operations).filter(op => op.status === 'completed').length, 3);
  assert.equal(fx.bridge.conversations()[0]?.busy, false);
});

test('switching while active preserves submitted target; old stop card cannot stop new binding', async t => {
  const fx = fixture(t); const pending = fx.send('旧任务'); await tick();
  const command = fx.cards.find(card => card.buttons?.length)?.buttons![0]!.command;
  assert.equal(command, '/stop rev 0');
  await fx.bridge.bind('chat', fx.dir, 'thread-b', 0);
  await fx.send(command!); assert.deepEqual(fx.stopped, []);
  await fx.bridge.stop('chat', 1); assert.deepEqual(fx.stopped, ['thread-b']);
  fx.finished.resolve(); await pending;
  assert.equal(fx.bridge.conversations()[0]?.threadId, 'thread-b');
  assert.equal(fx.store.state.history.chat?.some(message => message.text === '唯一回复'), false);
  assert.equal(Object.values(fx.store.state.operations)[0]?.threadId, 'thread-a');
});

test('stale management revision rejects before journal acceptance', async t => {
  const fx = fixture(t); await fx.bridge.bind('chat', fx.dir, 'thread-a', 0);
  await assert.rejects(fx.bridge.submit({ id: 'stale', chatId: 'chat', actorId: 'actor', text: '不发送', localOnly: true, expectedRevision: 0 }), /其他入口切换/);
  assert.equal(fx.store.state.operations.stale, undefined); assert.equal(fx.runs.length, 0);
});

test('receipt snapshot survives slow host guard while UI stale send rejects', async t => {
  const gate = deferred(); let checks = 0; const fx = fixture(t, async () => { if (++checks === 1) await gate.promise; });
  await fx.bridge.bind('chat', fx.dir, 'thread-a');
  const pending = fx.send('旧目标'); await tick(); await fx.bridge.bind('chat', fx.dir, 'thread-b'); gate.resolve(); await tick();
  assert.equal(fx.runs[0]?.threadId, 'thread-a'); fx.finished.resolve(); await pending;
  assert.equal(fx.bridge.conversations()[0]?.threadId, 'thread-b');
  assert.equal(fx.store.state.history.chat?.some(message => message.text === '旧目标'), false);
});

test('unavailable host explains phone failure without claiming it; management fails acceptance', async t => {
  const fx = fixture(t, async () => { throw new Error('独立桌面正在运行'); });
  await fx.send('待发送', { id: 'retryable' }); assert.equal(fx.store.state.seen.retryable, undefined);
  assert.match(fx.cards.at(-1)!.text, /独立桌面/);
  await assert.rejects(fx.bridge.submit({ id: 'local', chatId: 'chat', actorId: 'actor', text: '待发送', localOnly: true }), /独立桌面/);
  assert.equal(fx.runs.length, 0);
});

test('ambiguous accepted operation survives restart and is never replayed', async t => {
  const fx = fixture(t);
  fx.runtime.run = async input => { input.onThread?.('thread-a'); input.onSubmitted?.({ threadId: 'thread-a', turnId: 'turn-unknown', mode: 'start', status: 'submitting' }); input.onSubmitted?.({ threadId: 'thread-a', mode: 'start', status: 'uncertain' }); throw new Error('连接丢失'); };
  await fx.send('只执行一次', { id: 'once' }); assert.equal(fx.store.state.operations.once?.status, 'uncertain');
  fx.store.state.seen.once = 1; fx.store.save();
  const restarted = new Store(fx.dir); assert.equal(restarted.claim('once'), false); assert.equal(restarted.state.operations.once?.status, 'uncertain');
});

test('native-only deltas appear in history and do not send phone messages', async t => {
  const fx = fixture(t); await fx.bridge.bind('chat', fx.dir, 'thread-a');
  fx.notify({ method: 'turn/started', threadId: 'thread-a', turnId: 'native', params: { threadId: 'thread-a', turn: { id: 'native' } } });
  fx.notify({ method: 'item/agentMessage/delta', threadId: 'thread-a', turnId: 'native', params: { itemId: 'answer', delta: '正在' } });
  fx.notify({ method: 'item/agentMessage/delta', threadId: 'thread-a', turnId: 'native', params: { itemId: 'answer', delta: '输出' } });
  assert.equal((await fx.bridge.history('chat')).messages.at(-1)?.text, '正在输出');
  assert.equal(fx.bridge.conversations()[0]?.busy, true); assert.deepEqual(fx.cards, []);
});

test('current task exposes real activity without leaking it across bound sessions', async t => {
  const fx = fixture(t); await fx.bridge.bind('chat', fx.dir, 'thread-a');
  fx.notify({ method: 'turn/started', threadId: 'thread-a', turnId: 'turn-progress', params: { turn: { id: 'turn-progress' } } });
  const started = fx.bridge.conversations()[0]!;
  assert.equal(started.activeTurnId, 'turn-progress');
  assert.ok(started.startedAt);
  assert.equal(started.progress, '已接收任务，等待 Codex 更新');
  fx.notify({ method: 'item/started', threadId: 'thread-a', turnId: 'turn-progress', params: { item: { id: 'command', type: 'commandExecution', command: 'private-command' } } });
  assert.equal(fx.bridge.conversations()[0]?.progress, '正在运行命令');
  assert.equal(JSON.stringify(fx.bridge.conversations()).includes('private-command'), false);
  fx.notify({ method: 'item/completed', threadId: 'thread-a', turnId: 'turn-progress', params: { item: { id: 'update', type: 'agentMessage', phase: 'commentary', text: '正在核对结果。\n接下来整理报告。' } } });
  assert.equal(fx.bridge.conversations()[0]?.progress, '正在核对结果。 接下来整理报告。');
  await fx.bridge.bind('chat', fx.dir, 'thread-b');
  assert.equal(fx.bridge.conversations()[0]?.progress, undefined);
  await fx.bridge.bind('chat', fx.dir, 'thread-a');
  assert.equal(fx.bridge.conversations()[0]?.progress, '正在核对结果。 接下来整理报告。');
  fx.notify({ method: 'turn/completed', threadId: 'thread-a', turnId: 'turn-progress', params: { turn: { id: 'turn-progress', status: 'completed' } } });
  assert.equal(fx.bridge.conversations()[0]?.progress, undefined);
  assert.equal(fx.bridge.conversations()[0]?.busy, false);
});

test('desktop MCP request sends one completion card and switches only after button action', async t => {
  const fx = fixture(t);
  fx.store.conversation('oc_notify', 'actor', fx.dir);
  fx.runtime.threadInfo = async threadId => ({ threadId, cwd: fx.dir, title: '桌面开发会话' });
  fx.notify({ method: 'item/completed', threadId: 'thread-b', turnId: 'desktop-turn', params: { item: {
    id: 'notify-call', type: 'mcpToolCall', server: 'feishu_completion', tool: 'request_feishu_completion_notification',
    arguments: { summary: '开发新的通知功能' }, status: 'completed',
  } } });
  fx.notify({ method: 'turn/completed', threadId: 'thread-b', turnId: 'desktop-turn', params: { turn: { id: 'desktop-turn', status: 'completed', items: [] } } });
  for (let count = 0; count < 100 && !fx.cards.some(card => card.title === '桌面任务已完成'); count++) await new Promise(resolve => setTimeout(resolve, 10));
  const card = fx.cards.find(item => item.title === '桌面任务已完成');
  assert.match(card?.text ?? '', /开发新的通知功能/);
  assert.equal(fx.store.state.conversations.oc_notify?.threadId, undefined);
  const command = card?.buttons?.[0]?.command;
  assert.match(command ?? '', /^\/notification /);
  await fx.bridge.receive({ id: randomUUID(), chatId: 'oc_notify', actorId: 'actor', text: command!, actionMessageId: 'om_notification' });
  assert.equal(fx.store.state.conversations.oc_notify?.threadId, 'thread-b');
  assert.equal(fx.cards.at(-1)?.title, '已切换到通知对应的会话');
  assert.equal(Object.values(fx.store.state.notifications)[0]?.status, 'sent');
});

test('MCP request from a bridge-submitted turn does not duplicate its Feishu completion', async t => {
  const fx = fixture(t);
  fx.store.conversation('oc_notify', 'actor', fx.dir);
  fx.store.operation('phone', { chatId: 'oc_notify', actorId: 'actor', cwd: fx.dir, threadId: 'thread-a', turnId: 'phone-turn', revision: 0, source: 'feishu', status: 'submitted' });
  fx.notify({ method: 'turn/completed', threadId: 'thread-a', turnId: 'phone-turn', params: { turn: { id: 'phone-turn', status: 'completed', items: [{
    id: 'notify-call', type: 'mcpToolCall', server: 'feishu_completion', tool: 'request_feishu_completion_notification', arguments: { summary: '重复通知' }, status: 'completed',
  }] } } });
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.deepEqual(fx.store.state.notifications, {});
  assert.equal(fx.cards.some(card => card.title === '桌面任务已完成'), false);
});

test('desktop artifact MCP sends native images and files once to the bound Feishu conversation', async t => {
  const fx = fixture(t);
  const image = path.join(fx.dir, 'preview.png');
  const file = path.join(fx.dir, 'report.txt');
  fs.writeFileSync(image, 'image'); fs.writeFileSync(file, 'report');
  fx.store.conversation('oc_latest', 'actor', fx.dir);
  fx.store.conversation('oc_bound', 'actor', fx.dir);
  await fx.bridge.bind('oc_bound', fx.dir, 'thread-b');
  const event: RuntimeEvent = { method: 'item/completed', threadId: 'thread-b', turnId: 'artifact-turn', params: { item: {
    id: 'artifact-call', type: 'mcpToolCall', server: 'feishu_completion', tool: 'send_artifact_to_feishu',
    arguments: { paths: [image, file] }, status: 'completed',
  } } };
  fx.bridge.transport = undefined;
  fx.notify(event);
  for (let count = 0; count < 100 && Object.values(fx.store.state.artifacts)[0]?.status !== 'registered'; count++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(Object.values(fx.store.state.artifacts)[0]?.status, 'registered');
  assert.deepEqual(fx.images, []); assert.deepEqual(fx.files, []);
  fx.bridge.transport = fx.transport;
  await fx.bridge.deliverPendingArtifacts();
  for (let count = 0; count < 100 && !fx.cards.some(card => card.title === '成品已发送'); count++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.deepEqual(fx.images, [fs.realpathSync.native(image)]);
  assert.deepEqual(fx.files, [fs.realpathSync.native(file)]);
  assert.match(fx.cards.find(card => card.title === '成品已发送')?.text ?? '', /成功 2 个，失败 0 个/);
  assert.equal(Object.values(fx.store.state.artifacts)[0]?.chatId, 'oc_bound');
  fx.notify(event);
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(fx.images.length, 1); assert.equal(fx.files.length, 1);
});

test('new shared thread keeps native reads suppressed until its creating run finishes', async t => {
  const fx = fixture(t); const submitted = deferred(); const complete = deferred();
  let historyCalls = 0; let watchCalls = 0;
  fx.runtime.history = async () => { historyCalls++; return [{ id: 'native', role: 'assistant', text: '原生历史' }]; };
  fx.runtime.watch = async () => { watchCalls++; };
  fx.runtime.run = async input => {
    input.onThread?.('thread-new');
    await submitted.promise;
    input.onSubmitted?.({ threadId: 'thread-new', turnId: 'turn-new', mode: 'start', status: 'submitted' });
    await complete.promise;
    return { threadId: 'thread-new', turnId: 'turn-new', text: '最终回复' };
  };

  const running = fx.send('新任务'); await tick();
  fx.notify({ method: 'turn/started', threadId: 'thread-new', turnId: 'turn-new' });
  fx.notify({ method: 'item/agentMessage/delta', threadId: 'thread-new', turnId: 'turn-new', params: { itemId: 'draft', delta: '实时片段' } });
  await fx.bridge.watch('chat'); await fx.bridge.watch('chat');
  const first = await fx.bridge.history('chat'); const second = await fx.bridge.history('chat');
  assert.equal(watchCalls, 0); assert.equal(historyCalls, 0);
  assert.equal(first.source, 'bridge'); assert.equal(second.source, 'bridge');
  assert.ok(first.messages.some(message => message.text === '新任务'));
  assert.ok(first.messages.some(message => message.text === '实时片段'));

  submitted.resolve(); await tick();
  await fx.bridge.watch('chat'); await fx.bridge.history('chat');
  assert.equal(watchCalls, 0); assert.equal(historyCalls, 0);

  complete.resolve(); await running;
  await fx.bridge.watch('chat'); const native = await fx.bridge.history('chat');
  assert.equal(watchCalls, 1); assert.equal(historyCalls, 1); assert.equal(native.source, 'codex');
});

test('busy existing shared thread still allows native watch and history', async t => {
  const fx = fixture(t); let historyCalls = 0; let watchCalls = 0; const complete = deferred();
  fx.runtime.history = async () => { historyCalls++; return [{ role: 'assistant', text: '原生历史' }]; };
  fx.runtime.watch = async () => { watchCalls++; };
  await fx.bridge.bind('chat', fx.dir, 'thread-a'); watchCalls = 0;
  fx.runtime.run = async input => {
    input.onThread?.('thread-a');
    await complete.promise;
    input.onSubmitted?.({ threadId: 'thread-a', turnId: 'turn-existing', mode: 'steer', status: 'submitted' });
    return { threadId: 'thread-a', turnId: 'turn-existing', text: '完成' };
  };

  const running = fx.send('继续已有任务'); await tick();
  assert.equal(fx.bridge.conversations()[0]?.busy, true);
  await fx.bridge.watch('chat'); const history = await fx.bridge.history('chat');
  assert.equal(watchCalls, 1); assert.equal(historyCalls, 1); assert.equal(history.source, 'codex');
  complete.resolve(); await running;
});

test('initialization history error falls back briefly and retries native history', async t => {
  const fx = fixture(t); await fx.bridge.bind('chat', fx.dir, 'thread-a'); let calls = 0;
  fx.runtime.history = async () => {
    calls++;
    if (calls === 1) throw new Error('failed to read session metadata rollout.jsonl: rollout at rollout.jsonl is empty');
    return [{ role: 'assistant', text: '恢复后的历史' }];
  };
  assert.equal((await fx.bridge.history('chat')).source, 'bridge');
  assert.equal((await fx.bridge.history('chat')).source, 'bridge'); assert.equal(calls, 1);
  await new Promise(resolve => setTimeout(resolve, 120));
  const recovered = await fx.bridge.history('chat');
  assert.equal(calls, 2); assert.equal(recovered.source, 'codex'); assert.equal(recovered.messages[0]?.text, '恢复后的历史');
});

test('failed new shared thread clears native read suppression', async t => {
  const fx = fixture(t); let historyCalls = 0; let watchCalls = 0;
  fx.runtime.history = async () => { historyCalls++; return []; };
  fx.runtime.watch = async () => { watchCalls++; };
  fx.runtime.run = async input => {
    input.onThread?.('thread-failed');
    input.onSubmitted?.({ threadId: 'thread-failed', mode: 'start', status: 'rejected' });
    throw new Error('提交失败');
  };
  await fx.send('失败任务');
  await fx.bridge.watch('chat'); await fx.bridge.history('chat');
  assert.equal(watchCalls, 1); assert.equal(historyCalls, 1);
});

test('duplicate concurrent submissions acknowledge once before the model completes', async t => {
  const gate = deferred(); const fx = fixture(t, async () => { await gate.promise; });
  const message = { id: 'same-operation', chatId: 'chat', actorId: 'actor', text: '一次', localOnly: true };
  const first = fx.bridge.submit(message); const second = fx.bridge.submit(message);
  assert.equal(first, second); gate.resolve(); await Promise.all([first, second]); await tick();
  assert.equal(fx.runs.length, 1); assert.equal(fx.store.state.operations['same-operation']?.status, 'submitted');
  fx.finished.resolve(); await tick();
});

test('opening a Store does not rewrite live journal before acquiring service ownership', t => {
  const fx = fixture(t);
  fx.store.operation('live', { chatId: 'chat', actorId: 'actor', cwd: fx.dir, revision: 0, source: 'feishu', status: 'submitted' });
  const before = fs.readFileSync(path.join(fx.dir, 'state.json'), 'utf8');
  const reader = new Store(fx.dir);
  assert.equal(reader.state.operations.live?.status, 'uncertain');
  assert.equal(fs.readFileSync(path.join(fx.dir, 'state.json'), 'utf8'), before);
});

test('stream handover and oversized deltas use native history without retaining partial duplicates', async t => {
  const fx = fixture(t); await fx.bridge.bind('chat', fx.dir, 'thread-a');
  fx.runtime.history = async () => [{ id: 'answer', role: 'assistant', text: '原生完整文本' }];
  const deltaSizes: number[] = []; fx.bridge.subscribe(event => { if (event.delta) deltaSizes.push(event.delta.text.length); });
  fx.notify({ method: 'turn/started', threadId: 'thread-a', turnId: 'native' });
  fx.notify({ method: 'item/agentMessage/delta', threadId: 'thread-a', turnId: 'native', params: { itemId: 'answer', delta: 'a'.repeat(300000) } });
  assert.deepEqual(deltaSizes, []); assert.equal((await fx.bridge.history('chat')).messages[0]?.text, '原生完整文本');
  fx.notify({ method: 'stream/reset', threadId: 'thread-a' });
  fx.notify({ method: 'item/agentMessage/delta', threadId: 'thread-a', turnId: 'native', params: { itemId: 'answer', delta: '重复片段' } });
  assert.deepEqual(deltaSizes, []); assert.equal((await fx.bridge.history('chat')).messages[0]?.text, '原生完整文本');
});

test('revoking an actor stops detached flights and blocks writes after a slow guard', async t => {
  const fx = fixture(t); const first = fx.send('旧任务'); await tick();
  await fx.bridge.bind('chat', fx.dir, 'thread-b'); assert.equal(fx.bridge.hasActiveWork(), true);
  fx.store.authorize('actor', false); await fx.bridge.stopActor('actor'); assert.deepEqual(fx.stopped, ['thread-a']);
  fx.finished.resolve(); await first;
  const gate = deferred(); const guarded = fixture(t, async () => gate.promise);
  const submitted = guarded.bridge.submit({ id: 'guarded', chatId: 'chat', actorId: 'actor', text: '不执行', localOnly: true });
  await tick(); guarded.store.authorize('actor', false); gate.resolve(); await assert.rejects(submitted, /授权已撤销/);
  assert.equal(guarded.runs.length, 0);
});
