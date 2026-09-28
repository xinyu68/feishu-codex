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
