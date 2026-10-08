import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { WebSocketServer } from 'ws';
import { canonicalEnvironment, canRetireReusedIdentity, desktopMode, matchesEntry, recordedProcessState, RestartBudget, sameProcess, writePermission } from '../desktop/lifecycle.mjs';
import { runtimeProbe } from '../desktop/host.mjs';

test('child environment deduplicates Windows keys without changing parent values', () => {
  const parent = { Path: 'lower', PATH: 'canonical', http_proxy: 'lower-proxy', HTTP_PROXY: 'canonical-proxy', ELECTRON_RUN_AS_NODE: '1', CODEX_APP_SERVER_WS_URL: 'ws://old' };
  const env = canonicalEnvironment(parent, { CODEX_APP_SERVER_WS_URL: null, FEISHU_CODEX_PORT: 8790 });
  assert.equal(env.PATH, 'canonical'); assert.equal(env.HTTP_PROXY, 'canonical-proxy');
  assert.equal(Object.hasOwn(env, 'Path'), false); assert.equal(Object.hasOwn(env, 'ELECTRON_RUN_AS_NODE'), false);
  assert.equal(Object.hasOwn(env, 'CODEX_APP_SERVER_WS_URL'), false); assert.equal(env.FEISHU_CODEX_PORT, '8790');
  assert.equal(parent.CODEX_APP_SERVER_WS_URL, 'ws://old');
});

test('process ownership requires pid, full start time and executable path', () => {
  const expected = { pid: 20, exe: 'C:\\bin\\node.exe', startedAt: '2026-01-01T00:00:00.1234567Z' };
  assert.equal(sameProcess(expected, { ...expected, exe: 'c:\\BIN\\node.exe' }), true);
  assert.equal(sameProcess(expected, { ...expected, pid: 21 }), false);
  assert.equal(sameProcess(expected, { ...expected, startedAt: '2026-01-01T00:00:00.1234568Z' }), false);
  assert.equal(sameProcess(expected, { ...expected, exe: 'C:\\other\\node.exe' }), false);
});

test('entry matching cannot adopt a similarly prefixed executable argument', () => {
  const entry = 'D:\\my app\\build\\server.js';
  assert.equal(matchesEntry({ commandLine: `node.exe "${entry}" --flag` }, entry), true);
  assert.equal(matchesEntry({ commandLine: `node.exe "${entry}.evil"` }, entry), false);
  assert.equal(matchesEntry({ commandLine: 'node.exe D:\\elsewhere\\server.js' }, entry), false);
});

test('dead-host exit checks distinguish unreadable live identity from confirmed exit', () => {
  const expected = { pid: 1, exe: 'C:\\bin\\node.exe', startedAt: 'old' };
  assert.equal(recordedProcessState(expected, []), 'dead');
  assert.equal(recordedProcessState(expected, [expected]), 'alive');
  assert.equal(recordedProcessState(expected, [{ ...expected, exe: '' }]), 'unknown');
  assert.equal(recordedProcessState(expected, [{ ...expected, startedAt: 'new', exe: '' }]), 'dead');
});

test('reused PID records retire only for confirmed unrelated processes on free ports', () => {
  const expected = { pid: 2, exe: 'C:\\bin\\node.exe', startedAt: 'old' };
  const unrelated = { ...expected, startedAt: 'new', commandLine: 'node.exe C:\\other.js' };
  assert.equal(canRetireReusedIdentity(expected, unrelated, 'C:\\bridge.js', []), true);
  assert.equal(canRetireReusedIdentity(expected, unrelated, 'C:\\bridge.js', [{}]), false);
  assert.equal(canRetireReusedIdentity(expected, { ...unrelated, commandLine: '' }, 'C:\\bridge.js', []), false);
  assert.equal(canRetireReusedIdentity(expected, { ...unrelated, commandLine: 'node.exe C:\\bridge.js' }, 'C:\\bridge.js', []), false);
});

test('supervisor backs off only confirmed exits, then requires manual retry', () => {
  let now = 0; const budget = new RestartBudget({ now: () => now });
  for (const delay of [1_000, 2_000, 4_000, 8_000]) {
    budget.failed(); assert.equal(budget.nextAt - now, delay); assert.equal(budget.ready, false);
    now += delay; assert.equal(budget.ready, true);
  }
  budget.failed(); assert.equal(budget.blocked, true); now += 600_000; assert.equal(budget.ready, false);
  budget.reset(); assert.equal(budget.ready, true);
});

test('old isolated failures outside five-minute window do not trip new restart budget', () => {
  let now = 0; const budget = new RestartBudget({ now: () => now });
  for (let i = 0; i < 10; i++) { budget.failed(); now += 301_000; }
  assert.equal(budget.failures.length, 1); assert.equal(budget.blocked, false);
});

const root = { pid: 100, parentPid: 1, exe: 'C:\\WindowsApps\\OpenAI.Codex_1_x64\\app\\ChatGPT.exe', startedAt: 'start', commandLine: 'ChatGPT.exe' };
const snapshot = (processes, connections = []) => ({ desktopRoots: [root], processes: [root, ...processes], connections, unknownDesktop: false });

test('independent desktop pauses writes even if a stale launch record calls it shared', () => {
  const mode = desktopMode(snapshot([{ pid: 101, parentPid: 100, exe: 'C:\\bin\\codex.exe', commandLine: 'codex.exe app-server' }]), 18791, root);
  assert.equal(mode.mode, 'independent');
  assert.equal(writePermission({ runtime: { state: 'ready' }, bridge: { state: 'ready' }, desktop: mode }).canWrite, false);
});

test('shared native desktop is recognized through descendant TCP connection', () => {
  const mode = desktopMode(snapshot([{ pid: 102, parentPid: 100, exe: root.exe }], [{ pid: 102, remotePort: 18791, remoteAddress: '127.0.0.1' }]), 18791);
  assert.equal(mode.mode, 'shared');
  assert.equal(writePermission({ runtime: { state: 'ready' }, bridge: { state: 'ready' }, desktop: mode }).canWrite, true);
});

test('unknown process topology, unready runtime and shutdown all fail closed', () => {
  const unknown = desktopMode(snapshot([]), 18791);
  assert.equal(unknown.mode, 'unknown');
  const desktop = { mode: 'closed' }, runtime = { state: 'ready' }, bridge = { state: 'ready' };
  assert.equal(writePermission({ runtime, bridge, desktop: unknown }).canWrite, false);
  assert.equal(writePermission({ runtime: { state: 'unhealthy' }, bridge, desktop }).canWrite, false);
  assert.equal(writePermission({ runtime, bridge, desktop, stopping: true }).canWrite, false);
});

async function fixture(handler) {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await once(server, 'listening');
  server.on('connection', socket => socket.on('message', raw => {
    const message = JSON.parse(raw.toString());
    if (message.id) handler(message, result => socket.send(JSON.stringify({ id: message.id, result })));
  }));
  return { url: `ws://127.0.0.1:${server.address().port}`, close: async () => { for (const socket of server.clients) socket.terminate(); await new Promise(resolve => server.close(resolve)); } };
}

test('runtime quit probe reads every loaded task without resuming or sending prompts', async () => {
  const methods = [];
  const fx = await fixture((message, reply) => {
    methods.push(message.method);
    if (message.method === 'initialize') reply({ userAgent: 'mock' });
    else if (message.method === 'thread/loaded/list') reply(message.params.cursor ? { data: ['two'], nextCursor: null } : { data: ['one'], nextCursor: 'next' });
    else if (message.method === 'thread/read') reply({ thread: { id: message.params.threadId, status: { type: message.params.threadId === 'one' ? 'active' : 'idle' }, turns: [] } });
    else assert.fail(`unexpected write method ${message.method}`);
  });
  try { assert.deepEqual(await runtimeProbe(fx.url, { idle: true }), { ready: true, active: 1 }); assert.equal(methods.filter(method => method === 'thread/read').length, 3); }
  finally { await fx.close(); }
});

test('runtime account probe waits for a readable authenticated account without refreshing tokens', async () => {
  const requests = [];
  const fx = await fixture((message, reply) => {
    requests.push(message);
    if (message.method === 'initialize') reply({});
    else if (message.method === 'account/read') reply({ account: { type: 'chatgpt' }, requiresOpenaiAuth: true });
    else assert.fail(`unexpected method ${message.method}`);
  });
  try {
    assert.deepEqual(await runtimeProbe(fx.url, { account: true }), { ready: true, authenticated: true, accountType: 'chatgpt' });
    assert.deepEqual(requests.map(request => request.method), ['initialize', 'account/read']);
    assert.deepEqual(requests.at(-1).params, { refreshToken: false });
  } finally { await fx.close(); }
});

test('runtime account probe accepts providers that do not require OpenAI authentication', async () => {
  const fx = await fixture((message, reply) => {
    if (message.method === 'initialize') reply({});
    else if (message.method === 'account/read') reply({ account: null, requiresOpenaiAuth: false });
  });
  try { assert.deepEqual(await runtimeProbe(fx.url, { account: true }), { ready: true, authenticated: true, accountType: null }); }
  finally { await fx.close(); }
});

test('runtime account probe reports an unavailable login without treating the runtime as broken', async () => {
  const fx = await fixture((message, reply) => {
    if (message.method === 'initialize') reply({});
    else if (message.method === 'account/read') reply({ account: null, requiresOpenaiAuth: true });
  });
  try { assert.deepEqual(await runtimeProbe(fx.url, { account: true }), { ready: true, authenticated: false, accountType: null }); }
  finally { await fx.close(); }
});

test('summary idle with an accepted in-progress turn is never safe to shut down', async () => {
  for (const paginated of [false, true]) {
    const methods = [];
    const fx = await fixture((message, reply) => {
      methods.push(message.method);
      if (message.method === 'initialize') reply({});
      else if (message.method === 'thread/loaded/list') reply({ data: ['one'], nextCursor: null });
      else if (message.method === 'thread/turns/list') reply({ data: [{ id: 'turn', status: 'inProgress' }] });
      else reply({ thread: { id: 'one', status: { type: 'idle' }, historyMode: paginated ? 'paginated' : 'default', turns: [{ id: 'turn', status: 'inProgress' }] } });
    });
    try {
      assert.deepEqual(await runtimeProbe(fx.url, { idle: true }), { ready: true, active: 1 });
      assert.equal(methods.includes('thread/turns/list'), paginated);
    } finally { await fx.close(); }
  }
});

test('old in-progress history does not block an idle live thread', async () => {
  for (const paginated of [false, true]) {
    let reads = 0;
    const fx = await fixture((message, reply) => {
      if (message.method === 'initialize') reply({});
      else if (message.method === 'thread/loaded/list') reply({ data: ['one'], nextCursor: null });
      else if (message.method === 'thread/turns/list') reply({ data: [{ id: 'old', status: 'inProgress', startedAt: Math.floor(Date.now() / 1000) - 600 }] });
      else {
        assert.equal(message.method, 'thread/read');
        reads++;
        reply({ thread: { id: 'one', status: { type: 'idle' }, historyMode: paginated ? 'paginated' : 'default',
          turns: [{ id: 'old', status: 'inProgress', startedAt: Math.floor(Date.now() / 1000) - 600 }] } });
      }
    });
    try { assert.deepEqual(await runtimeProbe(fx.url, { idle: true }), { ready: true, active: 0 }); assert.equal(reads, paginated ? 2 : 3); }
    finally { await fx.close(); }
  }
});

test('idle summary turning active during stale-history recheck still blocks shutdown', async () => {
  let reads = 0;
  const fx = await fixture((message, reply) => {
    if (message.method === 'initialize') reply({});
    else if (message.method === 'thread/loaded/list') reply({ data: ['one'], nextCursor: null });
    else if (message.method === 'thread/turns/list') reply({ data: [{ id: 'old', status: 'inProgress', startedAt: 1 }] });
    else { reads++; reply({ thread: { id: 'one', status: { type: reads === 2 ? 'active' : 'idle' }, historyMode: 'paginated' } }); }
  });
  try { assert.deepEqual(await runtimeProbe(fx.url, { idle: true }), { ready: true, active: 1 }); }
  finally { await fx.close(); }
});

test('unknown runtime task state cannot be mistaken for safe idle', async () => {
  const fx = await fixture((message, reply) => {
    if (message.method === 'initialize') reply({});
    else if (message.method === 'thread/loaded/list') reply({ data: ['one'], nextCursor: null });
    else reply({ thread: { id: 'one', status: { type: 'unexpected' } } });
  });
  try { await assert.rejects(runtimeProbe(fx.url, { idle: true }), /无法确认任务/); }
  finally { await fx.close(); }
});

test('runtime protocol timeout fails without sending any user instruction', async () => {
  const methods = [];
  const fx = await fixture(message => methods.push(message.method));
  try { await assert.rejects(runtimeProbe(fx.url, { timeout: 100 }), /未及时响应/); assert.deepEqual(methods, ['initialize']); }
  finally { await fx.close(); }
});

test('ephemeral tasks use live state without requesting unsupported persisted history', async () => {
  for (const secondStatus of ['idle', 'active', 'unknown']) {
    let reads = 0;
    const fx = await fixture((message, reply) => {
      if (message.method === 'initialize') reply({});
      else if (message.method === 'thread/loaded/list') reply({ data: ['temporary'], nextCursor: null });
      else {
        assert.equal(message.method, 'thread/read');
        assert.equal(message.params.includeTurns, false);
        reply({ thread: { id: 'temporary', ephemeral: true, historyMode: 'legacy', status: { type: ++reads === 1 ? 'idle' : secondStatus } } });
      }
    });
    try {
      if (secondStatus === 'unknown') await assert.rejects(runtimeProbe(fx.url, { idle: true }), /无法确认临时任务/);
      else assert.deepEqual(await runtimeProbe(fx.url, { idle: true }), { ready: true, active: secondStatus === 'active' ? 1 : 0 });
      assert.equal(reads, 2);
    } finally { await fx.close(); }
  }
});

test('idle probe uses bounded turn summary when latest turn contains a large payload', async () => {
  const views = [];
  const fx = await fixture((message, reply) => {
    if (message.method === 'initialize') reply({});
    else if (message.method === 'thread/loaded/list') reply({ data: ['large'], nextCursor: null });
    else if (message.method === 'thread/read') reply({ thread: { id: 'large', status: { type: 'idle' }, historyMode: 'paginated' } });
    else if (message.method === 'thread/turns/list') {
      views.push(message.params.itemsView);
      reply({ data: [{ id: 'turn', status: 'completed', items: message.params.itemsView === 'full'
        ? [{ type: 'toolOutput', text: 'x'.repeat(3 * 1024 * 1024) }] : [] }] });
    }
  });
  try {
    assert.deepEqual(await runtimeProbe(fx.url, { idle: true }), { ready: true, active: 0 });
    assert.deepEqual(views, ['summary']);
  } finally { await fx.close(); }
});