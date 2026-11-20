import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import { playwrightMcpOverrides } from '../desktop/playwright-mcp.mjs';
import { verifyBrowser } from './verify-playwright-mcp.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function rpcClient(send) {
  let id = 0;
  const pending = new Map();
  return {
    receive(message) {
      if (message.method) return; // Tests do not start model turns or approve requests.
      const request = pending.get(message.id);
      if (!request) return;
      pending.delete(message.id); clearTimeout(request.timer);
      if (message.error) request.reject(new Error(JSON.stringify(message.error)));
      else request.resolve(message.result);
    },
    call(method, params) {
      return new Promise((resolve, reject) => {
        const requestId = ++id;
        const timer = setTimeout(() => { pending.delete(requestId); reject(new Error(`RPC timeout: ${method}`)); }, 60_000);
        pending.set(requestId, { resolve, reject, timer });
        send({ jsonrpc: '2.0', id: requestId, method, params });
      });
    },
    notify(method) { send({ jsonrpc: '2.0', method }); },
    close(error = new Error('Verification transport closed')) { for (const request of pending.values()) { clearTimeout(request.timer); request.reject(error); } pending.clear(); },
  };
}

async function connectShared(url) {
  const parsed = new URL(url);
  if (parsed.protocol !== 'ws:' || parsed.hostname !== '127.0.0.1') throw new Error('Verification only supports a loopback shared backend.');
  const socket = new WebSocket(url);
  const rpc = rpcClient(message => socket.send(JSON.stringify(message)));
  socket.on('message', data => rpc.receive(JSON.parse(data.toString())));
  await new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
  return { rpc, close: async () => { rpc.close(); socket.close(); } };
}

async function connectStandalone(codex, outputDir) {
  const codexHome = path.join(outputDir, 'codex-home');
  await fs.mkdir(codexHome, { recursive: true });
  const env = Object.fromEntries(['PATH', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'USERPROFILE', 'LOCALAPPDATA', 'APPDATA', 'PROGRAMFILES', 'PROGRAMFILES(X86)', 'COMSPEC', 'PATHEXT', 'HOMEDRIVE', 'HOMEPATH'].filter(key => process.env[key]).map(key => [key, process.env[key]]));
  env.CODEX_HOME = codexHome;
  const args = ['app-server', '--listen', 'stdio://', ...playwrightMcpOverrides({ root, nodePath: process.execPath, dataDir: outputDir })];
  const child = spawn(codex, args, { cwd: outputDir, env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', data => { stderr = (stderr + data).slice(-4000); });
  const rpc = rpcClient(message => child.stdin.write(JSON.stringify(message) + '\n'));
  child.once('exit', code => rpc.close(new Error(`Verification backend exited (${code}): ${stderr}`)));
  const reader = createInterface({ input: child.stdout });
  reader.on('line', line => { if (line.trim()) rpc.receive(JSON.parse(line)); });
  await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
  return { rpc, close: async () => {
    rpc.close(); reader.close(); child.stdin.end();
    if (child.exitCode === null) await new Promise(resolve => {
      const timer = setTimeout(() => child.kill(), 3000);
      child.once('exit', () => { clearTimeout(timer); resolve(); });
    });
    if (child.exitCode && child.exitCode !== 0) await fs.writeFile(path.join(outputDir, 'backend-stderr.log'), stderr);
  } };
}

async function verifyRuntime(connection, outputDir) {
  const { rpc } = connection;
  let threadId;
  try {
    await rpc.call('initialize', { clientInfo: { name: 'feishu-browser-verification', version: '1.0.0' }, capabilities: { experimentalApi: true } });
    rpc.notify('initialized');
    // Ephemeral threads never add a chat to the user's saved history. No model
    // request, official client impersonation, or Desktop authorization is used.
    const started = await rpc.call('thread/start', { cwd: outputDir, ephemeral: true });
    threadId = started.thread.id;
    const status = await rpc.call('mcpServerStatus/list', { serverName: 'feishu_browser', threadId });
    const server = status.data.find(item => item.name === 'feishu_browser');
    if (!server || server.toolsError || !Object.keys(server.tools).length) throw new Error(`MCP unavailable: ${JSON.stringify(server)}`);
    const result = await verifyBrowser({ tools: Object.values(server.tools), outputDir,
      call: (tool, args) => rpc.call('mcpServer/tool/call', { server: 'feishu_browser', threadId, tool, arguments: args }) });
    result.server = server.serverInfo;
    result.connection = server.runtimeStatus;
    await fs.writeFile(path.join(outputDir, 'report.json'), JSON.stringify(result, null, 2));
    return result;
  } finally {
    try { if (threadId) await rpc.call('thread/unsubscribe', { threadId }); }
    finally { await connection.close(); }
  }
}

export async function verifyCodex({ sharedUrl, codex, outputDir = path.join(root, 'artifacts', 'playwright-mcp') }) {
  if (!path.isAbsolute(codex)) throw new Error('An absolute Codex executable path is required.');
  const sharedDir = path.join(outputDir, 'shared'), standaloneDir = path.join(outputDir, 'standalone');
  await fs.mkdir(sharedDir, { recursive: true }); await fs.mkdir(standaloneDir, { recursive: true });
  const shared = await verifyRuntime(await connectShared(sharedUrl), sharedDir);
  const standalone = await verifyRuntime(await connectStandalone(codex, standaloneDir), standaloneDir);
  const sameTools = JSON.stringify(shared.tools) === JSON.stringify(standalone.tools);
  if (!sameTools) throw new Error('Shared and standalone tool catalogs differ.');
  const report = { passed: true, sameTools, shared, standalone,
    scope: 'Existing shared app-server versus isolated standalone app-server; does not restart or test the independent Desktop UI.' };
  await fs.writeFile(path.join(outputDir, 'codex-comparison.json'), JSON.stringify(report, null, 2));
  return report;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2), options = {};
  for (let i = 0; i < args.length; i += 2) {
    const key = { '--codex': 'codex', '--shared-url': 'sharedUrl', '--output-dir': 'outputDir' }[args[i]];
    if (!key || !args[i + 1]) throw new Error('Usage: verify-playwright-codex.mjs --codex <path> --shared-url ws://127.0.0.1:<port>');
    options[key] = args[i + 1];
  }
  const result = await verifyCodex(options);
  console.log(JSON.stringify({ passed: result.passed, sameTools: result.sameTools, toolCount: result.shared.tools.length, shared: result.shared.checks, standalone: result.standalone.checks, scope: result.scope }, null, 2));
}
