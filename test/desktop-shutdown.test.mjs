import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkIdleServices, closeSharedDesktop, waitForChildExit } from '../desktop/shutdown.mjs';
import { EventEmitter } from 'node:events';

const identity = { pid: 22, exe: 'C:\\Codex\\ChatGPT.exe', startedAt: '2026-09-26T01:02:03.0000000Z' };
function fixture() {
  let roots = [identity];
  let processes = [identity];
  const calls = [];
  return { calls, close: () => { roots = []; processes = []; },
    replace: next => { roots = [next]; processes = [next]; },
    independent: () => processes.push({ pid: 23, parentPid: 22, exe: 'C:\\Codex\\codex.exe', commandLine: 'codex.exe app-server' }),
    options: { sharedPort: 18791, launched: identity,
      inspect: async () => ({ desktopRoots: roots, processes, connections: [], unknownDesktop: false }),
      assertIdle: async () => { calls.push('idle'); },
      requestClose: async value => { assert.deepEqual(value, identity); calls.push('window'); },
      terminate: async value => { assert.deepEqual(value, identity); calls.push('terminate'); roots = []; processes = []; } } };
}

test('shared desktop without a tray or visible window can exit after two idle checks', async () => {
  const fx = fixture();
  await closeSharedDesktop(fx.options);
  assert.deepEqual(fx.calls, ['idle', 'window', 'idle', 'terminate']);
});

test('normal Codex exit does not invoke termination', async () => {
  const fx = fixture();
  fx.options.requestClose = async () => { fx.calls.push('window'); fx.close(); };
  await closeSharedDesktop(fx.options);
  assert.deepEqual(fx.calls, ['idle', 'window']);
});

test('a running task prevents even the initial window close', async () => {
  const fx = fixture();
  fx.options.assertIdle = async () => { throw new Error('task active'); };
  await assert.rejects(closeSharedDesktop(fx.options), /task active/);
  assert.deepEqual(fx.calls, []);
});

test('a task starting while the window closes prevents forced termination', async () => {
  const fx = fixture(); let checks = 0;
  fx.options.assertIdle = async () => { if (++checks === 2) throw new Error('task just started'); };
  await assert.rejects(closeSharedDesktop(fx.options), /task just started/);
  assert.deepEqual(fx.calls, ['window']);
});

test('independent desktop and reused desktop PID must never be closed', async () => {
  const independent = fixture(); independent.independent();
  await assert.rejects(closeSharedDesktop(independent.options), /无法确认/);
  assert.deepEqual(independent.calls, []);
  const reused = fixture();
  reused.options.requestClose = async () => { reused.replace({ ...identity, startedAt: 'new' }); };
  await assert.rejects(closeSharedDesktop(reused.options), /无法确认/);
  assert.deepEqual(reused.calls, ['idle']);
});

test('captured children are released even when the desktop parent exits normally', async () => {
  const fx = fixture();
  const tree = { ...identity, tree: [{ pid: 23, exe: 'helper.exe', startedAt: identity.startedAt }] };
  fx.options.captureTree = async () => { fx.calls.push('capture'); return tree; };
  fx.options.requestClose = async () => { fx.calls.push('window'); fx.close(); };
  fx.options.terminate = async value => { assert.deepEqual(value, tree); fx.calls.push('tree'); };
  await closeSharedDesktop(fx.options);
  assert.deepEqual(fx.calls, ['idle', 'capture', 'window', 'idle', 'tree']);
});

test('Codex and Feishu idle checks start together and either busy result prevents exit', async () => {
  const started = [];
  let finishCodex, finishFeishu;
  const checking = checkIdleServices({
    runtime: () => { started.push('codex'); return new Promise(resolve => { finishCodex = resolve; }); },
    bridge: () => { started.push('feishu'); return new Promise(resolve => { finishFeishu = resolve; }); },
  });
  assert.deepEqual(started, ['codex', 'feishu']);
  finishFeishu({ activeWork: true, conversations: [], pendingRequests: [] });
  finishCodex({ ready: true, active: 0 });
  await assert.rejects(checking, /飞书还有/);
  await assert.rejects(checkIdleServices({ runtime: async () => ({ ready: true, active: 1 }),
    bridge: async () => ({ activeWork: false, conversations: [], pendingRequests: [] }) }), /Codex 任务/);
});

test('uncertain state and failed concurrent checks cannot authorize shutdown', async () => {
  await assert.rejects(checkIdleServices({ runtime: async () => ({ ready: false, active: 0 }) }), /无法确认/);
  await assert.rejects(checkIdleServices({ bridge: async () => ({}) }), /无法确认/);
  let checked = false;
  await assert.rejects(checkIdleServices({ runtime: async () => { throw new Error('connection lost'); },
    bridge: async () => { checked = true; return { activeWork: false, conversations: [], pendingRequests: [] }; } }), /connection lost/);
  assert.equal(checked, true);
});

test('tree capture and idle verification overlap, and closing waits for both', async () => {
  const fx = fixture();
  let finishCapture, finishIdle;
  const snapshot = await fx.options.inspect();
  let checks = 0;
  fx.options.initialSnapshot = snapshot;
  fx.options.assertIdle = async current => {
    assert.ok(current.processes);
    if (++checks === 1) { fx.calls.push('idle'); await new Promise(resolve => { finishIdle = resolve; }); }
  };
  fx.options.captureTree = async () => { fx.calls.push('capture'); return new Promise(resolve => { finishCapture = resolve; }); };
  const closing = closeSharedDesktop(fx.options);
  assert.deepEqual(fx.calls, ['idle', 'capture']);
  finishIdle();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(fx.calls.includes('window'), false);
  finishCapture(identity);
  const after = await closing;
  assert.deepEqual(after.desktopRoots, []);
  assert.deepEqual(fx.calls, ['idle', 'capture', 'window', 'terminate']);
});

test('child exit uses its event, cleans listeners and does not terminate a slow process', async () => {
  const child = Object.assign(new EventEmitter(), { exitCode: null, signalCode: null });
  const waiting = waitForChildExit(child, 5000);
  child.exitCode = 0;
  child.emit('exit', 0);
  assert.equal(await waiting, true);
  assert.equal(child.listenerCount('exit'), 0);
  assert.equal(await waitForChildExit(child), true);
  child.exitCode = null;
  assert.equal(await waitForChildExit(child, 10), false);
  assert.equal(child.listenerCount('exit'), 0);
  assert.equal(child.exitCode, null);
});
