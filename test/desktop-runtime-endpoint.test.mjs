import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { orphanedRuntimeListener, recoverRuntimeEndpoint } from '../desktop/runtime-endpoint.mjs';

const identity = { pid: 31, exe: 'C:\\Codex\\codex.exe', startedAt: 'old' };
const snapshot = (processes = [], listeners = [{ state: 'Listen', localPort: 18791, localAddress: '127.0.0.1', pid: 31 }]) => ({ processes, connections: listeners });

test('only a recorded dead runtime can recover a lingering loopback listener', () => {
  assert.equal(orphanedRuntimeListener(snapshot(), identity, 18791), true);
  assert.equal(orphanedRuntimeListener(snapshot([identity]), identity, 18791), false);
  assert.equal(orphanedRuntimeListener(snapshot([{ ...identity, exe: '' }]), identity, 18791), false);
  assert.equal(orphanedRuntimeListener(snapshot(), null, 18791), false);
  assert.equal(orphanedRuntimeListener(snapshot([], []), identity, 18791), false);
  assert.equal(orphanedRuntimeListener(snapshot([], [{ state: 'Listen', localPort: 18791, localAddress: '127.0.0.1', pid: 32 }]), identity, 18791), false);
  assert.equal(orphanedRuntimeListener(snapshot([], [{ state: 'Listen', localPort: 18791, localAddress: '0.0.0.0', pid: 31 }]), identity, 18791), false);
});

test('a responding runtime is preserved even if Windows inspection omitted its process', async () => {
  const result = await recoverRuntimeEndpoint({ snapshot: snapshot(), identity, url: 'ws://127.0.0.1:18791',
    probe: async () => ({ ready: true }), allocate: () => { throw new Error('must not allocate'); } });
  assert.equal(result, null);
});

test('foreign and live listeners do not trigger recovery or a protocol connection', async () => {
  for (const state of [snapshot([identity]), snapshot([], [{ state: 'Listen', localPort: 18791, localAddress: '127.0.0.1', pid: 32 }])]) {
    assert.equal(await recoverRuntimeEndpoint({ snapshot: state, identity, url: 'ws://127.0.0.1:18791',
      probe: () => { throw new Error('must not probe'); }, allocate: () => { throw new Error('must not allocate'); } }), null);
  }
});

test('an unresponsive exited runtime selects a usable loopback port without closing the old listener', async t => {
  const old = net.createServer();
  await new Promise(resolve => old.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => old.close(resolve)));
  const oldPort = old.address().port;
  const state = snapshot([], [{ state: 'Listen', localPort: oldPort, localAddress: '127.0.0.1', pid: 31 }]);
  const result = await recoverRuntimeEndpoint({ snapshot: state, identity, url: `ws://127.0.0.1:${oldPort}`,
    probe: async (_url, options) => { assert.equal(options.timeout, 1500); throw new Error('timeout'); } });
  const endpoint = new URL(result);
  assert.equal(endpoint.hostname, '127.0.0.1'); assert.notEqual(Number(endpoint.port), oldPort);
  const replacement = net.createServer();
  await new Promise((resolve, reject) => { replacement.once('error', reject); replacement.listen(Number(endpoint.port), '127.0.0.1', resolve); });
  await new Promise(resolve => replacement.close(resolve));
  assert.equal(old.listening, true);
});

test('recovery rejects invalid, unchanged and reserved ports', async () => {
  for (const port of [80, 70000, 18791, 18792]) {
    await assert.rejects(recoverRuntimeEndpoint({ snapshot: snapshot(), identity, url: 'ws://127.0.0.1:18791',
      probe: async () => ({ ready: false }), allocate: async () => port, reservedPorts: [18792] }), /无法分配/);
  }
});
