import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import http from 'node:http';

test('bundled MCP advertises completion and explicit artifact tools', async t => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const directory = await mkdtemp(path.join(os.tmpdir(), 'notify-mcp-'));
  const artifact = path.join(directory, 'result.txt');
  await writeFile(artifact, 'done');
  t.after(() => rm(directory, { recursive: true, force: true }));
  const child = spawn(process.execPath, ['--import', 'tsx', path.join(root, 'src', 'notify-mcp.ts')], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  t.after(() => child.kill());
  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
  const replies: any[] = [];
  lines.on('line', line => replies.push(JSON.parse(line)));
  const send = (value: unknown) => child.stdin.write(`${JSON.stringify(value)}\n`);
  send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26' } });
  send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
  send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'request_feishu_completion_notification', arguments: { summary: '开发通知功能' } } });
  send({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'send_artifact_to_feishu', arguments: { paths: [artifact] } } });
  send({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'send_artifact_to_feishu', arguments: { paths: [directory] } } });
  for (let count = 0; count < 100 && replies.length < 5; count++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(replies[0]?.result.serverInfo.name, 'feishu-codex-notify');
  assert.equal(replies[1]?.result.tools[0].name, 'request_feishu_completion_notification');
  assert.equal(replies[1]?.result.tools[1].name, 'send_artifact_to_feishu');
  assert.match(replies[1]?.result.tools[0].description, /不同表达/);
  assert.match(replies[2]?.result.content[0].text, /已登记/);
  assert.equal(replies[2]?.result.isError, false);
  const artifactReply = replies.find(reply => reply.id === 4);
  assert.deepEqual(artifactReply?.result.structuredContent.paths, [await import('node:fs/promises').then(module => module.realpath(artifact))]);
  assert.match(artifactReply?.result.content[0].text, /已提交 1 个/);
  assert.match(replies.find(reply => reply.id === 5)?.error.message ?? '', /not a regular file/);
});

test('group handoff MCP validates a stateless scoped request and never claims the handoff executed', async t => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const child = spawn(process.execPath, ['--import', 'tsx', path.join(root, 'src', 'notify-mcp.ts')], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  t.after(() => child.kill());
  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
  const replies: any[] = [];
  lines.on('line', line => replies.push(JSON.parse(line)));
  const send = (value: unknown) => child.stdin.write(`${JSON.stringify(value)}\n`);
  send({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
  const inputs = [
    { target: ' 开发人员 ', task: ' 检查登录失败原因？\n只分析，不要改代码。 ' },
    { target: '甲'.repeat(100), task: '文'.repeat(6000) },
    { target: '甲'.repeat(101), task: '检查' }, { target: 'developer', task: '文'.repeat(6001) },
    { target: ' ', task: '检查' }, { target: 'developer', task: '\n' },
    { target: 'developer' }, { target: 'developer', task: 5 }, null, ['developer', '检查'],
    ...['chatId', 'threadId', 'turnId', 'actorId', 'botId', 'groupId'].map(field => ({ target: 'developer', task: '检查', [field]: 'untrusted' })),
  ];
  inputs.forEach((args, index) => send({ jsonrpc: '2.0', id: index + 2, method: 'tools/call', params: { name: 'request_feishu_group_handoff', arguments: args } }));
  for (let count = 0; count < 200 && replies.length < inputs.length + 1; count++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(replies.length, inputs.length + 1);
  const tool = replies.find(reply => reply.id === 1)?.result.tools.find((entry: any) => entry.name === 'request_feishu_group_handoff');
  assert.ok(tool);
  assert.deepEqual(tool.inputSchema.required, ['target', 'task']);
  assert.equal(tool.inputSchema.additionalProperties, false);
  assert.equal(tool.inputSchema.properties.target.minLength, 1);
  assert.equal(tool.inputSchema.properties.target.maxLength, 100);
  assert.equal(tool.inputSchema.properties.task.minLength, 1);
  assert.equal(tool.inputSchema.properties.task.maxLength, 6000);
  assert.deepEqual(Object.keys(tool.inputSchema.properties), ['target', 'task']);
  const valid = replies.find(reply => reply.id === 2)?.result;
  assert.equal(valid?.isError, false);
  assert.deepEqual(valid?.structuredContent, { target: '开发人员', task: '检查登录失败原因？\n只分析，不要改代码。' });
  assert.match(valid.content[0].text, /申请已提交.*尚未执行交接/);
  assert.match(valid.content[0].text, /群聊轮次结束且回复确认送达/);
  assert.match(valid.content[0].text, /校验授权、目标角色和交接限制/);
  assert.doesNotMatch(valid.content[0].text, /已交接|已派发|交接成功/);
  assert.equal(replies.find(reply => reply.id === 3)?.result.isError, false);
  for (let id = 4; id < inputs.length + 2; id++) {
    const reply = replies.find(reply => reply.id === id);
    assert.equal(reply?.error?.code, -32602, `request ${id}`);
    assert.equal(reply?.result, undefined, `request ${id}`);
  }
});

test('Hermes MCP exposes the handoff and synchronous consultation capabilities connected to its bridge', async t => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const child = spawn(process.execPath, ['--import', 'tsx', path.join(root, 'src', 'notify-mcp.ts')], {
    env: { ...process.env, FEISHU_CODEX_MCP_MODE: 'hermes' }, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
  });
  t.after(() => child.kill());
  const replies: any[] = [];
  createInterface({ input: child.stdout, crlfDelay: Infinity }).on('line', line => replies.push(JSON.parse(line)));
  child.stdin.write(JSON.stringify({ id: 1, method: 'tools/list' }) + '\n');
  child.stdin.write(JSON.stringify({ id: 2, method: 'tools/call', params: { name: 'request_feishu_completion_notification', arguments: { summary: 'test' } } }) + '\n');
  for (let count = 0; count < 200 && replies.length < 2; count++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.deepEqual(replies.find(reply => reply.id === 1)?.result.tools.map((tool: any) => tool.name), ['request_feishu_group_handoff', 'consult_feishu_group_agent', 'send_message_to_feishu']);
  assert.equal(replies.find(reply => reply.id === 2)?.error.code, -32602);
});

test('both runtimes synchronously receive a target answer and cancellations close the pending HTTP request', async t => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  for (const mode of ['codex', 'hermes']) {
    const calls: { body: any; response: http.ServerResponse; closed: boolean }[] = [];
    const server = http.createServer(async (request, response) => {
      assert.equal(request.url, '/api/group/consult');
      assert.equal(request.method, 'POST');
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const call = { body: JSON.parse(Buffer.concat(chunks).toString('utf8')), response, closed: false };
      response.on('close', () => { call.closed = true; });
      calls.push(call);
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(() => { server.closeAllConnections(); server.close(); });
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    const context_token = `fc1.${address.port}.${'b'.repeat(64)}`;
    const child = spawn(process.execPath, ['--import', 'tsx', path.join(root, 'src', 'notify-mcp.ts')], {
      env: { ...process.env, FEISHU_CODEX_MCP_MODE: mode }, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
    });
    t.after(() => child.kill());
    const replies: any[] = [];
    createInterface({ input: child.stdout, crlfDelay: Infinity }).on('line', line => replies.push(JSON.parse(line)));
    const send = (value: unknown) => child.stdin.write(`${JSON.stringify(value)}\n`);
    const waitFor = async (condition: () => boolean) => {
      for (let i = 0; i < 500 && !condition(); i++) await new Promise(resolve => setTimeout(resolve, 10));
      assert.ok(condition(), `timed out in ${mode}`);
    };
    send({ id: 'tools', method: 'tools/list' });
    send({ id: 'consult', method: 'tools/call', params: { name: 'consult_feishu_group_agent', arguments: { context_token, target: '测试人员', question: '验证结果如何？', context: '本轮公开背景' } } });
    await waitFor(() => calls.length === 1 && replies.some(reply => reply.id === 'tools'));
    const tool = replies.find(reply => reply.id === 'tools').result.tools.find((tool: any) => tool.name === 'consult_feishu_group_agent');
    assert.deepEqual(tool.inputSchema.required, ['context_token', 'target', 'question']);
    assert.equal(tool.inputSchema.additionalProperties, false);
    assert.match(tool.description, /公开问题并 @目标/);
    assert.match(tool.description, /目标在原群展示实际进度和答复/);
    assert.match(tool.description, /不要完整复述目标答复/);
    assert.equal(replies.some(reply => reply.id === 'consult'), false, 'no receipt can replace the target answer');
    assert.deepEqual(calls[0]!.body, { context_token, target: '测试人员', question: '验证结果如何？', context: '本轮公开背景' });
    const groupReply = mode === 'codex' ? 'sent' : 'uncertain';
    calls[0]!.response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ target: '测试人员', answer: '测试已通过。', truncated: false, groupReply }));
    await waitFor(() => replies.some(reply => reply.id === 'consult'));
    const result = replies.find(reply => reply.id === 'consult').result;
    assert.equal(result.isError, false);
    assert.deepEqual(result.structuredContent, { target: '测试人员', answer: '测试已通过。', truncated: false, groupReply });
    assert.match(result.content[0].text, /测试已通过/);
    if (groupReply === 'sent') {
      assert.match(result.content[0].text, /目标答复已由目标角色发送到原群/);
      assert.match(result.content[0].text, /不要完整复述/);
      assert.doesNotMatch(result.content[0].text, /送达状态未确认/);
    } else {
      assert.match(result.content[0].text, /群内送达状态未确认/);
      assert.match(result.content[0].text, /不要声称群内已送达/);
      assert.doesNotMatch(result.content[0].text, /目标答复已由目标角色发送到原群/);
    }
    assert.ok(!JSON.stringify(result).includes(context_token));

    send({ id: 'invalid', method: 'tools/call', params: { name: 'consult_feishu_group_agent', arguments: { context_token, target: '测试人员', question: '测试', groupId: 'foreign' } } });
    await waitFor(() => replies.some(reply => reply.id === 'invalid'));
    assert.equal(replies.find(reply => reply.id === 'invalid').error.code, -32602);
    assert.equal(calls.length, 1);
    send({ id: 'failed', method: 'tools/call', params: { name: 'consult_feishu_group_agent', arguments: { context_token, target: '测试人员', question: '继续验证' } } });
    await waitFor(() => calls.length === 2);
    calls[1]!.response.writeHead(403, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: '当前咨询凭据已失效' }));
    await waitFor(() => replies.some(reply => reply.id === 'failed'));
    assert.equal(replies.find(reply => reply.id === 'failed').result.isError, true);
    assert.match(replies.find(reply => reply.id === 'failed').result.content[0].text, /已失效/);

    send({ id: 'cancel', method: 'tools/call', params: { name: 'consult_feishu_group_agent', arguments: { context_token, target: '测试人员', question: '慢请求' } } });
    await waitFor(() => calls.length === 3);
    send({ method: 'notifications/cancelled', params: { requestId: 'cancel', reason: 'user requested' } });
    await waitFor(() => calls[2]!.closed);
    send({ id: 'ping', method: 'ping' });
    await waitFor(() => replies.some(reply => reply.id === 'ping'));
    assert.equal(replies.some(reply => reply.id === 'cancel'), false);
    assert.equal(calls.length, 3, 'errors and cancellations never retry');

    send({ id: 'close', method: 'tools/call', params: { name: 'consult_feishu_group_agent', arguments: { context_token, target: '测试人员', question: '关闭输入' } } });
    await waitFor(() => calls.length === 4);
    child.stdin.end();
    await waitFor(() => calls[3]!.closed);
    assert.equal(replies.some(reply => reply.id === 'close'), false);
  }
});
