import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { applicationExecutables, independentDesktop, stopIndependentDesktop } from '../desktop/switch-desktop.mjs';
import { canonicalEnvironment } from '../desktop/lifecycle.mjs';
import { captureProcessTree, closeWindowVerified, closeWindowsInspectors, inspectWindows, stopVerified } from '../desktop/windows.mjs';

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

test('switch protection covers packaged and development application entry points', () => {
  assert.deepEqual(applicationExecutables(path.join('E:/software/Feishu Codex', 'resources', 'product')),
    [path.resolve('E:/software/Feishu Codex/Feishu Codex.exe')]);
  assert.deepEqual(applicationExecutables(path.resolve('development')),
    [path.resolve('development/node_modules/electron/dist/electron.exe')]);
});

test('a nested Feishu application and its backend are excluded from independent task selection', async () => {
  const f = fixture();
  const app = { pid: 40, parentPid: backend.pid, exe: 'C:\\Feishu Codex\\Feishu Codex.exe', startedAt: 'app' };
  const appBackend = { ...backend, pid: 41, parentPid: app.pid, startedAt: 'application-backend' };
  f.replace([root, backend, shared, app, appBackend]);
  const identities = [];
  const stop = f.options.terminate;
  f.options.terminate = async identity => { identities.push(identity); await stop(identity); };
  await stopIndependentDesktop({ ...f.options, preserveExecutables: [app.exe] });
  assert.deepEqual(f.calls, ['close:10', 'stop:10', 'stop:12']);
  assert.deepEqual(f.processes(), [shared, app, appBackend]);
  assert.ok(identities.every(identity => identity.preserveExecutables[0] === app.exe));
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

for (const legacy of [false, true]) test(`Windows switch preserves a nested application and captured helpers (${legacy ? 'older host without metadata' : 'explicit protection'})`, { skip: process.platform !== 'win32', timeout: 60_000 }, async () => {
  const project = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'feishu-switch-preserve-')));
  const backendExe = path.join(directory, 'codex.exe'), appExe = path.join(directory, 'Feishu Codex.exe');
  await fs.copyFile(process.execPath, backendExe); await fs.copyFile(process.execPath, appExe);
  let parentExe = process.execPath, stopRoot = project;
  if (legacy) {
    parentExe = path.join(directory, 'ChatGPT.exe'); await fs.copyFile(process.execPath, parentExe);
    stopRoot = path.join(directory, 'resources/product');
    await fs.mkdir(path.join(stopRoot, 'scripts'), { recursive: true });
    for (const file of ['desktop-stop-owned.ps1', 'desktop-process-tree.ps1']) await fs.copyFile(path.join(project, 'scripts', file), path.join(stopRoot, 'scripts', file));
  }
  const appCode = `const {spawn}=require('node:child_process');const w=spawn(${JSON.stringify(process.execPath)},['-e','setInterval(()=>{},1000)'],{windowsHide:true,stdio:'ignore'});w.once('spawn',()=>console.log(JSON.stringify({appPid:process.pid,workerPid:w.pid})));setInterval(()=>{},1000);`;
  // The application is a GUI process in production. Give this console-based
  // stand-in its own console, while retaining the same parent/child topology.
  const backendCode = `const {spawn}=require('node:child_process');const c=spawn(${JSON.stringify(appExe)},['-e',${JSON.stringify(appCode)}],{windowsHide:true,detached:true,stdio:['ignore','pipe','ignore']});c.stdout.on('data',b=>console.log(JSON.stringify({...JSON.parse(b.toString()),backendPid:process.pid})));setInterval(()=>{},1000);`;
  const parentCode = `const {spawn}=require('node:child_process');const c=spawn(${JSON.stringify(backendExe)},['-e',${JSON.stringify(backendCode)},'--','app-server'],{windowsHide:true,stdio:['ignore','pipe','ignore']});c.stdout.pipe(process.stdout);setInterval(()=>{},1000);`;
  const child = spawn(parentExe, ['-e', parentCode], { windowsHide: true, env: canonicalEnvironment(process.env), stdio: ['ignore', 'pipe', 'pipe'] });
  let appIdentity;
  try {
    const pids = await new Promise((resolve, reject) => {
      let output = ''; const timer = setTimeout(() => reject(Error('nested application fixture not ready')), 10_000);
      child.once('error', error => { clearTimeout(timer); reject(error); });
      child.stdout.on('data', value => { output += value; if (output.includes('\n')) { clearTimeout(timer); resolve(JSON.parse(output.trim())); } });
    });
    const ids = [child.pid, pids.backendPid, pids.appPid, pids.workerPid];
    const inspect = async () => { const s = await inspectWindows(project, [18792], ids); return { ...s, unknownDesktop: false, desktopRoots: s.processes.filter(p => p.pid === child.pid) }; };
    const before = await inspect(); const desktop = before.desktopRoots[0];
    appIdentity = before.processes.find(p => p.pid === pids.appPid);
    assert.ok(desktop?.startedAt && appIdentity?.startedAt);
    assert.equal(appIdentity.parentPid, pids.backendPid, 'the protected app must actually be nested below the old Codex backend');
    const captured = await captureProcessTree(project, directory, desktop);
    assert.ok(captured.tree.some(p => p.pid === pids.appPid));
    await stopIndependentDesktop({ inspect, expected: desktop, sharedPort: 18791, ...(legacy ? {} : { preserveExecutables: [appExe] }), requestClose: async () => {},
      terminate: identity => stopVerified(stopRoot, directory, identity.pid === desktop.pid ? { ...captured, ...identity } : identity) });
    const after = await inspect();
    assert.ok(!after.processes.some(p => p.pid === child.pid || p.pid === pids.backendPid));
    assert.ok(after.processes.some(p => p.pid === pids.appPid), 'application must remain alive');
    assert.ok(after.processes.some(p => p.pid === pids.workerPid), 'application descendants must remain alive');
  } finally {
    if (appIdentity) await stopVerified(project, directory, appIdentity).catch(() => {});
    if (child.exitCode === null) child.kill();
    assert.equal(path.dirname(directory), await fs.realpath(os.tmpdir()));
    assert.ok(path.basename(directory).startsWith('feishu-switch-preserve-'));
    await fs.rm(directory, { recursive: true, force: true });
  }
});
