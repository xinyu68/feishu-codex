import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { WebSocketServer, type WebSocket } from 'ws';
import { HermesClient } from '../src/hermes.js';
import type { CodexRunInput } from '../src/types.js';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

type Row = { live: string; stored: string; running: boolean; history: { role: string; content: string; tool_calls?: unknown[]; tool_call_id?: string; tool_name?: string }[] };
type Request = { id: number; method: string; params: Record<string, any> };
async function fixture(options: { onPrompt?: (socket: WebSocket, row: Row, request: Request) => void; onInterrupt?: (socket: WebSocket, row: Row) => void;
  onCreate?: (socket: WebSocket, row: Row, request: Request) => boolean | void; rejectInteractions?: boolean } = {}) {
  const hermesHome = await mkdtemp(path.join(os.tmpdir(), 'hermes-client-'));
  const rows = new Map<string, Row>();
  const trace: Request[] = [];
  const token = 'test-desktop-token';
  let counter = 0;
  const server = createServer((request, response) => {
    if (request.url === '/api/status') { response.setHeader('content-type', 'application/json'); response.end(JSON.stringify({ version: '0.test', hermes_home: hermesHome })); return; }
    if (request.url === '/') { response.end(`<script>window.__HERMES_SESSION_TOKEN__=${JSON.stringify(token)}</script>`); return; }
    if (request.headers['x-hermes-session-token'] !== token) { response.writeHead(401); response.end(); return; }
    const stored = decodeURIComponent(request.url?.split('/')[3] || '');
    const row = [...rows.values()].find(row => row.stored === stored);
    if (!row) { response.writeHead(404); response.end(); return; }
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify(request.url?.endsWith('/messages') ? { session_id: stored, messages: row.history } : { id: stored, title: 'Hermes test', cwd: 'C:/work' }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const wss = new WebSocketServer({ server });
  const event = (socket: WebSocket, row: Row, type: string, payload: Record<string, unknown> = {}) => socket.send(JSON.stringify({ jsonrpc: '2.0', method: 'event', params: { type, session_id: row.live, payload } }));
  const finish = (socket: WebSocket, row: Row, text = 'answer') => {
    row.history.push({ role: 'assistant', content: text });
    event(socket, row, 'message.complete', { text, status: 'complete', reasoning: 'private reasoning' });
    row.running = false;
    event(socket, row, 'session.info', { running: false });
  };
  wss.on('connection', (socket, request) => {
    assert.equal(new URL(request.url!, baseUrl).searchParams.get('token'), token);
    socket.on('message', raw => {
      const request = JSON.parse(raw.toString()) as Request;
      trace.push(request);
      const p = request.params;
      const reply = (result: unknown) => socket.send(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }));
      if (request.method === 'session.create') {
        const n = ++counter;
        const row = { live: `live-${n}`, stored: `stored-${n}`, running: false, history: [] };
        rows.set(row.live, row);
        if (options.onCreate?.(socket, row, request) === false) return;
        reply({ session_id: row.live, stored_session_id: row.stored, info: { model: 'hermes-test', cwd: 'C:/work' } });
      } else if (request.method === 'session.resume') {
        const row = [...rows.values()].find(row => row.stored === p.session_id);
        if (!row) { socket.send(JSON.stringify({ id: request.id, error: { code: 4007 } })); return; }
        reply({ session_id: row.live, resumed: row.stored, session_key: row.stored, running: row.running, info: { model: 'hermes-test', cwd: 'C:/work' } });
      } else if (request.method === 'session.active_list') {
        reply({ sessions: [...rows.values()].map(row => ({ id: row.live, session_key: row.stored, status: row.running ? 'working' : 'idle' })) });
      } else if (request.method === 'session.status') {
        const row = rows.get(p.session_id)!;
        reply({ output: `Session ID: ${row.stored}\nAgent Running: ${row.running ? 'Yes' : 'No'}` });
      } else if (request.method === 'prompt.submit') {
        const row = rows.get(p.session_id)!;
        row.running = true;
        row.history.push({ role: 'user', content: p.text });
        reply({ status: 'streaming' });
        if (options.onPrompt) options.onPrompt(socket, row, request);
        else finish(socket, row);
      } else if (request.method === 'session.interrupt') {
        const row = rows.get(p.session_id)!;
        reply({ status: 'interrupted' });
        if (options.onInterrupt) options.onInterrupt(socket, row);
        else row.running = false;
      } else if (request.method === 'session.close') {
        rows.delete(p.session_id);
        reply({ closed: true });
      } else if (request.method === 'approval.respond' || request.method === 'clarify.respond') {
        if (options.rejectInteractions) socket.send(JSON.stringify({ jsonrpc: '2.0', id: request.id, error: { code: 5001, message: 'interaction response rejected' } }));
        else reply({ resolved: true });
      }
      else if (request.method === 'reload.mcp') reply({ status: 'reloaded' });
      else reply({});
    });
  });
  const clientOptions = { baseUrl, requestTimeoutMs: 1_000, runTimeoutMs: 3_000, pollIntervalMs: 20, completionSettleMs: 60,
    ensureMcp: async () => ({ status: 'unchanged' as const, changed: false }) };
  const client = new HermesClient(clientOptions);
  return { client, clientOptions, rows, trace, event, finish, hermesHome,
    async cleanup() { await client.close(); for (const socket of wss.clients) socket.terminate(); await new Promise<void>(resolve => wss.close(() => resolve())); await new Promise<void>(resolve => server.close(() => resolve())); await rm(hermesHome, { recursive: true, force: true }); },
  };
}

test('Hermes installs a Skill and pins compact independent role references across cold resumes; history is read-only', async () => {
  const fx = await fixture();
  let resumed: HermesClient | undefined;
  try {
    const hooks: string[] = [];
    const first = await fx.client.run({ cwd: 'C:/work', prompt: 'first', roleInstructions: '产品经理',
      onThread: id => hooks.push(id), onBeforeSubmit: () => { hooks.push('before'); },
      preparePrompt: (id, options) => { assert.equal(id, 'hermes:stored-1'); assert.equal(options?.compactChannelHeader, true); return '【飞书消息】\nfirst'; },
      onSubmitted: value => hooks.push(value.status),
    });
    assert.equal(first.threadId, 'hermes:stored-1');
    assert.equal(first.text, 'answer');
    assert.deepEqual(hooks, ['hermes:stored-1', 'before', 'submitting', 'submitted']);
    assert.equal(fx.trace.find(row => row.method === 'session.create')?.params.messages, undefined);
    const firstPrompt = fx.trace.find(row => row.method === 'prompt.submit')!.params.text;
    const reference = /references\/roles\/[a-f0-9]{64}\.md/.exec(firstPrompt)?.[0];
    assert.ok(reference);
    assert.equal(await readFile(path.join(fx.hermesHome, 'skills/feishu-codex', reference), 'utf8'), '产品经理');
    assert.doesNotMatch(firstPrompt, /产品经理|feishu_bridge_instructions/);
    assert.ok(firstPrompt.length < 300);
    assert.equal(fx.trace.some(row => row.method === 'config.set'), false);
    const beforeRead = fx.trace.length;
    const history = await fx.client.history(first.threadId);
    assert.equal(history[0]?.text, 'first');
    assert.equal(history[1]?.text, 'answer');
    assert.equal(fx.trace.length, beforeRead, 'history must not resume or steal desktop transport');
    assert.equal((await fx.client.threadInfo(first.threadId)).title, 'Hermes test');
    await fx.client.close();
    resumed = new HermesClient(fx.clientOptions);
    await resumed.run({ cwd: 'C:/work', threadId: first.threadId, prompt: 'next', roleInstructions: '产品经理' });
    assert.equal(fx.trace.filter(row => row.method === 'session.create').length, 1);
    assert.equal(fx.trace.find(row => row.method === 'session.resume')?.params.session_id, 'stored-1');
    assert.ok(fx.trace.filter(row => row.method === 'prompt.submit')[1]?.params.text.includes(reference));
    const separate = await resumed.run({ cwd: 'C:/work', prompt: 'separate' });
    assert.equal(separate.threadId, 'hermes:stored-2');
    assert.match(fx.trace.filter(row => row.method === 'prompt.submit')[2]?.params.text, /无自定义角色/);
    assert.equal((await resumed.status()).available, true);
    await assert.rejects(resumed.run({ cwd: 'C:/work', threadId: 'codex-thread', prompt: 'no' }), /不能把 Codex/);
  } finally { await resumed?.close(); await fx.cleanup(); }
});

test('Hermes does not finish at message.complete while the executor is still busy and never forwards reasoning', async () => {
  let finishBusy!: () => void;
  let seenFinal!: () => void;
  const finalArrived = new Promise<void>(resolve => { seenFinal = resolve; });
  const fx = await fixture({ onPrompt(socket, row) {
    fx.event(socket, row, 'reasoning.delta', { text: 'private chain' });
    fx.event(socket, row, 'message.delta', { text: 'checking' });
    fx.event(socket, row, 'tool.start', { args: { secret: 'private tool value' } });
    fx.event(socket, row, 'message.complete', { text: 'final', status: 'complete', reasoning: 'private reasoning' });
    finishBusy = () => { row.running = false; fx.event(socket, row, 'session.info', { running: false }); };
    seenFinal();
  } });
  try {
    const progress: string[] = [];
    let resolved = false;
    const running = fx.client.run({ cwd: 'C:/work', prompt: 'work', onProgress: text => progress.push(text) }).then(result => { resolved = true; return result; });
    await finalArrived;
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(resolved, false);
    finishBusy();
    assert.equal((await running).text, 'final');
    assert.deepEqual(progress, ['checking']);
  } finally { await fx.cleanup(); }
});

test('Hermes socket loss never resubmits an uncertain prompt and release never stops active work', async () => {
  let disconnect!: () => void;
  let submitted!: () => void;
  const ready = new Promise<void>(resolve => { submitted = resolve; });
  const fx = await fixture({ onPrompt(socket) { disconnect = () => socket.terminate(); submitted(); } });
  try {
    const states: string[] = [];
    const running = fx.client.run({ cwd: 'C:/work', prompt: 'once', onSubmitted: event => states.push(event.status) });
    const failure = assert.rejects(running, /连接已断开/);
    await ready;
    await fx.client.release('hermes:stored-1');
    assert.equal(fx.trace.some(row => row.method === 'session.interrupt' || row.method === 'session.close'), false);
    disconnect();
    await failure;
    assert.ok(states.includes('uncertain'));
    assert.equal(fx.trace.filter(row => row.method === 'prompt.submit').length, 1);
  } finally { await fx.cleanup(); }
});

test('Hermes refuses a busy resumed desktop session without taking its transport', async () => {
  const fx = await fixture();
  try {
    fx.rows.set('desktop-live', { live: 'desktop-live', stored: 'desktop-stored', running: true, history: [] });
    await assert.rejects(fx.client.run({ cwd: 'C:/work', threadId: 'hermes:desktop-stored', prompt: 'do not interrupt' }), /正在处理.*任务/);
    assert.equal(fx.trace.some(row => row.method === 'reload.mcp'), false);
    assert.equal(fx.trace.some(row => row.method === 'session.resume' || row.method === 'prompt.submit'), false);
  } finally { await fx.cleanup(); }
});

test('Hermes stop waits for idle and interrupts only its own run', async () => {
  let submitted!: () => void;
  const ready = new Promise<void>(resolve => { submitted = resolve; });
  const fx = await fixture({ onPrompt() { submitted(); }, onInterrupt(_socket, row) { setTimeout(() => { row.running = false; }, 70); } });
  try {
    const running = fx.client.run({ cwd: 'C:/work', prompt: 'wait' });
    const stopped = assert.rejects(running, /已停止当前任务/);
    await ready;
    const before = Date.now();
    await fx.client.stop('hermes:stored-1');
    assert.ok(Date.now() - before >= 65);
    await stopped;
    await fx.client.stop('hermes:other');
    assert.deepEqual(fx.trace.filter(row => row.method === 'session.interrupt').map(row => row.params.session_id), ['live-1']);
  } finally { await fx.cleanup(); }
});

test('Hermes forwards approval and clarification answers without enabling global approvals', async () => {
  let finish!: () => void;
  let seen!: () => void;
  let handled = 0;
  const ready = new Promise<void>(resolve => { seen = resolve; });
  const fx = await fixture({ onPrompt(socket, row) {
    finish = () => fx.finish(socket, row);
    fx.event(socket, row, 'approval.request', { command: 'echo safe' });
    fx.event(socket, row, 'clarify.request', { request_id: 'clarify-1', question: 'Which?', choices: ['A', 'B'] });
  } });
  try {
    const input: CodexRunInput = { cwd: 'C:/work', prompt: 'approve', onRequest: async request => {
      if (++handled === 2) seen();
      return request.kind === 'approval' ? { decision: 'accept' } : { answers: { 'clarify-1': { answers: ['A'] } } };
    } };
    const running = fx.client.run(input);
    await ready;
    for (let n = 0; n < 30 && fx.trace.filter(row => row.method.endsWith('.respond')).length < 2; n++) await new Promise(resolve => setTimeout(resolve, 10));
    assert.deepEqual(fx.trace.find(row => row.method === 'approval.respond')?.params, { session_id: 'live-1', choice: 'once' });
    assert.deepEqual(fx.trace.find(row => row.method === 'clarify.respond')?.params, { request_id: 'clarify-1', answer: 'A' });
    finish();
    await running;
  } finally { await fx.cleanup(); }
});

test('Hermes continuation cancels an interim completion and compaction updates the resumable identity', async () => {
  const fx = await fixture({ onPrompt(socket, row) {
    fx.event(socket, row, 'message.complete', { text: 'first segment', status: 'complete' });
    row.running = false;
    setTimeout(() => {
      row.running = true;
      fx.event(socket, row, 'message.start');
      fx.event(socket, row, 'message.delta', { text: 'continuing' });
    }, 30);
    setTimeout(() => {
      row.stored = 'stored-compacted';
      fx.finish(socket, row, 'real final');
    }, 120);
  } });
  try {
    const threads: string[] = [];
    const progress: string[] = [];
    const result = await fx.client.run({ cwd: 'C:/work', prompt: 'work', onThread: thread => threads.push(thread), onProgress: text => progress.push(text) });
    assert.equal(result.text, 'real final');
    assert.equal(result.threadId, 'hermes:stored-compacted');
    assert.deepEqual(threads, ['hermes:stored-1', 'hermes:stored-compacted']);
    assert.deepEqual(progress, ['first segment']);
    assert.equal(await fx.client.turnStatus(result.threadId, result.turnId!), 'completed');
  } finally { await fx.cleanup(); }
});

const handoffTool = 'mcp_feishu_completion_request_feishu_group_handoff';
const handoffArgs = { target: '开发人员', task: '逐条说明实现思路，不修改文件' };
function persistHandoff(row: Row, id: string, result: unknown = { result: '申请已提交', structuredContent: handoffArgs }): void {
  row.history.push({ role: 'assistant', content: '', tool_calls: [{ id, type: 'function', function: { name: handoffTool, arguments: JSON.stringify(handoffArgs) } }] });
  row.history.push({ role: 'tool', content: JSON.stringify(result), tool_call_id: id, tool_name: handoffTool });
}

test('Hermes reconciles only its current native tool receipts when tool progress is off', async () => {
  const fx = await fixture({ onPrompt(socket, row) {
    persistHandoff(row, 'off-call');
    fx.finish(socket, row, '方案完成');
  } });
  try {
    const events: any[] = [];
    fx.client.subscribe(event => events.push(event));
    const result = await fx.client.run({ cwd: 'C:/work', prompt: 'handoff\n<feishu_group_collaboration>开发人员</feishu_group_collaboration>' });
    assert.equal(result.text, '方案完成');
    assert.deepEqual(events.map(event => [event.method, event.threadId, event.turnId, event.params.item.id]), [
      ['item/started', result.threadId, result.turnId, 'off-call'], ['item/completed', result.threadId, result.turnId, 'off-call'],
    ]);
    assert.deepEqual(events[1].params.item.result.structuredContent, handoffArgs);
    assert.equal(fx.trace.some(row => row.method === 'config.set'), false);
  } finally { await fx.cleanup(); }
});

test('Hermes deduplicates live receipts and final reconciliation, never replaying an earlier turn', async () => {
  let count = 0;
  const fx = await fixture({ onPrompt(socket, row) {
    if (count++ === 0) {
      const payload = { name: handoffTool, tool_id: 'live-call', args: handoffArgs, result: { result: '申请已提交', structuredContent: handoffArgs } };
      fx.event(socket, { ...row, live: 'unowned' }, 'tool.start', payload);
      fx.event(socket, { ...row, live: 'unowned' }, 'tool.complete', payload);
      fx.event(socket, row, 'tool.complete', { ...payload, tool_id: 'orphan' });
      fx.event(socket, row, 'tool.start', payload);
      fx.event(socket, row, 'tool.complete', payload);
      fx.event(socket, row, 'tool.complete', payload);
      persistHandoff(row, 'live-call');
    }
    fx.finish(socket, row);
  } });
  try {
    const events: any[] = [];
    const unsubscribe = fx.client.subscribe(event => events.push(event));
    const prompt = 'same\n<feishu_group_collaboration>开发人员</feishu_group_collaboration>';
    const first = await fx.client.run({ cwd: 'C:/work', prompt });
    await fx.client.run({ cwd: 'C:/work', threadId: first.threadId, prompt });
    assert.equal(events.length, 2);
    assert.equal(events[1].params.item.id, 'live-call');
    assert.notEqual(fx.trace.filter(row => row.method === 'prompt.submit')[0].params.text, fx.trace.filter(row => row.method === 'prompt.submit')[1].params.text);
    unsubscribe();
  } finally { await fx.cleanup(); }
});

test('Hermes failed MCP receipt remains a failed handoff and cannot claim dispatch', async () => {
  const fx = await fixture({ onPrompt(socket, row) {
    persistHandoff(row, 'failed-call', { error: 'validation failed' });
    fx.finish(socket, row);
  } });
  try {
    const events: any[] = [];
    fx.client.subscribe(event => events.push(event));
    await fx.client.run({ cwd: 'C:/work', prompt: 'handoff\n<feishu_group_collaboration>开发人员</feishu_group_collaboration>' });
    assert.equal(events[1].params.item.status, 'failed');
    assert.equal(events[1].params.item.result.isError, true);
  } finally { await fx.cleanup(); }
});

test('Hermes preserves a completed answer but rejects MCP handoff after an unanchored goal continuation', async () => {
  const fx = await fixture({ onPrompt(socket, row) {
    persistHandoff(row, 'pre-goal');
    row.history.push({ role: 'user', content: 'goal continuation' });
    fx.finish(socket, row, '最终讨论结果');
  } });
  try {
    const events: any[] = [];
    fx.client.subscribe(event => events.push(event));
    const result = await fx.client.run({ cwd: 'C:/work', prompt: 'discuss\n<feishu_group_collaboration>开发人员</feishu_group_collaboration>' });
    assert.equal(result.text, '最终讨论结果');
    assert.equal(events.length, 2);
    assert.equal(events[1].params.item.status, 'failed');
    assert.equal(await fx.client.turnStatus(result.threadId, result.turnId!), 'completed');
  } finally { await fx.cleanup(); }
});

test('Hermes emits handoff receipts using the final compacted thread identity', async () => {
  const fx = await fixture({ onPrompt(socket, row) {
    const payload = { name: handoffTool, tool_id: 'compacted-call', args: handoffArgs, result: { result: '申请已提交', structuredContent: handoffArgs } };
    fx.event(socket, row, 'tool.start', payload);
    fx.event(socket, row, 'tool.complete', payload);
    persistHandoff(row, 'compacted-call');
    row.stored = 'compacted-with-anchor';
    fx.finish(socket, row);
  } });
  try {
    const events: any[] = [];
    fx.client.subscribe(event => events.push(event));
    const result = await fx.client.run({ cwd: 'C:/work', prompt: '<feishu_group_collaboration>开发人员</feishu_group_collaboration>' });
    assert.equal(result.threadId, 'hermes:compacted-with-anchor');
    assert.deepEqual(events.map(event => event.threadId), [result.threadId, result.threadId]);
    assert.equal(events[1].params.item.status, 'completed');
  } finally { await fx.cleanup(); }
});

test('Hermes consultation works while its source is busy without installing or reloading global integration', async () => {
  let sourceReady!: () => void;
  const ready = new Promise<void>(resolve => { sourceReady = resolve; });
  let sourceSocket!: WebSocket;
  let sourceRow!: Row;
  const fx = await fixture({ onPrompt(socket, row, request) {
    if (request.params.text.includes('hold source')) { sourceSocket = socket; sourceRow = row; sourceReady(); }
    else fx.finish(socket, row, 'consulted answer');
  } });
  const coldConsultant = new HermesClient(fx.clientOptions);
  try {
    const source = fx.client.run({ cwd: 'C:/work', prompt: 'hold source' });
    await ready;
    const before = fx.trace.length;
    const result = await coldConsultant.consult({ cwd: 'C:/consult', prompt: 'supplied summary', roleInstructions: 'Product perspective',
      model: 'consult-model', effort: 'high', signal: new AbortController().signal });
    assert.equal(result.text, 'consulted answer');
    assert.equal(sourceRow.running, true);
    const ownTrace = fx.trace.slice(before);
    assert.equal(ownTrace.some(row => ['skills.reload', 'reload.mcp', 'session.resume'].includes(row.method)), false);
    const created = ownTrace.find(row => row.method === 'session.create')!.params;
    assert.equal(created.source, 'tool');
    assert.equal(created.close_on_disconnect, true);
    assert.equal(created.model, 'consult-model');
    assert.equal(created.reasoning_effort, 'high');
    assert.equal(created.messages, undefined);
    const prompt = ownTrace.find(row => row.method === 'prompt.submit')!.params.text;
    assert.match(prompt, /不要调用任何工具/);
    assert.match(prompt, /Product perspective/);
    assert.doesNotMatch(prompt, /hold source|feishu_bridge_context/);
    assert.deepEqual(ownTrace.filter(row => row.method === 'session.close').map(row => row.params.session_id), ['live-2']);
    assert.equal(fx.rows.size, 1);
    fx.finish(sourceSocket, sourceRow, 'source answer');
    assert.equal((await source).text, 'source answer');
  } finally { await coldConsultant.close(); await fx.cleanup(); }
});

test('Hermes dedicated consultation resumes its own stored session across private sockets', async () => {
  const fx = await fixture();
  try {
    const signal = new AbortController().signal;
    const first = await fx.client.consult({ cwd: 'C:/work', prompt: '1 + 1?', persistent: true, signal });
    assert.equal(fx.rows.size, 1);
    assert.equal(fx.trace.find(row => row.method === 'session.create')!.params.close_on_disconnect, false);
    const second = await fx.client.consult({ cwd: 'C:/work', threadId: first.threadId,
      prompt: 'multiply the result by two', persistent: true, signal });
    assert.equal(second.threadId, first.threadId);
    assert.equal(fx.trace.filter(row => row.method === 'session.create').length, 1);
    assert.equal(fx.trace.filter(row => row.method === 'session.resume').length, 1);
    assert.equal(fx.trace.filter(row => row.method === 'reload.mcp').length, 0);
    assert.equal(fx.rows.size, 1);
    assert.equal([...fx.rows.values()][0]!.history.filter(item => item.role === 'user').length, 2);
  } finally { await fx.cleanup(); }
});

test('Hermes consultation discards handoff receipts and refuses approval without exposing public runtime events', async () => {
  const fx = await fixture({ onPrompt(socket, row) {
    const payload = { name: handoffTool, tool_id: 'consult-handoff', args: handoffArgs, result: { structuredContent: handoffArgs } };
    fx.event(socket, row, 'tool.start', payload);
    fx.event(socket, row, 'tool.complete', payload);
    persistHandoff(row, 'consult-handoff');
    fx.event(socket, row, 'approval.request', { request_id: 'consult-approval', command: 'unsafe-command' });
    fx.finish(socket, row, 'analysis');
  } });
  try {
    const events: unknown[] = [];
    fx.client.subscribe(event => events.push(event));
    await fx.client.consult({ cwd: 'C:/work', prompt: '<feishu_group_collaboration>role</feishu_group_collaboration>', signal: new AbortController().signal });
    assert.deepEqual(events, []);
    assert.equal(fx.trace.find(row => row.method === 'approval.respond')!.params.choice, 'deny');
    assert.equal(fx.trace.some(row => row.method === 'skills.reload'), false);
  } finally { await fx.cleanup(); }
});

test('Hermes consultation exposes only model commentary when credential and interaction requests fail', async () => {
  const fx = await fixture({ rejectInteractions: true, onPrompt(socket, row) {
    fx.event(socket, row, 'message.delta', { text: '检查边界条件' });
    fx.event(socket, row, 'tool.start', { name: 'analysis', tool_id: 'analysis-1' });
    fx.event(socket, row, 'secret.request', { request_id: 'secret-1' });
    fx.event(socket, row, 'sudo.request', { request_id: 'sudo-1' });
    fx.event(socket, row, 'approval.request', { request_id: 'approval-1', command: 'unsafe-command' });
    fx.event(socket, row, 'clarify.request', { request_id: 'clarify-1', question: 'missing detail' });
    fx.finish(socket, row, 'analysis');
  } });
  try {
    const progress: string[] = [];
    const answer = await fx.client.consult({ cwd: 'C:/work', prompt: 'analyze', signal: new AbortController().signal, onProgress: text => progress.push(text) });
    assert.equal(answer.text, 'analysis');
    assert.deepEqual(progress, ['检查边界条件']);
    assert.ok(fx.trace.some(row => row.method === 'approval.respond'));
    assert.ok(fx.trace.some(row => row.method === 'clarify.respond'));
  } finally { await fx.cleanup(); }
});

test('Hermes consultation cancellation only interrupts and closes the temporary session', async () => {
  let sourceReady!: () => void;
  let consultReady!: () => void;
  const sourceStarted = new Promise<void>(resolve => { sourceReady = resolve; });
  const consultStarted = new Promise<void>(resolve => { consultReady = resolve; });
  let sourceSocket!: WebSocket;
  let sourceRow!: Row;
  const fx = await fixture({ onPrompt(socket, row, request) {
    if (request.params.text.includes('hold source')) { sourceSocket = socket; sourceRow = row; sourceReady(); }
    else consultReady();
  } });
  try {
    const source = fx.client.run({ cwd: 'C:/work', prompt: 'hold source' });
    await sourceStarted;
    const controller = new AbortController();
    const result = fx.client.consult({ cwd: 'C:/work', prompt: 'analyze', signal: controller.signal });
    const rejected = assert.rejects(result, /咨询已取消或超时/);
    await consultStarted;
    controller.abort();
    await rejected;
    assert.deepEqual(fx.trace.filter(row => row.method === 'session.interrupt').map(row => row.params.session_id), ['live-2']);
    assert.deepEqual(fx.trace.filter(row => row.method === 'session.close').map(row => row.params.session_id), ['live-2']);
    assert.equal(sourceRow.running, true);
    fx.finish(sourceSocket, sourceRow, 'source answer');
    assert.equal((await source).text, 'source answer');
  } finally { await fx.cleanup(); }
});

test('Hermes rechecks consultation authorization and cleans the unsubmitted session', async () => {
  const fx = await fixture();
  try {
    await assert.rejects(fx.client.consult({ cwd: 'C:/work', prompt: 'analyze', signal: new AbortController().signal,
      onBeforeSubmit: () => { throw new Error('source turn ended'); },
    }), /source turn ended/);
    assert.equal(fx.trace.some(row => row.method === 'prompt.submit'), false);
    assert.equal(fx.rows.size, 0);
    const before = fx.trace.length;
    const controller = new AbortController(); controller.abort();
    await assert.rejects(fx.client.consult({ cwd: 'C:/work', prompt: 'analyze', signal: controller.signal }), /咨询已取消或超时/);
    assert.equal(fx.trace.length, before);
  } finally { await fx.cleanup(); }
});

test('Hermes history hides consultation capability tokens without changing stored receipt prompts', async () => {
  const fx = await fixture();
  try {
    const prompt = '【飞书消息】\n\nuser text\n\n<feishu_group_collaboration>\nroles\n</feishu_group_collaboration>'
      + '\n\n<feishu_group_context>\nbackground\n</feishu_group_context>'
      + '\n\n<feishu_group_consultation>\nconsultationToken=secret-consult-token\n</feishu_group_consultation>';
    const result = await fx.client.run({ cwd: 'C:/work', prompt });
    const submitted = fx.trace.find(row => row.method === 'prompt.submit')!.params.text;
    assert.match(submitted, /secret-consult-token/);
    assert.equal((await fx.client.history(result.threadId))[0].text, 'user text');
  } finally { await fx.cleanup(); }
});

test('Hermes connection shutdown interrupts owned consultations without stopping a normal source session', async () => {
  let sourceReady!: () => void;
  let consultReady!: () => void;
  const sourceStarted = new Promise<void>(resolve => { sourceReady = resolve; });
  const consultStarted = new Promise<void>(resolve => { consultReady = resolve; });
  let sourceRow!: Row;
  const fx = await fixture({ onPrompt(_socket, row, request) {
    if (request.params.text.includes('hold source')) { sourceRow = row; sourceReady(); }
    else consultReady();
  } });
  try {
    const source = fx.client.run({ cwd: 'C:/work', prompt: 'hold source' });
    const disconnected = assert.rejects(source, /桥接连接已关闭/);
    await sourceStarted;
    const consultation = fx.client.consult({ cwd: 'C:/work', prompt: 'analyze', signal: new AbortController().signal });
    const cancelled = assert.rejects(consultation, /桥接连接已关闭/);
    await consultStarted;
    await fx.client.close();
    await Promise.all([disconnected, cancelled]);
    assert.deepEqual(fx.trace.filter(row => row.method === 'session.interrupt').map(row => row.params.session_id), ['live-2']);
    assert.equal(sourceRow.running, true);
  } finally { await fx.cleanup(); }
});

test('Hermes cancellation disconnects an unacknowledged create without disconnecting the source socket', async () => {
  let consultCreated!: () => void;
  const created = new Promise<void>(resolve => { consultCreated = resolve; });
  let sourceSocket!: WebSocket;
  let consultationSocket!: WebSocket;
  let sourceReady!: () => void;
  const sourceStarted = new Promise<void>(resolve => { sourceReady = resolve; });
  let sourceRow!: Row;
  const fx = await fixture({
    onCreate(socket, _row, request) {
      if (request.params.source === 'tool') { consultationSocket = socket; consultCreated(); return false; }
      sourceSocket = socket;
    },
    onPrompt(_socket, row) { sourceRow = row; sourceReady(); },
  });
  try {
    const source = fx.client.run({ cwd: 'C:/work', prompt: 'source' });
    await sourceStarted;
    const controller = new AbortController();
    const result = fx.client.consult({ cwd: 'C:/work', prompt: 'analysis', signal: controller.signal });
    const cancelled = assert.rejects(result, /咨询已取消或超时/);
    await created;
    const disconnected = once(consultationSocket, 'close');
    controller.abort();
    await Promise.all([cancelled, disconnected]);
    assert.notEqual(sourceSocket, consultationSocket);
    assert.equal(sourceSocket.readyState, 1);
    assert.equal(sourceRow.running, true);
    assert.equal(fx.trace.filter(row => row.method === 'prompt.submit').length, 1);
    assert.equal(fx.trace.find(row => row.method === 'session.create' && row.params.source === 'tool')!.params.close_on_disconnect, true);
    fx.finish(sourceSocket, sourceRow, 'source answer');
    assert.equal((await source).text, 'source answer');
  } finally { await fx.cleanup(); }
});
