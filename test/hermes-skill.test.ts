import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { ensureHermesSkill, HermesSkillError } from '../src/hermes-skill.js';

async function fixture(t: TestContext) {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'feishu-hermes-skill-'));
  t.after(async () => {
    if (path.dirname(base) !== os.tmpdir() || !path.basename(base).startsWith('feishu-hermes-skill-')) throw new Error('Invalid test cleanup path');
    await fs.rm(base, { recursive: true, force: true });
  });
  const bundleRoot = path.join(base, 'product');
  const hermesHome = path.join(base, 'profile');
  const source = path.join(bundleRoot, 'skills', 'feishu-codex-hermes', 'SKILL.md');
  const directory = path.join(hermesHome, 'skills', 'feishu-codex');
  const skillPath = path.join(directory, 'SKILL.md');
  await fs.mkdir(path.dirname(source), { recursive: true });
  await fs.mkdir(hermesHome);
  await fs.writeFile(source, 'bundled v1 中文');
  return { base, bundleRoot, hermesHome, source, directory, skillPath, install: (roleInstructions?: string) => ensureHermesSkill({ bundleRoot, hermesHome, roleInstructions }) };
}

const errorCode = (code: HermesSkillError['code']) => (error: unknown) => error instanceof HermesSkillError && error.code === code;
const linkDirectory = (target: string, destination: string) => fs.symlink(target, destination, process.platform === 'win32' ? 'junction' : 'dir');

test('installs and updates only the managed Skill inside the selected existing profile', async t => {
  const fx = await fixture(t);
  const config = path.join(fx.hermesHome, 'config.yaml');
  await fs.writeFile(config, 'personality: keep my global settings\n');
  const unrelated = path.join(fx.hermesHome, 'skills', 'personal', 'SKILL.md');
  await fs.mkdir(path.dirname(unrelated), { recursive: true });
  await fs.writeFile(unrelated, 'personal skill');
  assert.deepEqual(await fx.install(), { status: 'installed', skillPath: fx.skillPath });
  const before = (await fs.stat(fx.skillPath)).mtimeMs;
  assert.equal((await fx.install()).status, 'unchanged');
  assert.equal((await fs.stat(fx.skillPath)).mtimeMs, before);
  await fs.writeFile(fx.source, 'bundled v2');
  assert.equal((await fx.install()).status, 'updated');
  assert.equal(await fs.readFile(fx.skillPath, 'utf8'), 'bundled v2');
  assert.equal(await fs.readFile(config, 'utf8'), 'personality: keep my global settings\n');
  assert.equal(await fs.readFile(unrelated, 'utf8'), 'personal skill');
});

test('keeps role versions immutable, supports concurrent roles, and never inherits an unspecified role', async t => {
  const fx = await fixture(t);
  const roles = ['产品经理：明确范围\n', '研发：实施已授权改动', '产品经理：明确范围\n'];
  const results = await Promise.all(roles.map(role => fx.install(role)));
  for (const [index, result] of results.entries()) {
    const hash = createHash('sha256').update(roles[index]!).digest('hex');
    assert.equal(result.roleHash, hash);
    assert.equal(result.roleReference, `references/roles/${hash}.md`);
    assert.equal(await fs.readFile(path.join(fx.directory, result.roleReference!), 'utf8'), roles[index]);
  }
  assert.deepEqual(await fx.install(), { status: 'unchanged', skillPath: fx.skillPath });
  assert.deepEqual(await fx.install(' \n '), { status: 'unchanged', skillPath: fx.skillPath });
  assert.equal((await fs.readdir(path.join(fx.directory, 'references', 'roles'))).length, 2);
  const before = (await fs.stat(path.join(fx.directory, results[0]!.roleReference!))).mtimeMs;
  await fx.install(roles[0]);
  assert.equal((await fs.stat(path.join(fx.directory, results[0]!.roleReference!))).mtimeMs, before);
});

test('preserves unowned Skill files', async t => {
  const unowned = await fixture(t);
  await fs.mkdir(unowned.directory, { recursive: true });
  await fs.writeFile(unowned.skillPath, 'user skill');
  await assert.rejects(unowned.install('role'), errorCode('conflict'));
  assert.equal(await fs.readFile(unowned.skillPath, 'utf8'), 'user skill');
});

test('does not adopt invalid or foreign management markers', async t => {
  for (const marker of ['{broken', '{}', JSON.stringify({ schema: 1, owner: 'another.app', sha256: 'a'.repeat(64) })]) {
    const fx = await fixture(t);
    await fx.install();
    await fs.writeFile(path.join(fx.directory, '.feishu-codex-managed.json'), marker);
    await assert.rejects(fx.install(), errorCode('conflict'));
    assert.equal(await fs.readFile(fx.skillPath, 'utf8'), 'bundled v1 中文');
  }
});

test('recovers after the new Skill was atomically published before the marker', async t => {
  const fx = await fixture(t);
  await fx.install();
  await fs.writeFile(fx.source, 'bundled v2');
  await fs.writeFile(fx.skillPath, 'bundled v2');
  assert.equal((await fx.install()).status, 'updated');
  assert.equal((await fx.install()).status, 'unchanged');
});

test('preserves an edited role reference and fails instead of returning it', async t => {
  const fx = await fixture(t);
  const installed = await fx.install('specific role');
  const reference = path.join(fx.directory, installed.roleReference!);
  await fs.writeFile(reference, 'modified by user');
  await assert.rejects(fx.install('specific role'), errorCode('modified'));
  assert.equal(await fs.readFile(reference, 'utf8'), 'modified by user');
  assert.equal((await fx.install('another role')).status, 'unchanged');
});

test('rejects relative or missing profile homes without creating them', async t => {
  const fx = await fixture(t);
  await assert.rejects(ensureHermesSkill({ hermesHome: 'profile', bundleRoot: fx.bundleRoot }), errorCode('invalid-home'));
  const missing = path.join(fx.base, 'missing-profile');
  await assert.rejects(ensureHermesSkill({ hermesHome: missing, bundleRoot: fx.bundleRoot }), errorCode('conflict'));
  await assert.rejects(fs.access(missing));
});

test('rejects linked profile, skills, Skill, and role directories without modifying their targets', async t => {
  for (const component of ['profile', 'skills', 'skill', 'references', 'roles']) {
    const fx = await fixture(t);
    const outside = path.join(fx.base, 'outside');
    await fs.mkdir(outside);
    await fs.writeFile(path.join(outside, 'keep.txt'), 'untouched');
    let destination: string;
    if (component === 'profile') {
      destination = path.join(fx.base, 'linked-profile');
      await linkDirectory(fx.hermesHome, destination);
      await assert.rejects(ensureHermesSkill({ hermesHome: destination, bundleRoot: fx.bundleRoot }), errorCode('conflict'));
      continue;
    }
    if (component === 'skills') destination = path.join(fx.hermesHome, 'skills');
    else if (component === 'skill') {
      await fs.mkdir(path.join(fx.hermesHome, 'skills'));
      destination = fx.directory;
    } else {
      await fx.install();
      destination = path.join(fx.directory, 'references');
      if (component === 'roles') {
        await fs.mkdir(destination);
        destination = path.join(destination, 'roles');
      }
    }
    await linkDirectory(outside, destination);
    await assert.rejects(fx.install('test role'), errorCode('conflict'));
    assert.deepEqual(await fs.readdir(outside), ['keep.txt']);
  }
});

test('finds the packaged Skill from the source module without a bundleRoot override', async t => {
  const fx = await fixture(t);
  const result = await ensureHermesSkill({ hermesHome: fx.hermesHome });
  assert.equal(result.status, 'installed');
  const source = fileURLToPath(new URL('../skills/feishu-codex-hermes/SKILL.md', import.meta.url));
  assert.equal(await fs.readFile(result.skillPath, 'utf8'), await fs.readFile(source, 'utf8'));
});

test('reinstall backs up edited managed Skill bytes before restoring the bundled version', async t => {
  const fx = await fixture(t);
  const previous = await fx.install('saved role');
  const markerPath = path.join(fx.directory, '.feishu-codex-managed.json');
  const originalMarker = await fs.readFile(markerPath);
  const edits = Buffer.from('\ufeffuser changes 中文\r\n');
  await fs.writeFile(fx.skillPath, edits);
  await fs.writeFile(fx.source, 'bundled v2');
  const personal = path.join(fx.directory, 'personal.md');
  await fs.writeFile(personal, 'keep this reference');
  const result = await fx.install('saved role');
  assert.equal(result.status, 'updated');
  assert.ok(result.backupPath);
  assert.equal(path.dirname(path.dirname(result.backupPath)), path.join(fx.hermesHome, '.feishu-codex', 'skill-backups'));
  assert.deepEqual(await fs.readFile(result.backupPath), edits);
  assert.deepEqual(await fs.readFile(path.join(path.dirname(result.backupPath), '.feishu-codex-managed.json')), originalMarker);
  assert.equal(await fs.readFile(fx.skillPath, 'utf8'), 'bundled v2');
  assert.equal(await fs.readFile(personal, 'utf8'), 'keep this reference');
  assert.equal(result.roleReference, previous.roleReference);
  assert.equal(await fs.readFile(path.join(fx.directory, result.roleReference!), 'utf8'), 'saved role');
  assert.equal(JSON.parse(await fs.readFile(markerPath, 'utf8')).sha256, createHash('sha256').update('bundled v2').digest('hex'));
  const recovery = JSON.parse(await fs.readFile(path.join(path.dirname(result.backupPath), 'recovery.json'), 'utf8'));
  assert.equal(recovery.sha256, createHash('sha256').update(edits).digest('hex'));
  assert.deepEqual(await fx.install(), { status: 'unchanged', skillPath: fx.skillPath });
  assert.equal((await fs.readdir(path.dirname(path.dirname(result.backupPath)))).length, 1);
});

test('concurrent bots recover an edited Skill once and share the restored version', async t => {
  const fx = await fixture(t);
  await fx.install();
  await fs.writeFile(fx.skillPath, 'old troubleshooting notes');
  const results = await Promise.all([fx.install('role A'), fx.install('role B'), fx.install()]);
  assert.equal(results.filter(result => result.backupPath).length, 1);
  assert.deepEqual(results.map(result => result.status), ['updated', 'unchanged', 'unchanged']);
  assert.equal(await fs.readFile(fx.skillPath, 'utf8'), 'bundled v1 中文');
});

test('backup failure never overwrites modified Skill or its marker', async t => {
  const fx = await fixture(t);
  await fx.install();
  const markerPath = path.join(fx.directory, '.feishu-codex-managed.json');
  const originalMarker = await fs.readFile(markerPath);
  await fs.writeFile(fx.skillPath, 'local edits');
  await fs.writeFile(path.join(fx.hermesHome, '.feishu-codex'), 'not a directory');
  await assert.rejects(fx.install(), errorCode('conflict'));
  assert.equal(await fs.readFile(fx.skillPath, 'utf8'), 'local edits');
  assert.deepEqual(await fs.readFile(markerPath), originalMarker);
});

test('refuses linked backup directories instead of writing outside the profile', async t => {
  const fx = await fixture(t);
  await fx.install();
  await fs.writeFile(fx.skillPath, 'local edits');
  const outside = path.join(fx.base, 'outside-backups');
  await fs.mkdir(outside);
  const directory = path.join(fx.hermesHome, '.feishu-codex');
  await fs.mkdir(directory);
  await linkDirectory(outside, path.join(directory, 'skill-backups'));
  await assert.rejects(fx.install(), errorCode('conflict'));
  assert.equal(await fs.readFile(fx.skillPath, 'utf8'), 'local edits');
  assert.deepEqual(await fs.readdir(outside), []);
});
