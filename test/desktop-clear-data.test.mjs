import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runPowerShell } from '../desktop/windows.mjs';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const q = value => `'${value.replaceAll("'", "''")}'`;
async function fixture() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'feishu-clear-data-test-'));
  const dataDir = path.join(directory, 'data'), profileDir = path.join(directory, 'roaming', 'feishu-codex'), codexHome = path.join(directory, '.codex');
  for (const dir of [dataDir, profileDir, codexHome, path.join(dataDir, 'desktop'), path.join(dataDir, 'my-project')]) await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(codexHome, 'auth.json'), 'login');
  await fs.writeFile(path.join(codexHome, 'history.jsonl'), 'history');
  await fs.writeFile(path.join(dataDir, 'config.json'), JSON.stringify({ appId: 'cli_fixture', appSecret: 'fixture-secret', defaultWorkspace: path.join(dataDir, 'my-project') }));
  await fs.writeFile(path.join(dataDir, 'state.json'), JSON.stringify({ conversations: {} }));
  await fs.writeFile(path.join(dataDir, 'service.lock'), '12345');
  await fs.writeFile(path.join(dataDir, 'config.json.12345.tmp'), 'old-secret');
  await fs.writeFile(path.join(dataDir, 'desktop', 'preferences.json'), '{}');
  await fs.writeFile(path.join(dataDir, 'my-project', 'code.txt'), 'project');
  await fs.writeFile(path.join(profileDir, 'Cache'), 'cached');
  const script = path.join(directory, 'fixture.ps1');
  await fs.writeFile(script, '\uFEFF' + `$ErrorActionPreference='Stop'
[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
. ${q(path.join(root, 'scripts', 'desktop-clear-data.ps1'))}
Remove-FeishuApplicationData -DataDir ${q(dataDir)} -ProfileDir ${q(profileDir)} -CodexHome ${q(codexHome)}
`);
  return { directory, dataDir, profileDir, codexHome, run: () => runPowerShell(script) };
}
test('explicit data clearing removes app credentials and cache while preserving Codex and project files', { skip: process.platform !== 'win32' }, async () => {
  const fx = await fixture();
  await fx.run();
  for (const file of ['config.json', 'state.json', 'service.lock', 'config.json.12345.tmp', 'desktop']) assert.equal(await fs.stat(path.join(fx.dataDir, file)).catch(() => null), null);
  assert.equal(await fs.stat(fx.profileDir).catch(() => null), null);
  assert.equal(await fs.readFile(path.join(fx.codexHome, 'auth.json'), 'utf8'), 'login');
  assert.equal(await fs.readFile(path.join(fx.codexHome, 'history.jsonl'), 'utf8'), 'history');
  assert.equal(await fs.readFile(path.join(fx.dataDir, 'my-project', 'code.txt'), 'utf8'), 'project');
});
test('a project inside an app-owned directory is preserved', { skip: process.platform !== 'win32' }, async () => {
  const fx = await fixture();
  const project = path.join(fx.dataDir, 'desktop', 'my-project');
  await fs.mkdir(project); await fs.writeFile(path.join(project, 'code.txt'), 'project');
  await fs.writeFile(path.join(fx.dataDir, 'state.json'), JSON.stringify({ conversations: { one: { cwd: project } } }));
  await fx.run();
  assert.equal(await fs.readFile(path.join(project, 'code.txt'), 'utf8'), 'project');
});
test('a junction aborts data cleanup before any credential or external file is deleted', { skip: process.platform !== 'win32' }, async () => {
  const fx = await fixture();
  await fs.symlink(fx.codexHome, path.join(fx.dataDir, 'desktop', 'linked-codex'), 'junction');
  await assert.rejects(fx.run(), /链接或异常路径/);
  assert.equal(await fs.readFile(path.join(fx.codexHome, 'auth.json'), 'utf8'), 'login');
  assert.ok(await fs.stat(path.join(fx.dataDir, 'config.json')));
  await fs.unlink(path.join(fx.dataDir, 'desktop', 'linked-codex'));
});
