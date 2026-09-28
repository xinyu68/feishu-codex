import assert from 'node:assert/strict';
import test from 'node:test';
import { TaskProgress } from '../src/task-progress.js';
import type { FeishuTransport, MessageCard } from '../src/types.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

async function flush(): Promise<void> {
  for (let i = 0; i < 8; i++) await Promise.resolve();
}

function fixture(t: test.TestContext, options: { throttleMs?: number } = {}) {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1_800_000_000_000 });
  const sent: { id: string; chatId: string; card: MessageCard; at: number }[] = [];
  const updated: { id: string; card: MessageCard; at: number }[] = [];
  const recalled: string[] = [];
  const logs: string[] = [];
  const hooks: {
    send?: () => Promise<string>;
    update?: () => Promise<void>;
    canShow?: () => boolean;
  } = {};
  let allowed = true;
  const transport: FeishuTransport = {
    async start() {}, async close() {}, async startTyping() { return async () => {}; },
    async sendText() { throw new Error('No text messages should be sent by progress handling'); },
    async sendImage() { throw new Error('No image messages should be sent by progress handling'); },
    async sendFile() { throw new Error('No file messages should be sent by progress handling'); },
    async sendCard(chatId, card) {
      const id = `message-${sent.length + 1}`;
      sent.push({ id, chatId, card: structuredClone(card), at: Date.now() });
      return hooks.send ? hooks.send() : id;
    },
    async updateCard(id, card) {
      updated.push({ id, card: structuredClone(card), at: Date.now() });
      await hooks.update?.();
    },
    async recallCard(id) { recalled.push(id); throw new Error('Task cards must never be recalled'); },
  };
  const card: MessageCard = { title: '开发正在处理', text: '正在准备', buttons: [{ label: '停止', command: '/stop task' }] };
  const fallback: MessageCard = { title: '已完成', text: '任务已结束，请查看最终回复。', buttons: [{ label: '不应保留', command: '/stop old' }] };
  const final: MessageCard = { title: 'Codex', text: '这是完整的最终答案。', tone: 'green', buttons: [{ label: '不应保留', command: '/stop old' }] };
  const progress = new TaskProgress({
    transport, chatId: 'oc_progress', card, canShow: () => hooks.canShow ? hooks.canShow() : allowed,
    log: message => { logs.push(message); }, throttleMs: options.throttleMs,
  });
  t.after(() => { progress.freeze(); assert.deepEqual(recalled, [], 'completion must never recall any message'); });
  const advance = async (ms: number) => { t.mock.timers.tick(ms); await flush(); };
  const explain = async (text = '开始检查相关代码') => { progress.update(text); await flush(); };
  return { progress, transport, sent, updated, recalled, logs, hooks, card, fallback, final, advance, explain, setAllowed(value: boolean) { allowed = value; } };
}

test('the first explanation immediately creates progress at zero seconds using the most recently cached content', async t => {
  const fx = fixture(t);
  await flush();
  assert.equal(fx.sent.length, 0);
  fx.progress.update('先读取配置');
  fx.progress.update('正在运行检查', '开发正在验证');
  await flush();
  assert.equal(fx.sent.length, 1);
  assert.equal(fx.sent[0]!.card.text, '正在运行检查');
  assert.equal(fx.sent[0]!.card.title, '开发正在验证');
  assert.equal(fx.sent[0]!.at, 1_800_000_000_000);
  assert.deepEqual(fx.sent[0]!.card.buttons, fx.card.buttons);
});

test('initial placeholders and empty explanations never create a card regardless of elapsed time', async t => {
  const fx = fixture(t);
  fx.progress.update('');
  fx.progress.update('   \n\t  ', '不应创建卡片');
  await fx.advance(24 * 60 * 60 * 1000);
  assert.deepEqual(fx.sent, []);
  assert.deepEqual(fx.updated, []);
  await fx.explain('真正开始分析了');
  assert.equal(fx.sent.length, 1);
  assert.equal(fx.sent[0]!.card.text, '真正开始分析了');
  assert.equal(fx.sent[0]!.card.title, '开发正在处理');
});

test('finishing a task with no intermediate explanation creates no progress card and finish is idempotent', async t => {
  const fx = fixture(t);
  await fx.advance(60_000);
  const first = fx.progress.finish(true, fx.fallback);
  const second = fx.progress.finish(false, { title: 'later', text: 'ignored' });
  assert.equal(first, second);
  await first;
  fx.progress.update('不应出现');
  await fx.advance(60_000);
  assert.deepEqual(fx.sent, []);
  assert.deepEqual(fx.updated, []);
  assert.deepEqual(fx.recalled, []);
});

test('updates are throttled to four seconds and send the latest progress rather than every queued value', async t => {
  const fx = fixture(t);
  await fx.explain();
  fx.progress.update('进度1');
  await fx.advance(3_999);
  fx.progress.update('进度2');
  assert.equal(fx.updated.length, 0);
  await fx.advance(1);
  assert.equal(fx.updated.length, 1);
  assert.equal(fx.updated[0]!.card.text, '进度2');
  fx.progress.update('进度3');
  await fx.advance(4_000);
  assert.equal(fx.updated.length, 2);
  assert.equal(fx.updated[1]!.card.text, '进度3');
  assert.equal(fx.updated[1]!.at - fx.updated[0]!.at, 4_000);
});

test('freeze cancels explanation-triggered creation before it reaches the transport', async t => {
  const fx = fixture(t);
  fx.progress.update('我会先检查代码');
  fx.progress.freeze();
  await flush();
  assert.equal(fx.sent.length, 0);
  await fx.progress.finish(true, fx.fallback);
});

test('deliver waits for in-flight progress creation and writes the final answer onto that same card', async t => {
  const fx = fixture(t);
  const creation = deferred<string>();
  fx.hooks.send = () => creation.promise;
  await fx.explain();
  fx.progress.update('创建期间的新进度');
  let finished = false;
  const delivery = fx.progress.deliver(fx.final).then(id => { finished = true; return id; });
  const finishing = fx.progress.finish(true, fx.fallback);
  await flush();
  assert.equal(finished, false);
  assert.deepEqual(fx.recalled, []);
  creation.resolve('late-progress-id');
  assert.equal(await delivery, 'late-progress-id');
  await finishing;
  assert.equal(fx.updated.length, 1);
  assert.equal(fx.updated[0]!.id, 'late-progress-id');
  assert.equal(fx.updated[0]!.card.text, fx.final.text);
  assert.equal(fx.updated[0]!.card.buttons, undefined);
  await fx.advance(60_000);
  assert.equal(fx.sent.length, 1);
});

test('deliver waits for a running update and cancels queued progress so nothing overwrites the final answer', async t => {
  const fx = fixture(t);
  await fx.explain();
  const updating = deferred<void>();
  fx.hooks.update = () => updating.promise;
  fx.progress.update('正在写入进度');
  await fx.advance(4_000);
  fx.progress.update('尚未发送的新进度');
  const delivery = fx.progress.deliver(fx.final);
  const finishing = fx.progress.finish(false, fx.fallback);
  await flush();
  assert.equal(fx.updated.length, 1);
  updating.resolve();
  assert.equal(await delivery, 'message-1');
  await finishing;
  await fx.advance(8_000);
  assert.equal(fx.updated.length, 2);
  assert.equal(fx.updated[1]!.card.text, fx.final.text);
  assert.equal(fx.updated[1]!.card.buttons, undefined);
  assert.equal(fx.sent.length, 1);
});

test('without deliver, finish only removes buttons and puts fallback on the existing card', async t => {
  const fx = fixture(t);
  await fx.explain();
  await fx.progress.finish(false, fx.fallback);
  assert.deepEqual(fx.recalled, []);
  assert.equal(fx.sent.length, 1);
  assert.deepEqual(fx.updated, [{ id: 'message-1', card: { title: '已完成', text: '任务已结束，请查看最终回复。' }, at: 1_800_000_000_000 }]);
  assert.equal(fx.fallback.buttons?.length, 1, 'the caller-owned fallback is not mutated');
});

test('deliver reuses an existing card exactly once and later finish cannot replace the complete answer', async t => {
  const fx = fixture(t);
  await fx.explain();
  const first = fx.progress.deliver(fx.final);
  const second = fx.progress.deliver({ title: '其他结果', text: '不应覆盖第一次结果' });
  assert.equal(first, second);
  assert.equal(await first, 'message-1');
  await fx.progress.finish(false, fx.fallback);
  await fx.progress.finish(true, fx.fallback);
  assert.equal(fx.updated.length, 1);
  assert.equal(fx.updated[0]!.card.text, fx.final.text);
  assert.equal(fx.updated[0]!.card.buttons, undefined);
  assert.equal(fx.sent.length, 1);
  assert.equal(fx.final.buttons?.length, 1, 'the caller-owned final card is not mutated');
});

test('when there was no explanation, deliver sends the only final card and is idempotent', async t => {
  const fx = fixture(t);
  await fx.advance(60_000);
  const first = fx.progress.deliver(fx.final);
  assert.equal(first, fx.progress.deliver(fx.final));
  assert.equal(await first, 'message-1');
  await fx.progress.finish(true, fx.fallback);
  assert.equal(fx.sent.length, 1);
  assert.equal(fx.sent[0]!.card.text, fx.final.text);
  assert.equal(fx.sent[0]!.card.buttons, undefined);
  assert.deepEqual(fx.updated, []);
});

test('creation failure is logged and never retried even when newer progress arrives', async t => {
  const fx = fixture(t);
  fx.hooks.send = async () => { throw new Error('send response lost'); };
  await fx.explain();
  fx.progress.update('失败后的进度');
  await fx.advance(60_000);
  await fx.progress.finish(true, fx.fallback);
  assert.equal(fx.sent.length, 1);
  assert.deepEqual(fx.updated, []);
  assert.deepEqual(fx.recalled, []);
  assert.ok(fx.logs.some(message => message.includes('未自动重试')));
});

test('canShow is checked on the first explanation and again before a throttled update is submitted', async t => {
  const fx = fixture(t);
  fx.setAllowed(false);
  await fx.explain('现在开始分析代码');
  assert.equal(fx.sent.length, 0);
  fx.setAllowed(true);
  fx.progress.update('现在开始分析代码');
  await flush();
  assert.equal(fx.sent.length, 1, 'an unchanged progress value can recheck visibility after enabling');
  fx.progress.update('这个更新将被撤权拦截');
  fx.setAllowed(false);
  await fx.advance(4_000);
  assert.equal(fx.updated.length, 0);
  await fx.progress.finish(false, fx.fallback);
  assert.equal(fx.updated.length, 1, 'terminal cleanup is allowed after revocation');
  assert.equal(fx.updated[0]!.card.buttons, undefined);
});

test('completion after authorization revocation can remove old buttons and never touches another message', async t => {
  const fx = fixture(t);
  await fx.explain();
  const finalId = await fx.transport.sendCard('oc_progress', { title: 'Codex', text: '唯一的最终答案' });
  fx.setAllowed(false);
  await fx.progress.finish(true, fx.fallback);
  assert.equal(fx.updated.length, 1);
  assert.equal(fx.updated[0]!.id, 'message-1');
  assert.equal(fx.updated[0]!.card.buttons, undefined);
  assert.equal(fx.sent.filter(entry => entry.card.text === '唯一的最终答案').length, 1);
  assert.equal(fx.updated.some(entry => entry.id === finalId), false);
});

test('cleanup errors are only logged and cannot generate an extra message', async t => {
  const fx = fixture(t);
  fx.hooks.update = async () => { throw new Error('update failed'); };
  await fx.explain();
  await assert.doesNotReject(fx.progress.finish(true, fx.fallback));
  assert.equal(fx.sent.length, 1);
  assert.equal(fx.logs.length, 1);
});

test('freeze discards an existing card update whose throttle timer has not expired', async t => {
  const fx = fixture(t);
  await fx.explain();
  fx.progress.update('这次更新尚未发出');
  await fx.advance(3_999);
  fx.progress.freeze();
  await fx.advance(60_000);
  assert.deepEqual(fx.updated, []);
  await fx.progress.finish(true, fx.fallback);
  assert.equal(fx.updated.length, 1);
  assert.equal(fx.updated[0]!.card.buttons, undefined);
});

test('newer progress waits for a slow update and uses the latest value after that update finishes', async t => {
  const fx = fixture(t);
  await fx.explain();
  const updating = deferred<void>();
  fx.hooks.update = () => updating.promise;
  fx.progress.update('较早进度');
  await fx.advance(4_000);
  fx.progress.update('过渡进度');
  fx.progress.update('最新进度');
  await fx.advance(6_000);
  assert.equal(fx.updated.length, 1, 'in-flight writes are serialized even after throttle time elapses');
  fx.hooks.update = undefined;
  updating.resolve();
  await flush();
  assert.equal(fx.updated.length, 2);
  assert.equal(fx.updated[1]!.card.text, '最新进度');
  await fx.progress.finish(true, fx.fallback);
});

test('empty updates cannot replace an already displayed explanation', async t => {
  const fx = fixture(t);
  await fx.explain('正在核对测试结果');
  fx.progress.update(' \t\n ');
  await fx.advance(4_000);
  assert.equal(fx.sent.length, 1);
  assert.equal(fx.sent[0]!.card.text, '正在核对测试结果');
  assert.deepEqual(fx.updated, []);
});

test('a failed final update rejects without sending a second card and fallback retains the complete answer', async t => {
  const fx = fixture(t);
  await fx.explain();
  fx.hooks.update = async () => { throw new Error('final update response lost'); };
  const delivery = fx.progress.deliver(fx.final);
  assert.equal(delivery, fx.progress.deliver({ title: '再次提交', text: '不可重发' }));
  await assert.rejects(delivery, /final update response lost/);
  assert.equal(fx.sent.length, 1);
  assert.equal(fx.updated.length, 1);
  fx.hooks.update = undefined;
  const fallback = { title: '送达未确认', text: '请检查这张卡片中的结果。', buttons: fx.card.buttons };
  await fx.progress.finish(false, fallback);
  await fx.progress.finish(false, fallback);
  assert.equal(fx.sent.length, 1);
  assert.equal(fx.updated.length, 2);
  assert.equal(fx.updated[1]!.id, 'message-1');
  assert.equal(fx.updated[1]!.card.text, `${fx.final.text}\n\n送达未确认：请检查这张卡片中的结果。`);
  assert.equal(fx.updated[1]!.card.buttons, undefined);
});

test('a failed final send is uncertain and is never retried by deliver or finish', async t => {
  const fx = fixture(t);
  fx.hooks.send = async () => { throw new Error('final send response lost'); };
  const first = fx.progress.deliver(fx.final);
  await assert.rejects(first, /final send response lost/);
  assert.equal(first, fx.progress.deliver(fx.final));
  await fx.progress.finish(false, fx.fallback);
  assert.equal(fx.sent.length, 1);
  assert.equal(fx.sent[0]!.card.text, fx.final.text);
  assert.deepEqual(fx.updated, []);
});

test('a slow final send owns the card and finish waits without posting a placeholder or fallback', async t => {
  const fx = fixture(t);
  const sending = deferred<string>();
  fx.hooks.send = () => sending.promise;
  const delivery = fx.progress.deliver(fx.final);
  await flush();
  const finishing = fx.progress.finish(false, fx.fallback);
  fx.progress.update('不应覆盖最终答案');
  await fx.advance(60_000);
  assert.equal(fx.sent.length, 1);
  assert.equal(fx.sent[0]!.card.text, fx.final.text);
  sending.resolve('only-final-id');
  assert.equal(await delivery, 'only-final-id');
  await finishing;
  assert.deepEqual(fx.updated, []);
});

test('finish without deliver waits for slow progress creation before removing its buttons', async t => {
  const fx = fixture(t);
  const creation = deferred<string>();
  fx.hooks.send = () => creation.promise;
  await fx.explain();
  const finishing = fx.progress.finish(false, fx.fallback);
  await flush();
  assert.deepEqual(fx.updated, []);
  creation.resolve('slow-card');
  await finishing;
  assert.equal(fx.updated.length, 1);
  assert.equal(fx.updated[0]!.id, 'slow-card');
  assert.equal(fx.updated[0]!.card.text, fx.fallback.text);
  assert.equal(fx.updated[0]!.card.buttons, undefined);
});

test('uncertain final cleanup failure logs the problem without discarding the answer or resending', async t => {
  const fx = fixture(t);
  await fx.explain();
  fx.hooks.update = async () => { throw new Error('all updates fail'); };
  await assert.rejects(fx.progress.deliver(fx.final), /all updates fail/);
  await assert.doesNotReject(fx.progress.finish(false, { title: '送达未确认', text: '状态'.repeat(500) }));
  assert.equal(fx.sent.length, 1);
  assert.equal(fx.updated.length, 2);
  assert.ok(fx.updated.every(update => update.card.text.startsWith(fx.final.text)));
  assert.ok(fx.updated[1]!.card.text.length <= fx.final.text.length + 202);
  assert.equal(fx.updated[1]!.card.buttons, undefined);
  assert.equal(fx.logs.length, 1);
});
