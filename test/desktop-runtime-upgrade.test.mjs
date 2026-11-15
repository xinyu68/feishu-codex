import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import http from 'node:http';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { startHost } from '../desktop/host.mjs';

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check) { for (let i = 0; i < 160; i++) { if (await check()) return; await wait(20); } throw Error('Runtime migration timed out'); }
async function listen(server) { await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); return server.address().port; }
async function close(server) { await new Promise(resolve => { server.close(resolve); server.closeAllConnections?.(); }); }

async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'feishu-runtime-upgrade-')), root = path.join(directory, 'product'), dataDir = path.join(directory, 'data');
  await fs.mkdir(root); await fs.mkdir(path.join(dataDir, 'desktop'), { recursive: true });
  const startedAt = new Date().toISOString(), own = { pid: process.pid, exe: process.execPath, startedAt };
  const desktop = { pid: 910010, exe: 'C:\\Program Files\\WindowsApps\\OpenAI.Codex_26.1111.2228.0_x64__2p2nqsd0c76g0\\app\\ChatGPT.exe', startedAt, parentPid: 1 };
  const bridgePid = 910001, relayPid = 910002, oldPid = 910003, newPid = 910004;
  const sourceOne = path.join(directory, 'official-one/codex.exe'), sourceTwo = path.join(directory, 'official-two/codex.exe');
  const pinnedOne = path.join(directory, 'pinned-one/codex.exe'), pinnedTwo = path.join(directory, 'pinned-two/codex.exe');
  let runtime = { pid: oldPid, exe: pinnedOne, startedAt, parentPid: process.pid, commandLine: 'codex.exe app-server' };
  const services = [
    { pid: bridgePid, exe: process.execPath, startedAt, commandLine: `"${path.join(root, 'build/server/server.js')}"` },
    { pid: relayPid, exe: process.execPath, startedAt, commandLine: `"${path.join(root, 'build/server/desktop-tools-relay.js')}"` },
  ];
  const bridge = http.createServer((_request, response) => response.end(JSON.stringify({ name: 'feishu-codex', pid: bridgePid })));
  const bridgePort = await listen(bridge), reserved = net.createServer(), runtimePort = await listen(reserved); await close(reserved);
  const reserveHost = net.createServer(), port = await listen(reserveHost); await close(reserveHost);
  const pipe = `\\\\.\\pipe\\runtime-upgrade-${randomUUID()}`, relay = net.createServer(socket => socket.end());
  await new Promise(resolve => relay.listen(pipe, resolve));
  await fs.writeFile(path.join(dataDir, 'runtime.json'), JSON.stringify({ desktopToolsPipe: pipe }));
  await fs.writeFile(path.join(dataDir, 'desktop/deployment.json'), JSON.stringify({ state: 'active', productRoot: root }));
  for (const [name, value] of [['bridge', services[0]], ['relay', services[1]], ['runtime', runtime], ['desktop', desktop]]) await fs.writeFile(path.join(dataDir, 'desktop', `${name}-identity.json`), JSON.stringify(value));
  let source = sourceOne, incomplete = false, active = 0, unknown = false, host, stops = [], launches = [];
  const snapshot = () => ({ processes: [own, ...services, desktop, ...(runtime ? [runtime] : [])], desktopRoots: [desktop], unknownDesktop: false,
    nativeCodexPath: source, desktopRuntimePath: source, desktopPackagePath: desktop.exe,
    connections: [{ pid: bridgePid, state: 'Listen', localAddress: '127.0.0.1', localPort: bridgePort },
      { pid: desktop.pid, remoteAddress: '127.0.0.1', remotePort: runtimePort },
      ...(runtime ? [{ pid: runtime.pid, state: 'Listen', localAddress: '127.0.0.1', localPort: runtimePort }] : [])] });
  t.after(async () => {
    if (host) { await close(host.server); await host.whenIdle(); } await close(bridge); await close(relay);
    assert.equal(path.dirname(directory), os.tmpdir()); assert.ok(path.basename(directory).startsWith('feishu-runtime-upgrade-')); await fs.rm(directory, { recursive: true, force: true });
  });
  host = await startHost({ root, dataDir, codexHome: path.join(directory, 'codex'), port, bridgePort, wsUrl: `ws://127.0.0.1:${runtimePort}`, pollMs: 40,
    inspector: async () => snapshot(),
    prepareRuntime: async selected => { if (incomplete) throw Error('Codex 运行文件尚未准备完整'); return { exe: selected === sourceOne ? pinnedOne : pinnedTwo, sourcePath: selected }; },
    runtimeProbe: async (_url, options) => { if (options?.idle && unknown) throw Error('Task status unavailable'); return { ready: true, ...(options?.idle ? { active } : {}) }; },
    stopRuntimeForUpgrade: async ({ identity }) => { assert.equal(identity.pid, oldPid); assert.equal(runtime.pid, oldPid); stops.push(identity); runtime = null; },
    spawnProcess: (exe, args) => {
      assert.equal(exe, pinnedTwo); assert.ok(args.includes(`ws://127.0.0.1:${runtimePort}`)); launches.push({ exe, args });
      runtime = { pid: newPid, exe, parentPid: process.pid, startedAt: new Date().toISOString(), commandLine: 'codex.exe app-server' };
      const child = Object.assign(new EventEmitter(), { pid: newPid, exitCode: null, signalCode: null }); queueMicrotask(() => child.emit('spawn')); return child;
    },
  });
  const status = () => fetch(`http://127.0.0.1:${port}/status`).then(response => response.json());
  await until(async () => (await status()).canWrite);
  return { status, stops, launches, oldPid, newPid, bridgePid, relayPid, desktop, pinnedTwo,
    upgrade: () => { source = sourceTwo; }, incomplete: value => { incomplete = value; }, active: value => { active = value; }, unknown: () => { unknown = true; } };
}

test('a complete new bundle replaces only the idle runtime, without restarting the desktop or Feishu services', async t => {
  const f = await fixture(t);
  f.incomplete(true); f.upgrade();
  await until(async () => Boolean((await f.status()).codexUpdate)); await wait(100);
  assert.equal(f.stops.length, 0); assert.equal(f.launches.length, 0, 'partial extraction must never launch');
  f.active(1); f.incomplete(false);
  await until(async () => /等待当前任务/.test((await f.status()).reason));
  await wait(100); assert.equal(f.stops.length, 0, 'active turns keep their original backend');
  f.active(0); await until(async () => f.launches.length === 1 && (await f.status()).canWrite);
  const status = await f.status();
  assert.equal(f.stops.length, 1); assert.equal(status.runtime.pid, f.newPid);
  assert.equal(status.bridge.pid, f.bridgePid); assert.equal(status.relay.pid, f.relayPid);
  assert.deepEqual(status.desktop.pids, [f.desktop.pid]);
  await wait(150); assert.equal(f.launches.length, 1);
});

test('unknown task state never authorizes ending an existing backend', async t => {
  const f = await fixture(t); f.unknown(); f.upgrade();
  await until(async () => Boolean((await f.status()).codexUpdate));
  await wait(150); assert.equal(f.stops.length, 0); assert.equal(f.launches.length, 0);
});
