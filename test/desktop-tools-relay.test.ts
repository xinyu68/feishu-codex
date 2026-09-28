import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { startDesktopToolsRelay } from '../src/desktop-tools-relay.js';

const endpoint = () => process.platform === 'win32'
  ? `\\\\.\\pipe\\feishu-codex-relay-test-${randomUUID()}`
  : path.join(os.tmpdir(), `fc-relay-${randomUUID()}.sock`);
const catalog = ['open_in_codex', 'list_artifacts'].map(name => ({ namespace: 'codex_app', name, description: '', inputSchema: {} }));
function frame(value: unknown) {
  const data = Buffer.from(JSON.stringify(value));
  const header = Buffer.alloc(4);
  os.endianness() === 'LE' ? header.writeUInt32LE(data.length) : header.writeUInt32BE(data.length);
  return Buffer.concat([header, data]);
}
const size = (buffer: Buffer) => os.endianness() === 'LE' ? buffer.readUInt32LE(0) : buffer.readUInt32BE(0);

async function fakeDesktop(options: { valid?: boolean; malformed?: boolean; silent?: boolean; split?: boolean } = {}) {
  const pipe = endpoint();
  const requests: any[] = [];
  const sockets = new Set<net.Socket>();
  const server = net.createServer(socket => {
    sockets.add(socket);
    socket.on('error', () => {});
    socket.once('close', () => sockets.delete(socket));
    let buffer: Buffer = Buffer.alloc(0);
    socket.on('data', chunk => {
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length >= 4 && buffer.length >= size(buffer) + 4) {
        const length = size(buffer);
        const message = JSON.parse(buffer.subarray(4, length + 4).toString());
        buffer = buffer.subarray(length + 4);
        requests.push(message);
        if (options.silent) continue;
        if (options.malformed) { const bad = Buffer.alloc(4); bad.writeUInt32LE(64 * 1024 * 1024); socket.write(bad); continue; }
        const response = frame({ jsonrpc: '2.0', id: message.id, result: message.method === 'tools/list'
          ? { tools: options.valid === false ? [{ namespace: 'browser', name: 'open_in_codex' }] : catalog }
          : { echoed: message } });
        if (options.split) { socket.write(response.subarray(0, 2)); setImmediate(() => { if (!socket.destroyed) socket.write(response.subarray(2)); }); }
        else socket.write(response);
      }
    });
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(pipe, resolve); });
  let closing: Promise<void> | undefined;
  return { pipe, requests, close: () => closing ??= new Promise<void>(resolve => { for (const socket of sockets) socket.destroy(); server.close(() => resolve()); }) };
}

function exchange(pipe: string, request: unknown): Promise<any | null> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(pipe);
    let buffer: Buffer = Buffer.alloc(0);
    let settled = false;
    const finish = (value: any) => { if (settled) return; settled = true; clearTimeout(timer); socket.destroy(); resolve(value); };
    const timer = setTimeout(() => { if (settled) return; settled = true; socket.destroy(); reject(new Error('Relay exchange timed out')); }, 2_000);
    socket.once('connect', () => socket.write(frame(request)));
    socket.once('error', () => finish(null));
    socket.once('close', () => finish(null));
    socket.on('data', chunk => {
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.length >= 4 && buffer.length >= size(buffer) + 4) finish(JSON.parse(buffer.subarray(4, size(buffer) + 4).toString()));
    });
  });
}

const call = (id = 31, namespace = 'codex_app') => ({ jsonrpc: '2.0', id, method: 'tools/call', params: { namespace, tool: 'read_only_fake_tool', arguments: { text: '消息原样转发' }, threadId: 'thread-test', turnId: 'turn-test', callId: `call-${id}` } });

test('preferred Desktop is verified before transparent tool and cancellation forwarding', async t => {
  const desktop = await fakeDesktop({ split: true }); t.after(desktop.close);
  let scanned = false;
  const relay = await startDesktopToolsRelay(endpoint(), { preferredPipePath: desktop.pipe, discoverPipePaths: async () => { scanned = true; return []; } }); t.after(() => relay.close());
  for (const request of [call(), call(32, 'plugin_management'), { jsonrpc: '2.0', id: 33, method: 'tools/cancel' }]) {
    const response = await exchange(relay.path, request);
    assert.deepEqual(response.result.echoed, request);
  }
  assert.equal(scanned, false);
  assert.equal(desktop.requests[0].method, 'tools/list');
  assert.equal(desktop.requests[0].params.threadStartKind, 'all');
});

test('rejects browser-only candidates without forwarding the user request', async t => {
  const desktop = await fakeDesktop({ valid: false }); t.after(desktop.close);
  const diagnostics: string[] = [];
  const relay = await startDesktopToolsRelay(endpoint(), { preferredPipePath: '', discoverPipePaths: async () => [desktop.pipe], onDiagnostic: message => diagnostics.push(message) }); t.after(() => relay.close());
  assert.equal(await exchange(relay.path, call()), null);
  assert.equal(desktop.requests.length, 1);
  assert.equal(desktop.requests[0].method, 'tools/list');
  assert.match(diagnostics[0]!, /No verified/);
});

test('refuses multiple verified Desktop instances instead of choosing one', async t => {
  const first = await fakeDesktop(); const second = await fakeDesktop(); t.after(first.close); t.after(second.close);
  const diagnostics: string[] = [];
  const relay = await startDesktopToolsRelay(endpoint(), { preferredPipePath: '', discoverPipePaths: async () => [first.pipe, second.pipe], onDiagnostic: message => diagnostics.push(message) }); t.after(() => relay.close());
  assert.equal(await exchange(relay.path, call()), null);
  assert.match(diagnostics[0]!, /Multiple/);
  assert.ok([...first.requests, ...second.requests].every(request => request.method === 'tools/list'));
});

test('rediscovers the next Desktop launch without restarting the relay', async t => {
  const first = await fakeDesktop(); const second = await fakeDesktop(); t.after(first.close); t.after(second.close);
  let candidates = [first.pipe];
  const stable = endpoint();
  const relay = await startDesktopToolsRelay(stable, { preferredPipePath: first.pipe, discoverPipePaths: async () => [stable, ...candidates] }); t.after(() => relay.close());
  assert.deepEqual((await exchange(stable, call(1))).result.echoed, call(1));
  await first.close(); candidates = [second.pipe];
  assert.deepEqual((await exchange(stable, call(2))).result.echoed, call(2));
  assert.ok(second.requests.some(request => request.id === 2));
});

test('upstream Desktop exit closes the persistent MCP socket so its next request can reconnect', async t => {
  const desktop = await fakeDesktop(); t.after(desktop.close);
  const relay = await startDesktopToolsRelay(endpoint(), { preferredPipePath: desktop.pipe, discoverPipePaths: async () => [] }); t.after(() => relay.close());
  const client = net.createConnection(relay.path); t.after(() => client.destroy());
  client.on('error', () => {});
  await once(client, 'connect');
  const response = once(client, 'data');
  client.write(frame(call()));
  await response;
  const disconnected = once(client, 'close');
  await desktop.close();
  await disconnected;
  assert.equal(client.destroyed, true);
});

test('times out silent probes and rejects oversized frames before forwarding', async t => {
  const silent = await fakeDesktop({ silent: true }); const malformed = await fakeDesktop({ malformed: true }); t.after(silent.close); t.after(malformed.close);
  const relay = await startDesktopToolsRelay(endpoint(), { preferredPipePath: '', probeTimeoutMs: 60, discoverPipePaths: async () => [silent.pipe, malformed.pipe] }); t.after(() => relay.close());
  const start = Date.now();
  assert.equal(await exchange(relay.path, call()), null);
  assert.ok(Date.now() - start < 1_000);
  assert.ok([...silent.requests, ...malformed.requests].every(request => request.method === 'tools/list'));
});

test('close aborts waiting clients and probe sockets and is idempotent', async t => {
  const silent = await fakeDesktop({ silent: true }); t.after(silent.close);
  const relay = await startDesktopToolsRelay(endpoint(), { preferredPipePath: '', probeTimeoutMs: 1_000, discoverPipePaths: async () => [silent.pipe] });
  const response = exchange(relay.path, call());
  while (!silent.requests.length) await new Promise(resolve => setTimeout(resolve, 5));
  await Promise.all([relay.close(), relay.close()]);
  assert.equal(await response, null);
});

test('coalesces parallel discovery and probes each candidate once', async t => {
  const candidates = await Promise.all(Array.from({ length: 7 }, () => fakeDesktop({ valid: false })));
  for (const desktop of candidates) t.after(desktop.close);
  let scans = 0;
  const relay = await startDesktopToolsRelay(endpoint(), { preferredPipePath: '', discoverPipePaths: async () => { scans++; return candidates.map(value => value.pipe); } }); t.after(() => relay.close());
  const results = await Promise.all([exchange(relay.path, call(1)), exchange(relay.path, call(2))]);
  assert.deepEqual(results, [null, null]);
  assert.equal(scans, 1);
  assert.ok(candidates.every(value => value.requests.length === 1));
});
