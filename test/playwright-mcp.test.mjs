import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { playwrightMcpConfig, playwrightMcpOverrides } from '../desktop/playwright-mcp.mjs';
import { browserChannel, installedMcpCli } from '../scripts/playwright-mcp.mjs';
import { configureBrowserMcp } from '../scripts/configure-playwright-mcp.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = path.join(os.tmpdir(), 'Feishu Codex browser configuration');

test('shared launchers generate identical MCP arguments, including paths with spaces', () => {
  const options = { root, nodePath: process.execPath, dataDir };
  const viaCli = JSON.parse(execFileSync(process.execPath,
    [path.join(root, 'scripts/playwright-mcp.mjs'), '--config-args', '--data-dir', dataDir], { encoding: 'utf8', windowsHide: true }));
  assert.deepEqual(viaCli, playwrightMcpOverrides(options));
  assert.deepEqual(playwrightMcpConfig(options).args, [path.join(root, 'scripts/playwright-mcp.mjs'), '--data-dir', dataDir]);
  assert.ok(installedMcpCli().endsWith(path.join('@playwright', 'mcp', 'cli.js')));
});

test('browser discovery prefers installed Chrome, falls back to Edge, and never downloads silently', () => {
  const env = { PROGRAMFILES: path.resolve('Programs'), LOCALAPPDATA: path.resolve('User Local') };
  const chrome = path.join(env.LOCALAPPDATA, 'Google/Chrome/Application/chrome.exe');
  const edge = path.join(env.PROGRAMFILES, 'Microsoft/Edge/Application/msedge.exe');
  assert.equal(browserChannel(env, value => [chrome, edge].includes(value)), 'chrome');
  assert.equal(browserChannel(env, value => value === edge), 'msedge');
  assert.throws(() => browserChannel(env, () => false), /未找到 Chrome/);
});

test('relative launch paths fail before starting a browser', () => {
  assert.throws(() => playwrightMcpConfig({ root: '.', nodePath: process.execPath, dataDir }), /absolute root/);
  assert.throws(() => execFileSync(process.execPath,
    [path.join(root, 'scripts/playwright-mcp.mjs'), '--data-dir', 'relative'], { stdio: 'pipe', windowsHide: true }), /Command failed/);
});

test('registration backs up existing configuration, is idempotent, and rejects conflicting servers', async t => {
  const codexHome = await fs.mkdtemp(path.join(os.tmpdir(), 'feishu-mcp-register-'));
  t.after(async () => {
    assert.equal(path.dirname(codexHome), os.tmpdir()); assert.ok(path.basename(codexHome).startsWith('feishu-mcp-register-'));
    await fs.rm(codexHome, { recursive: true, force: true });
  });
  const original = '# preserve unrelated configuration\nmodel = "existing-model"\n';
  await fs.writeFile(path.join(codexHome, 'config.toml'), original);
  let stored = [], writes = 0;
  const options = { codex: process.execPath, dataDir, codexHome, execute: async (_command, args) => {
    if (args[1] === 'list') return { stdout: JSON.stringify(stored) };
    assert.deepEqual(args.slice(0, 4), ['mcp', 'add', 'feishu_browser', '--']);
    writes++;
    stored = [{ name: 'feishu_browser', enabled: true, transport: { command: args[4], args: args.slice(5) } }];
    return { stdout: '' };
  } };
  const first = await configureBrowserMcp(options);
  assert.equal(first.changed, true); assert.equal(writes, 1);
  assert.equal(await fs.readFile(first.backup, 'utf8'), original);
  assert.equal((await configureBrowserMcp(options)).changed, false); assert.equal(writes, 1);
  stored[0].transport.args = ['some-other-service.mjs'];
  await assert.rejects(configureBrowserMcp(options), /no configuration was overwritten/);
  assert.equal(writes, 1);
  const previousRoot = path.resolve(os.tmpdir(), 'previous-source'), previousNode = process.execPath;
  stored[0].transport = playwrightMcpConfig({ root: previousRoot, nodePath: previousNode, dataDir });
  assert.equal((await configureBrowserMcp({ ...options, previousRoot, previousNode })).changed, true);
  assert.equal(writes, 2);
  assert.equal((await configureBrowserMcp(options)).changed, false);
});
