import assert from 'node:assert/strict';
import test from 'node:test';
import { GroupConsultations } from '../src/group-consult.js';

const request = (token: string, question = '请分析') => ({ context_token: token, target: '产品', question });
test('consultation capabilities cache results without duplicate model work and limit sequential calls', async () => {
  const registry = new GroupConsultations();
  let calls = 0, valid = true;
  const scope = registry.issue({ botId: 'dev', valid: () => valid, prepare: () => ({ botId: 'pm', target: '产品', valid: () => valid,
    run: async () => { calls++; return { text: '建议' }; } }) });
  const input = request(scope.token);
  assert.deepEqual(await registry.execute(input), { target: '产品', answer: '建议', truncated: false });
  await registry.execute(input);
  assert.equal(calls, 1);
  await registry.execute(request(scope.token, '二')); await registry.execute(request(scope.token, '三'));
  await assert.rejects(registry.execute(request(scope.token, '四')), /最多咨询三次/);
  valid = false;
  await assert.rejects(registry.execute(input), /没有可用的群聊咨询上下文/);
  scope.dispose(); await registry.close();
});

test('follow-up consultations receive only successful answers from the same source turn', async () => {
  const registry = new GroupConsultations();
  const seen: Array<readonly { botId: string; question: string; answer: string }[]> = [];
  const issue = () => registry.issue({ botId: 'dev', valid: () => true,
    prepare: (_request, previous) => {
      seen.push(previous);
      return { botId: 'pm', target: '产品经理', valid: () => true,
        run: async () => ({ text: '1 + 1 = 2' }) };
    } });
  const firstTurn = issue();
  await registry.execute(request(firstTurn.token, '1 + 1？'));
  await registry.execute(request(firstTurn.token, '1 + 1？'));
  await registry.execute(request(firstTurn.token, '把刚才结果乘 2'));
  assert.deepEqual(seen[0], []);
  assert.deepEqual(seen[1], [{ botId: 'pm', question: '1 + 1？', answer: '1 + 1 = 2' }]);
  firstTurn.dispose();
  const nextTurn = issue();
  await registry.execute(request(nextTurn.token, '新的任务'));
  assert.deepEqual(seen[2], [], 'a new source turn must not inherit consultation history');
  await registry.close();
});

test('timeout stops the target and a duplicate timed-out call is not restarted', async () => {
  const registry = new GroupConsultations(20);
  let calls = 0, stopped = false;
  const scope = registry.issue({ botId: 'dev', valid: () => true, prepare: () => ({ botId: 'pm', target: '产品', valid: () => true,
    run: signal => new Promise((_, reject) => { calls++; signal.addEventListener('abort', () => { stopped = true; reject(signal.reason); }); }) }) });
  const input = request(scope.token);
  await assert.rejects(registry.execute(input), /咨询等待超时/);
  assert.ok(stopped);
  await assert.rejects(registry.execute(input), /咨询等待超时/);
  assert.equal(calls, 1); assert.equal(registry.hasActiveWork(), false);
  await registry.close();
});

test('in-flight duplicates share a result while different simultaneous calls are rejected', async () => {
  const registry = new GroupConsultations();
  let finish!: (result: { text: string }) => void;
  const scope = registry.issue({ botId: 'dev', valid: () => true, prepare: () => ({ botId: 'pm', target: '产品', valid: () => true,
    run: () => new Promise(resolve => { finish = resolve; }) }) });
  const first = registry.execute(request(scope.token)); const duplicate = registry.execute(request(scope.token));
  await assert.rejects(registry.execute(request(scope.token, '另一个问题')), /已有咨询/);
  assert.equal(registry.hasBotWork('pm'), true);
  finish({ text: '答复' });
  assert.deepEqual(await duplicate, await first);
  assert.equal(registry.hasBotWork('pm'), false);
  scope.dispose(); await registry.close();
});

for (const change of ['caller', 'revoke', 'dispose', 'close'] as const) {
  test(`${change} cancels only its consultation and never releases a late answer`, async () => {
    const registry = new GroupConsultations();
    const caller = new AbortController();
    let valid = true, stopped = false;
    const scope = registry.issue({ botId: 'dev', valid: () => valid, prepare: () => ({ botId: 'pm', target: '产品', valid: () => valid,
      run: signal => new Promise((_, reject) => { signal.addEventListener('abort', () => { stopped = true; reject(signal.reason); }); }) }) });
    const task = registry.execute(request(scope.token), caller.signal);
    await new Promise(resolve => setImmediate(resolve));
    const rejected = assert.rejects(task, /取消|停止|变化|关闭/);
    if (change === 'caller') caller.abort();
    if (change === 'revoke') { valid = false; registry.cancelInvalid(); }
    if (change === 'dispose') scope.dispose();
    if (change === 'close') await registry.close();
    await rejected; assert.ok(stopped);
    await registry.close();
  });
}

test('consultation rejects unknown capabilities and extra routing fields, and bounds returned material', async () => {
  const registry = new GroupConsultations();
  registry.setPort(12345);
  const scope = registry.issue({ botId: 'dev', valid: () => true, prepare: () => ({ botId: 'pm', target: '产品', valid: () => true,
    run: async () => ({ text: '答'.repeat(31_000) }) }) });
  assert.match(scope.token, /^fc1\.12345\./);
  await assert.rejects(registry.execute(request(`fc1.12345.${'0'.repeat(64)}`)), /没有可用/);
  await assert.rejects(registry.execute({ ...request(scope.token), chatId: 'oc_other' }), /参数无效/);
  const result = await registry.execute(request(scope.token));
  assert.equal(result.truncated, true); assert.equal(result.answer.length, 30_000);
  scope.dispose(); await registry.close();
});

test('a cached success cannot bypass changed target authorization', async () => {
  const registry = new GroupConsultations(); let allowed = true, calls = 0;
  const scope = registry.issue({ botId: 'dev', valid: () => true, prepare: () => ({ botId: 'pm', target: '产品', valid: () => allowed,
    run: async () => { calls++; return { text: '答复' }; } }) });
  const input = request(scope.token);
  await registry.execute(input); allowed = false;
  await assert.rejects(registry.execute(input), /授权或上下文已变化/);
  assert.equal(calls, 1); await registry.close();
});

test('multiple messages steering the same native turn share the consultation budget', async () => {
  const registry = new GroupConsultations();
  const issue = () => registry.issue({ botId: 'dev', valid: () => true, turnKey: () => 'chat:thread:turn',
    prepare: () => ({ botId: 'pm', target: '产品', valid: () => true, run: async () => ({ text: '答复' }) }) });
  const a = issue(), b = issue();
  await registry.execute(request(a.token)); await registry.execute(request(a.token, '二'));
  await registry.execute(request(b.token, '三'));
  await assert.rejects(registry.execute(request(b.token, '四')), /最多咨询三次/);
  await registry.close();
});

test('slow public delivery preserves the obtained answer and cancels publication without retrying', async () => {
  const registry = new GroupConsultations(1000, 20);
  let calls = 0, publicationCancelled = false;
  const scope = registry.issue({ botId: 'dev', valid: () => true, prepare: () => ({ botId: 'pm', target: '产品', valid: () => true,
    run: (signal, answerReady) => new Promise((_, reject) => {
      calls++; answerReady('实际计算结果：4');
      signal.addEventListener('abort', () => { publicationCancelled = true; reject(signal.reason); });
    }) }) });
  const input = request(scope.token);
  const expected = { target: '产品', answer: '实际计算结果：4', truncated: false, groupReply: 'uncertain' };
  assert.deepEqual(await registry.execute(input), expected);
  assert.ok(publicationCancelled); assert.deepEqual(await registry.execute(input), expected);
  assert.equal(calls, 1); await registry.close();
});

for (const change of ['caller', 'revoke', 'dispose'] as const) {
  test(`${change} during public delivery still suppresses an obtained answer`, async () => {
    const registry = new GroupConsultations(1000, 1000);
    const caller = new AbortController(); let valid = true;
    const scope = registry.issue({ botId: 'dev', valid: () => valid, prepare: () => ({ botId: 'pm', target: '产品', valid: () => valid,
      run: (signal, answerReady) => new Promise((_, reject) => {
        answerReady('不应返回的答案');
        signal.addEventListener('abort', () => reject(signal.reason));
      }) }) });
    const task = registry.execute(request(scope.token), caller.signal);
    await new Promise(resolve => setImmediate(resolve));
    const rejected = assert.rejects(task, /取消|停止|变化/);
    if (change === 'caller') caller.abort();
    if (change === 'revoke') { valid = false; registry.cancelInvalid(); }
    if (change === 'dispose') scope.dispose();
    await rejected; await registry.close();
  });
}
