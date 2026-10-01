import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyDependencyTree, verifyInstallerHelpers } from '../scripts/verify-desktop-package.mjs';
import { runPowerShell } from '../desktop/windows.mjs';

test('packaging rejects missing transitive files even when direct dependencies are present', async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'feishu-package-test-'));
  const expected = path.join(temp, 'expected'), actual = path.join(temp, 'actual');
  const files = ['ws/package.json', '@vendor/sdk/index.js', '@vendor/sdk/node_modules/helper/index.js'];
  try {
    for (const file of files) {
      await fs.mkdir(path.dirname(path.join(expected, file)), { recursive: true });
      await fs.writeFile(path.join(expected, file), `fixture ${file}`);
    }
    await fs.cp(expected, actual, { recursive: true });
    assert.equal(await verifyDependencyTree(expected, actual), 3);
    const nested = path.join(actual, files[2]);
    await fs.unlink(nested);
    await assert.rejects(verifyDependencyTree(expected, actual), /缺少运行依赖/);
    await fs.writeFile(nested, 'truncated');
    await assert.rejects(verifyDependencyTree(expected, actual), /内容不完整/);
  } finally {
    if (path.dirname(temp) !== os.tmpdir() || !path.basename(temp).startsWith('feishu-package-test-')) throw new Error('Invalid cleanup directory');
    await fs.rm(temp, { recursive: true, force: true });
  }
});

test('packaging rejects an installer whose embedded helper dependencies are missing', async () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'feishu-installer-manifest-'));
  const manifest = await fs.readFile(path.join(root, 'scripts/nsis-uninstall.nsh'), 'utf8');
  try {
    await fs.mkdir(path.join(temp, 'scripts'));
    const helpers = await verifyInstallerHelpers(root);
    for (const { relative } of helpers) await fs.copyFile(path.join(root, relative), path.join(temp, relative));
    await fs.writeFile(path.join(temp, 'scripts/nsis-uninstall.nsh'), manifest.replace(/^.*File .*desktop-service-listeners\.ps1.*\r?\n/m, ''));
    await assert.rejects(verifyInstallerHelpers(temp), /缺少内嵌脚本：desktop-service-listeners\.ps1/);
    await fs.writeFile(path.join(temp, 'scripts/nsis-uninstall.nsh'), manifest);
    assert.deepEqual(await verifyInstallerHelpers(temp), helpers);
  } finally {
    for (const file of await fs.readdir(path.join(temp, 'scripts'))) await fs.unlink(path.join(temp, 'scripts', file));
    await fs.rmdir(path.join(temp, 'scripts')); await fs.rmdir(temp);
  }
});

test('the actual embedded installer helpers run in isolation and log missing dependencies', { skip: process.platform !== 'win32', timeout: 20_000 }, async () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'feishu-embedded-installer-'));
  const extracted = path.join(temp, 'plugins'), data = path.join(temp, 'data'), install = path.join(temp, 'install');
  await fs.mkdir(extracted);
  const helpers = await verifyInstallerHelpers(root);
  for (const { name, relative } of helpers) await fs.copyFile(path.join(root, relative), path.join(extracted, name));
  const entry = path.join(extracted, 'desktop-uninstall.ps1');
  const run = () => runPowerShell(entry, ['-InstallDir', install, '-DataDir', data, '-Phase', 'Prepare'], { timeout: 15_000 });
  // The install/data paths are unique and have no process identity records.
  // Prepare only reads the real task, whose production paths cannot match them.
  assert.match(await run(), /已安全关闭本应用及其服务/);
  const log = path.join(data, 'desktop/uninstall.log');
  assert.match(await fs.readFile(log, 'utf8'), /退出检查通过/);
  await fs.unlink(path.join(extracted, 'desktop-service-listeners.ps1'));
  await assert.rejects(run(), /desktop-service-listeners\.ps1/);
  assert.match(await fs.readFile(log, 'utf8'), /操作中止：.*desktop-service-listeners\.ps1/);
  for (const file of await fs.readdir(extracted)) await fs.unlink(path.join(extracted, file));
  await fs.unlink(log);
  await fs.rmdir(path.join(data, 'desktop')); await fs.rmdir(data); await fs.rmdir(extracted); await fs.rmdir(temp);
});
