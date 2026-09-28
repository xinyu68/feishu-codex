import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { powershell } from '../desktop/windows.mjs';

const execFileAsync = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const script = path.join(root, 'scripts', 'desktop-fresh-setup.ps1');

test('全新设置的只读检查接受空目录并拒绝旧配置', { skip: process.platform !== 'win32' }, async () => {
  const isolated = await fs.mkdtemp(path.join(os.tmpdir(), 'feishu-fresh-setup-test-'));
  try {
    const product = path.join(isolated, 'product');
    const data = path.join(isolated, 'data');
    for (const name of ['build/server/server.js', 'build/ui/index.html', 'desktop/host.mjs', 'scripts/desktop-host.vbs', 'scripts/desktop-start.ps1', 'scripts/desktop-register.ps1', 'scripts/desktop-task-security.ps1']) {
      const target = path.join(product, name);
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, 'fixture');
    }
    await fs.mkdir(data);
    const wrapper = path.join(isolated, 'check.ps1');
    const quote = value => `'${value.replaceAll("'", "''")}'`;
    await fs.writeFile(wrapper, '\uFEFF' + [
      'function Get-ScheduledTask { param($TaskName, $ErrorAction) return $null }',
      'function Get-NetTCPConnection { param($LocalPort, $State, $ErrorAction) return @() }',
      `& ${quote(script)} -ProductRoot ${quote(product)} -NodePath ${quote(process.execPath)} -DataDir ${quote(data)} -CheckOnly`,
      'if (-not $?) { exit 1 }',
    ].join('\n'));
    const command = () => execFileAsync(powershell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', wrapper], { windowsHide: true, timeout: 15_000 });
    const first = await command();
    assert.match(first.stdout, /全新设置检查通过/);
    assert.equal(await fs.access(path.join(data, 'desktop', 'deployment.json')).then(() => true, () => false), false);
    await fs.writeFile(path.join(data, 'config.json'), '{}');
    await assert.rejects(command(), error => /检测到已有飞书配置/.test(`${error.stdout}\n${error.stderr}`));
    assert.equal(await fs.access(path.join(data, 'desktop', 'deployment.json')).then(() => true, () => false), false);
  } finally {
    if (path.dirname(isolated) !== os.tmpdir() || !path.basename(isolated).startsWith('feishu-fresh-setup-test-')) throw new Error('Unsafe cleanup path');
    await fs.rm(isolated, { recursive: true, force: true });
  }
});
