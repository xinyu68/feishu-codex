import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { restoreInstallation } from '../desktop/installation.mjs';
import { atomicJson, readJson, runPowerShell } from '../desktop/windows.mjs';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('reinstallation changes only the deployment location after preparation succeeds', async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'feishu-restore-test-'));
  const old = { version: 1, state: 'active', productRoot: 'C:\\old\\resources\\product' };
  await atomicJson(path.join(dataDir, 'desktop', 'deployment.json'), old);
  await atomicJson(path.join(dataDir, 'config.json'), { appId: 'cli_fixture', appSecret: 'fixture-secret' });
  await atomicJson(path.join(dataDir, 'desktop', 'preferences.json'), { openCodexOnLaunch: false });
  let calls = 0;
  const productRoot = 'E:\\new\\resources\\product';
  await restoreInstallation({ dataDir, productRoot, nodePath: process.execPath, prepare: async () => {
    calls++; assert.deepEqual(await readJson(path.join(dataDir, 'desktop', 'deployment.json')), old);
  } });
  assert.equal(calls, 1);
  assert.equal((await readJson(path.join(dataDir, 'desktop', 'deployment.json'))).productRoot, productRoot);
  assert.deepEqual(await readJson(path.join(dataDir, 'desktop', 'previous-installation.json')), old);
  assert.deepEqual(await readJson(path.join(dataDir, 'config.json')), { appId: 'cli_fixture', appSecret: 'fixture-secret' });
  assert.deepEqual(await readJson(path.join(dataDir, 'desktop', 'preferences.json')), { openCodexOnLaunch: false });
});

test('failed recovery keeps the original installation record for retry', async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'feishu-restore-test-'));
  const old = { state: 'active', productRoot: 'C:\\old' };
  const file = path.join(dataDir, 'desktop', 'deployment.json');
  await atomicJson(file, old);
  await assert.rejects(restoreInstallation({ dataDir, productRoot: 'E:\\new', nodePath: process.execPath, prepare: async () => { throw new Error('old service active'); } }), /old service active/);
  assert.deepEqual(await readJson(file), old);
});

test('Windows recovery permits a changed install path but rejects an occupied service port', { skip: process.platform !== 'win32' }, async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'feishu-restore-win-'));
  const productRoot = path.join(directory, '新安装'), dataDir = path.join(directory, 'data');
  for (const name of ['build/server/server.js', 'build/ui/index.html', 'desktop/host.mjs', 'scripts/desktop-host.vbs', 'scripts/desktop-register.ps1']) {
    const file = path.join(productRoot, name); await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, 'fixture');
  }
  await atomicJson(path.join(dataDir, 'desktop', 'deployment.json'), { state: 'active', productRoot: path.join(directory, 'old') });
  const script = path.join(directory, 'fixture.ps1');
  const q = value => `'${value.replaceAll("'", "''")}'`;
  const check = async occupied => {
    await fs.writeFile(script, '\uFEFF' + `function Get-ScheduledTask { return $null }
function Get-NetTCPConnection { ${occupied ? "return @{LocalPort=8790}" : 'return @()'} }
& ${q(path.join(root, 'scripts', 'desktop-restore-setup.ps1'))} -ProductRoot ${q(productRoot)} -NodePath ${q(process.execPath)} -DataDir ${q(dataDir)} -CheckOnly
if (-not $?) { exit 1 }
`);
    return runPowerShell(script);
  };
  assert.match(await check(false), /恢复检查通过/);
  await assert.rejects(check(true), /端口正在使用/);
});

test('Windows reinstall restores registration past a confirmed stale port and retains configuration', { skip: process.platform !== 'win32', timeout: 30_000 }, async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'feishu-reinstall-stale-'));
  const productRoot = path.join(directory, 'product'), dataDir = path.join(directory, 'data');
  const q = value => `'${value.replaceAll("'", "''")}'`;
  const script = path.join(directory, 'check.ps1');
  for (const name of ['build/server/server.js', 'build/ui/index.html', 'desktop/host.mjs', 'scripts/desktop-host.vbs', 'scripts/desktop-register.ps1']) {
    const file = path.join(productRoot, name); await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, 'fixture');
  }
  const deployment = { version: 1, state: 'active', productRoot };
  const runtime = { wsUrl: 'ws://127.0.0.1:64087', mode: 'shared' };
  const config = { appId: 'cli_fixture', appSecret: 'fixture-only' };
  await atomicJson(path.join(dataDir, 'desktop/deployment.json'), deployment);
  await atomicJson(path.join(dataDir, 'runtime.json'), runtime);
  await atomicJson(path.join(dataDir, 'config.json'), config);
  await atomicJson(path.join(dataDir, 'desktop/runtime-endpoint-recovery.json'), {
    previousUrl: 'ws://127.0.0.1:18791', wsUrl: runtime.wsUrl,
    previousIdentity: { pid: 4242, exe: 'C:\\fixture\\codex.exe', startedAt: '2026-10-01T00:00:00Z' },
  });
  const marker = path.join(dataDir, 'registration.marker');
  // Run a copied launcher so its relative register script is the isolated stub,
  // never the production scheduled-task implementation.
  for (const name of ['desktop-restore-setup.ps1', 'desktop-process-tree.ps1', 'desktop-service-listeners.ps1']) {
    await fs.copyFile(path.join(root, 'scripts', name), path.join(productRoot, 'scripts', name));
  }
  await fs.writeFile(path.join(productRoot, 'scripts/desktop-register.ps1'), '\uFEFF' + `param($ProductRoot, $NodePath, $DataDir)\n[IO.File]::WriteAllText((Join-Path $DataDir 'registration.marker'), 'registered')\n`);
  const run = async (port = 18791, live = false, unknown = false) => {
    await fs.writeFile(script, '\uFEFF' + `
function Get-ScheduledTask { return $null }
function Get-NetTCPConnection($LocalPort, $State) {
    if (64087 -notin $LocalPort) { throw 'Actual runtime port missing' }
    return @{ LocalPort = ${port}; LocalAddress = '127.0.0.1'; OwningProcess = 4242 }
}
function Get-CimInstance {
    ${unknown ? "throw 'Inspection unavailable'" : live ? 'return @{ ProcessId = 4242 }' : 'return $null'}
}
& ${q(path.join(productRoot, 'scripts/desktop-restore-setup.ps1'))} -ProductRoot ${q(productRoot)} -NodePath ${q(process.execPath)} -DataDir ${q(dataDir)}
if (-not $?) { exit 1 }
`);
    return runPowerShell(script);
  };
  assert.match(await run(), /已恢复本机启动项/);
  assert.equal(await fs.readFile(marker, 'utf8'), 'registered');
  await fs.unlink(marker);
  for (const args of [[18791, true], [64087, false], [18791, false, true]]) {
    await assert.rejects(run(...args), error => {
      assert.match(error.message, /端口正在使用|Inspection unavailable/);
      assert.doesNotMatch(error.message, /所在位置|CategoryInfo|FullyQualifiedErrorId|At .*line/);
      return true;
    });
    await assert.rejects(fs.access(marker));
  }
  assert.deepEqual(await readJson(path.join(dataDir, 'desktop/deployment.json')), deployment);
  assert.deepEqual(await readJson(path.join(dataDir, 'runtime.json')), runtime);
  assert.deepEqual(await readJson(path.join(dataDir, 'config.json')), config);
});
