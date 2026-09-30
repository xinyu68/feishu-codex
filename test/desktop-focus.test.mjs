import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { canonicalEnvironment } from '../desktop/lifecycle.mjs';
import { runPowerShell } from '../desktop/windows.mjs';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const windows = { skip: process.platform !== 'win32', timeout: 60_000 };
const quote = value => `'${value.replaceAll("'", "''")}'`;

test('launch and focus failures preserve readable Chinese without PowerShell error records', windows, async () => {
  for (const pid of [0, process.pid]) {
    await assert.rejects(runPowerShell(path.join(root, 'scripts/desktop-focus.ps1'), ['-ProcessId', pid]),
      { message: '未找到可切换的 Codex 窗口。' });
  }
  await assert.rejects(runPowerShell(path.join(root, 'scripts/launch-packaged-shared.ps1'),
    ['-WsUrl', 'invalid-url', '-ResultPath', path.join(os.tmpdir(), 'unused-launch-result.json')]), error => {
    assert.match(error.message, /^共享模式的 WsUrl 必须为/);
    assert.doesNotMatch(error.message, /\uFFFD|CategoryInfo|FullyQualifiedErrorId/);
    return true;
  });
});

test('PowerShell output survives split UTF-8 bytes and is drained before completion', windows, async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "feishu-中文'output-"));
  const script = path.join(directory, '输出.ps1');
  const expected = '中文错误：窗口未就绪。';
  try {
    await fs.writeFile(script, `\uFEFF$bytes = [Text.Encoding]::UTF8.GetBytes('${expected}')
$stream = [Console]::OpenStandardOutput()
foreach ($byte in $bytes) { $stream.WriteByte($byte); $stream.Flush(); Start-Sleep -Milliseconds 2 }
`);
    assert.equal(await runPowerShell(script), expected);
    await fs.writeFile(script, `\uFEFF$bytes = [Text.Encoding]::UTF8.GetBytes('${expected}')
$stream = [Console]::OpenStandardError()
foreach ($byte in $bytes) { $stream.WriteByte($byte); $stream.Flush(); Start-Sleep -Milliseconds 2 }
exit 7
`);
    await assert.rejects(runPowerShell(script), { message: expected });
  } finally {
    await fs.unlink(script).catch(() => {});
    await fs.rmdir(directory);
  }
});

test('restores isolated hidden and minimized Electron windows without touching other processes', windows, async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'feishu-window-restore-'));
  const entry = path.join(directory, 'fixture.cjs');
  const helper = path.join(directory, 'restore.ps1');
  const readyFile = path.join(directory, 'ready.json');
  const errorFile = path.join(directory, 'error.txt');
  await fs.writeFile(path.join(directory, 'package.json'), JSON.stringify({ name: 'feishu-window-restore-test', main: 'fixture.cjs' }));
  await fs.writeFile(entry, `
const fs = require('node:fs');
process.on('uncaughtException', error => { fs.writeFileSync(${JSON.stringify(errorFile)}, String(error.stack)); process.exit(1); });
const { app, BrowserWindow } = require('electron');
const http = require('node:http');
app.setPath('userData', ${JSON.stringify(path.join(directory, 'profile'))});
app.whenReady().then(() => {
  const main = new BrowserWindow({ title: 'Codex restore test', show: false, width: 320, height: 140 });
  const overlay = new BrowserWindow({ title: 'Avatar overlay', show: false, frame: false, resizable: false, focusable: false, skipTaskbar: true });
  const handle = main.getNativeWindowHandle().readBigUInt64LE().toString();
  const server = http.createServer(async (request, response) => {
    if (request.url === '/hide') main.hide();
    if (request.url === '/minimize') main.minimize();
    if (request.url === '/maximize') main.maximize();
    await new Promise(resolve => setTimeout(resolve, 100));
    response.end(JSON.stringify({ visible: main.isVisible(), minimized: main.isMinimized(), maximized: main.isMaximized(), overlayVisible: overlay.isVisible(), pid: process.pid }));
  });
  server.listen(0, '127.0.0.1', () => fs.writeFileSync(${JSON.stringify(readyFile)}, JSON.stringify({ pid: process.pid, handle, port: server.address().port })));
});
`);
  await fs.writeFile(helper, `\uFEFFparam([int]$TargetPid)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
. ${quote(path.join(root, 'scripts/desktop-window.ps1'))}
$window = [FeishuCodex.NativeWindow]::FindMainWindow([uint32]$TargetPid)
$restored = $false
$deadline = [DateTime]::UtcNow.AddSeconds(3)
if ($window -ne [IntPtr]::Zero) {
    do {
        $restored = [FeishuCodex.NativeWindow]::Restore($window, [uint32]$TargetPid)
        if ($restored) { break }
        Start-Sleep -Milliseconds 50
    } while ([DateTime]::UtcNow -lt $deadline)
}
@{ handle = $window.ToInt64().ToString(); restored = $restored } | ConvertTo-Json -Compress
`);
  const environment = canonicalEnvironment(process.env);
  delete environment.ELECTRON_RUN_AS_NODE;
  const child = spawn(path.join(root, 'node_modules/electron/dist/electron.exe'), [directory],
    { windowsHide: true, env: environment, stdio: ['pipe', 'pipe', 'pipe'] });
  let errors = '', fixturePort;
  child.stderr.setEncoding('utf8'); child.stderr.on('data', chunk => { errors += chunk; });
  child.on('error', error => { errors += error.message; });
  const request = async action => (await fetch(`http://127.0.0.1:${fixturePort}/${action}`, { signal: AbortSignal.timeout(3_000) })).json();
  const restore = async pid => JSON.parse(await runPowerShell(helper, ['-TargetPid', pid]));
  try {
    let fixture;
    const deadline = Date.now() + 20_000;
    do {
      fixture = await fs.readFile(readyFile, 'utf8').then(JSON.parse).catch(() => null);
      if (fixture || child.exitCode !== null) break;
      await new Promise(resolve => setTimeout(resolve, 50));
    } while (Date.now() < deadline);
    assert.ok(fixture, `Fixture did not become ready: ${errors} ${await fs.readFile(errorFile, 'utf8').catch(() => '')}`);
    fixturePort = fixture.port;
    assert.equal(fixture.pid, child.pid);
    assert.deepEqual(await restore(process.pid), { handle: '0', restored: false }, 'never select another process by window title');
    for (const action of ['hide', 'minimize', 'maximize', 'hide']) {
      const before = await request(action);
      if (action === 'hide') assert.equal(before.visible, false);
      if (action === 'minimize') assert.equal(before.minimized, true);
      if (action === 'maximize') assert.equal(before.maximized, true);
      const result = await restore(child.pid);
      assert.equal(result.handle, fixture.handle);
      assert.equal(result.restored, true);
      const after = await request('state');
      assert.equal(after.pid, fixture.pid);
      assert.equal(after.visible, true);
      assert.equal(after.minimized, false);
      assert.equal(after.overlayVisible, false);
      if (before.maximized) assert.equal(after.maximized, true);
    }
  } finally {
    if (child.exitCode === null) {
      const stopped = new Promise(resolve => child.once('exit', resolve));
      child.kill(); await stopped;
    }
    // Only remove this test's generated workspace and Electron profile.
    const resolved = path.resolve(directory);
    assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()));
    assert.ok(path.basename(resolved).startsWith('feishu-window-restore-'));
    await fs.rm(resolved, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});
