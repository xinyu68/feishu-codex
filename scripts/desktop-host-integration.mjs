import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';

// Explicit, bounded integration probe. No production credentials, listeners,
// named pipes, native windows, scheduled tasks, or conversation writes.
// Development: node scripts/desktop-host-integration.mjs
// Packaged: <resources>/node/node.exe scripts/desktop-host-integration.mjs
//           --product-root <resources>/product
// Keep this probe outside the installed product so reports always belong to
// the source workspace, even when all tested modules come from the package.
const workspaceRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const args = process.argv.slice(2);
if (args.length && (args.length !== 2 || args[0] !== '--product-root' || !path.isAbsolute(args[1]))) {
  throw new Error('Usage: [bundled node.exe] scripts/desktop-host-integration.mjs [--product-root <absolute resources/product path>]');
}
const packaged = args.length > 0;
const root = path.resolve(packaged ? args[1] : workspaceRoot);
const expectedNode = packaged ? path.join(path.dirname(root), 'node', 'node.exe') : process.execPath;
const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'feishu-desktop-host-integration-'));
const directory = path.join(dataDir, 'desktop');
const codexHome = path.join(dataDir, 'codex-home');
const runtimePort = 18801, bridgePort = 18802, port = 18803;
const wsUrl = `ws://127.0.0.1:${runtimePort}`;
const report = { startedAt: new Date().toISOString(), mode: packaged ? 'packaged' : 'development', productRoot: root,
  nodePath: process.execPath, nodeVersion: process.version, dataDir, ports: { runtime: runtimePort, bridge: bridgePort, host: port },
  passed: false, checks: [], createdPids: [] };
let startHost, runtimeProbe, atomicJson, inspectWindows, readJson, stopVerified, powershell, canonicalEnvironment;
let host, control, simulatedUnhealthy = false, simulatedUnknownDesktop = false, simulatedActive = false, exited = false, lockChild, desktopChild, desktopIdentity;
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const inspect = async (...args) => {
  const snapshot = await inspectWindows(...args);
  const fakeDesktop = desktopIdentity && snapshot.processes.find(item => item.pid === desktopIdentity.pid && item.startedAt === desktopIdentity.startedAt);
  return { ...snapshot, desktopRoots: fakeDesktop ? [fakeDesktop] : [], unknownDesktop: simulatedUnknownDesktop };
};
async function status() { return (await fetch(`http://127.0.0.1:${port}/status`, { signal: AbortSignal.timeout(3_000) })).json(); }
async function command(action, params = {}) {
  assert.ok(['checkWrite', 'retry', 'shutdown', 'shutdownAll', 'prepareSwitch', 'switchToShared'].includes(action), 'probe cannot activate native Codex or perform migration');
  if (action === 'switchToShared') assert.notEqual(params.expectedDesktop?.pid, desktopIdentity?.pid, 'switch rejection probe must never select a real desktop');
  const response = await fetch(`http://127.0.0.1:${port}/control`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Host-Token': control.token }, body: JSON.stringify({ action, ...params }), signal: AbortSignal.timeout(90_000) });
  const result = await response.json(); if (!response.ok) throw Object.assign(new Error(result.error), { code: result.code }); return result;
}
async function waitState(predicate, label, timeout = 45_000) {
  const deadline = Date.now() + timeout; let latest;
  do { latest = await status(); if (predicate(latest)) return latest; await wait(500); } while (Date.now() < deadline);
  throw new Error(`${label}: ${JSON.stringify(latest)}`);
}
async function verifyNotificationMcp() {
  const WebSocket = createRequire(path.join(root, 'package.json'))('ws');
  const socket = new WebSocket(wsUrl);
  const pending = new Map(); let sequence = 0;
  const rpc = (method, params) => new Promise((resolve, reject) => {
    const id = ++sequence; pending.set(id, { resolve, reject });
    socket.send(JSON.stringify({ id, method, params }));
  });
  socket.on('message', data => {
    const message = JSON.parse(data.toString()); const request = pending.get(message.id);
    if (!request || message.method) return;
    pending.delete(message.id);
    if (message.error) request.reject(new Error(message.error.message)); else request.resolve(message.result);
  });
  let timer;
  try {
    await Promise.race([(async () => {
      await new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
      await rpc('initialize', { clientInfo: { name: 'feishu_notification_probe', version: '1.0.0' }, capabilities: { experimentalApi: true } });
      socket.send(JSON.stringify({ method: 'initialized', params: {} }));
      const { config } = await rpc('config/read', { includeLayers: false });
      assert.equal(config.sandbox_mode, 'danger-full-access');
      assert.equal(config.approval_policy, 'never');
      assert.equal(config.mcp_servers.feishu_completion.command, expectedNode);
      assert.deepEqual(config.mcp_servers.feishu_completion.args, [path.join(root, 'build', 'server', 'notify-mcp.js')]);
      let cursor, notification;
      do {
        const result = await rpc('mcpServerStatus/list', { limit: 100, detail: 'toolsAndAuthOnly', ...(cursor ? { cursor } : {}) });
        notification ||= result.data.find(server => server.name === 'feishu_completion');
        cursor = result.nextCursor;
      } while (cursor);
      assert.ok(notification?.tools.request_feishu_completion_notification, 'completion MCP must be callable in the actual runtime');
      assert.ok(notification?.tools.send_artifact_to_feishu, 'artifact MCP must be callable in the actual runtime');
      assert.ok(notification?.tools.request_feishu_group_handoff, 'group handoff MCP must be callable in the actual runtime');
      const skills = await rpc('skills/list', { cwds: [dataDir], forceReload: true });
      const skill = skills.data.flatMap(entry => entry.skills).find(entry => entry.name === 'feishu-codex');
      assert.ok(skill, 'bundled skill must be discovered by the actual runtime');
      assert.equal(path.resolve(skill.path), path.join(codexHome, 'skills', 'feishu-codex', 'SKILL.md'));
    })(), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('notification MCP inventory timed out')), 60_000); })]);
  } finally { clearTimeout(timer); socket.terminate(); }
}
try {
  const actualNode = await fs.realpath(process.execPath);
  assert.equal(actualNode.toLowerCase(), (await fs.realpath(expectedNode)).toLowerCase(), 'packaged integration must run with the bundled resources/node/node.exe');
  for (const entry of ['desktop/host.mjs', 'desktop/windows.mjs', 'build/server/server.js', 'build/server/desktop-tools-relay.js', 'build/ui/index.html', 'scripts/desktop-inspect.ps1', 'scripts/desktop-stop-owned.ps1']) {
    assert.equal((await fs.stat(path.join(root, entry))).isFile(), true, `missing product file: ${entry}`);
  }
  if (packaged) {
    const productRealPath = (await fs.realpath(root)).toLowerCase() + path.sep;
    const packagedRequire = createRequire(path.join(root, 'desktop', 'host.mjs'));
    report.dependencyPaths = {};
    for (const dependency of ['ws', '@larksuiteoapi/node-sdk']) {
      // A package staged beneath the source workspace must not silently find
      // missing production dependencies in the workspace's node_modules.
      await fs.access(path.join(root, 'node_modules', dependency, 'package.json'));
      const resolved = await fs.realpath(packagedRequire.resolve(dependency));
      assert.ok(resolved.toLowerCase().startsWith(productRealPath), `${dependency} resolved outside the packaged product`);
      report.dependencyPaths[dependency] = resolved;
    }
    report.checks.push('bundled Node and product-local production dependencies verified');
  }
  ({ startHost, runtimeProbe } = await import(pathToFileURL(path.join(root, 'desktop', 'host.mjs')).href));
  ({ atomicJson, inspectWindows, readJson, stopVerified, powershell } = await import(pathToFileURL(path.join(root, 'desktop', 'windows.mjs')).href));
  ({ canonicalEnvironment } = await import(pathToFileURL(path.join(root, 'desktop', 'lifecycle.mjs')).href));
  const before = await inspectWindows(root, [runtimePort, bridgePort, port]);
  assert.equal(before.connections.some(connection => connection.state === 'Listen' && [runtimePort, bridgePort, port].includes(connection.localPort)), false, 'probe ports must be unused');
  await atomicJson(path.join(directory, 'deployment.json'), { version: 1, state: 'active', productRoot: root });
  await atomicJson(path.join(dataDir, 'runtime.json'), { mode: 'shared', wsUrl, desktopToolsPipe: `\\\\.\\pipe\\feishu-codex-integration-${randomUUID()}` });
  await atomicJson(path.join(dataDir, 'config.json'), { appId: '', appSecret: '', enabled: false, allowedActors: [], defaultWorkspace: dataDir, model: '', effort: '', progress: true });
  desktopChild = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { windowsHide: true, env: canonicalEnvironment(process.env), stdio: 'ignore' });
  await new Promise((resolve, reject) => { desktopChild.once('spawn', resolve); desktopChild.once('error', reject); });
  const desktopProcess = (await inspectWindows(root, [port], [desktopChild.pid])).processes.find(item => item.pid === desktopChild.pid);
  assert.ok(desktopProcess?.exe && desktopProcess.startedAt);
  const savedDesktop = { pid: desktopProcess.pid, exe: desktopProcess.exe, startedAt: desktopProcess.startedAt };
  await atomicJson(path.join(directory, 'desktop-identity.json'), savedDesktop);
  report.createdPids.push(desktopChild.pid);
  host = await startHost({ root, dataDir, codexHome, port, bridgePort, wsUrl, inspector: inspect, pollMs: 1_000, exit: () => { exited = true; },
    runtimeProbe: (...args) => simulatedUnhealthy ? Promise.reject(new Error('isolated unhealthy fixture')) : simulatedActive && args[1]?.idle ? Promise.resolve({ ready: true, active: 1 }) : runtimeProbe(...args) });
  control = await readJson(path.join(directory, 'host-control.json'));
  let healthy = await waitState(value => value.canWrite && value.relay.state === 'ready', 'startup');
  assert.equal(healthy.pid, process.pid, 'host must be the process running the selected product module');
  assert.equal(healthy.desktop.mode, 'closed');
  assert.deepEqual(await command('prepareSwitch'), { desktop: null });
  await assert.rejects(command('switchToShared', { expectedDesktop: { pid: -1, exe: 'unrelated', startedAt: 'old' } }), /请先确认/);
  await assert.rejects(command('switchToShared', { confirmed: true, expectedDesktop: { pid: -1, exe: 'unrelated', startedAt: 'old' } }), /状态已变化/);
  report.checks.push('switch requires explicit confirmation and rejects a changed desktop before any process action');
  const initialBridgePid = healthy.bridge.pid;
  for (const name of ['bridge', 'relay']) {
    const identity = await readJson(path.join(directory, `${name}-identity.json`));
    assert.equal(identity.pid, healthy[name].pid);
    assert.equal((await fs.realpath(identity.exe)).toLowerCase(), actualNode.toLowerCase(), `${name} must use the selected Node runtime`);
  }
  const bridgeState = await (await fetch(`http://127.0.0.1:${bridgePort}/api/state`, { signal: AbortSignal.timeout(5_000) })).json();
  assert.equal(bridgeState.config.enabled, false, 'isolated bridge must not consume Feishu events');
  assert.equal(bridgeState.config.appId, '', 'isolated bridge must not load production credentials');
  const ownRuntime = await readJson(path.join(directory, 'runtime-identity.json'));
  assert.equal(ownRuntime.pid, healthy.runtime.pid);
  report.createdPids.push(healthy.runtime.pid, healthy.bridge.pid, healthy.relay.pid);
  report.checks.push('all three isolated components ready; bot disabled');
  await verifyNotificationMcp();
  report.checks.push('actual runtime preserves all CLI overrides, advertises all three MCP tools, and discovers the bundled skill in its isolated Codex home');
  const stateFile = path.join(directory, 'host-state.json');
  const lockScript = path.join(dataDir, 'hold-state.ps1');
  await fs.writeFile(lockScript, `\uFEFFparam([string]$Path)
$ErrorActionPreference = 'Stop'
$handle = [IO.File]::Open($Path, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::ReadWrite)
try { [Console]::WriteLine('LOCKED'); [Console]::Out.Flush(); [void][Console]::ReadLine() }
finally { $handle.Dispose() }
`);
  lockChild = spawn(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', lockScript, '-Path', stateFile], {
    windowsHide: true, env: canonicalEnvironment(process.env), stdio: ['pipe', 'pipe', 'pipe'],
  });
  await new Promise((resolve, reject) => {
    let output = '';
    const timer = setTimeout(() => reject(new Error('isolated state lock did not become ready')), 8000);
    lockChild.once('error', error => { clearTimeout(timer); reject(error); });
    lockChild.once('exit', code => { clearTimeout(timer); reject(new Error(`isolated state lock exited early: ${code}`)); });
    lockChild.stderr.on('data', data => { output += data; });
    lockChild.stdout.on('data', data => {
      output += data;
      if (output.includes('LOCKED')) { clearTimeout(timer); resolve(); }
    });
  });
  await wait(2500);
  const permissions = await Promise.all([command('checkWrite'), command('checkWrite'), command('checkWrite')]);
  assert.ok(permissions.every(value => value.canWrite), 'state file lock must not fail live topology checks');
  simulatedUnknownDesktop = true;
  await wait(650);
  assert.equal((await command('checkWrite')).canWrite, false, 'unknown desktop must still reject writes while its snapshot file is locked');
  simulatedUnknownDesktop = false;
  await wait(650);
  assert.equal((await command('checkWrite')).canWrite, true);
  assert.ok((await fs.readFile(path.join(directory, 'host.log'), 'utf8')).includes('后台状态文件暂时无法更新'), 'persistent lock must be diagnosed without crashing the host');
  const released = new Promise(resolve => lockChild.once('exit', resolve));
  lockChild.stdin.end('\n'); await released; lockChild = null;
  const releasedAt = Date.now();
  await waitState(value => value.canWrite && Date.parse(value.updatedAt) >= releasedAt, 'locked heartbeat recovery');
  const heartbeatDeadline = Date.now() + 15_000;
  while (Date.now() < heartbeatDeadline && Date.parse((await readJson(stateFile)).updatedAt) < releasedAt) await wait(200);
  assert.ok(Date.parse((await readJson(stateFile)).updatedAt) >= releasedAt, 'heartbeat must resume after the Windows reader releases its handle');
  report.checks.push('Windows file lock preserves live checks, rejects unknown desktop, logs persistence failure, then restores heartbeat');
  simulatedUnhealthy = true;
  await command('retry');
  const unhealthy = await waitState(value => value.runtime.state === 'unhealthy', 'unhealthy');
  assert.equal(unhealthy.canWrite, false); assert.equal(unhealthy.runtime.pid, ownRuntime.pid);
  await wait(1_300); assert.equal((await status()).runtime.pid, ownRuntime.pid);
  report.checks.push('alive unhealthy runtime paused writes and retained PID');
  simulatedUnhealthy = false; await command('retry');
  await waitState(value => value.canWrite, 'recover');
  await stopVerified(root, dataDir, ownRuntime, runtimePort);
  healthy = await waitState(value => value.canWrite && value.runtime.pid !== ownRuntime.pid, 'restart');
  assert.equal(healthy.bridge.pid, initialBridgePid, 'runtime recovery must preserve the running isolated bridge');
  report.createdPids.push(healthy.runtime.pid);
  report.checks.push('confirmed-exited own runtime restarted, bridge stayed alive');
  assert.equal((await runtimeProbe(wsUrl, { idle: true })).active, 0);
  desktopIdentity = savedDesktop;
  await wait(650);
  await assert.rejects(command('shutdown'), error => error.code === 'SHARED_CODEX_RUNNING');
  assert.equal(desktopChild.exitCode, null, 'exit confirmation must not stop a desktop process');
  simulatedActive = true;
  await assert.rejects(command('shutdownAll'), /任务正在运行/);
  assert.equal(desktopChild.exitCode, null, 'busy tasks must prevent closing even the windowless fake desktop');
  assert.equal((await command('checkWrite')).canWrite, true, 'cancelled shutdown must restore the write gate');
  simulatedActive = false;
  await command('shutdownAll');
  for (let i = 0; i < 30 && !exited; i++) await wait(100);
  assert.equal(exited, true);
  // The host invokes its exit hook after requesting server.close(); the OS
  // may release the listener on the next event-loop turn.
  let after;
  for (let i = 0; i < 30; i++) {
    after = await inspectWindows(root, [runtimePort, bridgePort, port]);
    if (!after.connections.some(connection => connection.state === 'Listen' && [runtimePort, bridgePort, port].includes(connection.localPort))
      && !after.processes.some(candidate => report.createdPids.includes(candidate.pid))) break;
    await wait(100);
  }
  assert.equal(after.connections.some(connection => connection.state === 'Listen' && [runtimePort, bridgePort, port].includes(connection.localPort)), false);
  assert.equal(after.processes.some(candidate => report.createdPids.includes(candidate.pid)), false);
  report.checks.push('shared desktop exit requires confirmation; busy tasks retain desktop and services; idle exit closes a windowless fixture and releases all isolated ports');
  report.passed = true;
} catch (error) { report.error = error.message; process.exitCode = 1; }
finally {
  if (lockChild && lockChild.exitCode === null) { lockChild.stdin.end('\n'); await wait(300); if (lockChild.exitCode === null) lockChild.kill(); }
  simulatedUnknownDesktop = false;
  simulatedUnhealthy = false;
  simulatedActive = false;
  desktopIdentity = undefined;
  if (host && !exited) {
    try { await command('retry'); await command('shutdown'); await wait(300); }
    catch (error) { report.cleanupError = error.message; }
  }
  if (desktopChild && desktopChild.exitCode === null) desktopChild.kill();
  report.finishedAt = new Date().toISOString();
  const artifactDirectory = path.join(workspaceRoot, 'artifacts');
  await fs.mkdir(artifactDirectory, { recursive: true });
  // Report even when a packaged dependency/import fails before atomicJson is
  // available. Nothing is written into the installed product directory.
  const reportFile = path.join(artifactDirectory, packaged ? 'desktop-packaged-host-integration.json' : 'desktop-host-integration.json');
  await fs.writeFile(reportFile, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report, null, 2));
  // Keep the unique temp directory for logs; no recursive cleanup and no
  // force-killing on ambiguity. The probe process exits once host is closed.
}
