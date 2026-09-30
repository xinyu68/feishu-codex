import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Bridge } from '../src/bridge.js';
import { Store } from '../src/store.js';
import type { CodexRunInput, CodexRuntime, FeishuTransport, InboundMessage, MessageCard } from '../src/types.js';

const tick = () => new Promise<void>(resolve => setImmediate(resolve));
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
async function until(predicate: () => boolean, description: string) {
  for (let count = 0; count < 50 && !predicate(); count++) await tick();
  assert.ok(predicate(), description);
}
function mockTime(t: test.TestContext) {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_800_000_000_000 });
}
function fixture(t: test.TestContext, supportsSteering = false) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-notifications-'));
  const store = new Store(dir);
  store.saveConfig({ allowedActors: ['actor'], defaultWorkspace: dir, progress: true });
  store.conversation('chat', 'actor');
  const sends: Array<{ chatId: string; messageId: string; card: MessageCard }> = [];
  const updates: Array<{ messageId: string; card: MessageCard }> = [];
  const recalls: string[] = [];
  const completed: string[] = [];
  const texts: string[] = [];
  const images: Array<{ chatId: string; path: string }> = [];
  const runs: CodexRunInput[] = [];
  const faults: {
    send?: (card: MessageCard) => boolean | Promise<boolean>;
    update?: (card: MessageCard) => boolean | Promise<boolean>;
    complete?: (messageId: string) => boolean | Promise<boolean>;
  } = {};
  const gates: ReturnType<typeof deferred>[] = [];
  let taskWait: Promise<void> | undefined;
  let typingCalls = 0;
  let typingCleanups = 0;
  const runtime: CodexRuntime = {
    supportsSteering,
    async run(input) {
      runs.push(input); input.onThread?.('thread-a');
      input.onSubmitted?.({ threadId: 'thread-a', turnId: 'turn-a', mode: 'start', status: 'submitted' });
      if (taskWait) await taskWait;
      return { threadId: 'thread-a', turnId: 'turn-a', text: '最终答案只发送一次' };
    },
    async stop() {}, async release() {}, async close() {}, async models() { return []; }, async history() { return []; },
    async status() { return { available: true }; }
  };
  const transport: FeishuTransport = {
    async start() {}, async close() {},
    async startTyping() { typingCalls++; return async () => { typingCleanups++; }; },
    async markCompleted(messageId) {
      completed.push(messageId);
      if (await faults.complete?.(messageId)) throw new Error('reaction rejected');
    },
    async sendText(_chatId, text) { texts.push(text); return randomUUID(); },
    async sendImage(chatId, imagePath) { images.push({ chatId, path: imagePath }); return randomUUID(); },
    async sendFile() { return randomUUID(); },
    async sendCard(chatId, card) {
      const messageId = `card-${sends.length + 1}`;
      sends.push({ chatId, messageId, card: structuredClone(card) });
      if (await faults.send?.(card)) throw new Error('send response lost');
      return messageId;
    },
    async updateCard(messageId, card) {
      updates.push({ messageId, card: structuredClone(card) });
      if (await faults.update?.(card)) throw new Error('update rejected');
    },
    async recallCard(messageId) {
      recalls.push(messageId);
    }
  };
  const bridge = new Bridge(store, runtime, { projects: async () => [], threads: async () => [] });
  bridge.transport = transport;
  const send = (text: string, extra: Partial<InboundMessage> = {}) => bridge.receive({
    id: `om_${randomUUID()}`, actorId: 'actor', chatId: 'chat', text, ...extra
  });
  const gate = () => { const value = deferred(); gates.push(value); return value; };
  const hold = () => { const value = gate(); taskWait = value.promise; return value; };
  t.after(async () => {
    for (const value of gates) value.resolve();
    await bridge.close();
    assert.equal(path.dirname(dir), os.tmpdir());
    assert.ok(path.basename(dir).startsWith('bridge-notifications-'));
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return { dir, store, runtime, bridge, transport, sends, updates, recalls, completed, texts, images, runs, faults, send, gate, hold,
    typingCalls: () => typingCalls, typingCleanups: () => typingCleanups };
}
function isProgress(card: MessageCard) {
  return card.buttons?.some(button => button.command.startsWith('/stop')) === true;
}
function progressCards(fx: ReturnType<typeof fixture>) { return fx.sends.filter(call => isProgress(call.card)); }
async function emitProgress(fx: ReturnType<typeof fixture>, count = 1) {
  for (const input of fx.runs) input.onProgress?.('正在核对结果');
  await until(() => progressCards(fx).length === count, 'actual commentary must create temporary progress without a delay');
  await tick();
  return progressCards(fx)[0]!;
}
function assertFinalCard(fx: ReturnType<typeof fixture>, messageId: string, text = '最终答案只发送一次') {
  const update = fx.updates.filter(call => call.messageId === messageId).at(-1);
  assert.ok(update, 'the original progress card must contain the final result');
  assert.equal(update.card.buttons?.length ?? 0, 0);
  assert.equal(update.card.text, text);
  return update;
}

test('tasks without commentary use typing and one final card without temporary progress', async t => {
  mockTime(t); const fx = fixture(t);
  await fx.send('短任务', { id: 'om_short' }); await tick();
  assert.deepEqual(fx.sends.map(call => call.card.text), ['最终答案只发送一次']);
  assert.deepEqual(fx.updates, []); assert.deepEqual(fx.recalls, []);
  assert.equal(fx.typingCalls(), 1); assert.equal(fx.typingCleanups(), 1);
  assert.deepEqual(fx.completed, ['om_short']);
});

test('a new final card must be acknowledged before a completion reaction, and uncertain sends never retry', async t => {
  for (const fail of [false, true]) await t.test(fail ? 'uncertain send' : 'confirmed send', async child => {
    const fx = fixture(child, true); const acknowledged = fx.gate();
    fx.faults.send = async () => { await acknowledged.promise; return fail; };
    const turn = fx.send('只发送最终答案', { id: 'om_acknowledge_send' });
    await until(() => fx.sends.length === 1, 'new final send in flight'); await tick();
    assert.deepEqual(fx.completed, []);
    assert.deepEqual(Object.values(fx.store.state.deliveries).map(delivery => delivery.status), ['sending']);
    acknowledged.resolve(); await turn;
    await fx.send('重复事件', { id: 'om_acknowledge_send' });
    assert.equal(fx.runs.length, 1); assert.equal(fx.sends.length, 1);
    assert.deepEqual(fx.completed, fail ? [] : ['om_acknowledge_send']);
    assert.deepEqual(fx.updates, []); assert.deepEqual(fx.recalls, []);
    assert.deepEqual(Object.values(fx.store.state.deliveries).map(delivery => delivery.status), [fail ? 'uncertain' : 'sent']);
  });
});

test('first commentary creates one card and the confirmed result updates that same card', async t => {
  mockTime(t); const fx = fixture(t); const finish = fx.hold();
  const turn = fx.send('长任务', { id: 'om_long' });
  await until(() => fx.runs.length === 1, 'task starts without waiting for progress');
  fx.runs[0]!.onProgress?.('   '); await tick();
  assert.equal(fx.sends.length, 0, 'empty commentary must not create a placeholder card');
  const progress = await emitProgress(fx);
  assert.equal(progress.card.text, '正在核对结果');
  assert.deepEqual(fx.recalls, []);
  finish.resolve(); await turn;
  assert.equal(fx.sends.length, 1);
  assertFinalCard(fx, progress.messageId);
  assert.deepEqual(fx.recalls, []); assert.deepEqual(fx.completed, ['om_long']);
  assert.deepEqual(Object.values(fx.store.state.deliveries).map(delivery => delivery.status), ['sent']);
});

test('a fast task with commentary still reuses its progress card for the answer', async t => {
  const fx = fixture(t);
  fx.runtime.run = async input => {
    fx.runs.push(input); input.onThread?.('thread-a');
    input.onSubmitted?.({ threadId: 'thread-a', turnId: 'fast-commentary', mode: 'start', status: 'submitted' });
    input.onProgress?.('正在快速核对');
    await tick();
    return { threadId: 'thread-a', turnId: 'fast-commentary', text: '快速核对完成' };
  };
  await fx.send('快速核对', { id: 'om_fast' });
  const progress = progressCards(fx);
  assert.equal(progress.length, 1);
  assert.equal(progress[0]!.card.text, '正在快速核对');
  assert.equal(fx.sends.length, 1); assertFinalCard(fx, progress[0]!.messageId, '快速核对完成');
  assert.deepEqual(fx.recalls, []); assert.deepEqual(fx.completed, ['om_fast']);
});

test('disabled progress still sends a final answer for long tasks', async t => {
  mockTime(t); const fx = fixture(t); fx.store.saveConfig({ progress: false });
  const finish = fx.hold(); const turn = fx.send('直接回复', { id: 'om_no_progress' });
  await until(() => fx.runs.length === 1, 'task start');
  fx.runs[0]!.onProgress?.('正在处理，但已关闭进度显示'); await tick(); assert.equal(fx.sends.length, 0);
  finish.resolve(); await turn;
  assert.deepEqual(fx.sends.map(call => call.card.text), ['最终答案只发送一次']);
  assert.deepEqual(fx.updates, []); assert.deepEqual(fx.recalls, []);
  assert.deepEqual(fx.completed, ['om_no_progress']);
});

test('generated images are sent after the final answer card', async t => {
  const fx = fixture(t);
  fx.runtime.run = async input => {
    input.onThread?.('thread-a');
    return { threadId: 'thread-a', turnId: 'turn-image', text: '图片已经生成', images: ['C:\\safe\\generated\\one.png', 'C:\\safe\\generated\\two.webp'] };
  };
  await fx.send('生成两张图片');
  assert.equal(fx.sends.at(-1)?.card.text, '图片已经生成');
  assert.deepEqual(fx.images, [
    { chatId: 'chat', path: 'C:\\safe\\generated\\one.png' }, { chatId: 'chat', path: 'C:\\safe\\generated\\two.webp' },
  ]);
  assert.deepEqual(Object.values(fx.store.state.deliveries).map(delivery => delivery.status), ['sent']);
});

test('a failed intermediate update does not prevent a confirmed final update on the same card', async t => {
  mockTime(t); const fx = fixture(t); const finish = fx.hold(); fx.faults.update = card => card.text === '更新测试';
  const turn = fx.send('更新失败');
  await until(() => fx.runs.length === 1, 'task start');
  const progress = await emitProgress(fx);
  t.mock.timers.tick(4_000); fx.runs[0]!.onProgress?.('更新测试');
  await until(() => fx.updates.length > 0, 'progress update attempted');
  finish.resolve(); await turn;
  assert.equal(fx.sends.length, 1); assertFinalCard(fx, progress.messageId);
  assert.deepEqual(fx.recalls, []); assert.equal(fx.completed.length, 1);
  assert.deepEqual(Object.values(new Store(fx.dir).state.deliveries).map(delivery => delivery.status), ['sent']);
});

test('an uncertain final update preserves the answer without creating another card or marking completion', async t => {
  mockTime(t); const fx = fixture(t, true); const finish = fx.hold();
  fx.faults.update = card => card.text === '最终答案只发送一次';
  const turn = fx.send('结果不明确', { id: 'om_single_update' });
  await until(() => fx.runs.length === 1, 'task start');
  const progress = await emitProgress(fx);
  finish.resolve(); await turn; await fx.send('重复事件', { id: 'om_single_update' });
  assert.equal(fx.runs.length, 1); assert.equal(fx.sends.length, 1);
  const finalUpdates = fx.updates.filter(call => call.messageId === progress.messageId);
  assert.ok(finalUpdates.length >= 1);
  assert.ok(finalUpdates.every(call => call.card.text.includes('最终答案只发送一次') && !call.card.buttons?.length), 'uncertain cleanup must not erase an answer which may already be visible');
  assert.deepEqual(fx.recalls, []); assert.deepEqual(fx.completed, []);
  assert.deepEqual(Object.values(new Store(fx.dir).state.deliveries).map(delivery => delivery.status), ['uncertain']);
});

test('a failed completion reaction never resends or downgrades the confirmed answer', async t => {
  mockTime(t); const fx = fixture(t); const finish = fx.hold(); fx.faults.complete = () => true;
  const turn = fx.send('完成表情失败', { id: 'om_reaction_failed' });
  await until(() => fx.runs.length === 1, 'task start'); const progress = await emitProgress(fx);
  finish.resolve(); await turn; await fx.send('重复事件', { id: 'om_reaction_failed' });
  assert.equal(fx.sends.length, 1); assertFinalCard(fx, progress.messageId);
  assert.deepEqual(fx.completed, ['om_reaction_failed']); assert.deepEqual(fx.recalls, []);
  assert.equal(fx.updates.length, 1);
  assert.deepEqual(Object.values(fx.store.state.deliveries).map(delivery => delivery.status), ['sent']);
});

test('runtime failure updates its progress card without a completion reaction', async t => {
  mockTime(t); const fx = fixture(t); const finish = fx.gate();
  fx.runtime.run = async input => { fx.runs.push(input); input.onThread?.('thread-a'); await finish.promise; throw new Error('任务执行失败：测试故障'); };
  const turn = fx.send('会失败的任务');
  await until(() => fx.runs.length === 1, 'task start');
  const progress = await emitProgress(fx);
  finish.resolve(); await turn;
  const terminal = assertFinalCard(fx, progress.messageId, '任务执行失败：测试故障');
  assert.equal(terminal.card.tone, 'red');
  assert.equal(fx.sends.length, 1); assert.deepEqual(fx.recalls, []); assert.deepEqual(fx.completed, []);
});

test('stopping a long task updates its existing card and never marks the message completed', async t => {
  mockTime(t); const fx = fixture(t); const finish = fx.gate();
  fx.runtime.run = async input => { fx.runs.push(input); input.onThread?.('thread-a'); await finish.promise; throw new Error('interrupted'); };
  let stopped = '';
  fx.runtime.stop = async threadId => { stopped = threadId; finish.resolve(); };
  const turn = fx.send('长任务');
  await until(() => fx.runs.length === 1, 'task start');
  const progress = await emitProgress(fx);
  await fx.bridge.stop('chat'); await turn;
  assert.equal(stopped, 'thread-a');
  const terminal = assertFinalCard(fx, progress.messageId, '已停止当前任务。');
  assert.equal(terminal.card.title, '已停止'); assert.equal(terminal.card.tone, 'orange');
  assert.equal(fx.sends.length, 1); assert.deepEqual(fx.recalls, []); assert.deepEqual(fx.completed, []);
});

test('failed short terminal notifications are not resent by the outer error handler', async t => {
  const fx = fixture(t, true);
  fx.runtime.run = async input => { input.onThread?.('thread-a'); throw new Error('runtime failure'); };
  fx.faults.send = () => true;
  await fx.send('失败且通知失败', { id: 'failed-notification' });
  await fx.send('重复事件', { id: 'failed-notification' });
  assert.equal(fx.sends.filter(call => call.card.text === 'runtime failure').length, 1);
  assert.equal(fx.sends.length, 1); assert.deepEqual(fx.recalls, []);
  assert.deepEqual(fx.completed, []);
  assert.deepEqual(Object.values(fx.store.state.deliveries).map(delivery => delivery.status), ['uncertain']);
});

test('long answers send every segment with no lost or duplicated content', async t => {
  const fx = fixture(t); const answer = `第一段\n${'段落🙂\n'.repeat(2300)}最后一段`;
  fx.runtime.run = async input => { input.onThread?.('thread-a'); return { threadId: 'thread-a', text: answer }; };
  await fx.send('长回复');
  assert.ok(fx.sends.length > 2); assert.equal(fx.sends.map(call => call.card.text).join(''), answer);
  assert.ok(fx.sends.every(call => call.card.text.length <= 4500 && !/^[\uDC00-\uDFFF]/.test(call.card.text)));
  assert.ok(fx.sends.every(call => !call.card.buttons?.length)); assert.deepEqual(fx.recalls, []);
});

test('shared inputs with a local participant use one card and one completion reaction', async t => {
  mockTime(t); const fx = fixture(t, true); const finish = fx.gate();
  fx.runtime.run = async input => {
    fx.runs.push(input); input.onThread?.('thread-a');
    input.onSubmitted?.({ threadId: 'thread-a', turnId: 'shared-turn', mode: fx.runs.length === 1 ? 'start' : 'steer', status: 'submitted' });
    await finish.promise; return { threadId: 'thread-a', turnId: 'shared-turn', text: '共享任务的唯一完整答案' };
  };
  const local = fx.send('本地开始', { localOnly: true }); await tick();
  const first = fx.send('飞书补充', { id: 'om_shared_first' }); const second = fx.send('再次补充', { id: 'om_shared_second' });
  await until(() => fx.runs.length === 3, 'all shared listeners');
  const progress = await emitProgress(fx); finish.resolve(); await Promise.all([local, first, second]); await tick();
  assert.equal(fx.sends.length, 1); assertFinalCard(fx, progress.messageId, '共享任务的唯一完整答案');
  assert.deepEqual(fx.recalls, []);
  assert.equal(fx.completed.length, 1);
  assert.ok(['om_shared_first', 'om_shared_second'].includes(fx.completed[0]!));
  assert.equal(fx.typingCalls(), 2); assert.equal(fx.typingCleanups(), 2);
  assert.equal(fx.store.state.history.chat!.filter(message => message.role === 'assistant').length, 1);
  assert.equal(fx.store.state.totalTurns, 1);
  assert.deepEqual(Object.values(fx.store.state.deliveries).map(delivery => delivery.status), ['sent']);
});

test('shared listeners wait for a confirmed final update before adding one completion reaction', async t => {
  for (const fail of [false, true]) await t.test(fail ? 'lost acknowledgement' : 'confirmed delivery', async child => {
    mockTime(child); const fx = fixture(child, true); const finish = fx.gate(); const acknowledged = fx.gate();
    fx.runtime.run = async input => {
      fx.runs.push(input); input.onThread?.('thread-a');
      input.onSubmitted?.({ threadId: 'thread-a', turnId: 'shared-pending', mode: fx.runs.length === 1 ? 'start' : 'steer', status: 'submitted' });
      await finish.promise; return { threadId: 'thread-a', turnId: 'shared-pending', text: '等待送达确认的唯一答案' };
    };
    fx.faults.update = async card => { if (card.text !== '等待送达确认的唯一答案') return false; await acknowledged.promise; return fail; };
    const first = fx.send('开始处理', { id: 'om_pending_first' }); await tick(); const second = fx.send('补充说明', { id: 'om_pending_second' });
    await until(() => fx.runs.length === 2, 'shared listeners'); const progress = await emitProgress(fx);
    finish.resolve();
    await until(() => fx.updates.some(call => call.card.text === '等待送达确认的唯一答案'), 'final update in flight'); await tick();
    assert.deepEqual(Object.values(fx.store.state.deliveries).map(delivery => delivery.status), ['sending']);
    assert.deepEqual(fx.recalls, []); assert.deepEqual(fx.completed, []);
    acknowledged.resolve(); await Promise.all([first, second]);
    assert.equal(fx.sends.length, 1); assert.deepEqual(fx.recalls, []);
    if (fail) {
      assert.deepEqual(fx.completed, []);
      assert.ok(fx.updates.filter(call => call.messageId === progress.messageId).every(call => call.card.text.includes('等待送达确认的唯一答案') && !call.card.buttons?.length));
    } else {
      assertFinalCard(fx, progress.messageId, '等待送达确认的唯一答案');
      assert.equal(fx.updates.length, 1);
      assert.equal(fx.completed.length, 1);
      assert.ok(['om_pending_first', 'om_pending_second'].includes(fx.completed[0]!));
    }
    assert.deepEqual(Object.values(fx.store.state.deliveries).map(delivery => delivery.status), [fail ? 'uncertain' : 'sent']);
  });
});

test('one failed shared listener cannot finalize the card still owned by a healthy listener', async t => {
  mockTime(t); const fx = fixture(t, true); const failed = fx.gate(); const finished = fx.gate();
  fx.runtime.run = async input => {
    const index = fx.runs.length;
    fx.runs.push(input); input.onThread?.('thread-a');
    input.onSubmitted?.({ threadId: 'thread-a', turnId: 'surviving-turn', mode: index ? 'steer' : 'start', status: 'submitted' });
    if (index === 0) { await failed.promise; throw new Error('listener connection closed'); }
    await finished.promise;
    return { threadId: 'thread-a', turnId: 'surviving-turn', text: '存活监听者返回的最终答案' };
  };
  const first = fx.send('开始任务', { id: 'om_failed_listener' });
  await until(() => fx.runs.length === 1, 'first listener');
  fx.runs[0]!.onProgress?.('第一条中途说明');
  await until(() => progressCards(fx).length === 1, 'first listener creates the shared card'); await tick();
  const progress = progressCards(fx)[0]!;
  const second = fx.send('补充说明', { id: 'om_healthy_listener' });
  await until(() => fx.runs.length === 2, 'second listener submitted');
  failed.resolve(); await first;
  assert.equal(fx.sends.length, 1);
  assert.deepEqual(fx.updates, []); assert.deepEqual(fx.completed, []);
  t.mock.timers.tick(4_000); fx.runs[1]!.onProgress?.('仍在继续处理');
  await until(() => fx.updates.some(call => call.messageId === progress.messageId && call.card.text === '仍在继续处理'), 'healthy listener keeps updating the original card');
  finished.resolve(); await second; await tick();
  assert.equal(fx.sends.length, 1);
  assertFinalCard(fx, progress.messageId, '存活监听者返回的最终答案');
  assert.deepEqual(fx.completed, ['om_healthy_listener']); assert.deepEqual(fx.recalls, []);
  assert.deepEqual(Object.values(fx.store.state.deliveries).map(delivery => delivery.status), ['sent']);
  assert.equal(fx.typingCalls(), 2); assert.equal(fx.typingCleanups(), 2);
});

test('the original progress stop button remains valid for a surviving listener of the same turn', async t => {
  const fx = fixture(t, true); const failed = fx.gate(); const interrupted = fx.gate(); const stops: string[] = [];
  fx.runtime.run = async input => {
    const index = fx.runs.length;
    fx.runs.push(input); input.onThread?.('thread-a');
    input.onSubmitted?.({ threadId: 'thread-a', turnId: 'surviving-stop-turn', mode: index ? 'steer' : 'start', status: 'submitted' });
    if (index === 0) { await failed.promise; throw new Error('listener connection closed'); }
    await interrupted.promise; throw new Error('interrupted');
  };
  fx.runtime.stop = async threadId => { stops.push(threadId); interrupted.resolve(); };
  const first = fx.send('开始任务', { id: 'om_original_progress_owner' });
  await until(() => fx.runs.length === 1, 'first listener');
  fx.runs[0]!.onProgress?.('第一条中途说明');
  await until(() => progressCards(fx).length === 1, 'shared progress card'); await tick();
  const progress = progressCards(fx)[0]!;
  const stopCommand = progress.card.buttons!.find(button => button.command.startsWith('/stop'))!.command;
  const second = fx.send('继续这项任务', { id: 'om_remaining_listener' });
  await until(() => fx.runs.length === 2, 'second listener submitted');
  failed.resolve(); await first;
  await fx.send(stopCommand);
  assert.deepEqual(stops, ['thread-a']); await second; assert.equal(fx.runs.length, 2);
  assert.equal(progressCards(fx).length, 1);
  assert.ok(fx.sends.every(call => call.messageId === progress.messageId || call.card.title === '停止请求已提交'));
  const terminal = assertFinalCard(fx, progress.messageId, '已停止当前任务。');
  assert.equal(terminal.card.title, '已停止');
  assert.deepEqual(fx.completed, []); assert.deepEqual(fx.recalls, []);
});

test('cancellation or authorization removal while typing cleanup waits prevents the completion reaction', async t => {
  for (const change of ['cancel', 'revoke'] as const) await t.test(change, async child => {
    const fx = fixture(child, true); const cleaned = fx.gate(); let cleanups = 0;
    fx.transport.startTyping = async () => async () => { cleanups++; await cleaned.promise; };
    const turn = fx.send('结果送达后状态变化', { id: 'om_cleanup_wait' });
    await until(() => cleanups === 1, 'final answer delivered and typing cleanup started');
    assert.equal(fx.sends.length, 1); assert.equal(fx.sends[0]!.card.text, '最终答案只发送一次');
    assert.deepEqual(Object.values(fx.store.state.deliveries).map(delivery => delivery.status), ['sent']);
    assert.deepEqual(fx.completed, []);
    if (change === 'cancel') await fx.bridge.stop('chat');
    else fx.store.saveConfig({ allowedActors: [] });
    cleaned.resolve(); await turn; await tick();
    assert.deepEqual(fx.completed, []); assert.equal(cleanups, 1);
    assert.equal(fx.sends.length, 1); assert.deepEqual(fx.recalls, []);
  });
});

test('final delivery waits for slow progress creation and updates the acknowledged card', async t => {
  mockTime(t); const fx = fixture(t); const finish = fx.hold(); const created = fx.gate();
  fx.faults.send = async card => { if (isProgress(card)) await created.promise; return false; };
  let done = false; const turn = fx.send('创建很慢').then(() => { done = true; });
  await until(() => fx.runs.length === 1, 'task start');
  const progress = await emitProgress(fx); finish.resolve();
  await tick(); await tick();
  assert.equal(fx.sends.length, 1); assert.deepEqual(fx.updates, []); assert.deepEqual(fx.completed, []);
  assert.equal(done, false); assert.deepEqual(fx.recalls, []);
  created.resolve(); await turn;
  assert.equal(fx.sends.length, 1); assertFinalCard(fx, progress.messageId);
  assert.deepEqual(fx.recalls, []); assert.equal(fx.completed.length, 1); assert.equal(done, true);
});

test('final delivery follows a slow progress update on the same card without late overwrites', async t => {
  mockTime(t); const fx = fixture(t); const finish = fx.hold(); const updated = fx.gate(); const order: string[] = [];
  fx.faults.update = async card => { if (card.text === '新的进度') await updated.promise; order.push(card.text); return false; };
  let done = false; const turn = fx.send('更新很慢').then(() => { done = true; });
  await until(() => fx.runs.length === 1, 'task start');
  const progress = await emitProgress(fx);
  t.mock.timers.tick(4_000); fx.runs[0]!.onProgress?.('新的进度');
  await until(() => fx.updates.length > 0, 'progress update in flight'); finish.resolve();
  await tick(); await tick();
  assert.equal(fx.sends.length, 1); assert.equal(fx.updates.length, 1); assert.deepEqual(fx.completed, []);
  assert.equal(done, false); assert.deepEqual(fx.recalls, []);
  updated.resolve(); await turn;
  assert.equal(fx.sends.length, 1); assertFinalCard(fx, progress.messageId);
  assert.deepEqual(fx.recalls, []); assert.deepEqual(order, ['新的进度', '最终答案只发送一次']);
  assert.equal(fx.completed.length, 1);
});

test('local preview progress, completion, and failure produce no Feishu calls', async t => {
  const fx = fixture(t); await fx.send('本地成功', { localOnly: true });
  fx.runtime.run = async input => { input.onProgress?.('本地过程'); throw new Error('本地失败'); };
  await fx.send('本地失败', { localOnly: true }); await fx.send('独立预览失败', { chatId: 'local-preview' });
  assert.deepEqual(fx.sends, []); assert.deepEqual(fx.updates, []); assert.deepEqual(fx.recalls, []);
  assert.deepEqual(fx.texts, []); assert.equal(fx.typingCalls(), 0); assert.deepEqual(fx.store.state.deliveries, {});
  assert.deepEqual(fx.completed, []);
});

test('questions and approvals keep their own card while progress becomes the final answer', async t => {
  for (const kind of ['question', 'approval'] as const) await t.test(kind, async child => {
    mockTime(child); const fx = fixture(child);
    const title = kind === 'question' ? '请确认环境' : '请批准检查';
    fx.runtime.run = async input => {
      fx.runs.push(input); input.onThread?.('thread-a');
      const answer = await input.onRequest!({ id: kind, kind, title, text: '需要你的决定',
        ...(kind === 'question' ? { questions: [{ id: 'env', question: '选择哪个环境？' }] } : {}) });
      assert.deepEqual(answer, kind === 'question' ? { answers: { env: { answers: ['测试环境'] } } } : { decision: 'accept' });
      return { threadId: 'thread-a', text: '已根据你的决定完成' };
    };
    const turn = fx.send('需要决定');
    await until(() => fx.bridge.pendingRequests().length === 1, 'user request');
    const request = fx.bridge.pendingRequests()[0]!;
    let decisionCard: (typeof fx.sends)[number] | undefined;
    let progress: (typeof fx.sends)[number] | undefined;
    try {
      decisionCard = fx.sends.find(call => call.card.title === title); assert.ok(decisionCard);
      progress = await emitProgress(fx); assert.notEqual(decisionCard.messageId, progress.messageId);
      assert.deepEqual(fx.recalls, []);
    } finally {
      await fx.bridge.answer(request.id, kind === 'question' ? { answers: { env: { answers: ['测试环境'] } } } : { decision: 'accept' });
      await turn;
    }
    assert.ok(progress); assert.deepEqual(fx.recalls, []);
    assert.ok(fx.updates.some(call => call.messageId === decisionCard!.messageId && !call.card.buttons?.length));
    assert.equal(fx.sends.length, 2); assertFinalCard(fx, progress.messageId, '已根据你的决定完成');
    assert.equal(fx.completed.length, 1);
  });
});

function completionEventFixture(t: test.TestContext) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-final-notifications-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = new Store(dir);
  store.saveConfig({ allowedActors: ['actor'], defaultWorkspace: dir, autoNotifyDesktop: true, desktopNotificationMode: 'all' });
  Object.assign(store.conversation('oc_notify', 'actor', dir), { threadId: 'desktop-thread' });
  let listener: ((event: import('../src/types.js').RuntimeEvent) => void) | undefined;
  const cards: MessageCard[] = [];
  const runtime: CodexRuntime = {
    supportsSteering: true,
    subscribe(callback) { listener = callback; return () => { listener = undefined; }; },
    async run() { throw new Error('A completion notification must not run a model task'); },
    async stop() { throw new Error('A completion notification must not stop a task'); },
    async release() {}, async close() {}, async models() { return []; }, async history() { return []; },
    async status() { return { available: true }; },
    async threadInfo(threadId) { return { threadId, cwd: dir, title: '桌面开发会话', isUserThread: true }; },
  };
  const bridge = new Bridge(store, runtime, { projects: async () => [], threads: async () => [] });
  bridge.transport = {
    async start() {}, async close() {}, async startTyping() { return async () => {}; },
    async sendText() { throw new Error('Completion results must use cards'); },
    async sendImage() { return ''; }, async sendFile() { return ''; }, async updateCard() {},
    async sendCard(_chatId, card) { cards.push(card); return `notification-${cards.length}`; },
  };
  const emit = (items: Record<string, unknown>[]) => listener?.({
    method: 'turn/completed', threadId: 'desktop-thread', turnId: 'desktop-turn',
    params: { turn: { id: 'desktop-turn', status: 'completed', items } },
  });
  const call = {
    id: 'completion-mcp', type: 'mcpToolCall', server: 'feishu_completion', tool: 'request_feishu_completion_notification',
    arguments: { summary: '核对完成结果' }, status: 'completed',
  };
  return { bridge, store, runtime, cards, emit, call };
}

test('desktop completion events select the last non-empty final answer and deduplicate repeated MCP notifications', async t => {
  const fx = completionEventFixture(t);
  try {
    let historyReads = 0;
    fx.runtime.history = async () => { historyReads++; return []; };
    const items = [
      fx.call,
      { id: 'first-final', type: 'agentMessage', phase: 'final_answer', text: '早先的结果，请接我的单张3。' },
      { id: 'second-final', type: 'agentMessage', phase: 'final_answer', text: '最终结果：如果已经接过牌，就等待用户。' },
      { id: 'empty-final', type: 'agentMessage', phase: 'final_answer', text: '  \n ' },
      { id: 'late-progress', type: 'agentMessage', phase: 'commentary', text: '后续过程说明不应拼到通知里。' },
    ];
    fx.emit(items);
    fx.emit(items);
    for (let count = 0; count < 4; count++) await tick();
    assert.equal(fx.cards.length, 1);
    assert.match(fx.cards[0]!.text, /最终结果：如果已经接过牌，就等待用户。/);
    assert.doesNotMatch(fx.cards[0]!.text, /早先的结果|后续过程说明/);
    assert.equal(historyReads, 0);
    const notifications = Object.values(fx.store.state.notifications);
    assert.equal(notifications.length, 1);
    assert.equal(notifications[0]!.result, '最终结果：如果已经接过牌，就等待用户。');
    assert.equal(notifications[0]!.automatic, false);
    assert.equal(notifications[0]!.status, 'sent');
    assert.equal(fx.cards[0]!.buttons?.[0]?.label, '切换到此会话');
  } finally { await fx.bridge.close(); }
});

test('completion history fallback selects the last non-empty answer from the requested turn without concatenating earlier finals', async t => {
  for (const phase of ['final_answer', undefined]) {
    const fx = completionEventFixture(t);
    try {
      let historyReads = 0;
      fx.runtime.history = async threadId => {
        historyReads++;
        assert.equal(threadId, 'desktop-thread');
        return [
          { id: 'old-answer', role: 'assistant', turnId: 'desktop-turn', phase, text: '第一份结果已经过时。' },
          { id: 'final-answer', role: 'assistant', turnId: 'desktop-turn', phase, text: '第二份结果才是最终结论。' },
          { id: 'empty-answer', role: 'assistant', turnId: 'desktop-turn', phase, text: ' \n ' },
          { id: 'late-progress', role: 'assistant', turnId: 'desktop-turn', phase: 'commentary', text: '过程消息不进入完成通知。' },
          { id: 'another-turn', role: 'assistant', turnId: 'unrelated-turn', phase: 'final_answer', text: '其他任务的最终结果。' },
        ];
      };
      fx.emit([fx.call]);
      fx.emit([fx.call]);
      for (let count = 0; count < 4; count++) await tick();
      assert.equal(fx.cards.length, 1, `phase=${phase ?? 'unspecified'}`);
      assert.match(fx.cards[0]!.text, /第二份结果才是最终结论。/);
      assert.doesNotMatch(fx.cards[0]!.text, /第一份结果|过程消息|其他任务/);
      assert.equal(historyReads, 1);
      const notifications = Object.values(fx.store.state.notifications);
      assert.equal(notifications.length, 1);
      assert.equal(notifications[0]!.result, '第二份结果才是最终结论。');
      assert.equal(notifications[0]!.status, 'sent');
    } finally { await fx.bridge.close(); }
  }
});
