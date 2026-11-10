import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';
import { randomUUID } from 'node:crypto';
import { startHost } from '../desktop/host.mjs';

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const exe = version => `C:\\Program Files\\WindowsApps\\OpenAI.Codex_${version}_x64__2p2nqsd0c76g0\\app\\ChatGPT.exe`;
async function listen(server, target = 0) { await new Promise(resolve => server.listen(target, '127.0.0.1', resolve)); return server.address().port; }
async function close(server) { await new Promise(resolve => { server.close(resolve); server.closeAllConnections?.(); }); }
async function until(check) { for (let i = 0; i < 160; i++) { if (await check()) return; await wait(20); } throw Error('Update recovery fixture timed out'); }

for (const mode of ['closed', 'independent']) test(`host automatically restores an updated ${mode} desktop without restarting services`, { timeout: 15_000 }, async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'feishu-update-host-'));
  const root = path.join(directory, 'product'), dataDir = path.join(directory, 'data');
  const pipe = `\\\\.\\pipe\\feishu-update-test-${randomUUID()}`;
  const relay = net.createServer(socket => socket.end());
  await new Promise(resolve => relay.listen(pipe, resolve));
  const bridgePid = 900001, runtimePid = 900002, relayPid = 900003;
  const bridge = http.createServer((request, response) => { response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify({ name: 'feishu-codex', pid: bridgePid })); });
  const bridgePort = await listen(bridge);
  const unused = net.createServer(); const runtimePort = await listen(unused); await close(unused);
  const portServer = net.createServer(); const port = await listen(portServer); await close(portServer);
  const startedAt = new Date().toISOString();
  const old = { pid: 900010, exe: exe('26.1101.1000.0'), startedAt, parentPid: 1 };
  const replacement = { pid: 900011, exe: exe('26.1103.7773.0'), startedAt, parentPid: 1 };
  const own = { pid: process.pid, exe: process.execPath, startedAt };
  const services = [
    { pid: runtimePid, exe: process.execPath, startedAt, commandLine: 'codex.exe app-server' },
    { pid: relayPid, exe: process.execPath, startedAt, commandLine: `"${path.join(root, 'build/server/desktop-tools-relay.js')}"` },
    { pid: bridgePid, exe: process.execPath, startedAt, commandLine: `"${path.join(root, 'build/server/server.js')}"` },
  ];
  await fs.mkdir(path.join(dataDir, 'desktop'), { recursive: true }); await fs.mkdir(root);
  await fs.writeFile(path.join(dataDir, 'desktop/deployment.json'), JSON.stringify({ state: 'active', productRoot: root }));
  await fs.writeFile(path.join(dataDir, 'desktop/desktop-identity.json'), JSON.stringify(old));
  await fs.writeFile(path.join(dataDir, 'runtime.json'), JSON.stringify({ desktopToolsPipe: pipe }));
  for (const [i, name] of ['runtime', 'relay', 'bridge'].entries()) await fs.writeFile(path.join(dataDir, 'desktop', name + '-identity.json'), JSON.stringify(services[i]));
  let roots = [old], packagePath = old.exe, connected = true, active = 0, launches = 0, switches = 0, host;
  t.after(async () => {
    if (host) { await close(host.server); await host.whenIdle(); } await close(bridge); await close(relay);
    assert.equal(path.dirname(directory), os.tmpdir()); assert.ok(path.basename(directory).startsWith('feishu-update-host-'));
    await fs.rm(directory, { recursive: true, force: true });
  });
  host = await startHost({ root, dataDir, port, bridgePort, wsUrl: `ws://127.0.0.1:${runtimePort}`,
    codexHome: path.join(directory, 'codex'), pollMs: 50,
    inspector: async () => ({ processes: [own, ...services, ...roots,
      ...(!connected && roots.length ? [{ pid: 900012, parentPid: roots[0].pid, exe: 'C:\\runtime\\codex.exe', startedAt, commandLine: 'codex.exe app-server' }] : [])], desktopRoots: roots, unknownDesktop: false,
      nativeCodexPath: process.execPath, desktopPackagePath: packagePath,
      connections: [
        { pid: runtimePid, state: 'Listen', localPort: runtimePort, localAddress: '127.0.0.1' },
        { pid: bridgePid, state: 'Listen', localPort: bridgePort, localAddress: '127.0.0.1' },
        ...(connected && roots[0] ? [{ pid: roots[0].pid, remotePort: runtimePort, remoteAddress: '127.0.0.1' }] : []),
      ] }),
    runtimeProbe: async (_url, options) => ({ ready: true, ...(options?.idle ? { active } : {}), ...(options?.account ? { authenticated: true } : {}) }),
    stopIndependentDesktop: async ({ expected, preserveExecutables }) => {
      assert.equal(expected.pid, replacement.pid); assert.ok(preserveExecutables.length); switches++; roots = []; connected = false;
    },
    runPowerShell: async (script, args) => {
      assert.equal(path.basename(script), 'launch-packaged-shared.ps1'); launches++; roots = [replacement]; connected = true;
      await fs.writeFile(args[args.indexOf('-ResultPath') + 1], JSON.stringify({ started: true, pid: replacement.pid, exe: replacement.exe }));
    },
  });
  const status = () => fetch(`http://127.0.0.1:${port}/status`).then(response => response.json());
  await until(async () => (await status()).canWrite);
  active = 1; packagePath = replacement.exe; roots = mode === 'closed' ? [] : [replacement]; connected = false;
  await until(async () => (await status()).codexUpdate?.state === 'recovering');
  await wait(150); assert.equal(launches, 0, 'an active shared task must delay recovery');
  active = 0;
  await until(async () => launches === 1 && (await status()).canWrite);
  const result = await status();
  assert.equal(result.desktop.mode, 'shared'); assert.equal(result.runtime.pid, runtimePid);
  assert.equal(result.bridge.pid, bridgePid); assert.equal(result.relay.pid, relayPid);
  assert.equal(switches, mode === 'closed' ? 0 : 1);
  await wait(150); assert.equal(launches, 1, 'polling must not launch multiple windows');
  assert.equal(JSON.parse(await fs.readFile(path.join(dataDir, 'desktop/desktop-identity.json'), 'utf8')).pid, replacement.pid);
});
