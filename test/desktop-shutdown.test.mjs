import { test } from 'node:test';
import assert from 'node:assert/strict';
import { closeSharedDesktop } from '../desktop/shutdown.mjs';

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
