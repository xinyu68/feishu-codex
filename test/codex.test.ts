import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CodexClient } from '../src/codex.js';
import type { RuntimeRequest } from '../src/types.js';

async function fixture(scenario: string) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'feishu-codex-rpc-'));
  const client = new CodexClient({
    command: { command: process.execPath, args: [fileURLToPath(new URL('./fixtures/fake-codex.mjs', import.meta.url)), scenario, directory] },
    codexHome: directory, requestTimeoutMs: 15_000, idleTimeoutMs: 30_000,
  });
  return { client, directory,
    async trace() {
      const files = (await fs.readdir(directory)).filter(name => name.startsWith('trace-'));
      return (await Promise.all(files.map(file => fs.readFile(path.join(directory, file), 'utf8')))).flatMap(text => text.trim().split('\n').map(line => JSON.parse(line)));
    },
    async cleanup() { await client.close(); assert.equal((await fs.readdir(directory)).filter(name => name.startsWith('owned-')).length, 0, 'all owned processes must exit'); await fs.rm(directory, { recursive: true, force: true }); },
  };
}

test('early final events are retained; resumed turns override sandbox and release process ownership', async () => {
  const fx = await fixture('early');
  try {
    const progress: string[] = [];
    const first = await fx.client.run({ cwd: fx.directory, prompt: 'first', onProgress: text => progress.push(text) });
    assert.equal(first.text, 'new-thread: final answer');
    assert.deepEqual(progress, ['working']);
    const next = await fx.client.run({ cwd: fx.directory, threadId: first.threadId, prompt: 'next' });
    assert.equal(next.threadId, first.threadId);
    assert.equal(next.text, first.text);
    const trace = await fx.trace();
    const spawns = trace.filter(row => row.argv);
    assert.equal(spawns.length, 2, 'each turn must own a fresh process');
    for (const row of spawns) {
      assert.ok(row.argv.includes('sandbox_mode="danger-full-access"'));
      assert.ok(row.argv.includes('approval_policy="never"'));
      assert.equal(row.codexHome, fx.directory);
    }
    const opening = trace.filter(row => ['thread/start', 'thread/resume'].includes(row.method));
    assert.deepEqual(opening.map(row => row.method).sort(), ['thread/resume', 'thread/start']);
    for (const row of opening) {
      assert.equal(row.params.sandbox, 'danger-full-access');
      assert.equal(row.params.approvalPolicy, 'never');
      assert.deepEqual(row.params.config, { sandbox_mode: 'danger-full-access', approval_policy: 'never' });
    }
    for (const row of trace.filter(row => row.method === 'turn/start')) {
      assert.deepEqual(row.params.sandboxPolicy, { type: 'dangerFullAccess' });
      assert.equal(row.params.approvalPolicy, 'never');
    }
    assert.equal((await fs.readdir(fx.directory)).filter(name => name.startsWith('owned-')).length, 0);
  } finally { await fx.cleanup(); }
});

test('same-thread concurrency is rejected; stop interrupts only its owned turn and permits a fresh resume', async () => {
  const fx = await fixture('hang');
  try {
    let ready!: () => void;
    const running = new Promise<void>(resolve => { ready = resolve; });
    const result = fx.client.run({ cwd: fx.directory, threadId: 'existing', prompt: 'wait', onProgress: () => ready() });
    const stopped = assert.rejects(result, /已停止当前任务/);
    await running;
    await assert.rejects(fx.client.run({ cwd: fx.directory, threadId: 'existing', prompt: 'duplicate' }), /会话.*处理/);
    await fx.client.stop('existing');
    await stopped;
    assert.equal((await fx.trace()).filter(row => row.method === 'turn/interrupt').length, 1);
    await fx.client.release('desktop-owned-thread');
    assert.equal((await fx.trace()).filter(row => row.method === 'turn/interrupt').length, 1, 'must not interrupt unknown desktop threads');
  } finally { await fx.cleanup(); }
});

test('concurrent independent threads do not mix results', async () => {
  const fx = await fixture('early');
  try {
    const result = await Promise.all(['one', 'two'].map(threadId => fx.client.run({ cwd: fx.directory, threadId, prompt: threadId })));
    assert.deepEqual(result.map(value => value.text), ['one: final answer', 'two: final answer']);
  } finally { await fx.cleanup(); }
});

test('standalone consultation starts an ephemeral session and declines all approvals', async () => {
  const fx = await fixture('approval');
  try {
    const result = await fx.client.consult({ cwd: fx.directory, prompt: 'analyze supplied text', roleInstructions: 'product perspective',
      model: 'consult-model', effort: 'high', signal: new AbortController().signal });
    assert.equal(result.text, 'new-thread: final answer');
    const rows = await fx.trace();
    const start = rows.find(row => row.method === 'thread/start').params;
    assert.equal(start.ephemeral, true);
    assert.equal(start.sandbox, 'danger-full-access');
    assert.equal(start.model, 'consult-model');
    assert.match(start.developerInstructions, /不要调用任何工具/);
    assert.match(start.developerInstructions, /product perspective/);
    assert.equal(rows.some(row => ['thread/resume', 'turn/steer'].includes(row.method)), false);
    const answers = rows.filter(row => String(row.id).startsWith('approval-'));
    assert.deepEqual(answers.slice(0, 3).map(row => row.result), [{ decision: 'decline' }, { decision: 'decline' }, { permissions: {}, scope: 'turn' }]);
    assert.match(answers[3].result.answers.pick.answers[0], /独立咨询/);
  } finally { await fx.cleanup(); }
});

test('standalone consultation cancellation interrupts only its temporary session', async () => {
  const fx = await fixture('hang');
  try {
    let ready!: () => void;
    const running = new Promise<void>(resolve => { ready = resolve; });
    const controller = new AbortController();
    const result = fx.client.consult({ cwd: fx.directory, prompt: 'wait', signal: controller.signal, onProgress: ready });
    const rejected = assert.rejects(result, /咨询已取消或超时/);
    await running;
    controller.abort();
    await rejected;
    const interrupts = (await fx.trace()).filter(row => row.method === 'turn/interrupt');
    assert.deepEqual(interrupts.map(row => row.params), [{ threadId: 'new-thread', turnId: 'turn-1' }]);
  } finally { await fx.cleanup(); }
});

test('process exits and foreign writer locks fail clearly and release local ownership', async () => {
  for (const [scenario, pattern] of [['crash', /进程已退出/], ['busy', /桌面回复结束不代表已释放/], ['active-writer', /桌面回复结束不代表已释放/]] as const) {
    const fx = await fixture(scenario);
    try { await assert.rejects(fx.client.run({ cwd: fx.directory, threadId: 'existing', prompt: 'hello' }), pattern); }
    finally { await fx.cleanup(); }
  }
});

test('approval and question hooks return protocol-specific answers with unique request ids', async () => {
  const fx = await fixture('approval');
  try {
    const requests: RuntimeRequest[] = [];
    await fx.client.run({ cwd: fx.directory, prompt: 'ask', onRequest: async request => {
      requests.push(request);
      return { decision: 'accept', answers: { pick: { answers: ['yes'] } } };
    } });
    assert.equal(new Set(requests.map(request => request.id)).size, 4);
    assert.deepEqual(requests.map(request => request.kind), ['approval', 'approval', 'approval', 'question']);
    const trace = await fx.trace();
    assert.deepEqual(trace.find(row => row.id === 'approval-2').result, { permissions: { network: { enabled: true } }, scope: 'turn' });
    assert.deepEqual(trace.find(row => row.id === 'approval-3').result, { answers: { pick: { answers: ['yes'] } } });
  } finally { await fx.cleanup(); }
});

test('status, models and paginated desktop history use read-only requests without resuming threads', async () => {
  const fx = await fixture('early');
  try {
    assert.deepEqual(await fx.client.status(), { available: true, version: 'fake-codex/1', authenticated: true });
    assert.deepEqual(await fx.client.models(), [{ id: 'test-model', name: 'Test Model', efforts: ['high'], defaultEffort: 'high' }]);
    const history = await fx.client.history('desktop');
    assert.deepEqual(history.map(message => [message.role, message.text]), [['user', 'Hello'], ['assistant', 'Hello back']]);
    assert.equal((await fx.trace()).some(row => row.method === 'thread/resume' || row.method === 'thread/start'), false);
  } finally { await fx.cleanup(); }
});

test('standalone prepares after thread identity and acknowledges the exact submitted prompt', async () => {
  const fx = await fixture('early');
  const events: string[] = [];
  try {
    const result = await fx.client.run({ cwd: fx.directory, prompt: 'stale',
      onThread: threadId => { assert.equal(threadId, 'new-thread'); events.push('thread'); },
      onBeforeSubmit: () => { events.push('guard'); },
      preparePrompt: threadId => { assert.equal(threadId, 'new-thread'); events.push('prepare'); return 'current group context'; },
      onSubmitted: event => { events.push(event.status); if (event.status === 'submitted') assert.equal(event.turnId, 'turn-1'); },
    });
    assert.deepEqual(events, ['thread', 'guard', 'prepare', 'submitting', 'submitted']);
    assert.equal(result.turnId, 'turn-1');
    assert.equal((await fx.trace()).find(row => row.method === 'turn/start').params.input[0].text, 'current group context');
  } finally { await fx.cleanup(); }
});

test('standalone preparation failure is not submitted and a lost mutation stays uncertain', async t => {
  for (const lost of [false, true]) await t.test(lost ? 'lost response' : 'preparation failed', async () => {
    const fx = await fixture(lost ? 'crash' : 'early');
    const states: string[] = [];
    try {
      await assert.rejects(fx.client.run({ cwd: fx.directory, prompt: 'stale',
        preparePrompt: () => { if (!lost) throw new Error('context unavailable'); return 'prepared once'; },
        onSubmitted: event => states.push(event.status),
      }), lost ? /进程已退出/ : /context unavailable/);
      assert.deepEqual(states, lost ? ['submitting', 'uncertain'] : []);
      assert.equal((await fx.trace()).filter(row => row.method === 'turn/start').length, lost ? 1 : 0);
    } finally { await fx.cleanup(); }
  });
});
