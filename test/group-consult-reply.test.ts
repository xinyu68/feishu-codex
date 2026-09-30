import assert from 'node:assert/strict';
import test from 'node:test';
import { GroupConsultReply, cleanConsultationText } from '../src/group-consult-reply.js';
import type { MessageCard } from '../src/types.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

async function flush(): Promise<void> {
  for (let i = 0; i < 12; i++) await Promise.resolve();
}

function fixture(t: test.TestContext) {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1_800_000_000_000 });
  const sent: { id: string; chatId: string; card: MessageCard }[] = [];
  const updated: { id: string; card: MessageCard }[] = [];
  const remembered: { id: string; text: string }[] = [];
  const logs: string[] = [];
  const controller = new AbortController();
  const sendOptions: { signal?: AbortSignal; canSend?: () => boolean }[] = [];
  const updateOptions: { signal?: AbortSignal; canSend?: () => boolean }[] = [];
  const hooks: { send?: () => Promise<string>; update?: () => Promise<void>; log?: () => void } = {};
  const state = { publish: true, notify: true, progress: true };
  const reply = new GroupConsultReply({
    chatId: 'target-bot:original-group', name: '测试人员', signal: controller.signal,
    canPublish: () => state.publish, canNotify: () => state.notify, showProgress: () => state.progress,
    remember: (id, text) => { remembered.push({ id, text }); }, log: text => { logs.push(text); hooks.log?.(); },
    transport: {
      async sendCard(chatId, card, options) {
        sendOptions.push(options ?? {});
        const id = `message-${sent.length + 1}`;
        sent.push({ id, chatId, card: structuredClone(card) });
        return hooks.send ? hooks.send() : id;
      },
      async updateCard(id, card, options) {
        updateOptions.push(options ?? {});
        updated.push({ id, card: structuredClone(card) });
        await hooks.update?.();
      },
    },
  });
  const advance = async (ms: number) => { t.mock.timers.tick(ms); await flush(); };
  t.after(async () => { state.publish = false; state.notify = false; await reply.fail(true); });
  return { reply, state, sent, updated, remembered, logs, hooks, advance, controller, sendOptions, updateOptions };
}

test('consultation creates no placeholder and coalesces only supplied real progress', async t => {
  const fx = fixture(t);
  fx.reply.update(' \n\t ');
  await fx.advance(60_000);
  assert.deepEqual(fx.sent, []);
  fx.reply.update('先检查边界');
  fx.reply.update('已经定位到问题');
  await flush();
  assert.equal(fx.sent.length, 1);
  assert.equal(fx.sent[0]!.chatId, 'target-bot:original-group');
  assert.deepEqual(fx.sent[0]!.card, { title: '测试人员 · 正在答复', text: '已经定位到问题' });
  fx.reply.update('较早的进度');
  await fx.advance(3999);
  fx.reply.update('最新的进度');
  assert.deepEqual(fx.updated, []);
  await fx.advance(1);
  assert.deepEqual(fx.updated, [{ id: 'message-1', card: { title: '测试人员 · 正在答复', text: '最新的进度' } }]);
  assert.deepEqual(fx.remembered, [], 'progress is not persisted as the final public answer');
});

test('consultation final waits for progress creation and replaces that same card exactly once', async t => {
  const fx = fixture(t);
  const creation = deferred<string>();
  fx.hooks.send = () => creation.promise;
  fx.reply.update('我正在检查');
  await flush();
  fx.reply.update('不要覆盖最终答复');
  const delivery = fx.reply.deliver(['完整答复']);
  assert.equal(delivery, fx.reply.deliver(['重复答复']));
  await flush();
  assert.deepEqual(fx.updated, []);
  creation.resolve('target-progress-id');
  assert.equal(await delivery, 'sent');
  fx.reply.update('完成后的回调');
  await fx.advance(60_000);
  await fx.reply.fail(false);
  assert.equal(fx.sent.length, 1);
  assert.deepEqual(fx.updated, [{ id: 'target-progress-id', card: { title: '测试人员 · 咨询答复', text: '完整答复', tone: 'green' } }]);
  assert.deepEqual(fx.remembered, [{ id: 'target-progress-id', text: '完整答复' }]);
});

test('consultation without commentary or with progress disabled creates only the final answer', async t => {
  for (const progress of [true, false]) await t.test(String(progress), async st => {
    const fx = fixture(st);
    fx.state.progress = progress;
    if (!progress) fx.reply.update('这条实际进度已被用户关闭');
    await fx.advance(60_000);
    assert.deepEqual(fx.sent, []);
    assert.equal(await fx.reply.deliver(['最终答案']), 'sent');
    assert.equal(fx.sent.length, 1);
    assert.equal(fx.sent[0]!.card.text, '最终答案');
    assert.deepEqual(fx.updated, []);
    assert.deepEqual(fx.remembered, [{ id: 'message-1', text: '最终答案' }]);
  });
});

test('uncertain progress creation never blindly creates another progress, answer or failure card', async t => {
  const fx = fixture(t);
  fx.hooks.send = async () => { throw new Error('send may have succeeded'); };
  fx.reply.update('正在分析');
  await flush();
  fx.reply.update('新进度');
  await fx.advance(60_000);
  assert.equal(await fx.reply.deliver(['保留在咨询结果中的答案']), 'uncertain');
  await fx.reply.fail(false);
  assert.equal(fx.sent.length, 1);
  assert.deepEqual(fx.updated, []);
  assert.deepEqual(fx.remembered, []);
});

test('uncertain final update does not replace or retry the real answer during failure cleanup', async t => {
  const fx = fixture(t);
  fx.reply.update('正在分析');
  await flush();
  fx.hooks.update = async () => { throw new Error('update may have succeeded'); };
  const answer = ['已经取得的真实答案'];
  const delivery = fx.reply.deliver(answer);
  assert.equal(await delivery, 'uncertain');
  assert.equal(fx.reply.deliver(['不可重复发送']), delivery);
  await fx.reply.fail(false);
  await fx.reply.fail(true);
  assert.deepEqual(answer, ['已经取得的真实答案']);
  assert.equal(fx.sent.length, 1);
  assert.equal(fx.updated.length, 1);
  assert.equal(fx.updated[0]!.card.text, answer[0]);
  assert.deepEqual(fx.remembered, []);
});

test('failure and cancellation freeze queued and late progress without accepting a late final', async t => {
  for (const cancelled of [false, true]) await t.test(String(cancelled), async st => {
    const fx = fixture(st);
    fx.reply.update('已公开的进度');
    await flush();
    fx.reply.update('还在节流队列里的进度');
    const failure = fx.reply.fail(cancelled);
    assert.equal(fx.reply.fail(cancelled), failure);
    fx.reply.update('失效回调');
    await failure;
    assert.equal(await fx.reply.deliver(['不应公开的迟到答复']), 'uncertain');
    await fx.advance(60_000);
    assert.equal(fx.sent.length, 1);
    assert.equal(fx.updated.length, 1);
    assert.equal(fx.updated[0]!.card.title, `测试人员 · ${cancelled ? '咨询已停止' : '咨询未完成'}`);
    assert.equal(fx.updated[0]!.card.tone, 'orange');
    assert.deepEqual(fx.remembered, []);
  });
});

test('revocation while progress creation is pending prevents final publication and failure notices', async t => {
  const fx = fixture(t);
  const creation = deferred<string>();
  fx.hooks.send = () => creation.promise;
  fx.reply.update('撤权前的进度');
  await flush();
  const delivery = fx.reply.deliver(['不能在撤权后公开的答复']);
  fx.state.publish = false;
  fx.state.notify = false;
  creation.resolve('existing-card');
  assert.equal(await delivery, 'uncertain');
  await fx.reply.fail(true);
  fx.reply.update('迟到进度');
  await fx.advance(60_000);
  assert.equal(fx.sent.length, 1);
  assert.deepEqual(fx.updated, []);
  assert.deepEqual(fx.remembered, []);
});

test('revoked consultation guards suppress even a first answer or status card', async t => {
  const fx = fixture(t);
  fx.state.publish = false;
  fx.state.notify = false;
  fx.reply.update('不可公开');
  await flush();
  assert.equal(await fx.reply.deliver(['不可公开的答复']), 'uncertain');
  await fx.reply.fail(true);
  assert.deepEqual(fx.sent, []);
  assert.deepEqual(fx.updated, []);
});

test('bounded answer chunks are sent in order and every acknowledged chunk enters public context', async t => {
  const fx = fixture(t);
  fx.reply.update('进度'.repeat(2000));
  await flush();
  assert.equal(fx.sent[0]!.card.text.length, 2500);
  const chunks = ['甲'.repeat(4500), '乙'.repeat(4500), '丙'.repeat(3000)];
  assert.equal(await fx.reply.deliver(chunks), 'sent');
  assert.equal(fx.updated.length, 1);
  assert.equal(fx.sent.length, 3);
  assert.deepEqual(fx.remembered, chunks.map((text, index) => ({ id: `message-${index + 1}`, text })));
  assert.ok([fx.updated[0]!.card, ...fx.sent.slice(1).map(entry => entry.card)].every(card => card.text.length <= 4500));
  assert.ok(fx.sent.slice(1).every(entry => entry.card.title === '测试人员 · 咨询答复（续）'));
});

test('a continuation acknowledgement loss stops later chunks and tracks only confirmed public content', async t => {
  const fx = fixture(t);
  fx.hooks.send = async () => fx.sent.length === 1 ? 'acknowledged-answer' : '';
  assert.equal(await fx.reply.deliver(['第一段', '第二段送达未确认', '不应继续发送第三段']), 'uncertain');
  await fx.reply.fail(false);
  assert.equal(fx.sent.length, 2);
  assert.deepEqual(fx.remembered, [{ id: 'acknowledged-answer', text: '第一段' }]);
  assert.deepEqual(fx.updated, []);
});

test('revocation between acknowledged chunks prevents any subsequent answer content', async t => {
  const fx = fixture(t);
  const sending = deferred<string>();
  fx.hooks.send = () => sending.promise;
  const delivery = fx.reply.deliver(['授权时发出的第一段', '不应发出的第二段']);
  await flush();
  fx.state.publish = false;
  sending.resolve('first-ack');
  assert.equal(await delivery, 'uncertain');
  assert.equal(fx.sent.length, 1);
  assert.deepEqual(fx.remembered, [{ id: 'first-ack', text: '授权时发出的第一段' }]);
});

test('consultation tickets are removed from progress and final answers before publication or persistence', async t => {
  const fx = fixture(t);
  const ticket = `fc1.8790.${'a'.repeat(64)}`;
  assert.equal(cleanConsultationText(`  ${ticket}  `), '[咨询凭据已省略]');
  fx.reply.update(`真实进度 ${ticket}`);
  await flush();
  assert.equal(await fx.reply.deliver([`答复 ${ticket}`]), 'sent');
  const publicState = JSON.stringify({ sent: fx.sent, updated: fx.updated, remembered: fx.remembered });
  assert.ok(!publicState.includes(ticket));
  assert.match(publicState, /咨询凭据已省略/);
});

test('public writes carry the consultation signal and recheck authorization before transport retries', async t => {
  const fx = fixture(t);
  fx.reply.update('真实进度');
  await flush();
  assert.equal(await fx.reply.deliver(['第一段', '第二段']), 'sent');
  assert.equal(fx.sendOptions.length, 2);
  assert.equal(fx.updateOptions.length, 1);
  const options = [...fx.sendOptions, ...fx.updateOptions];
  assert.ok(options.every(option => option.signal === fx.controller.signal && option.canSend?.() === true));
  fx.state.publish = false;
  assert.ok(options.every(option => option.canSend?.() === false));
  fx.state.publish = true;
  fx.controller.abort();
  assert.ok(options.every(option => option.signal?.aborted && option.canSend?.() === false));
});

test('cancellation notices have their own bounded signal and notification guard', async t => {
  for (const progress of [false, true]) await t.test(String(progress), async st => {
    const fx = fixture(st);
    if (progress) { fx.reply.update('已公开进度'); await flush(); }
    fx.controller.abort();
    await fx.reply.fail(true);
    const options = progress ? fx.updateOptions.at(-1)! : fx.sendOptions.at(-1)!;
    assert.ok(options.signal instanceof AbortSignal);
    assert.notEqual(options.signal, fx.controller.signal);
    assert.equal(options.signal.aborted, false);
    assert.equal(options.canSend?.(), true);
    fx.state.notify = false;
    assert.equal(options.canSend?.(), false);
    assert.equal((progress ? fx.updated.at(-1) : fx.sent.at(-1))!.card.title, '测试人员 · 咨询已停止');
  });
});

test('an abort while awaiting the last answer acknowledgement cannot report sent', async t => {
  const fx = fixture(t);
  const sending = deferred<string>();
  fx.hooks.send = () => sending.promise;
  const delivery = fx.reply.deliver(['实际答复']);
  await flush();
  fx.controller.abort();
  sending.resolve('ack-after-abort');
  assert.equal(await delivery, 'uncertain');
  await fx.reply.fail(true);
  assert.equal(fx.sent.length, 1);
  assert.deepEqual(fx.updated, []);
  assert.deepEqual(fx.remembered, [{ id: 'ack-after-abort', text: '实际答复' }]);
});

test('logging failures cannot reject progress, final publication or cancellation cleanup', async t => {
  for (const phase of ['progress', 'final', 'failure']) await t.test(phase, async st => {
    const fx = fixture(st);
    fx.hooks.send = async () => { throw new Error('transport failed'); };
    fx.hooks.log = () => { throw new Error('logging failed'); };
    if (phase === 'progress') { fx.reply.update('实际进度'); await flush(); }
    if (phase !== 'failure') assert.equal(await fx.reply.deliver(['实际答复']), 'uncertain');
    await assert.doesNotReject(fx.reply.fail(true));
    assert.equal(fx.sent.length, 1);
    assert.deepEqual(fx.updated, []);
    assert.ok(fx.logs.length > 0);
  });
});
