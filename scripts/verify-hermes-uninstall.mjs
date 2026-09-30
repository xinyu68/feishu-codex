import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { stringify, parse } from 'yaml';
import { ensureHermesSkill } from '../build/server/hermes-skill.js';
import { recordManagedHermesHome } from '../build/server/hermes-cleanup.js';
import { installBundledSkill } from '../desktop/bundled-skill.mjs';
import { canonicalEnvironment } from '../desktop/lifecycle.mjs';

// Execute the actual NSIS customUnInstall macro against disposable profiles.
// Neither the user's installed program nor their agents are uninstalled.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'feishu-hermes-uninstall-hook-')));
const installDir = path.join(base, '测试安装');
const product = path.join(installDir, 'resources/product');
const userHome = path.join(base, '用户');
const codexHome = path.join(userHome, '.codex');
const hermesHome = path.join(userHome, 'hermes');
const dataDir = path.join(userHome, '.feishu-codex');
const bundledNode = path.join(installDir, 'resources/node/node.exe');
await fs.mkdir(path.dirname(bundledNode), { recursive: true });
await fs.copyFile(process.execPath, bundledNode);
for (const file of ['scripts/remove-bundled-skill.mjs', 'desktop/bundled-skill.mjs', 'build/server/hermes-cleanup.js']) {
  await fs.mkdir(path.dirname(path.join(product, file)), { recursive: true });
  await fs.copyFile(path.join(root, file), path.join(product, file));
}
await fs.cp(path.join(root, 'node_modules/yaml'), path.join(product, 'node_modules/yaml'), { recursive: true });
await fs.writeFile(path.join(product, 'package.json'), '{"type":"module"}');
await fs.mkdir(hermesHome, { recursive: true });
const skill = await ensureHermesSkill({ hermesHome, bundleRoot: root, roleInstructions: '保留其他角色，仅清理本应用生成的引用' });
await recordManagedHermesHome(dataDir, hermesHome);
await installBundledSkill({ root, codexHome });
const canonical = v => Array.isArray(v) ? `[${v.map(canonical).join(',')}]` : v && typeof v === 'object'
  ? `{${Object.keys(v).sort().map(k => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}` : JSON.stringify(v);
const entry = { command: bundledNode, args: [path.join(product, 'build/server/notify-mcp.js')], env: { FEISHU_CODEX_MANAGED_MCP: 'hermes-v1', FEISHU_CODEX_MCP_MODE: 'hermes' } };
entry.env.FEISHU_CODEX_MANAGED_MCP_SHA256 = createHash('sha256').update(canonical(entry)).digest('hex');
const config = { model: 'keep-model', mcp_servers: { personal: { command: 'keep-personal' }, feishu_completion: entry } };
const configFile = path.join(hermesHome, 'config.yaml');
await fs.writeFile(configFile, stringify(config));
await fs.writeFile(path.join(hermesHome, 'sessions.db'), 'keep sessions');
await fs.writeFile(path.join(codexHome, 'auth.json'), 'keep login');
const original = await fs.readFile(configFile);
const env = canonicalEnvironment(process.env, { USERPROFILE: userHome, HOME: userHome,
  LOCALAPPDATA: path.join(userHome, 'local'), APPDATA: path.join(userHome, 'roaming'),
  CODEX_HOME: codexHome, HERMES_HOME: hermesHome, FEISHU_CODEX_DATA_DIR: dataDir });
const cache = path.join(process.env.LOCALAPPDATA, 'electron-builder/Cache/nsis-3.0.4.1');
const compiler = (await Promise.all((await fs.readdir(cache)).map(async name => {
  const file = path.join(cache, name, 'Bin/makensis.exe');
  return await fs.stat(file).catch(() => null) ? file : null;
}))).find(Boolean);
assert.ok(compiler, 'Build the Windows package once to populate NSIS');
const quote = value => value.replaceAll('$', '$$').replaceAll('"', '$\\"');
async function run(command, args, environment = env) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { env: environment, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', chunk => { output += chunk; });
    child.stderr.on('data', chunk => { output += chunk; });
    const timer = setTimeout(() => { child.kill(); reject(new Error('NSIS fixture timed out')); }, 60000);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', code => { clearTimeout(timer); resolve({ code, output }); });
  });
}
for (const upgrade of [true, false]) {
  const mode = upgrade ? 'upgrade' : 'uninstall';
  const executable = path.join(base, `${mode}.exe`);
  const script = path.join(base, `${mode}.nsi`);
  const marker = path.join(base, `${mode}.passed`);
  await fs.writeFile(script, `\uFEFFUnicode true
Name "Hermes uninstall integration test"
RequestExecutionLevel user
SilentInstall silent
AutoCloseWindow true
OutFile "${quote(executable)}"
!include LogicLib.nsh
!define BUILD_UNINSTALLER
!define isUpdated '${upgrade ? '1' : '0'} == 1'
!define PROJECT_DIR "${quote(root)}"
!include "${quote(path.join(root, 'scripts/nsis-uninstall.nsh'))}"
InstallDir "${quote(installDir)}"
Section
  StrCpy $feishuClearData 0
  !insertmacro customUnInstall
  FileOpen $0 "${quote(marker)}" w
  FileWrite $0 "passed"
  FileClose $0
SectionEnd
`);
  const build = await run(compiler, ['/V2', script], canonicalEnvironment(process.env));
  assert.equal(build.code, 0, build.output);
  const executed = await run(executable, ['/S']);
  assert.equal(executed.code, 0, executed.output);
  assert.equal(await fs.readFile(marker, 'utf8'), 'passed');
  if (upgrade) {
    assert.deepEqual(await fs.readFile(configFile), original);
    await fs.access(skill.skillPath);
    await fs.access(path.join(codexHome, 'skills/feishu-codex/SKILL.md'));
  } else {
    delete config.mcp_servers.feishu_completion;
    assert.deepEqual(parse(await fs.readFile(configFile, 'utf8')), config);
    assert.equal(await fs.stat(path.dirname(skill.skillPath)).catch(() => null), null);
    assert.equal(await fs.stat(path.join(codexHome, 'skills/feishu-codex')).catch(() => null), null);
  }
}
assert.equal(await fs.readFile(path.join(hermesHome, 'sessions.db'), 'utf8'), 'keep sessions');
assert.equal(await fs.readFile(path.join(codexHome, 'auth.json'), 'utf8'), 'keep login');
const report = { passed: true, directory: base, realUserDataTouched: false, checks: ['actual NSIS hook skips upgrade cleanup', 'normal uninstall removes Codex and Hermes managed skills and Hermes MCP', 'no running Hermes required', 'Chinese installation/profile paths supported', 'sessions, login and other MCP settings retained'], checkedAt: new Date().toISOString() };
await fs.writeFile(path.join(root, 'artifacts/hermes-uninstall-hook-verification.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
