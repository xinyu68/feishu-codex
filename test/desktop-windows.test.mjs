import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { canonicalEnvironment } from '../desktop/lifecycle.mjs';
import { captureProcessTree, closeWindowVerified, closeWindowsInspectors, inspectWindows, powershell, runWindowlessScript, stopVerified } from '../desktop/windows.mjs';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
after(closeWindowsInspectors);

test('native TCP inspection retains listener and established ownership in both address families', { skip: process.platform !== 'win32', timeout: 25_000 }, async () => {
  for (const address of ['127.0.0.1', '::1']) {
    const sockets = [];
    const server = net.createServer(socket => sockets.push(socket));
    let client;
    try {
      await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, address, resolve); });
      const port = server.address().port;
      client = net.connect({ host: address, port });
      await once(client, 'connect');
      const snapshot = await inspectWindows(root, [port], [process.pid]);
      const listener = snapshot.connections.find(row => row.state === 'Listen' && row.localPort === port && row.pid === process.pid);
      assert.equal(listener?.localAddress, address);
      assert.ok(snapshot.connections.some(row => row.remotePort === port && row.pid === process.pid && row.state === 'Established'));
      assert.ok(snapshot.connections.every(row => row.localPort === port || row.remotePort === port));
    } finally {
      client?.destroy(); for (const socket of sockets) socket.destroy();
      await new Promise(resolve => server.close(resolve));
    }
  }
});

test('queued Windows checks get individual deadlines and timed out workers recover', { skip: process.platform !== 'win32', timeout: 30_000 }, async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'feishu-inspector-queue-'));
  const script = path.join(directory, 'scripts/desktop-inspect.ps1');
  await fs.mkdir(path.dirname(script));
  const fixture = delay => `param([switch]$Server, [switch]$ProgressOutput)
while ($null -ne ($line = [Console]::In.ReadLine())) {
  $r = $line | ConvertFrom-Json
  [Console]::Out.WriteLine((@{id=$r.id;stage='processes'} | ConvertTo-Json -Compress))
  [Console]::Out.Flush()
  Start-Sleep -Milliseconds ${delay}
  [Console]::Out.WriteLine((@{id=$r.id;ok=$true;result=@{processes=@();connections=@()}} | ConvertTo-Json -Depth 5 -Compress))
  [Console]::Out.Flush()
}`;
  try {
    // Warm up the worker separately so startup load cannot affect this check.
    await fs.writeFile(script, fixture(1100));
    await inspectWindows(directory, [18792]);
    await Promise.all(Array.from({ length: 4 }, () => inspectWindows(directory, [18792], [], { timeout: 2500 })));
    closeWindowsInspectors();
    await fs.writeFile(script, fixture(10000));
    await assert.rejects(inspectWindows(directory, [18792], [], { timeout: 3000 }), /Windows 检查超时.*进程身份/);
    await fs.writeFile(script, fixture(0));
    assert.ok((await inspectWindows(directory, [18792])).connections);
  } finally {
    closeWindowsInspectors();
    await fs.unlink(script); await fs.rmdir(path.dirname(script)); await fs.rmdir(directory);
  }
});

test('a verified exited service with a lingering Windows listener can finish cleanup without touching another process', { skip: process.platform !== 'win32', timeout: 40_000 }, async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'feishu-lingering-port-test-'));
  const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { windowsHide: true, env: canonicalEnvironment(process.env), stdio: 'ignore' });
  await once(child, 'spawn');
  try {
    const state = await inspectWindows(root, [18791], [child.pid]);
    const identity = state.processes.find(item => item.pid === child.pid);
    assert.ok(identity?.exe && identity.startedAt);
    await fs.mkdir(path.join(directory, 'scripts'));
    const script = await fs.readFile(path.join(root, 'scripts/desktop-stop-owned.ps1'), 'utf8');
    // Model the Windows failure: TCP still reports the terminated owner's PID.
    const mocked = script.replace(/@\(\[FeishuCodex\.TcpSnapshot\]::Read[^\n]+/, `@([pscustomobject]@{ pid = ${child.pid}; state = 'Listen'; localPort = $ServicePort; localAddress = '127.0.0.1' })`);
    assert.notEqual(mocked, script);
    await fs.writeFile(path.join(directory, 'scripts/desktop-stop-owned.ps1'), '\uFEFF' + mocked.replace(/^\uFEFF/, ''));
    await fs.copyFile(path.join(root, 'scripts/desktop-process-tree.ps1'), path.join(directory, 'scripts/desktop-process-tree.ps1'));
    await fs.copyFile(path.join(root, 'scripts/desktop-tcp-snapshot.ps1'), path.join(directory, 'scripts/desktop-tcp-snapshot.ps1'));
    const exited = once(child, 'exit');
    await stopVerified(directory, directory, identity, 18791);
    await exited;
    assert.notEqual(child.exitCode, null);
  } finally { if (child.exitCode === null) child.kill(); }
});

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

test('native exit port checks reject a foreign listener and bypass the slow NetTCPIP provider', { skip: process.platform !== 'win32', timeout: 25_000 }, async () => {
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'feishu-native-exit-')));
  const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { windowsHide: true, env: canonicalEnvironment(process.env), stdio: 'ignore' });
  const server = net.createServer();
  await once(child, 'spawn');
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    const snapshot = await inspectWindows(root, [port], [child.pid]);
    const identity = snapshot.processes.find(item => item.pid === child.pid);
    await fs.mkdir(path.join(directory, 'scripts'));
    for (const name of ['desktop-process-tree.ps1', 'desktop-tcp-snapshot.ps1']) await fs.copyFile(path.join(root, 'scripts', name), path.join(directory, 'scripts', name));
    const script = await fs.readFile(path.join(root, 'scripts/desktop-stop-owned.ps1'), 'utf8');
    const guarded = script.replace(/^(\uFEFF?param\([^\n]*\)\r?\n)/, '$1function Get-NetTCPConnection { throw "Slow provider must not be used" }\n');
    await fs.writeFile(path.join(directory, 'scripts/desktop-stop-owned.ps1'), '\uFEFF' + guarded.replace(/^\uFEFF/, ''));
    await assert.rejects(stopVerified(directory, directory, identity, port), /监听端口属于其他进程/);
    assert.equal(child.exitCode, null, 'foreign port must be rejected before termination');
    await new Promise(resolve => server.close(resolve));
    const exited = once(child, 'exit');
    await stopVerified(directory, directory, identity, port);
    await exited;
  } finally {
    if (server.listening) await new Promise(resolve => server.close(resolve));
    if (child.exitCode === null) child.kill();
    assert.equal(path.dirname(directory), await fs.realpath(os.tmpdir()));
    assert.ok(path.basename(directory).startsWith('feishu-native-exit-'));
    await fs.rm(directory, { recursive: true, force: true });
  }
});
