import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import { consultFeishuGroupAgent, GroupConsultClientError } from '../src/group-consult-client.js';
import { GROUP_CONSULT_PATH, GROUP_CONSULT_REQUEST_SCHEMA, groupConsultPort, validateGroupConsultRequest } from '../src/group-consult-request.js';

const ticket = (port = 8790) => `fc1.${port}.${'a'.repeat(64)}`;
const request = { context_token: ticket(), target: '开发人员', question: '定位失败原因' };

test('consultation arguments accept only a current ticket and bounded public question/context', () => {
  assert.deepEqual(validateGroupConsultRequest({ ...request, target: ' 开发人员 ', question: ' 检查问题\n提供结论 ', context: ' 已重现 ' }), {
    ...request, question: '检查问题\n提供结论', context: '已重现',
  });
  assert.equal(groupConsultPort(ticket(1)), 1);
  assert.equal(groupConsultPort(ticket(65535)), 65535);
  assert.equal(GROUP_CONSULT_REQUEST_SCHEMA.additionalProperties, false);
  assert.deepEqual(Object.keys(GROUP_CONSULT_REQUEST_SCHEMA.properties), ['context_token', 'target', 'question', 'context']);
  for (const value of [undefined, null, [], Object.create(request),
    ...['chatId', 'groupId', 'threadId', 'turnId', 'botId', 'actorId', 'url', 'port'].map(key => ({ ...request, [key]: 'foreign' })),
    ...['', ' ', ticket(0), ticket(65536), `fc1.08790.${'a'.repeat(64)}`, `fc1.8790.${'a'.repeat(63)}`,
      `fc1.8790.${'A'.repeat(64)}`, `http://localhost:8790/${'a'.repeat(64)}`, `${ticket()}\n`].map(context_token => ({ ...request, context_token })),
    { ...request, target: ' ' }, { ...request, target: '甲'.repeat(101) }, { ...request, question: 7 },
    { ...request, question: '文'.repeat(6001) }, { ...request, context: undefined },
    { ...request, context: '' }, { ...request, context: '文'.repeat(12001) },
  ]) assert.throws(() => validateGroupConsultRequest(value));
  assert.doesNotThrow(() => validateGroupConsultRequest({ ...request, target: '😀'.repeat(100), question: '问'.repeat(6000), context: '文'.repeat(12000) }));
});

test('consultation client selects only the ticket loopback port and returns the real bounded reply', async () => {
  let calls = 0;
  const result = await consultFeishuGroupAgent({ ...request, context_token: ticket(13456), context: '本群公开摘要' }, {
    fetch: (async (url, init) => {
      calls++;
      assert.equal(url, `http://127.0.0.1:13456${GROUP_CONSULT_PATH}`);
      assert.equal(init?.method, 'POST');
      assert.equal(init?.redirect, 'error');
      assert.ok(init?.signal);
      assert.deepEqual(JSON.parse(String(init?.body)), { ...request, context_token: ticket(13456), context: '本群公开摘要' });
      return Response.json({ target: '开发人员', answer: '失败原因是配置缺少路径。', truncated: true, ignored: 'not forwarded' });
    }) as typeof fetch,
  });
  assert.equal(calls, 1);
  assert.deepEqual(result, { target: '开发人员', answer: '失败原因是配置缺少路径。', truncated: true });
});

test('consultation client rejects receipt-only, malformed and oversized replies without retrying or exposing the ticket', async () => {
  const replies = [
    Response.json({ accepted: true }), Response.json({ target: '开发人员', answer: '' }),
    Response.json({ target: '开发人员', answer: 'reply', truncated: 'yes' }),
    Response.json({ target: '开发人员', answer: 'a'.repeat(60_001) }),
    new Response('not json'), new Response('a'.repeat(256 * 1024 + 1)),
    Response.json({ error: `expired: ${request.context_token}` }, { status: 403 }),
  ];
  for (const response of replies) {
    let calls = 0;
    await assert.rejects(consultFeishuGroupAgent(request, { fetch: (async () => { calls++; return response; }) as typeof fetch }), error => {
      assert.ok(error instanceof GroupConsultClientError);
      assert.match(error.message, /不要自动重试/);
      assert.ok(!error.message.includes(request.context_token));
      return true;
    });
    assert.equal(calls, 1);
  }
  let calls = 0;
  await assert.rejects(consultFeishuGroupAgent(request, { fetch: (async () => { calls++; throw new Error(`connect ${request.context_token}`); }) as typeof fetch }), error => {
    assert.ok(error instanceof GroupConsultClientError);
    assert.equal(error.code, 'request');
    assert.ok(!error.message.includes(request.context_token));
    return true;
  });
  assert.equal(calls, 1);
});

test('consultation client times out, aborts a pending body and never follows redirects', async t => {
  let calls = 0;
  let route = 'wait';
  const server = http.createServer((_request, response) => {
    calls++;
    if (route === 'redirect') { response.writeHead(302, { Location: 'https://example.invalid/secret' }).end(); return; }
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.write('{"target":"dev","answer":"');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const input = { ...request, context_token: ticket(address.port) };
  await assert.rejects(consultFeishuGroupAgent(input, { timeoutMs: 100 }), (error: unknown) => error instanceof GroupConsultClientError && error.code === 'timeout');
  assert.equal(calls, 1);
  const controller = new AbortController();
  const pending = consultFeishuGroupAgent(input, { signal: controller.signal });
  for (let i = 0; i < 100 && calls < 2; i++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(calls, 2);
  controller.abort();
  await assert.rejects(pending, (error: unknown) => error instanceof GroupConsultClientError && error.code === 'cancelled');
  const alreadyCancelled = new AbortController();
  alreadyCancelled.abort();
  await assert.rejects(consultFeishuGroupAgent(input, { signal: alreadyCancelled.signal }), (error: unknown) => error instanceof GroupConsultClientError && error.code === 'cancelled');
  assert.equal(calls, 2);
  route = 'redirect';
  await assert.rejects(consultFeishuGroupAgent(input), (error: unknown) => error instanceof GroupConsultClientError && error.code === 'request');
  assert.equal(calls, 3);
});

test('consultation client preserves verified group delivery states and rejects invalid metadata', async () => {
  for (const groupReply of ['sent', 'uncertain'] as const) {
    const reply = { target: '开发人员', answer: '配置缺少路径。', groupReply };
    const result = await consultFeishuGroupAgent(request, { fetch: (async () => Response.json(reply)) as typeof fetch });
    assert.deepEqual(result, reply);
  }
  for (const groupReply of ['', 'pending', 'failed', true, null, 1, ['sent'], { status: 'sent' }]) {
    let calls = 0;
    await assert.rejects(consultFeishuGroupAgent(request, {
      fetch: (async () => { calls++; return Response.json({ target: '开发人员', answer: '配置缺少路径。', groupReply }); }) as typeof fetch,
    }), error => error instanceof GroupConsultClientError && error.code === 'invalid-response');
    assert.equal(calls, 1);
  }
});
