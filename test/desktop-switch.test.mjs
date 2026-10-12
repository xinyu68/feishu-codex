import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { independentDesktop, stopIndependentDesktop } from '../desktop/switch-desktop.mjs';
import { canonicalEnvironment } from '../desktop/lifecycle.mjs';
import { closeWindowVerified, closeWindowsInspectors, inspectWindows, stopVerified } from '../desktop/windows.mjs';

after(closeWindowsInspectors);

const root = { pid: 10, exe: 'C:\\Codex\\ChatGPT.exe', startedAt: 'root', parentPid: 1 };
const backend = { pid: 12, exe: 'C:\\Codex\\codex.exe', startedAt: 'independent', parentPid: 10, commandLine: 'codex.exe app-server' };
const shared = { ...backend, pid: 30, parentPid: 22, startedAt: 'shared' };
function fixture() {
  let processes = [root, backend, shared];
  const calls = [];
  const options = { expected: root, sharedPort: 18791,
    inspect: async () => ({ processes, desktopRoots: processes.filter(item => item.pid === 10), connections: [], unknownDesktop: false }),
    requestClose: async identity => { calls.push(`close:${identity.pid}`); },
    terminate: async identity => { calls.push(`stop:${identity.pid}`); processes = processes.filter(item => item.pid !== identity.pid); },
  };
  return { options, calls, processes: () => processes, replace: value => { processes = value; } };
}
test('explicit switch ends independent desktop and its task backend while retaining shared runtime', async () => {
  const f = fixture(); await stopIndependentDesktop(f.options);
  assert.deepEqual(f.calls, ['close:10', 'stop:10', 'stop:12']);
  assert.deepEqual(f.processes(), [shared]);
});
test('a backend orphaned by normal desktop close is still stopped by its captured identity', async () => {
  const f = fixture(); f.options.requestClose = async () => f.replace([backend, shared]);
  await stopIndependentDesktop(f.options);
  assert.deepEqual(f.calls, ['stop:10', 'stop:12']); assert.deepEqual(f.processes(), [shared]);
});
test('PID replacement while the confirmation is open cannot close a new desktop', async () => {
  const f = fixture(); f.replace([{ ...root, startedAt: 'replacement' }, backend, shared]);
  await assert.rejects(stopIndependentDesktop(f.options), /已重新打开/); assert.deepEqual(f.calls, []);
});
test('unknown and shared desktops are never selected for independent termination', async () => {
  const f = fixture(); f.replace([root, shared]);
  await assert.rejects(stopIndependentDesktop({ ...f.options, launched: root }), /已重新打开/);
  assert.deepEqual(f.calls, []);
  assert.throws(() => independentDesktop({ desktopRoots: [root], processes: [root], unknownDesktop: true }, 18791), /无法确认/);
});
test('an unexpected window during termination prevents a successful switch', async () => {
  const f = fixture(); const stop = f.options.terminate;
  f.options.terminate = async identity => { await stop(identity); if (identity.pid === 12) f.replace([{ ...root, startedAt: 'new' }, shared]); };
  await assert.rejects(stopIndependentDesktop(f.options), /新打开的 Codex/);
});

test('a briefly retained exited identity is rechecked without terminating it twice', async () => {
  const f = fixture();
  const inspect = f.options.inspect;
  let reads = 0, time = 0;
  f.options.inspect = async () => {
    const snapshot = await inspect();
    if (++reads === 2) return { ...snapshot, processes: [root, backend, shared], desktopRoots: [root] };
    return snapshot;
  };
  await stopIndependentDesktop({ ...f.options, now: () => time, sleep: async ms => { time += ms; } });
  assert.equal(reads, 3);
  assert.deepEqual(f.calls, ['close:10', 'stop:10', 'stop:12']);
});

test('exit settling is bounded and a new desktop is never stopped during recovery', async () => {
  const f = fixture();
  let time = 0;
  f.options.terminate = async identity => { f.calls.push(`stop:${identity.pid}`); };
  await assert.rejects(stopIndependentDesktop({ ...f.options, settleMs: 500, now: () => time, sleep: async ms => { time += ms; } }), /尚未完全退出/);
  assert.equal(time, 500);
  assert.deepEqual(f.calls, ['close:10', 'stop:10', 'stop:12']);
  const g = fixture();
  let reads = 0;
  const inspect = g.options.inspect;
  g.options.inspect = async () => ++reads === 3
    ? { processes: [{ ...root, startedAt: 'new' }, shared], desktopRoots: [{ ...root, startedAt: 'new' }], connections: [], unknownDesktop: false }
    : reads === 2 ? { processes: [backend, shared], desktopRoots: [], connections: [], unknownDesktop: false } : inspect();
  await assert.rejects(stopIndependentDesktop({ ...g.options, sleep: async () => {} }), /未关闭新窗口/);
  assert.deepEqual(g.calls, ['close:10', 'stop:10', 'stop:12']);
});

test('Windows switch removes only its isolated desktop and orphaned backend processes', { skip: process.platform !== 'win32', timeout: 30_000 }, async () => {
  const project = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'feishu-switch-test-'));
  const alias = path.join(directory, 'codex.exe');
  await fs.copyFile(process.execPath, alias);
  const child = spawn(process.execPath, ['-e', "const {spawn}=require('node:child_process'); const child=spawn(process.argv[1],['-e','setInterval(()=>{},1000)','--','app-server'],{windowsHide:true,stdio:'ignore'}); child.once('spawn',()=>console.log(child.pid)); setInterval(()=>{},1000)", alias], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: canonicalEnvironment(process.env) });
  let backendIdentity;
  try {
    const backendPid = await new Promise((resolve, reject) => {
      let output = ''; const timer = setTimeout(() => reject(new Error('fixture backend did not start')), 8_000);
      child.once('error', error => { clearTimeout(timer); reject(error); });
      child.stdout.on('data', chunk => { output += chunk; if (output.includes('\n')) { clearTimeout(timer); resolve(Number(output.trim())); } });
    });
    const inspect = async () => {
      const result = await inspectWindows(project, [18792], [child.pid, backendPid]);
      return { ...result, unknownDesktop: false, desktopRoots: result.processes.filter(item => item.pid === child.pid) };
    };
    const before = await inspect(); const desktop = before.desktopRoots[0];
    backendIdentity = before.processes.find(item => item.pid === backendPid);
    assert.ok(desktop?.startedAt && backendIdentity?.startedAt);
    await stopIndependentDesktop({ inspect, expected: desktop, sharedPort: 18791,
      requestClose: identity => closeWindowVerified(project, directory, identity),
      terminate: identity => stopVerified(project, directory, identity) });
    const remaining = await inspect();
    assert.equal(remaining.processes.some(item => item.pid === child.pid || item.pid === backendPid), false);
    assert.ok(remaining.processes.some(item => item.pid === process.pid), 'the unrelated test runner must stay alive');
  } finally {
    if (child.exitCode === null) child.kill();
    if (backendIdentity) await stopVerified(project, directory, backendIdentity).catch(() => {});
    if (path.dirname(directory) !== os.tmpdir() || !path.basename(directory).startsWith('feishu-switch-test-')) throw new Error('Unexpected fixture path');
    await fs.rm(directory, { recursive: true, force: true });
  }
});
