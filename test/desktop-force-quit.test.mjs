import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { forceQuitOwnedServices } from '../desktop/force-quit.mjs';
import { atomicJson, inspectWindows, closeWindowsInspectors, runPowerShell } from '../desktop/windows.mjs';
import { canonicalEnvironment } from '../desktop/lifecycle.mjs';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
after(closeWindowsInspectors);
const live = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };

for (const rootOnly of [false, true]) test(`native force exit preserves unrelated processes and handles root-only control restart (${rootOnly})`, { skip: process.platform !== 'win32', timeout: 30_000 }, async () => {
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'feishu-force-exit-')));
  const opts = { windowsHide: true, env: canonicalEnvironment(process.env), stdio: ['ignore', 'pipe', 'ignore'] };
  const host = spawn(process.execPath, ['-e', `const{spawn}=require('node:child_process');const c=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{windowsHide:true,detached:true,stdio:'ignore'});console.log(c.pid);setInterval(()=>{},1000);`], opts);
  const independent = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { ...opts, stdio: 'ignore' });
  let childPid;
  try {
    childPid = Number((await once(host.stdout, 'data'))[0].toString().trim());
    const state = await inspectWindows(root, [18792], [host.pid, independent.pid, childPid]);
    const identity = state.processes.find(p => p.pid === host.pid), other = state.processes.find(p => p.pid === independent.pid);
    assert.ok(identity?.startedAt && other?.startedAt);
    await atomicJson(path.join(directory, 'desktop/deployment.json'), { productRoot: root, state: 'active' });
    await atomicJson(path.join(directory, 'desktop/host-identity.json'), identity);
    // A PID reused by an unrelated process must not redirect the forced exit.
    await atomicJson(path.join(directory, 'desktop/desktop-identity.json'), { ...other, startedAt: '2000-01-01T00:00:00.000Z' });
    const result = await forceQuitOwnedServices({ root, dataDir: directory, run: async (script, args, options) => {
      if (rootOnly) { const file = args[args.indexOf('-InputFile') + 1], data = JSON.parse(await fs.readFile(file, 'utf8')); data.rootOnly = true; await fs.writeFile(file, JSON.stringify(data)); }
      return runPowerShell(script, args, options);
    } });
    assert.equal(result.success, true); assert.ok(result.terminated >= (rootOnly ? 1 : 2));
    for (let i = 0; i < 30 && (live(host.pid) || (!rootOnly && live(childPid))); i++) await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal(live(host.pid), false); assert.equal(live(childPid), rootOnly);
    assert.equal(live(independent.pid), true);
    assert.deepEqual((await fs.readdir(path.join(directory, 'desktop'))).filter(name => name.startsWith('force-exit-')), []);
  } finally {
    for (const pid of [host.pid, independent.pid, childPid].filter(Boolean)) { if (live(pid)) { try { process.kill(pid); } catch {} } }
    assert.equal(path.dirname(directory), await fs.realpath(os.tmpdir())); assert.ok(path.basename(directory).startsWith('feishu-force-exit-'));
    await fs.rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test('an installation mismatch never targets the other installation processes', async () => {
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'feishu-force-exit-mismatch-')));
  try {
    await atomicJson(path.join(directory, 'desktop/deployment.json'), { productRoot: path.join(root, 'other-install') });
    const result = await forceQuitOwnedServices({ root, dataDir: directory, run: async () => { throw Error('Must not execute'); } });
    assert.equal(result.skipped, true);
  } finally {
    assert.equal(path.dirname(directory), await fs.realpath(os.tmpdir())); assert.ok(path.basename(directory).startsWith('feishu-force-exit-'));
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('force exit preserves a nested application branch until its own UI exits', { skip: process.platform !== 'win32', timeout: 30_000 }, async () => {
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'feishu-force-ui-')));
  const install = path.join(directory, 'install'), productRoot = path.join(install, 'resources/product'), appExe = path.join(install, 'Feishu Codex.exe');
  await fs.mkdir(path.join(productRoot, 'scripts'), { recursive: true });
  await fs.copyFile(process.execPath, appExe);
  await fs.copyFile(path.join(root, 'scripts/desktop-force-quit.ps1'), path.join(productRoot, 'scripts/desktop-force-quit.ps1'));
  const appCode = `const{spawn}=require('node:child_process');const w=spawn(${JSON.stringify(process.execPath)},['-e','setInterval(()=>{},1000)'],{windowsHide:true,stdio:'ignore'});console.log(JSON.stringify({appPid:process.pid,workerPid:w.pid}));setInterval(()=>{},1000);`;
  const hostCode = `const{spawn}=require('node:child_process');const c=spawn(${JSON.stringify(appExe)},['-e',${JSON.stringify(appCode)}],{windowsHide:true,detached:true,stdio:['ignore','pipe','ignore']});c.stdout.pipe(process.stdout);setInterval(()=>{},1000);`;
  const host = spawn(process.execPath, ['-e', hostCode], { windowsHide: true, env: canonicalEnvironment(process.env), stdio: ['ignore', 'pipe', 'ignore'] });
  let ids;
  try {
    ids = JSON.parse((await once(host.stdout, 'data'))[0].toString().trim());
    const state = await inspectWindows(root, [18792], [host.pid, ids.appPid, ids.workerPid]);
    const identity = state.processes.find(p => p.pid === host.pid); assert.ok(identity?.startedAt);
    await atomicJson(path.join(directory, 'desktop/deployment.json'), { productRoot });
    await atomicJson(path.join(directory, 'desktop/host-identity.json'), identity);
    await forceQuitOwnedServices({ root: productRoot, dataDir: directory });
    for (let i = 0; i < 20 && live(host.pid); i++) await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal(live(host.pid), false); assert.equal(live(ids.appPid), true); assert.equal(live(ids.workerPid), true);
  } finally {
    for (const pid of [host.pid, ids?.appPid, ids?.workerPid].filter(Boolean)) if (live(pid)) { try { process.kill(pid); } catch {} }
    assert.equal(path.dirname(directory), await fs.realpath(os.tmpdir())); assert.ok(path.basename(directory).startsWith('feishu-force-ui-'));
    await fs.rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
