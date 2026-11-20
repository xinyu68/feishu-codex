import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { browserMcpName, playwrightMcpConfig } from '../desktop/playwright-mcp.mjs';

const run = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export async function configureBrowserMcp({ codex, nodePath = process.execPath,
  dataDir = path.join(os.homedir(), '.feishu-codex'), codexHome = process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), previousRoot, previousNode, execute = run }) {
  if (!codex || !path.isAbsolute(codex)) throw new Error('Provide --codex <absolute codex.exe path>.');
  const spec = playwrightMcpConfig({ root, nodePath, dataDir });
  const previous = previousRoot && previousNode ? playwrightMcpConfig({ root: previousRoot, nodePath: previousNode, dataDir }) : null;
  if (Boolean(previousRoot) !== Boolean(previousNode)) throw new Error('Both previous root and Node paths are required for migration.');
  const options = { env: { ...process.env, CODEX_HOME: codexHome }, windowsHide: true, timeout: 30_000 };
  const { stdout } = await execute(codex, ['mcp', 'list', '--json'], options);
  const existing = JSON.parse(stdout).find(item => item.name === browserMcpName);
  if (existing) {
    const transport = existing.transport;
    const matches = expected => expected && transport?.command === expected.command && JSON.stringify(transport?.args) === JSON.stringify(expected.args);
    if (existing.enabled !== false && matches(spec)) return { name: browserMcpName, changed: false, config: path.join(codexHome, 'config.toml') };
    if (existing.enabled === false || !matches(previous)) {
      throw new Error(`${browserMcpName} already exists with different settings; no configuration was overwritten.`);
    }
  }
  const config = path.join(codexHome, 'config.toml');
  const backup = `${config}.before-playwright-${Date.now()}`;
  let backedUp = false;
  try { await fs.copyFile(config, backup, fs.constants.COPYFILE_EXCL); backedUp = true; }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  await execute(codex, ['mcp', 'add', browserMcpName, '--', spec.command, ...spec.args], options);
  return { name: browserMcpName, changed: true, config, ...(backedUp ? { backup } : {}) };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2), options = {};
  for (let i = 0; i < args.length; i += 2) {
    const key = { '--codex': 'codex', '--node': 'nodePath', '--data-dir': 'dataDir', '--codex-home': 'codexHome', '--previous-root': 'previousRoot', '--previous-node': 'previousNode' }[args[i]];
    if (!key || !args[i + 1]) throw new Error('Usage: configure-playwright-mcp.mjs --codex <path> [--node <path>] [--data-dir <path>] [--codex-home <path>]');
    options[key] = args[i + 1];
  }
  console.log(JSON.stringify(await configureBrowserMcp(options), null, 2));
}
