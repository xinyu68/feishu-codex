import { chromium, expect } from '@playwright/test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import WebSocket from 'ws';
import { fileURLToPath } from 'node:url';
import { canonicalEnvironment } from '../desktop/lifecycle.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'feishu-codex-migration-ui-test-'));
const executablePath = process.argv[2] || path.join(root, 'node_modules/electron/dist/electron.exe');
const fixture = path.join(dataDir, 'harmless-migration.ps1');
const lease = net.createServer();
await new Promise(resolve => lease.listen(0, '127.0.0.1', resolve));
const port = lease.address().port;
await new Promise(resolve => lease.close(resolve));
const args = ['--inspect=0', `--remote-debugging-port=${port}`, ...(process.argv[2] ? [] : [root])];
const env = canonicalEnvironment(process.env, { FEISHU_CODEX_DATA_DIR: dataDir, FEISHU_CODEX_TEST_HIDDEN: '1', ELECTRON_RUN_AS_NODE: null, CODEX_APP_SERVER_WS_URL: null });
const result = { startedAt: new Date().toISOString(), executablePath, isolated: true, passed: false };
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
let child, browser, stderr = '';

async function mainEvaluate(expression) {
  const endpoint = /Debugger listening on (ws:\/\/127\.0\.0\.1:\d+\/[^\s]+)/.exec(stderr)?.[1];
  if (!endpoint) throw new Error('没有发现隔离桌面的主进程诊断端口。');
  const socket = new WebSocket(endpoint);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { socket.terminate(); reject(new Error('主进程诊断超时')); }, 10_000);
    socket.once('error', error => { clearTimeout(timer); reject(error); });
    socket.once('open', () => socket.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression, returnByValue: true, awaitPromise: true } })));
    socket.on('message', raw => {
      const response = JSON.parse(raw.toString());
      if (response.id !== 1) return;
      clearTimeout(timer); socket.close();
      if (response.error || response.result?.exceptionDetails) reject(new Error(JSON.stringify(response.error || response.result.exceptionDetails)));
      else resolve(response.result?.result?.value);
    });
  });
}

const fixtureSource = `param(
  [string]$ProductRoot, [string]$NodePath, [string]$DataDir,
  [switch]$NonInteractive, [switch]$WaitForDesktopExit,
  [string]$StatusFile, [string]$RunId
)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$expected = [IO.Path]::GetFullPath($PSScriptRoot)
if ([IO.Path]::GetFullPath($DataDir) -ine $expected) { throw 'Fixture data directory mismatch' }
if (-not [IO.Path]::GetFullPath($StatusFile).StartsWith($expected + '\\', [StringComparison]::OrdinalIgnoreCase)) { throw 'Fixture status path escaped isolated directory' }
[void][IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($StatusFile))
$counterFile = Join-Path $DataDir 'fixture-runs.txt'
$count = if (Test-Path -LiteralPath $counterFile) { [int][IO.File]::ReadAllText($counterFile) + 1 } else { 1 }
[IO.File]::WriteAllText($counterFile, [string]$count)
if ($count -gt 1) {
  Write-Error '隔离测试：子进程启动后立即失败，没有生成状态文件' -ErrorAction Continue
  exit 29
}
$startedAt = [DateTime]::UtcNow.ToString('o')
function Publish-FixtureState([string]$Status, [string]$Phase, [string]$Message) {
  $record = @{ runId = $RunId; status = $Status; phase = $Phase; message = $Message; startedAt = $startedAt; updatedAt = [DateTime]::UtcNow.ToString('o'); pid = $PID; backupDir = $null }
  $temporary = $StatusFile + '.fixture.tmp'
  [IO.File]::WriteAllText($temporary, ($record | ConvertTo-Json -Depth 4), [Text.UTF8Encoding]::new($false))
  Move-Item -LiteralPath $temporary -Destination $StatusFile -Force
}
Publish-FixtureState 'waiting_for_codex' 'preflight' '隔离测试：请先完全退出 Codex 桌面'
Write-Output '隔离测试：检查通过，正在等待桌面关闭'
Start-Sleep -Seconds 3
Publish-FixtureState 'running' 'migrating' '隔离测试：正在模拟接管进度，不会修改服务'
Write-Output '隔离测试：正在模拟接管进度'
Start-Sleep -Seconds 3
Publish-FixtureState 'failed' 'fixture_failure' '隔离测试：模拟接管失败，现有服务未改变'
Write-Error '隔离测试：模拟接管失败，现有服务未改变' -ErrorAction Continue
exit 23
`;

try {
  await fs.writeFile(fixture, '\uFEFF' + fixtureSource, 'utf8');
  await fs.writeFile(path.join(dataDir, 'config.json'), '{}', 'utf8');
  await fs.access(executablePath);
  child = spawn(executablePath, args, { cwd: root, env, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
  child.stderr.on('data', value => { stderr = (stderr + value).slice(-10000); });
  await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
  const deadline = Date.now() + 30_000;
  let endpoint;
  while (Date.now() < deadline && child.exitCode === null) {
    try { endpoint = (await (await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(1000) })).json()).webSocketDebuggerUrl; if (endpoint) break; } catch {}
    await wait(200);
  }
  if (!endpoint) throw new Error(`桌面诊断窗口未就绪。${stderr}`);
  browser = await chromium.connectOverCDP(endpoint, { timeout: 10_000 });
  let page;
  while (Date.now() < deadline) {
    page = browser.contexts().flatMap(context => context.pages())[0];
    if (page) break;
    await wait(200);
  }
  if (!page) throw new Error('隔离桌面窗口未创建。');
  const status = () => page.evaluate(() => window.feishuCodex.getStatus());
  await expect.poll(async () => (await status()).state, { timeout: 15_000 }).toBe('setup');
  assert.equal((await status()).setupMode, 'blocked');
  assert.equal(await page.locator('#migrate').count(), 0, '公开首次设置页不显示开发阶段迁移入口');

  // Redirect only the migration helper in this isolated Electron process. The
  // application, IPC, child-process lifecycle, status reader, and UI stay real.
  // No production test hook or production file is modified.
  const interception = await mainEvaluate(`(() => {
    const cp = process.getBuiltinModule('child_process');
    const module = process.getBuiltinModule('module');
    const path = process.getBuiltinModule('path');
    const original = cp.spawn;
    const fixture = ${JSON.stringify(fixture)};
    const expectedData = ${JSON.stringify(dataDir)};
    globalThis.__fcMigrationTestSpawns = [];
    cp.spawn = function(executable, args, options) {
      const fileIndex = Array.isArray(args) ? args.findIndex(value => String(value).toLowerCase() === '-file') : -1;
      if (fileIndex >= 0 && ['desktop-migrate.ps1', 'desktop-migration-launch.ps1'].includes(path.basename(args[fileIndex + 1]).toLowerCase())) {
        const dataIndex = args.findIndex(value => String(value).toLowerCase() === '-datadir');
        if (dataIndex < 0 || path.resolve(args[dataIndex + 1]).toLowerCase() !== expectedData.toLowerCase()) throw new Error('Migration test attempted to access production data');
        const rewritten = args.slice(); rewritten[fileIndex + 1] = fixture;
        globalThis.__fcMigrationTestSpawns.push({ args: rewritten, windowsHide: options?.windowsHide, detached: options?.detached, stdio: options?.stdio });
        const target = globalThis.__fcMigrationTestSpawns.length === 3 ? path.join(expectedData, 'intentionally-missing-powershell.exe') : executable;
        return original.call(this, target, rewritten, options);
      }
      return original.call(this, executable, args, options);
    };
    module.syncBuiltinESMExports();
    return true;
  })()`);
  assert.equal(interception, true);
  await page.evaluate(() => window.feishuCodex.migrate());
  await expect.poll(async () => (await status()).migration?.status, { timeout: 15_000 }).toBe('waiting_for_codex');
  await expect(page.locator('#description')).toContainText('请先完全退出 Codex');
  assert.equal(await page.locator('#fresh').isVisible(), false);
  await page.evaluate(() => window.feishuCodex.migrate()).catch(() => {});
  assert.equal(await mainEvaluate('globalThis.__fcMigrationTestSpawns.length'), 1, '等待关闭期间不得启动第二个接管进程');
  await expect.poll(async () => (await status()).migration?.status, { timeout: 10_000 }).toBe('running');
  await expect(page.locator('#description')).toContainText('正在模拟接管进度');
  await expect.poll(async () => (await status()).migration?.status, { timeout: 10_000 }).toBe('failed');
  await page.waitForFunction(() => window.feishuCodex?.getStatus().then(status => status.migration?.status === 'failed'), null, { timeout: 10_000 });
  await expect(page.locator('main')).toContainText('模拟接管失败');
  await wait(4300);
  assert.equal((await page.evaluate(() => window.feishuCodex.getStatus())).migration.status, 'failed', '普通状态轮询不能抹掉接管失败');
  assert.match(await page.locator('main').textContent(), /模拟接管失败/);
  assert.doesNotMatch(await page.locator('main').textContent(), /窗口已打开|新打开的中文切换窗口/);
  result.waitingAndProgressVisible = true;
  result.failureSurvivesPolling = true;
  result.singleMigrationProcess = true;

  const firstRunId = (await status()).migration.runId;
  await page.evaluate(() => window.feishuCodex.migrate());
  await expect.poll(async () => {
    const state = await status();
    return state.migration?.runId !== firstRunId && state.migration?.status === 'failed';
  }, { timeout: 15_000 }).toBe(true);
  result.secondAttempt = (await page.evaluate(() => window.feishuCodex.getStatus())).migration;
  assert.equal(await mainEvaluate('globalThis.__fcMigrationTestSpawns.length'), 2);
  await expect(page.locator('main')).toContainText('子进程启动后立即失败');
  result.exitBeforeStatusReported = true;

  const secondRunId = (await status()).migration.runId;
  await page.evaluate(() => window.feishuCodex.migrate()).catch(() => {});
  await expect.poll(async () => {
    const state = await status();
    return state.migration?.runId !== secondRunId && state.migration?.status === 'failed';
  }, { timeout: 15_000 }).toBe(true);
  result.thirdAttempt = (await page.evaluate(() => window.feishuCodex.getStatus())).migration;
  assert.equal(await mainEvaluate('globalThis.__fcMigrationTestSpawns.length'), 3);
  await expect(page.locator('main')).toContainText(/ENOENT|无法启动|未能启动|启动失败|找不到/i);
  result.spawnFailureReported = true;

  const launches = await mainEvaluate('globalThis.__fcMigrationTestSpawns');
  for (const launch of launches) {
    assert.equal(launch.windowsHide, true, '接管应在应用中显示进度，不另外弹空白控制台');
    assert.equal(launch.args.includes('-NoExit'), false, '接管子进程必须能正常结束');
    assert.equal(launch.args.includes('-WaitForDesktopExit'), true);
    assert.equal(launch.args.includes('-StatusFile'), true);
    assert.equal(launch.args.includes('-RunId'), true);
  }
  for (const name of ['desktop/deployment.json', 'service.lock', 'desktop/host-control.json']) {
    assert.equal(await fs.access(path.join(dataDir, name)).then(() => true, () => false), false, `隔离测试不应创建 ${name}`);
  }
  await fs.mkdir(path.join(root, 'artifacts'), { recursive: true });
  await page.screenshot({ path: path.join(root, 'artifacts', process.argv[2] ? 'desktop-packaged-migration-failure.png' : 'desktop-migration-failure.png') });
  await page.evaluate(() => window.feishuCodex.quit()).catch(() => {});
  const quitDeadline = Date.now() + 10_000;
  while (Date.now() < quitDeadline && child.exitCode === null) await wait(100);
  assert.equal(child.exitCode, 0, '接管失败后应用仍应能正常退出');
  result.cleanQuitAfterFailure = true;
  result.passed = true;
} catch (error) { result.error = error.message; process.exitCode = 1; }
finally {
  if (child?.exitCode === null) child.kill();
  await browser?.close().catch(() => {});
  if (!result.passed) await wait(6500); // Harmless fixture children finish before removing their private files.
  if (path.dirname(dataDir) !== os.tmpdir() || !path.basename(dataDir).startsWith('feishu-codex-migration-ui-test-')) throw new Error('Unsafe cleanup path');
  await fs.rm(dataDir, { recursive: true, force: true, maxRetries: 8, retryDelay: 150 }).catch(error => { result.cleanupError = error.code; });
  result.finishedAt = new Date().toISOString();
  await fs.mkdir(path.join(root, 'artifacts'), { recursive: true });
  await fs.writeFile(path.join(root, 'artifacts', process.argv[2] ? 'desktop-packaged-migration-test.json' : 'desktop-migration-test.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
}
