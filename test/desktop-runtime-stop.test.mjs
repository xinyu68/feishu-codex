import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { stopOwnedRuntimeForUpgrade } from '../desktop/force-quit.mjs';
import { inspectWindows, closeWindowsInspectors, atomicJson } from '../desktop/windows.mjs';
import { canonicalEnvironment } from '../desktop/lifecycle.mjs';

after(closeWindowsInspectors);
const root = path.resolve(import.meta.dirname, '..');
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };

test('an idle runtime stop keeps its detached developer process and unrelated services alive', { skip: process.platform !== 'win32', timeout: 30_000 }, async () => {
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'feishu-runtime-stop-')));
  const productRoot = path.join(directory, 'product'), exe = path.join(directory, 'codex.exe');
  await fs.mkdir(path.join(productRoot, 'scripts'), { recursive: true });
  await fs.copyFile(process.execPath, exe);
  await fs.copyFile(path.join(root, 'scripts/desktop-force-quit.ps1'), path.join(productRoot, 'scripts/desktop-force-quit.ps1'));
  const code = `const{spawn}=require('node:child_process');const c=spawn(${JSON.stringify(process.execPath)},['-e','setInterval(()=>{},1000)'],{stdio:'ignore',windowsHide:true,detached:true});console.log(c.pid);setInterval(()=>{},1000);`;
  const backend = spawn(exe, ['-e', code], { windowsHide: true, env: canonicalEnvironment(process.env), stdio: ['ignore', 'pipe', 'ignore'] });
  const other = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { windowsHide: true, stdio: 'ignore' });
  let developerPid;
  try {
    developerPid = Number((await once(backend.stdout, 'data'))[0].toString().trim());
    const snapshot = await inspectWindows(root, [18792], [backend.pid, developerPid, other.pid]);
    const identity = snapshot.processes.find(process => process.pid === backend.pid); assert.ok(identity?.startedAt);
    await atomicJson(path.join(directory, 'desktop/deployment.json'), { productRoot });
    await atomicJson(path.join(directory, 'desktop/runtime-identity.json'), identity);
    await assert.rejects(stopOwnedRuntimeForUpgrade({ root: productRoot, dataDir: directory, identity: { ...identity, startedAt: '2000-01-01T00:00:00.000Z' } }), /归属已变化/);
    assert.equal(alive(backend.pid), true);
    await stopOwnedRuntimeForUpgrade({ root: productRoot, dataDir: directory, identity });
    for (let i = 0; i < 30 && alive(backend.pid); i++) await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal(alive(backend.pid), false);
    assert.equal(alive(developerPid), true); assert.equal(alive(other.pid), true);
    assert.equal((await fs.readdir(path.join(directory, 'desktop'))).some(name => name.startsWith('runtime-upgrade-')), false);
  } finally {
    for (const pid of [backend.pid, developerPid, other.pid].filter(Boolean)) if (alive(pid)) { try { process.kill(pid); } catch {} }
    assert.equal(path.dirname(directory), await fs.realpath(os.tmpdir())); assert.ok(path.basename(directory).startsWith('feishu-runtime-stop-'));
    await fs.rm(directory, { recursive: true, force: true, maxRetries: 6, retryDelay: 100 });
  }
});
