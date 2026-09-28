import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { canonicalEnvironment } from '../desktop/lifecycle.mjs';
import { captureProcessTree, closeWindowVerified, closeWindowsInspectors, inspectWindows, powershell, runWindowlessScript, stopVerified } from '../desktop/windows.mjs';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
after(closeWindowsInspectors);

test('Windows inspection reuses one hidden worker for repeated and concurrent checks', { skip: process.platform !== 'win32', timeout: 20_000 }, async () => {
  const snapshots = await Promise.all([
    inspectWindows(root, [8790, 18791, 18792], [process.pid]),
    inspectWindows(root, [8790, 18791, 18792], [process.pid]),
    inspectWindows(root, [8790, 18791, 18792], [process.pid]),
  ]);
  for (const snapshot of snapshots) {
    assert.ok(snapshot.processes.some(item => item.pid === process.pid));
    assert.ok(Array.isArray(snapshot.connections));
  }
});

test('tree stop removes an orphaned child and leaves an unrelated process alive', { skip: process.platform !== 'win32', timeout: 40_000 }, async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'feishu-tree-stop-test-'));
  const options = { windowsHide: true, env: canonicalEnvironment(process.env), stdio: ['pipe', 'pipe', 'ignore'] };
  const parent = spawn(process.execPath, ['-e', `const {spawn}=require('node:child_process'); const c=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{windowsHide:true,detached:true,stdio:'ignore'}); console.log(c.pid); process.stdin.once('data',()=>process.exit()); setInterval(()=>{},1000);`], options);
  const unrelated = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { ...options, stdio: 'ignore' });
  let childPid;
  try {
    childPid = Number((await once(parent.stdout, 'data'))[0].toString().trim());
    const snapshot = await inspectWindows(root, [18792], [parent.pid, childPid]);
    const record = snapshot.processes.find(value => value.pid === parent.pid);
    const captured = await captureProcessTree(root, directory, record);
    assert.ok(captured.tree.some(value => value.pid === childPid));
    const exited = once(parent, 'exit'); parent.stdin.write('exit'); await exited;
    process.kill(childPid, 0);
    await stopVerified(root, directory, captured);
    assert.throws(() => process.kill(childPid, 0));
    process.kill(unrelated.pid, 0);
  } finally {
    if (parent.exitCode === null) parent.kill();
    if (childPid) { try { process.kill(childPid); } catch {} }
    unrelated.kill();
    const desktop = path.join(directory, 'desktop');
    for (const name of await fs.readdir(desktop).catch(() => [])) await fs.unlink(path.join(desktop, name));
    await fs.rmdir(desktop).catch(() => {}); await fs.rmdir(directory).catch(() => {});
  }
});

test('windowless script runner executes VBScript without a console host', { skip: process.platform !== 'win32', timeout: 10_000 }, async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'feishu-vbs-test-'));
  const script = path.join(directory, 'write.vbs'), output = path.join(directory, 'result.txt');
  try {
    await fs.writeFile(script, 'Set f=CreateObject("Scripting.FileSystemObject")\nSet o=f.CreateTextFile(WScript.Arguments(0),True,False)\no.Write "ok"\no.Close\n', 'ascii');
    await runWindowlessScript(script, [output]);
    assert.equal(await fs.readFile(output, 'ascii'), 'ok');
  } finally {
    for (const file of [script, output]) await fs.unlink(file).catch(() => {});
    await fs.rmdir(directory).catch(() => {});
  }
});

test('Windows inspection includes a recorded PID even after reuse by a non-Node process', { skip: process.platform !== 'win32', timeout: 20_000 }, async () => {
  const child = spawn(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', 'Start-Sleep -Seconds 15'], { windowsHide: true, env: canonicalEnvironment(process.env), stdio: 'ignore' });
  await once(child, 'spawn');
  try {
    const snapshot = await inspectWindows(root, [18792], [child.pid]);
    const found = snapshot.processes.find(item => item.pid === child.pid);
    assert.ok(found, 'the explicit process ID must reach the PowerShell inspector');
    assert.match(found.name, /powershell\.exe/i);
  } finally { if (child.exitCode === null) child.kill(); }
});

test('Windows ownership stop refuses wrong executable and releases only its isolated fixture', { skip: process.platform !== 'win32', timeout: 40_000 }, async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'feishu-desktop-stop-test-'));
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { windowsHide: true, env: canonicalEnvironment(process.env), stdio: 'ignore' });
  await once(child, 'spawn');
  try {
    let processInfo;
    for (let attempt = 0; attempt < 8; attempt++) {
      const snapshot = await inspectWindows(root, [18792], [child.pid]);
      processInfo = snapshot.processes.find(item => item.pid === child.pid);
      if (processInfo?.startedAt && processInfo.exe) break;
      await new Promise(resolve => setTimeout(resolve, 200));
    }
    assert.ok(processInfo?.startedAt && processInfo.exe, 'Windows must expose the isolated fixture identity before a stop is attempted');
    const identity = { pid: processInfo.pid, exe: processInfo.exe, startedAt: processInfo.startedAt };
    await assert.rejects(stopVerified(root, directory, { ...identity, exe: 'C:\\unrelated\\node.exe' }), /身份/);
    assert.equal(child.exitCode, null);
    await assert.rejects(closeWindowVerified(root, directory, { ...identity, exe: 'C:\\unrelated\\node.exe' }), /身份/);
    await closeWindowVerified(root, directory, identity);
    assert.equal(child.exitCode, null, 'a tray-less process is not force-stopped by the normal window close request');
    const exited = once(child, 'exit');
    await stopVerified(root, directory, identity);
    await exited;
    assert.notEqual(child.exitCode, null);
  } finally {
    if (child.exitCode === null) child.kill();
    // This test creates only the named metadata files; no recursive deletion.
    const desktop = path.join(directory, 'desktop');
    for (const name of await fs.readdir(desktop).catch(() => [])) await fs.unlink(path.join(desktop, name));
    await fs.rmdir(desktop).catch(() => {}); await fs.rmdir(directory).catch(() => {});
  }
});
