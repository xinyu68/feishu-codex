import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { parse, stringify } from 'yaml';
import { ensureHermesSkill } from '../src/hermes-skill.js';
import { managedHermesHomes, recordManagedHermesHome, removeHermesIntegrations } from '../src/hermes-cleanup.js';

const canonical = (v: any): string => Array.isArray(v) ? `[${v.map(canonical).join(',')}]`
  : v && typeof v === 'object' ? `{${Object.keys(v).sort().map(k => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}` : JSON.stringify(v);
const sha = (v: string) => createHash('sha256').update(v).digest('hex');
const exists = (file: string) => fs.access(file).then(() => true, () => false);
async function fixture(t: TestContext) {
  const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'hermes-uninstall-test-')));
  t.after(async () => {
    if (!path.basename(base).startsWith('hermes-uninstall-test-') || path.dirname(base) !== await fs.realpath(os.tmpdir())) throw new Error('Unsafe fixture cleanup');
    await fs.rm(base, { recursive: true, force: true });
  });
  const productRoot = path.join(base, '安装目录', 'product');
  const home = path.join(base, 'Hermes 配置');
  const dataDir = path.join(base, 'app-data');
  await fs.mkdir(path.join(productRoot, 'skills/feishu-codex-hermes'), { recursive: true });
  await fs.writeFile(path.join(productRoot, 'skills/feishu-codex-hermes/SKILL.md'), 'Hermes bundled skill');
  await fs.mkdir(home);
  const skill = await ensureHermesSkill({ hermesHome: home, bundleRoot: productRoot, roleInstructions: '测试角色' });
  const entry: any = { command: 'C:\\runtime\\node.exe', args: [path.join(productRoot, 'build/server/notify-mcp.js')], env: { FEISHU_CODEX_MANAGED_MCP: 'hermes-v1', FEISHU_CODEX_MCP_MODE: 'hermes' } };
  const seal = () => { delete entry.env.FEISHU_CODEX_MANAGED_MCP_SHA256; entry.env.FEISHU_CODEX_MANAGED_MCP_SHA256 = sha(canonical(entry)); };
  seal();
  const config: any = { model: { default: 'personal-model', base_url: 'https://example.invalid' }, mcp_servers: { personal: { command: 'keep', env: { KEY: 'private-value' } }, feishu_completion: entry }, personality: '保留用户说明' };
  const file = path.join(home, 'config.yaml');
  const writeConfig = () => fs.writeFile(file, '# User comment kept\n' + stringify(config));
  await writeConfig();
  const personal = path.join(home, 'skills/personal/SKILL.md');
  await fs.mkdir(path.dirname(personal), { recursive: true });
  await fs.writeFile(personal, 'personal skill');
  await fs.writeFile(path.join(home, 'sessions.db'), 'session history');
  await fs.writeFile(path.join(home, '.env'), 'provider credentials');
  const remove = async () => (await removeHermesIntegrations({ productRoot, dataDir, homes: [home] }))[0]!;
  return { base, home, productRoot, dataDir, file, skill, config, entry, seal, writeConfig, remove, personal };
}

test('uninstall removes owned skill, hashed role references and MCP offline, preserving Hermes data', async t => {
  const fx = await fixture(t);
  const backups = path.join(fx.home, '.feishu-codex/skill-backups/previous.md');
  await fs.mkdir(path.dirname(backups), { recursive: true });
  await fs.writeFile(backups, 'saved local edits');
  assert.deepEqual(await fx.remove(), { home: fx.home, skill: 'removed', mcp: 'removed' });
  const after = await fs.readFile(fx.file, 'utf8');
  delete fx.config.mcp_servers.feishu_completion;
  assert.deepEqual(parse(after), fx.config);
  assert.match(after, /# User comment kept/);
  assert.equal(await exists(path.dirname(fx.skill.skillPath)), false);
  assert.equal(await fs.readFile(fx.personal, 'utf8'), 'personal skill');
  assert.equal(await fs.readFile(path.join(fx.home, 'sessions.db'), 'utf8'), 'session history');
  assert.equal(await fs.readFile(path.join(fx.home, '.env'), 'utf8'), 'provider credentials');
  assert.equal(await fs.readFile(backups, 'utf8'), 'saved local edits');
  assert.deepEqual(await fx.remove(), { home: fx.home, skill: 'missing', mcp: 'missing' });
});

test('edited skill, edited role or extra personal files preserve the skill, but owned MCP is removed', async t => {
  for (const kind of ['skill', 'role', 'personal']) {
    const fx = await fixture(t);
    const modified = kind === 'skill' ? fx.skill.skillPath : kind === 'role'
      ? path.join(path.dirname(fx.skill.skillPath), fx.skill.roleReference!) : path.join(path.dirname(fx.skill.skillPath), 'personal.md');
    await fs.writeFile(modified, 'user content');
    const result = await fx.remove();
    assert.equal(result.skill, 'preserved-modified');
    assert.equal(result.mcp, 'removed');
    assert.equal(await fs.readFile(modified, 'utf8'), 'user content');
  }
});

test('user MCP entries, edited managed entries and foreign skills are left intact', async t => {
  for (const kind of ['unowned', 'modified']) {
    const fx = await fixture(t);
    if (kind === 'unowned') delete fx.entry.env.FEISHU_CODEX_MANAGED_MCP;
    else fx.entry.env.PERSONAL_SETTING = 'keep';
    await fx.writeConfig();
    await fs.writeFile(path.join(path.dirname(fx.skill.skillPath), '.feishu-codex-managed.json'), JSON.stringify({ owner: 'user' }));
    const original = await fs.readFile(fx.file);
    assert.deepEqual(await fx.remove(), { home: fx.home, skill: 'preserved-unowned', mcp: `preserved-${kind}` });
    assert.deepEqual(await fs.readFile(fx.file), original);
    assert.equal(await exists(fx.skill.skillPath), true);
  }
});

test('a different installation retains both integrations even when the entry is managed', async t => {
  const fx = await fixture(t);
  fx.entry.args = [path.join(fx.base, 'another-install/build/server/notify-mcp.js')];
  fx.seal(); await fx.writeConfig();
  const original = await fs.readFile(fx.file);
  assert.deepEqual(await fx.remove(), { home: fx.home, skill: 'preserved-other-install', mcp: 'preserved-other-install' });
  assert.deepEqual(await fs.readFile(fx.file), original);
  assert.equal(await exists(fx.skill.skillPath), true);
});

test('malformed YAML cancels cleanup without leaking parser content or deleting the Skill', async t => {
  const fx = await fixture(t);
  await fs.writeFile(fx.file, 'secret: private-secret\nmcp_servers: [broken');
  await assert.rejects(fx.remove(), e => e instanceof Error && !e.message.includes('private-secret') && /无法安全解析/.test(e.message));
  assert.equal(await exists(fx.skill.skillPath), true);
  assert.equal(await fs.readFile(fx.file, 'utf8'), 'secret: private-secret\nmcp_servers: [broken');
});

test('aliases referencing the removed entry do not corrupt user YAML', async t => {
  const fx = await fixture(t);
  const owned = stringify(fx.entry).split('\n').filter(Boolean).map(line => '    ' + line).join('\n');
  await fs.writeFile(fx.file, `mcp_servers:\n  feishu_completion: &owned\n${owned}\n  personal: *owned\n`);
  const before = await fs.readFile(fx.file);
  assert.equal((await fx.remove()).mcp, 'preserved-modified');
  assert.deepEqual(await fs.readFile(fx.file), before);
});

test('never follows a profile junction or a linked Skill directory', async t => {
  const fx = await fixture(t);
  const link = path.join(fx.base, 'profile-link');
  await fs.symlink(fx.home, link, process.platform === 'win32' ? 'junction' : 'dir');
  const original = await fs.readFile(fx.file);
  const result = await removeHermesIntegrations({ productRoot: fx.productRoot, dataDir: fx.dataDir, homes: [link] });
  assert.equal(result[0]!.mcp, 'preserved-unsafe-path');
  assert.deepEqual(await fs.readFile(fx.file), original);
  assert.equal(await exists(fx.skill.skillPath), true);
  const directory = path.dirname(fx.skill.skillPath);
  const outside = path.join(fx.base, 'outside-skill');
  await fs.rename(directory, outside);
  await fs.symlink(outside, directory, process.platform === 'win32' ? 'junction' : 'dir');
  assert.equal((await fx.remove()).skill, 'preserved-unsafe-path');
  assert.equal(await exists(path.join(outside, 'SKILL.md')), true);
});

test('tracks multiple custom homes and discovers legacy default/named profiles without Hermes running', async t => {
  const fx = await fixture(t);
  const second = path.join(fx.base, 'second'); await fs.mkdir(second);
  await Promise.all([recordManagedHermesHome(fx.dataDir, fx.home), recordManagedHermesHome(fx.dataDir, second), recordManagedHermesHome(fx.dataDir, fx.home)]);
  const userHome = path.join(fx.base, 'user');
  const local = path.join(fx.base, 'local');
  const named = path.join(local, 'hermes/profiles/work');
  await fs.mkdir(named, { recursive: true });
  const homes = await managedHermesHomes({ dataDir: fx.dataDir, userHome, env: { LOCALAPPDATA: local, HERMES_HOME: second } });
  for (const home of [fx.home, second, named, path.join(userHome, '.hermes')]) assert.ok(homes.includes(home));
  assert.equal(homes.filter(home => home === second).length, 1);
});
