import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import WebSocket, { WebSocketServer } from 'ws';
import { CodexClient } from '../src/codex.js';
import type { RpcMessage, RpcParams } from '../src/codex-websocket.js';

type Turn = { id: string; status: string; items: RpcParams[] };

async function fixture() {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const received: RpcMessage[] = [];
  const failures: string[] = [];
  const fx = {
    received,
    resumeStatus: 'idle',
    readStatus: 'idle',
    turns: [] as Turn[],
    injectionFailure: '',
    client: new CodexClient({ websocketUrl: `ws://127.0.0.1:${address.port}`, requestTimeoutMs: 2_000, idleTimeoutMs: 3_000 }),
    async cleanup() {
      await fx.client.close();
      for (const socket of server.clients) socket.terminate();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      assert.deepEqual(failures, []);
    },
  };
  server.on('connection', socket => socket.on('message', raw => {
    const message = JSON.parse(raw.toString()) as RpcMessage;
    if (!message.method) return;
    received.push(message);
    const threadId = String(message.params?.threadId ?? 'thread');
    const reply = (result: unknown) => socket.send(JSON.stringify({ id: message.id, result }));
    switch (message.method) {
      case 'initialize': reply({ userAgent: 'handoff-policy-fixture/1' }); return;
      case 'initialized': return;
      case 'thread/resume': reply({ thread: { id: threadId, status: { type: fx.resumeStatus } } }); return;
      case 'thread/read': reply({ thread: { id: threadId, status: { type: fx.readStatus }, historyMode: 'paginated' } }); return;
      case 'thread/turns/list': reply({ data: fx.turns, nextCursor: null }); return;
      case 'thread/inject_items':
        if (fx.injectionFailure) socket.send(JSON.stringify({ id: message.id, error: { code: -32600, message: fx.injectionFailure } }));
        else reply({});
        return;
      default:
        failures.push(`Unexpected request: ${message.method}`);
        if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ id: message.id, error: { code: -32601, message: `Unexpected request: ${message.method}` } }));
    }
  }));
  return fx;
}

function mutationMethods(received: RpcMessage[]): string[] {
  return received.map(message => message.method ?? '').filter(method => ['thread/start', 'turn/start', 'turn/steer', 'turn/interrupt'].includes(method));
}

test('handoff policy resumes and confirms idle before appending one developer item without starting a turn', async () => {
  const fx = await fixture();
  try {
    fx.turns = [{ id: 'completed-turn', status: 'completed', items: [] }];
    const instructions = '角色职责保持不变。\n群内交接使用明确的最后一行。';
    await fx.client.updateGroupHandoffPolicy('role-thread', instructions);
    const relevant = fx.received.filter(message => message.method !== 'initialize' && message.method !== 'initialized');
    assert.deepEqual(relevant.map(message => message.method), ['thread/resume', 'thread/read', 'thread/turns/list', 'thread/inject_items']);
    assert.deepEqual(relevant[0]!.params, { threadId: 'role-thread', excludeTurns: true });
    assert.deepEqual(relevant[1]!.params, { threadId: 'role-thread', includeTurns: false });
    assert.deepEqual(relevant[2]!.params, { threadId: 'role-thread', limit: 10, sortDirection: 'desc', itemsView: 'full' });
    assert.deepEqual(relevant[3]!.params, {
      threadId: 'role-thread', items: [{ type: 'message', role: 'developer', content: [{ type: 'input_text', text: instructions }] }],
    });
    assert.deepEqual(mutationMethods(fx.received), []);
  } finally { await fx.cleanup(); }
});

test('handoff policy refuses a thread whose resume reports active without injecting or interrupting it', async () => {
  const fx = await fixture();
  try {
    fx.resumeStatus = 'active';
    await assert.rejects(fx.client.updateGroupHandoffPolicy('busy-role', 'new group instructions'), /当前角色会话正在执行任务/);
    assert.equal(fx.received.some(message => message.method === 'thread/inject_items'), false);
    assert.equal(fx.received.some(message => message.method === 'thread/read'), false);
    assert.deepEqual(mutationMethods(fx.received), []);
  } finally { await fx.cleanup(); }
});

test('handoff policy checks paginated turns even when metadata says idle and refuses a still-running turn', async () => {
  const fx = await fixture();
  try {
    fx.turns = [{ id: 'active-before-metadata-catches-up', status: 'inProgress', items: [] }];
    await assert.rejects(fx.client.updateGroupHandoffPolicy('busy-role', 'new group instructions'), /当前角色会话正在执行任务/);
    assert.equal(fx.received.some(message => message.method === 'thread/turns/list'), true);
    assert.equal(fx.received.some(message => message.method === 'thread/inject_items'), false);
    assert.deepEqual(mutationMethods(fx.received), []);
  } finally { await fx.cleanup(); }
});

test('unknown runtime state fails closed rather than injecting group instructions into an unconfirmed thread', async () => {
  const fx = await fixture();
  try {
    fx.readStatus = 'systemError';
    await assert.rejects(fx.client.updateGroupHandoffPolicy('unconfirmed-role', 'new group instructions'), /无法确认共享任务状态/);
    assert.equal(fx.received.some(message => message.method === 'thread/inject_items'), false);
    assert.deepEqual(mutationMethods(fx.received), []);
  } finally { await fx.cleanup(); }
});

test('an injection RPC failure is propagated without fallback mutation or automatic retry', async () => {
  const fx = await fixture();
  try {
    fx.injectionFailure = 'test-only injection rejected';
    await assert.rejects(fx.client.updateGroupHandoffPolicy('role-thread', 'new group instructions'), /injection rejected/);
    assert.equal(fx.received.filter(message => message.method === 'thread/inject_items').length, 1);
    assert.deepEqual(mutationMethods(fx.received), []);
  } finally { await fx.cleanup(); }
});

test('allowSteering false rejects each supported active-turn state instead of joining the native task', async () => {
  for (const status of ['inProgress', 'in_progress', 'active']) {
    const fx = await fixture();
    try {
      fx.resumeStatus = 'active';
      fx.readStatus = 'active';
      fx.turns = [{ id: `native-${status}`, status, items: [] }];
      let beforeSubmitCount = 0;
      const submissions: unknown[] = [];
      await assert.rejects(fx.client.run({
        cwd: process.cwd(), threadId: 'busy-role', prompt: '接手产品刚才的任务', allowSteering: false,
        onBeforeSubmit: async () => { beforeSubmitCount++; }, onSubmitted: value => { submissions.push(value); },
      }), /本次交接没有加入该任务/);
      assert.equal(beforeSubmitCount, 0);
      assert.deepEqual(submissions, []);
      assert.deepEqual(mutationMethods(fx.received), []);
      assert.equal(fx.received.some(message => message.method === 'thread/inject_items'), false);
    } finally { await fx.cleanup(); }
  }
});

test('allowSteering false also protects a live native turn while thread metadata still says idle', async () => {
  const fx = await fixture();
  try {
    fx.turns = [{ id: 'native-stale-idle', status: 'inProgress', items: [] }];
    await assert.rejects(fx.client.run({ cwd: process.cwd(), threadId: 'busy-role', prompt: '继续开发', allowSteering: false }), /本次交接没有加入该任务/);
    assert.equal(fx.received.some(message => message.method === 'thread/turns/list'), true);
    assert.deepEqual(mutationMethods(fx.received), []);
  } finally { await fx.cleanup(); }
});

test('allowSteering false never guesses a turn id when active metadata has no matching turn', async () => {
  const fx = await fixture();
  try {
    fx.resumeStatus = 'active';
    fx.readStatus = 'active';
    fx.turns = [{ id: 'previous-completed', status: 'completed', items: [] }];
    await assert.rejects(fx.client.run({ cwd: process.cwd(), threadId: 'busy-role', prompt: '继续开发', allowSteering: false }), /未能确认任务编号/);
    assert.equal(fx.received.filter(message => message.method === 'thread/read').length, 2);
    assert.deepEqual(mutationMethods(fx.received), []);
  } finally { await fx.cleanup(); }
});
