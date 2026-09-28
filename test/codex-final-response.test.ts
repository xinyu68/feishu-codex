import assert from 'node:assert/strict';
import { once } from 'node:events';
import test from 'node:test';
import WebSocket, { WebSocketServer } from 'ws';
import { CodexClient } from '../src/codex.js';
import type { RpcMessage, RpcParams } from '../src/codex-websocket.js';

type Item = { id: string; type: string; phase?: string; text?: string };
type Turn = { id: string; status: string; items: RpcParams[] };
const answer = (id: string, text: string, phase = 'final_answer'): Item => ({ id, type: 'agentMessage', phase, text });

async function fixture(t: test.TestContext) {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const client = new CodexClient({ websocketUrl: `ws://127.0.0.1:${address.port}`, requestTimeoutMs: 2_000, idleTimeoutMs: 5_000 });
  const turn: Turn = { id: 'same-native-turn', status: 'inProgress', items: [] };
  let began = false;
  const failures: string[] = [];
  const send = (socket: WebSocket, value: unknown) => { if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(value)); };
  const reply = (socket: WebSocket, request: RpcMessage, result: unknown) => send(socket, { id: request.id, result });
  const notify = (method: string, params: RpcParams) => {
    for (const socket of server.clients) send(socket, { method, params: { threadId: 'thread', turnId: turn.id, ...params } });
  };
  const fx = {
    client, turn, notify,
    onStart: () => {}, onSteer: () => {},
    item(item: Item) { notify('item/completed', { item }); },
    complete(items: RpcParams[] = turn.items, status = 'completed') {
      turn.status = status;
      turn.items = items;
      notify('turn/completed', { turn: { ...turn, items } });
    },
    run(prompt = '继续') { return client.run({ threadId: 'thread', cwd: process.cwd(), prompt }); },
  };
  server.on('connection', socket => socket.on('message', raw => {
    const request = JSON.parse(raw.toString()) as RpcMessage;
    if (!request.method) return;
    switch (request.method) {
      case 'initialize': reply(socket, request, { userAgent: 'final-response-test' }); break;
      case 'initialized': break;
      case 'thread/resume': reply(socket, request, { thread: { id: 'thread', status: { type: began && turn.status === 'inProgress' ? 'active' : 'idle' } } }); break;
      case 'thread/read': reply(socket, request, { thread: { id: 'thread', historyMode: 'paginated', status: { type: began && turn.status === 'inProgress' ? 'active' : 'idle' } } }); break;
      case 'thread/turns/list': reply(socket, request, { data: began ? [turn] : [], nextCursor: null }); break;
      case 'turn/start':
        began = true;
        reply(socket, request, { turn: { ...turn, items: [] } });
        fx.onStart();
        break;
      case 'turn/steer': reply(socket, request, { turnId: turn.id }); fx.onSteer(); break;
      case 'turn/interrupt': fx.complete([], 'interrupted'); reply(socket, request, {}); break;
      default:
        failures.push(request.method);
        send(socket, { id: request.id, error: { code: -32601, message: `Unexpected method: ${request.method}` } });
    }
  }));
  t.after(async () => {
    await client.close();
    for (const socket of server.clients) socket.terminate();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    assert.deepEqual(failures, []);
  });
  return fx;
}

test('steering after an initial final returns only the last final to both runs', { timeout: 8_000 }, async t => {
  const fx = await fixture(t);
  let started!: () => void;
  const ready = new Promise<void>(resolve => { started = resolve; });
  const old = answer('old-final', '我出 3。\n交接给 @开发：旧交接。');
  const current = answer('new-final', '改为出 4。\n交接给 @开发：接着最新的一手。');
  fx.onStart = () => { fx.turn.items.push(old); fx.item(old); started(); };
  fx.onSteer = () => {
    fx.turn.items.push({ id: 'steered-user', type: 'userMessage', content: [{ type: 'text', text: '更正上一手。' }] }, current);
    fx.item(current); fx.complete();
  };
  const first = fx.run('先出牌。');
  await ready;
  const second = fx.run('更正上一手。');
  const results = await Promise.all([first, second]);
  assert.deepEqual(results.map(result => result.turnId), ['same-native-turn', 'same-native-turn']);
  assert.deepEqual(results.map(result => result.text), [current.text, current.text]);
});

test('terminal snapshot order wins over out-of-order streamed item insertion', async t => {
  const fx = await fixture(t);
  const old = answer('old', '已经被更新的结果。');
  const current = answer('current', '最新结果。');
  fx.onStart = () => { fx.item(current); fx.item(old); fx.complete([old, current]); };
  assert.equal((await fx.run()).text, current.text);
});

test('empty terminal items preserve the last streamed final and ignore commentary or empty finals', async t => {
  const fx = await fixture(t);
  const current = answer('current', '最后的完整答复。');
  fx.onStart = () => {
    fx.item(answer('old', '早期答复。'));
    fx.item(current);
    fx.item(answer('empty', '  '));
    fx.item(answer('progress', '正在清理资源。', 'commentary'));
    fx.complete([]);
  };
  assert.equal((await fx.run()).text, current.text);
});

test('one final retains all paragraphs and repeated text inside that message', async t => {
  const fx = await fixture(t);
  const content = '第一段。\n\n第二段。\n\n重复说明。\n重复说明。\n\n交接给 @开发：具体任务。';
  fx.onStart = () => fx.complete([answer('only-final', content)]);
  assert.equal((await fx.run()).text, content);
});

test('an empty snapshot field does not erase valid final text previously streamed for that item', async t => {
  const fx = await fixture(t);
  fx.onStart = () => {
    fx.item(answer('valid', '完整答复。'));
    fx.complete([answer('valid', ''), answer('empty', '\n\t')]);
  };
  assert.equal((await fx.run()).text, '完整答复。');
});

test('legacy messages without a final phase still use the last non-commentary reply', async t => {
  const fx = await fixture(t);
  fx.onStart = () => fx.complete([answer('old', '旧结果', ''), answer('current', '兼容结果', ''), answer('progress', '进度', 'commentary')]);
  assert.equal((await fx.run()).text, '兼容结果');
});

test('a failed or interrupted turn does not present its partial final as success', async t => {
  for (const status of ['failed', 'interrupted']) await t.test(status, async child => {
    const fx = await fixture(child);
    fx.onStart = () => fx.complete([answer('partial', '尚未完成。')], status);
    await assert.rejects(fx.run(), status === 'failed' ? /Codex 执行失败/ : /已停止当前任务/);
  });
});

test('progress reports only completed commentary, never partial text, tools, finals or terminal snapshots', async t => {
  const fx = await fixture(t);
  const progress: string[] = [];
  const commentary = answer('explanation', '已检查配置。\n接下来验证连接。', 'commentary');
  const final = answer('answer', '连接已恢复。');
  fx.onStart = () => {
    fx.notify('item/started', { item: answer('explanation', '尚未完成的说明', 'commentary') });
    fx.notify('item/agentMessage/delta', { itemId: 'explanation', delta: '，仍在输出。' });
    fx.notify('item/started', { item: { id: 'tool', type: 'commandExecution', command: 'check' } });
    fx.notify('item/completed', { item: { id: 'tool', type: 'commandExecution', aggregatedOutput: 'done' } });
    fx.item(commentary);
    fx.notify('item/started', { item: answer('answer', '尚未完成的回复') });
    fx.notify('item/agentMessage/delta', { itemId: 'answer', delta: '，继续输出。' });
    fx.item(final);
    fx.complete([commentary, answer('snapshot-only', '仅在终态快照出现的说明。', 'commentary'), final]);
  };
  const result = await fx.client.run({ threadId: 'thread', cwd: process.cwd(), prompt: '检查连接', onProgress: text => progress.push(text) });
  assert.equal(result.text, final.text);
  assert.deepEqual(progress, [commentary.text]);
});

test('starting or steering a turn without commentary does not fabricate progress', async t => {
  const fx = await fixture(t);
  const firstProgress: string[] = [];
  const steeredProgress: string[] = [];
  let started!: () => void;
  const ready = new Promise<void>(resolve => { started = resolve; });
  fx.onStart = () => started();
  fx.onSteer = () => fx.complete([answer('answer', '已结合补充要求完成。')]);
  const first = fx.client.run({ threadId: 'thread', cwd: process.cwd(), prompt: '开始任务', onProgress: text => firstProgress.push(text) });
  await ready;
  const steered = fx.client.run({ threadId: 'thread', cwd: process.cwd(), prompt: '补充要求', onProgress: text => steeredProgress.push(text) });
  const results = await Promise.all([first, steered]);
  assert.deepEqual(results.map(result => result.text), ['已结合补充要求完成。', '已结合补充要求完成。']);
  assert.deepEqual(firstProgress, []);
  assert.deepEqual(steeredProgress, []);
});
