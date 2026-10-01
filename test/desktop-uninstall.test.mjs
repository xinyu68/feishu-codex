import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { canonicalEnvironment } from '../desktop/lifecycle.mjs';
import { atomicJson, closeWindowsInspectors, inspectWindows, runPowerShell, stopVerified } from '../desktop/windows.mjs';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
after(closeWindowsInspectors);
const pause = () => spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { windowsHide: true, env: canonicalEnvironment(process.env), stdio: 'ignore' });
const alive = child => {
  if (typeof child !== 'number' && (child.exitCode !== null || child.signalCode !== null)) return false;
  try { process.kill(typeof child === 'number' ? child : child.pid, 0); return true; } catch { return false; }
};

async function fixture(mode) {
  // Windows runners may expose TEMP through an 8.3 alias. Use the same native
  // path spelling as PowerShell before writing the ownership records.
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'feishu-uninstall-test-')));
  const installDir = path.join(directory, '安装目录'), dataDir = path.join(directory, '用户数据');
  const productRoot = path.join(installDir, 'resources', 'product');
  await fs.mkdir(productRoot, { recursive: true });
  await atomicJson(path.join(dataDir, 'desktop', 'deployment.json'), { state: 'active', productRoot });
  const codexHome = path.join(directory, 'codex-home');
  await fs.mkdir(codexHome);
  for (const name of ['auth.json', 'config.toml', 'history.jsonl']) await fs.writeFile(path.join(codexHome, name), `retain ${name}`);
  const host = spawn(process.execPath, ['-e', `
    const http=require('node:http'), {spawn}=require('node:child_process');
    const orphan=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{windowsHide:true,detached:true,stdio:'ignore'});
    const server=http.createServer(async(req,res)=>{ let text=''; for await(const c of req)text+=c;
      const body=JSON.parse(text);
      if(req.headers['x-host-token']!=='fixture-token'||body.action!=='shutdownAll'||body.uninstall!==true) {res.writeHead(403);res.end('{}');return;}
      res.setHeader('Content-Type','application/json');
      if(${JSON.stringify(mode)}==='busy'){res.writeHead(409);res.end(JSON.stringify({error:'任务正在运行'}));return;}
      res.end(JSON.stringify(${mode === 'independent' ? '{ok:true,closedDesktop:null}' : '{ok:true}'}));
      setTimeout(()=>process.exit(),100);
    }); server.listen(0,'127.0.0.1',()=>console.log(JSON.stringify({port:server.address().port,orphan:orphan.pid})));`],
  { windowsHide: true, env: canonicalEnvironment(process.env), stdio: ['ignore', 'pipe', 'ignore'] });
  const info = JSON.parse((await once(host.stdout, 'data'))[0].toString());
  const desktop = pause(); await once(desktop, 'spawn');
  const unrelated = pause(); await once(unrelated, 'spawn');
  let snapshot;
  for (let attempt = 0; attempt < 15; attempt++) {
    snapshot = await inspectWindows(root, [info.port], [host.pid, desktop.pid, info.orphan]);
    if ([host.pid, desktop.pid, info.orphan].every(pid => snapshot.processes.some(item => item.pid === pid && item.exe && item.startedAt))) break;
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  const hostIdentity = snapshot.processes.find(item => item.pid === host.pid);
  const desktopIdentity = snapshot.processes.find(item => item.pid === desktop.pid);
  const orphanIdentity = snapshot.processes.find(item => item.pid === info.orphan);
  if (!hostIdentity?.exe || !hostIdentity.startedAt || !desktopIdentity?.exe || !desktopIdentity.startedAt || !orphanIdentity?.exe) {
    host.kill(); desktop.kill(); unrelated.kill();
    if (orphanIdentity?.exe) await stopVerified(root, dataDir, orphanIdentity).catch(() => {});
    throw new Error('fixture process identity missing');
  }
  await atomicJson(path.join(dataDir, 'desktop', 'host-identity.json'), hostIdentity);
  await atomicJson(path.join(dataDir, 'desktop', 'desktop-identity.json'), desktopIdentity);
  await atomicJson(path.join(dataDir, 'desktop', 'host-control.json'), { pid: host.pid, port: info.port, root: productRoot, dataDir, token: 'fixture-token' });
  return { directory, installDir, productRoot, host, desktop, unrelated, info, dataDir, orphanIdentity,
    run: () => runPowerShell(path.join(root, 'scripts', 'desktop-uninstall.ps1'), ['-InstallDir', installDir, '-DataDir', dataDir, '-Phase', 'Cleanup'], { timeout: 60_000 }),
    cleanup: async () => {
      for (const child of [host, desktop, unrelated]) if (alive(child)) child.kill();
      if (orphanIdentity && alive(info.orphan)) await stopVerified(root, dataDir, orphanIdentity).catch(() => {});
      for (const name of ['auth.json', 'config.toml', 'history.jsonl']) assert.equal(await fs.readFile(path.join(codexHome, name), 'utf8'), `retain ${name}`);
    } };
}

test('uninstall releases authenticated host, its orphan and the owned desktop', { skip: process.platform !== 'win32', timeout: 60_000 }, async () => {
  const fx = await fixture('shared');
  try {
    await fx.run();
    assert.equal(alive(fx.host), false); assert.equal(alive(fx.info.orphan), false);
    assert.equal(alive(fx.desktop), false, await fs.readFile(path.join(fx.dataDir, 'desktop', 'uninstall.log'), 'utf8'));
    assert.equal(alive(fx.unrelated), true);
    await fx.run(); // Already-stopped installations remain safely uninstallable.
  } finally { await fx.cleanup(); }
});

test('an active task aborts uninstall without killing the desktop or task host', { skip: process.platform !== 'win32', timeout: 60_000 }, async () => {
  const fx = await fixture('busy');
  try {
    await assert.rejects(fx.run(), /任务正在运行/);
    for (const child of [fx.host, fx.desktop, fx.info.orphan, fx.unrelated]) assert.equal(alive(child), true);
  } finally { await fx.cleanup(); }
});

test('uninstall preserves an independent Codex even with a stale desktop identity record', { skip: process.platform !== 'win32', timeout: 60_000 }, async () => {
  const fx = await fixture('independent');
  try {
    await fx.run();
    assert.equal(alive(fx.host), false); assert.equal(alive(fx.info.orphan), false);
    assert.equal(alive(fx.desktop), true); assert.equal(alive(fx.unrelated), true);
    await fx.run(); // The subsequent NSIS cleanup pass also preserves it.
  } finally { await fx.cleanup(); }
});

test('missing host control aborts before touching a surviving desktop', { skip: process.platform !== 'win32', timeout: 60_000 }, async () => {
  const fx = await fixture('shared');
  try {
    const done = once(fx.host, 'exit'); fx.host.kill(); await done;
    await assert.rejects(fx.run(), /后台控制服务不可用/);
    assert.equal(alive(fx.desktop), true); assert.equal(alive(fx.info.orphan), true);
  } finally { await fx.cleanup(); }
});

test('uninstall removes only its exact scheduled task and login entry, restoring task on refusal', { skip: process.platform !== 'win32', timeout: 90_000 }, async () => {
  const fx = await fixture('busy');
  const taskName = `Feishu Codex Uninstall Test ${path.basename(fx.directory)}`;
  const helper = path.join(fx.directory, 'desktop-uninstall.ps1');
  const quoted = value => `'${value.replaceAll("'", "''")}'`;
  const ps = async (name, body) => {
    const script = path.join(fx.directory, `${name}.ps1`);
    await fs.writeFile(script, '\uFEFF$ErrorActionPreference = "Stop"\n' + body);
    return runPowerShell(script, [], { timeout: 30_000 });
  };
  try {
    // Give the fixture a unique task name; retain all production ownership checks.
    const contents = await fs.readFile(path.join(root, 'scripts', 'desktop-uninstall.ps1'), 'utf8');
    await fs.writeFile(helper, contents.replace("$taskName = 'Feishu Codex Desktop Host'", `$taskName = ${quoted(taskName)}`));
    await fs.copyFile(path.join(root, 'scripts', 'desktop-process-tree.ps1'), path.join(fx.directory, 'desktop-process-tree.ps1'));
    await fs.copyFile(path.join(root, 'scripts', 'desktop-service-listeners.ps1'), path.join(fx.directory, 'desktop-service-listeners.ps1'));
    const args = `//B //NoLogo "${path.join(fx.productRoot, 'scripts', 'desktop-host.vbs')}" "${fx.productRoot}" "${path.join(fx.installDir, 'resources', 'node', 'node.exe')}" "${fx.dataDir}"`;
    await ps('setup', `
$action = New-ScheduledTaskAction -Execute (Join-Path $env:SystemRoot 'System32\\wscript.exe') -Argument ${quoted(args)} -WorkingDirectory ${quoted(fx.productRoot)}
$principal = New-ScheduledTaskPrincipal -UserId ([Security.Principal.WindowsIdentity]::GetCurrent().Name) -LogonType Interactive -RunLevel Limited
Register-ScheduledTask -TaskName ${quoted(taskName)} -Action $action -Principal $principal | Out-Null
$key = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey('Software\\Microsoft\\Windows\\CurrentVersion\\Run')
try { $key.SetValue(${quoted(taskName)}, ${quoted(`"${path.join(fx.installDir, 'Feishu Codex.exe')}"`)}); $key.SetValue(${quoted(taskName + ' Other')}, 'unrelated.exe') } finally { $key.Dispose() }
`);
    const run = () => runPowerShell(helper, ['-InstallDir', fx.installDir, '-DataDir', fx.dataDir, '-Phase', 'Cleanup'], { timeout: 60_000 });
    await assert.rejects(run(), /任务正在运行/);
    await ps('check-restored', `if (-not (Get-ScheduledTask -TaskName ${quoted(taskName)}).Settings.Enabled) { throw 'Task left disabled after refusal' }`);
    // Simulate the user finishing and exiting, then retry the same uninstaller.
    for (const child of [fx.host, fx.desktop]) { const done = once(child, 'exit'); child.kill(); await done; }
    if (alive(fx.info.orphan)) await stopVerified(root, fx.dataDir, fx.orphanIdentity);
    await run();
    await ps('check-removed', `
if (Get-ScheduledTask -TaskName ${quoted(taskName)} -ErrorAction SilentlyContinue) { throw 'Owned task retained' }
$key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Software\\Microsoft\\Windows\\CurrentVersion\\Run')
try {
 if ($null -ne $key.GetValue(${quoted(taskName)})) { throw 'Owned startup retained' }
 if ($key.GetValue(${quoted(taskName + ' Other')}) -ne 'unrelated.exe') { throw 'Unrelated startup modified' }
} finally { $key.Dispose() }
`);
  } finally {
    await ps('cleanup', `
Get-ScheduledTask -TaskName ${quoted(taskName)} -ErrorAction SilentlyContinue | Unregister-ScheduledTask -Confirm:$false
$key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Software\\Microsoft\\Windows\\CurrentVersion\\Run', $true)
try { if ($key) { $key.DeleteValue(${quoted(taskName)}, $false); $key.DeleteValue(${quoted(taskName + ' Other')}, $false) } } finally { if ($key) { $key.Dispose() } }
`).catch(() => {});
    await fx.cleanup();
  }
});
