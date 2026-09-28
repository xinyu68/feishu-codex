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

function fixture(t: test.TestContext, supportsSteering = false) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-notifications-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = new Store(dir);
  store.saveConfig({ allowedActors: ['actor'], defaultWorkspace: dir, progress: true });
  store.conversation('chat', 'actor');
  const sends: Array<{ chatId: string; messageId: string; card: MessageCard }> = [];
  const updates: Array<{ messageId: string; card: MessageCard }> = [];
  const texts: string[] = [];
  const images: Array<{ chatId: string; path: string }> = [];
  const runs: CodexRunInput[] = [];
  const faults: {
    send?: (card: MessageCard) => boolean;
    update?: (card: MessageCard) => boolean;
  } = {};
  let typingCalls = 0;
  const runtime: CodexRuntime = {
    supportsSteering,
    async run(input) {
      runs.push(input);
      input.onThread?.('thread-a');
      input.onProgress?.('正在核对结果');
      return { threadId: 'thread-a', turnId: 'turn-a', text: '最终答案只发送一次' };
    },
    async stop() {}, async release() {}, async close() {},
    async models() { return []; }, async history() { return []; },
    async status() { return { available: true }; }
  };
  const transport: FeishuTransport = {
    async start() {}, async close() {},
    async startTyping() { typingCalls++; return async () => {}; },
    async sendText(_chatId, text) { texts.push(text); return randomUUID(); },
    async sendImage(chatId, imagePath) { images.push({ chatId, path: imagePath }); return randomUUID(); }, async sendFile() { return randomUUID(); },
    async sendCard(chatId, card) {
      const messageId = `card-${sends.length + 1}`;
      sends.push({ chatId, messageId, card: structuredClone(card) });
      if (faults.send?.(card)) throw new Error('send response lost');
      return messageId;
    },
    async updateCard(messageId, card) {
      updates.push({ messageId, card: structuredClone(card) });
      if (faults.update?.(card)) throw new Error('update rejected');
    }
  };
  const bridge = new Bridge(store, runtime, { projects: async () => [], threads: async () => [] });
  bridge.transport = transport;
  const send = (text: string, extra: Partial<InboundMessage> = {}) => bridge.receive({
    id: randomUUID(), actorId: 'actor', chatId: 'chat', text, ...extra
  });
  return { dir, store, runtime, bridge, sends, updates, texts, images, runs, faults, send, typingCalls: () => typingCalls };
}

function assertClosedProgress(fx: ReturnType<typeof fixture>, messageId: string, answer: string) {
  const lastUpdate = fx.updates.filter(call => call.messageId === messageId).at(-1);
  assert.ok(lastUpdate, 'the original progress card must be closed');
  assert.equal(lastUpdate.card.buttons?.length ?? 0, 0, 'finished progress cards must not retain stop buttons');
  assert.ok(lastUpdate.card.text.length <= 200, 'the original card should contain a short status');
  assert.notEqual(lastUpdate.card.text, answer, 'the original card must not duplicate the final answer');
}

test('progress updates the original card and completion sends the full answer in one new card', async t => {
  const fx = fixture(t);
  await fx.send('处理任务');
  const progress = fx.sends.find(call => call.card.buttons?.some(button => button.command.startsWith('/stop')))!;
  assert.ok(progress);
  assert.ok(fx.updates.some(call => call.messageId === progress.messageId && call.card.text === '正在核对结果'));
  const final = fx.sends.filter(call => call.card.text === '最终答案只发送一次');
  assert.equal(final.length, 1);
  assert.notEqual(final[0]!.messageId, progress.messageId);
  assert.equal(fx.sends.length, 2);
  assert.equal(fx.updates.some(call => call.card.text === '最终答案只发送一次'), false);
  assertClosedProgress(fx, progress.messageId, '最终答案只发送一次');
  assert.deepEqual(Object.values(fx.store.state.deliveries).map(delivery => delivery.status), ['sent']);
});

test('completion still sends a new answer when progress cards are disabled', async t => {
  const fx = fixture(t);
  fx.store.saveConfig({ progress: false });
  await fx.send('直接回复');
  assert.deepEqual(fx.sends.map(call => call.card.text), ['最终答案只发送一次']);
  assert.deepEqual(fx.updates, []);
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
    { chatId: 'chat', path: 'C:\\safe\\generated\\one.png' },
    { chatId: 'chat', path: 'C:\\safe\\generated\\two.webp' },
  ]);
  assert.deepEqual(Object.values(fx.store.state.deliveries).map(delivery => delivery.status), ['sent']);
});

test('failed progress updates cannot suppress the final answer or downgrade a successful delivery', async t => {
  const fx = fixture(t);
  fx.faults.update = () => true;
  await fx.send('更新过程卡会失败');
  assert.equal(fx.sends.filter(call => call.card.text === '最终答案只发送一次').length, 1);
  assert.ok(fx.updates.some(call => call.card.text === '正在核对结果'));
  assertClosedProgress(fx, fx.sends[0]!.messageId, '最终答案只发送一次');
  assert.deepEqual(Object.values(fx.store.state.deliveries).map(delivery => delivery.status), ['sent']);
  assert.deepEqual(Object.values(new Store(fx.dir).state.deliveries).map(delivery => delivery.status), ['sent']);
});

test('a lost final-send response is recorded as uncertain and never blindly retried', async t => {
  const fx = fixture(t, true);
  fx.faults.send = card => card.text === '最终答案只发送一次';
  await fx.send('发送结果不明确', { id: 'single-send' });
  await fx.send('重复事件', { id: 'single-send' });
  assert.equal(fx.runs.length, 1);
  assert.equal(fx.sends.filter(call => call.card.text === '最终答案只发送一次').length, 1);
  assert.equal(fx.sends.length, 2, 'no additional error card should blindly retry delivery');
  assertClosedProgress(fx, fx.sends[0]!.messageId, '最终答案只发送一次');
  assert.deepEqual(Object.values(new Store(fx.dir).state.deliveries).map(delivery => delivery.status), ['uncertain']);
});

test('runtime failure sends a new terminal card and closes the old progress card', async t => {
  const fx = fixture(t);
  fx.runtime.run = async input => {
    input.onThread?.('thread-a');
    input.onProgress?.('即将失败');
    throw new Error('任务执行失败：测试故障');
  };
  await fx.send('会失败的任务');
  const terminal = fx.sends.filter(call => call.card.text === '任务执行失败：测试故障');
  assert.equal(terminal.length, 1);
  assert.equal(terminal[0]!.card.tone, 'red');
  assert.equal(fx.sends.length, 2);
  assertClosedProgress(fx, fx.sends[0]!.messageId, '任务执行失败：测试故障');
});

test('stopping a running task sends a new stopped card and removes the original stop button', async t => {
  const fx = fixture(t);
  const finish = deferred();
  fx.runtime.run = async input => {
    input.onThread?.('thread-a');
    await finish.promise;
    throw new Error('interrupted');
  };
  let stopped = '';
  fx.runtime.stop = async threadId => { stopped = threadId; finish.resolve(); };
  const turn = fx.send('长任务');
  await tick();
  await fx.bridge.stop('chat');
  await turn;
  assert.equal(stopped, 'thread-a');
  const terminal = fx.sends.filter(call => call.card.title === '已停止');
  assert.equal(terminal.length, 1);
  assert.equal(terminal[0]!.card.tone, 'orange');
  assert.equal(fx.sends.length, 2);
  assertClosedProgress(fx, fx.sends[0]!.messageId, terminal[0]!.card.text);
});

test('a failed terminal notification is not resent by the outer receive error handler', async t => {
  const fx = fixture(t, true);
  fx.runtime.run = async input => { input.onThread?.('thread-a'); throw new Error('runtime failure'); };
  fx.faults.send = card => !card.buttons?.length;
  await fx.send('失败且通知失败', { id: 'failed-notification' });
  await fx.send('重复事件', { id: 'failed-notification' });
  assert.equal(fx.sends.filter(call => call.card.text === 'runtime failure').length, 1);
  assert.equal(fx.sends.length, 2, 'a terminal send failure must not trigger another outbound error card');
  assertClosedProgress(fx, fx.sends[0]!.messageId, 'runtime failure');
  assert.deepEqual(Object.values(fx.store.state.deliveries).map(delivery => delivery.status), ['uncertain']);
});

test('long answers send every segment as a new card with no lost or duplicated content', async t => {
  const fx = fixture(t);
  const answer = `第一段\n${'段落🙂\n'.repeat(2300)}最后一段`;
  fx.runtime.run = async input => { input.onThread?.('thread-a'); return { threadId: 'thread-a', text: answer }; };
  await fx.send('长回复');
  const progress = fx.sends[0]!;
  const parts = fx.sends.slice(1);
  assert.ok(parts.length > 2);
  assert.equal(parts.map(call => call.card.text).join(''), answer);
  assert.ok(parts.every(call => call.card.text.length <= 4500 && !/^[\uDC00-\uDFFF]/.test(call.card.text)));
  assert.ok(parts.every(call => !call.card.buttons?.length));
  assertClosedProgress(fx, progress.messageId, answer);
  assert.equal(fx.updates.some(call => call.card.text === parts[0]!.card.text), false);
});

test('shared turn inputs and a local participant still send one final answer and close every progress card', async t => {
  const fx = fixture(t, true);
  const finish = deferred();
  fx.runtime.run = async input => {
    fx.runs.push(input);
    input.onThread?.('thread-a');
    input.onSubmitted?.({ threadId: 'thread-a', turnId: 'shared-turn', mode: fx.runs.length === 1 ? 'start' : 'steer', status: 'submitted' });
    await finish.promise;
    return { threadId: 'thread-a', turnId: 'shared-turn', text: '共享任务的唯一完整答案' };
  };
  const local = fx.send('本地开始', { localOnly: true });
  await tick();
  const first = fx.send('飞书补充');
  const second = fx.send('再次补充');
  await tick();
  finish.resolve();
  await Promise.all([local, first, second]);
  assert.equal(fx.runs.length, 3);
  assert.equal(fx.sends.filter(call => call.card.text === '共享任务的唯一完整答案').length, 1);
  assert.equal(fx.updates.some(call => call.card.text === '共享任务的唯一完整答案'), false);
  const progress = fx.sends.filter(call => call.card.buttons?.length);
  assert.equal(progress.length, 2);
  for (const card of progress) assertClosedProgress(fx, card.messageId, '共享任务的唯一完整答案');
  assert.equal(fx.store.state.history.chat!.filter(message => message.role === 'assistant').length, 1);
  assert.equal(fx.store.state.totalTurns, 1);
  assert.deepEqual(Object.values(fx.store.state.deliveries).map(delivery => delivery.status), ['sent']);
});

test('local preview progress, completion, and failure produce no Feishu calls', async t => {
  const fx = fixture(t);
  await fx.send('本地成功', { localOnly: true });
  fx.runtime.run = async input => { input.onProgress?.('本地过程'); throw new Error('本地失败'); };
  await fx.send('本地失败', { localOnly: true });
  await fx.send('独立预览失败', { chatId: 'local-preview' });
  assert.deepEqual(fx.sends, []);
  assert.deepEqual(fx.updates, []);
  assert.deepEqual(fx.texts, []);
  assert.equal(fx.typingCalls(), 0);
  assert.deepEqual(fx.store.state.deliveries, {});
});

test('questions remain separate new cards and their answers continue to a new final reply', async t => {
  const fx = fixture(t);
  fx.runtime.run = async input => {
    input.onThread?.('thread-a');
    const answer = await input.onRequest!({ id: 'question', kind: 'question', title: '请确认环境', text: '需要你的选择', questions: [{ id: 'env', question: '选择哪个环境？' }] });
    assert.deepEqual(answer, { answers: { env: { answers: ['测试环境'] } } });
    return { threadId: 'thread-a', text: '已使用测试环境完成' };
  };
  const turn = fx.send('需要回答的问题');
  await tick();
  const request = fx.bridge.pendingRequests()[0]!;
  try {
    const question = fx.sends.filter(call => call.card.title === '请确认环境');
    assert.equal(question.length, 1);
    assert.notEqual(question[0]!.messageId, fx.sends[0]!.messageId);
    assert.match(question[0]!.card.text, /选择哪个环境/);
    assert.equal(fx.updates.some(call => call.card.title === '请确认环境'), false);
  } finally {
    await fx.bridge.answer(request.id, { answers: { env: { answers: ['测试环境'] } } });
    await turn;
  }
  assert.equal(fx.sends.filter(call => call.card.text === '已使用测试环境完成').length, 1);
  assert.equal(fx.sends.length, 3);
  assertClosedProgress(fx, fx.sends[0]!.messageId, '已使用测试环境完成');
});
