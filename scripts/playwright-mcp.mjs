import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { playwrightMcpOverrides } from '../desktop/playwright-mcp.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);

export function browserChannel(env = process.env, exists = fs.existsSync) {
  const bases = [env.PROGRAMFILES, env['PROGRAMFILES(X86)'], env.LOCALAPPDATA].filter(Boolean);
  for (const [channel, relative] of [
    ['chrome', ['Google', 'Chrome', 'Application', 'chrome.exe']],
    ['msedge', ['Microsoft', 'Edge', 'Application', 'msedge.exe']],
  ]) {
    if (bases.some(base => exists(path.join(base, ...relative)))) return channel;
  }
  throw new Error('Playwright MCP 未找到 Chrome 或 Microsoft Edge，请先安装其中一个浏览器。');
}

export function installedMcpCli() {
  return path.join(path.dirname(require.resolve('@playwright/mcp/package.json')), 'cli.js');
}

export async function main(argv = process.argv.slice(2)) {
  const configOnly = argv[0] === '--config-args';
  const args = configOnly ? argv.slice(1) : argv;
  if (args.length !== 2 || args[0] !== '--data-dir' || !path.isAbsolute(args[1])) {
    throw new Error('Usage: playwright-mcp.mjs [--config-args] --data-dir <absolute directory>');
  }
  const dataDir = args[1];
  if (configOnly) {
    console.log(JSON.stringify(playwrightMcpOverrides({ root, nodePath: process.execPath, dataDir })));
    return;
  }
  const browser = browserChannel();
  const outputs = path.join(dataDir, 'browser-artifacts');
  fs.mkdirSync(outputs, { recursive: true });
  const outputDir = fs.mkdtempSync(path.join(outputs, 'session-'));
  const cli = installedMcpCli();
  // Use the bundled version with a fresh browser context. No Desktop auth
  // bootstrap, extension, CDP connection, or personal Chrome profile is used.
  process.argv = [process.execPath, cli, '--browser', browser, '--isolated', '--output-dir', outputDir];
  await import(pathToFileURL(cli).href);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
