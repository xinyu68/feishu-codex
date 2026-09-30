import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { installBundledSkill, removeBundledSkill } from '../desktop/bundled-skill.mjs';

const execFileAsync = promisify(execFile);

async function fixture(t) {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'feishu-bundled-skill-'));
  t.after(async () => {
    if (path.dirname(base) !== os.tmpdir() || !path.basename(base).startsWith('feishu-bundled-skill-')) throw new Error('Invalid test cleanup path');
    await fs.rm(base, { recursive: true, force: true });
  });
  const root = path.join(base, 'product'), codexHome = path.join(base, 'custom-codex-home');
  const source = path.join(root, 'skills', 'feishu-codex', 'SKILL.md');
  const directory = path.join(codexHome, 'skills', 'feishu-codex');
  const file = path.join(directory, 'SKILL.md');
  await fs.mkdir(path.dirname(source), { recursive: true });
  await fs.writeFile(source, 'bundled v1 中文');
  return { base, source, directory, file, root, codexHome, install: () => installBundledSkill({ root, codexHome }) };
}

test('installs once, updates owned content and preserves user config and unrelated skills', async t => {
  const fx = await fixture(t);
  const other = path.join(fx.codexHome, 'skills', 'user-skill', 'SKILL.md');
  await fs.mkdir(path.dirname(other), { recursive: true });
  await fs.writeFile(other, 'user content');
  const config = path.join(fx.codexHome, 'config.toml');
  await fs.writeFile(config, '[[skills.config]]\nenabled = false\n');
  assert.equal((await fx.install()).status, 'installed');
  assert.equal(await fs.readFile(fx.file, 'utf8'), 'bundled v1 中文');
  const before = (await fs.stat(fx.file)).mtimeMs;
  assert.equal((await fx.install()).status, 'unchanged');
  assert.equal((await fs.stat(fx.file)).mtimeMs, before);
  await fs.writeFile(fx.source, 'bundled v2 中文');
  assert.equal((await fx.install()).status, 'updated');
  assert.equal(await fs.readFile(fx.file, 'utf8'), 'bundled v2 中文');
  assert.equal(await fs.readFile(other, 'utf8'), 'user content');
  assert.equal(await fs.readFile(config, 'utf8'), '[[skills.config]]\nenabled = false\n');
});

test('never replaces an unowned same-name skill or a locally modified managed skill', async t => {
  const fx = await fixture(t);
  await fs.mkdir(fx.directory, { recursive: true });
  await fs.writeFile(fx.file, 'user-owned skill');
  assert.equal((await fx.install()).status, 'conflict');
  assert.equal(await fs.readFile(fx.file, 'utf8'), 'user-owned skill');
  const managed = await fixture(t);
  await managed.install();
  await fs.writeFile(managed.file, 'edited by user');
  await fs.writeFile(managed.source, 'new bundled version');
  assert.equal((await managed.install()).status, 'modified');
  assert.equal(await fs.readFile(managed.file, 'utf8'), 'edited by user');
});

test('does not follow a linked skill folder or adopt an invalid ownership marker', async t => {
  const fx = await fixture(t);
  const outside = path.join(fx.base, 'outside');
  await fs.mkdir(outside); await fs.writeFile(path.join(outside, 'SKILL.md'), 'outside');
  await fs.mkdir(path.dirname(fx.directory), { recursive: true });
  await fs.symlink(outside, fx.directory, process.platform === 'win32' ? 'junction' : 'dir');
  assert.equal((await fx.install()).status, 'conflict');
  assert.equal(await fs.readFile(path.join(outside, 'SKILL.md'), 'utf8'), 'outside');
  const broken = await fixture(t);
  await broken.install();
  await fs.writeFile(path.join(broken.directory, '.feishu-codex-managed.json'), '{}');
  assert.equal((await broken.install()).status, 'conflict');
});

test('recovers the ownership marker after content was updated before an interrupted marker write', async t => {
  const fx = await fixture(t);
  await fx.install();
  await fs.writeFile(fx.source, 'v2');
  await fs.writeFile(fx.file, 'v2');
  assert.equal((await fx.install()).status, 'updated');
  assert.equal((await fx.install()).status, 'unchanged');
});

test('uninstall removes only the unchanged managed Skill', async t => {
  const fx = await fixture(t);
  const other = path.join(fx.codexHome, 'skills', 'personal-skill', 'SKILL.md');
  await fs.mkdir(path.dirname(other), { recursive: true });
  await fs.writeFile(other, 'personal');
  await fx.install();
  assert.equal((await removeBundledSkill({ codexHome: fx.codexHome })).status, 'removed');
  assert.equal(await fs.access(fx.directory).then(() => true, () => false), false);
  assert.equal(await fs.readFile(other, 'utf8'), 'personal');
  assert.equal((await removeBundledSkill({ codexHome: fx.codexHome })).status, 'missing');
});

test('uninstall preserves edited, unowned, linked and extended Skill folders', async t => {
  const edited = await fixture(t);
  await edited.install();
  await fs.writeFile(edited.file, 'personal changes');
  assert.equal((await removeBundledSkill({ codexHome: edited.codexHome })).status, 'modified');
  assert.equal(await fs.readFile(edited.file, 'utf8'), 'personal changes');

  const extended = await fixture(t);
  await extended.install();
  await fs.writeFile(path.join(extended.directory, 'notes.txt'), 'keep');
  assert.equal((await removeBundledSkill({ codexHome: extended.codexHome })).status, 'modified');
  assert.equal(await fs.readFile(path.join(extended.directory, 'notes.txt'), 'utf8'), 'keep');

  const unowned = await fixture(t);
  await fs.mkdir(unowned.directory, { recursive: true });
  await fs.writeFile(unowned.file, 'personal Skill');
  assert.equal((await removeBundledSkill({ codexHome: unowned.codexHome })).status, 'modified');
  assert.equal(await fs.readFile(unowned.file, 'utf8'), 'personal Skill');

  const linked = await fixture(t);
  const outside = path.join(linked.base, 'outside-skill');
  await fs.mkdir(outside);
  await fs.mkdir(path.dirname(linked.directory), { recursive: true });
  await fs.symlink(outside, linked.directory, process.platform === 'win32' ? 'junction' : 'dir');
  assert.equal((await removeBundledSkill({ codexHome: linked.codexHome })).status, 'conflict');
  assert.equal(await fs.access(outside).then(() => true, () => false), true);
});

test('uninstall helper finds a recorded custom Codex home', async t => {
  const fx = await fixture(t);
  await fx.install();
  const dataDir = path.join(fx.base, 'data');
  const locationFile = path.join(dataDir, 'desktop', 'managed-skill-home.json');
  await fs.mkdir(path.dirname(locationFile), { recursive: true });
  await fs.writeFile(locationFile, JSON.stringify({ schema: 1, owner: 'local.feishu-codex.desktop', codexHome: fx.codexHome }));
  const helper = fileURLToPath(new URL('../scripts/remove-bundled-skill.mjs', import.meta.url));
  const { stdout } = await execFileAsync(process.execPath, [helper], {
    env: { ...process.env, CODEX_HOME: path.join(fx.base, 'other-codex-home'), FEISHU_CODEX_DATA_DIR: dataDir },
  });
  assert.equal(JSON.parse(stdout).some(item => item.status === 'removed' && item.path === fx.directory), true);
  assert.equal(await fs.access(fx.directory).then(() => true, () => false), false);
});

test('installs the packaged Codex Skill without dropping bundled guidance', async t => {
  const fx = await fixture(t);
  const root = fileURLToPath(new URL('..', import.meta.url));
  const source = path.join(root, 'skills', 'feishu-codex', 'SKILL.md');
  assert.equal((await installBundledSkill({ root, codexHome: fx.codexHome })).status, 'installed');
  assert.equal(await fs.readFile(fx.file, 'utf8'), await fs.readFile(source, 'utf8'));
});
