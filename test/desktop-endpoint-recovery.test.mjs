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
async function until(check) { for (let i = 0; i < 240; i++) { if (await check()) return; await wait(20); } throw Error('Endpoint recovery timed out'); }
async function listen(server, port = 0) { await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); }); return server.address().port; }
async function close(server) { if (server.listening) await new Promise(resolve => { server.close(resolve); server.closeAllConnections?.(); }); }

async function fixture(t, { busy = false, unknown = false } = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'feishu-port-recovery-'));
  const root = path.join(directory, 'product'), dataDir = path.join(directory, 'data');
  await fs.mkdir(root); await fs.mkdir(path.join(dataDir, 'desktop'), { recursive: true });
  const startedAt = new Date().toISOString(), own = { pid: process.pid, exe: process.execPath, startedAt };
  const dead = { pid: 910003, exe: 'C:\\old\\codex.exe', startedAt };
  const relayIdentity = { pid: 910002, exe: process.execPath, startedAt, commandLine: `"${path.join(root, 'build/server/desktop-tools-relay.js')}"` };
  let nextPid = 920000, runtime, runtimeChild, bridgeIdentity, bridge, host, foreignConnections = 0, shutdowns = 0;
  const launches = [], foreign = net.createServer(socket => { foreignConnections++; socket.destroy(); });
  const oldPort = await listen(foreign);
  const foreignServers = [foreign];
  let foreignPort = oldPort;
  const reserveHost = net.createServer(), port = await listen(reserveHost); await close(reserveHost);
  const pipe = `\\\\.\\pipe\\port-recovery-${randomUUID()}`, relay = net.createServer(socket => socket.end());
  await new Promise(resolve => relay.listen(pipe, resolve));
  const createBridge = async (requestedPort = 0) => {
    bridgeIdentity = { pid: ++nextPid, exe: process.execPath, parentPid: process.pid, startedAt,
      commandLine: `"${path.join(root, 'build/server/server.js')}"` };
    bridge = http.createServer((request, response) => {
      if (request.url === '/api/idle-state') return response.end(JSON.stringify({ activeWork: busy, conversations: [], pendingRequests: [], csrfToken: 'test-token' }));
      if (request.url === '/api/shutdown') {
        assert.equal(request.headers['x-bridge-token'], 'test-token'); shutdowns++;
        response.end(JSON.stringify({ ok: true }));
        const old = bridge; bridgeIdentity = null; void close(old); return;
      }
      response.end(JSON.stringify({ name: 'feishu-codex', pid: bridgeIdentity.pid }));
    });
    return listen(bridge, requestedPort);
  };
  const bridgePort = await createBridge();
  await fs.writeFile(path.join(dataDir, 'runtime.json'), JSON.stringify({ wsUrl: `ws://127.0.0.1:${oldPort}`, desktopToolsPipe: pipe, keep: 'preserved' }));
  await fs.writeFile(path.join(dataDir, 'desktop/deployment.json'), JSON.stringify({ state: 'active', productRoot: root }));
  for (const [name, identity] of [['runtime', dead], ['relay', relayIdentity], ['bridge', bridgeIdentity]]) await fs.writeFile(path.join(dataDir, 'desktop', `${name}-identity.json`), JSON.stringify(identity));
  const snapshot = () => ({ processes: [own, relayIdentity, ...(bridgeIdentity ? [bridgeIdentity] : []), ...(runtime ? [runtime] : []), ...(unknown ? [{ ...dead, exe: '' }] : [])],
    desktopRoots: [], unknownDesktop: false, nativeCodexPath: 'C:\\source\\codex.exe',
    connections: [{ pid: 4240, state: 'Listen', localAddress: '0.0.0.0', localPort: foreignPort },
      ...(bridgeIdentity ? [{ pid: bridgeIdentity.pid, state: 'Listen', localAddress: '127.0.0.1', localPort: bridgePort }] : []),
      ...(runtime ? [{ pid: runtime.pid, state: 'Listen', localAddress: '127.0.0.1', localPort: runtime.port }] : [])] });
  t.after(async () => {
    if (host) { await close(host.server); await host.whenIdle(); }
    await close(bridge); await close(relay); for (const server of foreignServers) await close(server);
    assert.equal(path.dirname(directory), os.tmpdir()); assert.ok(path.basename(directory).startsWith('feishu-port-recovery-'));
    await fs.rm(directory, { recursive: true, force: true });
  });
  host = await startHost({ root, dataDir, codexHome: path.join(directory, 'codex'), port, bridgePort, pollMs: 35,
    inspector: async () => snapshot(), prepareRuntime: async () => ({ exe: 'C:\\pinned\\codex.exe' }),
    runtimeProbe: async url => { assert.notEqual(Number(new URL(url).port), foreignPort, 'never speak Codex to a foreign service'); return { ready: true }; },
    spawnProcess: (exe, args, options) => {
      const child = Object.assign(new EventEmitter(), { pid: ++nextPid, exitCode: null, signalCode: null });
      launches.push({ exe, args, wsUrl: options.env.FEISHU_CODEX_WS_URL });
      if (exe.endsWith('codex.exe')) {
        runtimeChild = child;
        runtime = { pid: child.pid, exe, parentPid: process.pid, startedAt, port: Number(new URL(options.env.FEISHU_CODEX_WS_URL).port), commandLine: args.join(' ') };
        queueMicrotask(() => child.emit('spawn'));
      } else {
        assert.equal(args[0], path.join(root, 'build/server/server.js'));
        void createBridge(bridgePort).then(() => { bridgeIdentity.pid = child.pid; child.emit('spawn'); });
      }
      return child;
    },
  });
  const status = () => fetch(`http://127.0.0.1:${port}/status`).then(response => response.json());
  return { status, launches, dataDir, foreign, oldPort, setBusy: value => { busy = value; },
    loseRuntime: async () => {
      const occupied = net.createServer(socket => { foreignConnections++; socket.destroy(); });
      foreignPort = await listen(occupied, runtime.port); foreignServers.push(occupied);
      runtimeChild.exitCode = 1; runtimeChild.emit('exit', 1); runtime = null;
    },
    retry: async () => {
      const control = JSON.parse(await fs.readFile(path.join(dataDir, 'desktop/host-control.json'), 'utf8'));
      const response = await fetch(`http://127.0.0.1:${port}/control`, { method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Host-Token': control.token }, body: JSON.stringify({ action: 'retry' }) });
      assert.equal(response.status, 200);
    },
    shutdowns: () => shutdowns, foreignConnections: () => foreignConnections };
}

test('a foreign system port is recovered and the existing bridge restarts once with the new URL', async t => {
  const f = await fixture(t);
  await until(async () => (await f.status()).canWrite);
  const config = JSON.parse(await fs.readFile(path.join(f.dataDir, 'runtime.json'), 'utf8'));
  assert.notEqual(Number(new URL(config.wsUrl).port), f.oldPort); assert.equal(config.keep, 'preserved');
  assert.equal(f.launches.length, 2); assert.ok(f.launches.every(item => item.wsUrl === config.wsUrl));
  assert.equal(f.shutdowns(), 1); assert.equal(f.foreignConnections(), 0); assert.ok(f.foreign.listening);
  await wait(120); assert.equal(f.launches.length, 2, 'only one bridge consumer may be launched');
});

test('busy Feishu work delays port recovery until idle, then recovery completes automatically', async t => {
  const f = await fixture(t, { busy: true });
  await until(async () => /等待飞书/.test((await f.status()).reason));
  await wait(100); assert.equal(f.shutdowns(), 0); assert.equal(f.launches.length, 0);
  assert.equal(Number(new URL(JSON.parse(await fs.readFile(path.join(f.dataDir, 'runtime.json'), 'utf8')).wsUrl).port), f.oldPort);
  f.setBusy(false); await until(async () => (await f.status()).canWrite);
  assert.equal(f.shutdowns(), 1); assert.equal(f.launches.length, 2);
});

test('unknown runtime identity never authorizes changing an endpoint or stopping the bridge', async t => {
  const f = await fixture(t, { unknown: true });
  await until(async () => (await f.status()).runtime.state === 'blocked');
  await wait(100); assert.equal(f.launches.length, 0); assert.equal(f.shutdowns(), 0);
  assert.equal(Number(new URL(JSON.parse(await fs.readFile(path.join(f.dataDir, 'runtime.json'), 'utf8')).wsUrl).port), f.oldPort);
});

test('a later port collision is recovered without restarting the application or duplicating consumers on retry', async t => {
  const f = await fixture(t);
  await until(async () => (await f.status()).canWrite);
  const first = JSON.parse(await fs.readFile(path.join(f.dataDir, 'runtime.json'), 'utf8')).wsUrl;
  await f.loseRuntime();
  await Promise.all([f.retry(), f.retry()]);
  await until(async () => f.launches.length === 4 && (await f.status()).canWrite);
  const second = JSON.parse(await fs.readFile(path.join(f.dataDir, 'runtime.json'), 'utf8')).wsUrl;
  assert.notEqual(first, second); assert.equal(f.shutdowns(), 2);
  assert.ok(f.launches.slice(2).every(item => item.wsUrl === second)); assert.equal(f.foreignConnections(), 0);
  await wait(120); assert.equal(f.launches.length, 4);
});
