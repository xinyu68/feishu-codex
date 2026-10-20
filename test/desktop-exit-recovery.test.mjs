import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { startHost } from '../desktop/host.mjs';

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function freePort() {
  const server = net.createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

test('confirmed exit inspection failure pauses supervision until explicit retry', { timeout: 15_000 }, async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'feishu-exit-recovery-'));
  const root = path.join(directory, 'product'), dataDir = path.join(directory, 'data');
  const port = await freePort(), bridgePort = await freePort(), runtimePort = await freePort();
  const startedAt = new Date().toISOString();
  const own = { pid: process.pid, exe: process.execPath, startedAt };
  const components = ['relay', 'runtime', 'bridge'].map((name, i) => ({ name, pid: 1_000_000 + i,
    exe: process.execPath, startedAt,
    commandLine: name === 'runtime' ? 'app-server' : `"${path.join(root, 'build/server', name === 'bridge' ? 'server.js' : 'desktop-tools-relay.js')}"` }));
  await fs.mkdir(path.join(dataDir, 'desktop'), { recursive: true });
  await fs.mkdir(root);
  await fs.writeFile(path.join(dataDir, 'desktop/deployment.json'), JSON.stringify({ state: 'active', productRoot: root }));
  for (const component of components) await fs.writeFile(path.join(dataDir, 'desktop', component.name + '-identity.json'), JSON.stringify(component));
  let inspections = 0, failNext = false, host;
  try {
    host = await startHost({ root, dataDir, codexHome: path.join(directory, 'codex'), port, bridgePort,
      wsUrl: `ws://127.0.0.1:${runtimePort}`, pollMs: 30,
      inspector: async () => {
        inspections++;
        if (failNext) { failNext = false; throw Error('Windows inspection fixture timeout'); }
        return { processes: [own, ...components], connections: [], desktopRoots: [], unknownDesktop: false, nativeCodexPath: process.execPath };
      }, runtimeProbe: async () => ({ ready: false }) });
    const control = JSON.parse(await fs.readFile(path.join(dataDir, 'desktop/host-control.json'), 'utf8'));
    const request = action => fetch(`http://127.0.0.1:${port}/control`, { method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Host-Token': control.token }, body: JSON.stringify({ action, confirmed: true }) });
    // Wait until the initial tick has finished before introducing a failure.
    await delay(120);
    failNext = true;
    const failed = await request('shutdownConfirmed');
    assert.equal(failed.status, 409);
    const count = inspections;
    await delay(180);
    assert.equal(inspections, count, 'the supervisor must remain paused after failed confirmed exit');
    const paused = await (await fetch(`http://127.0.0.1:${port}/status`)).json();
    assert.equal(paused.canWrite, false);
    assert.match(paused.reason, /自动重启已暂停/);
    assert.equal((await request('retry')).status, 200);
    const resumed = await (await fetch(`http://127.0.0.1:${port}/status`)).json();
    assert.notEqual(resumed.state, 'stopping');
    assert.doesNotMatch(resumed.reason, /自动重启已暂停/);
    assert.ok(inspections > count);
  } finally {
    if (host) { await new Promise(resolve => { host.server.close(resolve); host.server.closeAllConnections(); }); }
    const resolved = await fs.realpath(directory);
    assert.equal(path.dirname(resolved), await fs.realpath(os.tmpdir()));
    assert.ok(path.basename(resolved).startsWith('feishu-exit-recovery-'));
    await fs.rm(resolved, { recursive: true, force: true });
  }
});
