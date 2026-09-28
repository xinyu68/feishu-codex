import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { WebSocketServer } from 'ws';
import { waitForLaunchAccount } from '../desktop/launch-account.mjs';
import { runtimeProbe } from '../desktop/host.mjs';

const ready = { ready: true, authenticated: true, accountType: 'chatgpt' };
const timeout = () => Object.assign(new Error('delayed account'), { code: 'RUNTIME_PROBE_TIMEOUT', stage: 'account/read' });

test('cold account initialization can exceed the old fifteen-second launch deadline', { timeout: 25_000 }, async () => {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await once(server, 'listening');
  const methods = [], timers = new Set();
  server.on('connection', socket => socket.on('message', raw => {
    const request = JSON.parse(raw.toString());
    methods.push(request.method);
    if (request.method === 'initialize') socket.send(JSON.stringify({ id: request.id, result: {} }));
    if (request.method === 'account/read') {
      assert.deepEqual(request.params, { refreshToken: false });
      const timer = setTimeout(() => {
        timers.delete(timer);
        socket.send(JSON.stringify({ id: request.id, result: { account: { type: 'chatgpt' }, requiresOpenaiAuth: true } }));
      }, 16_000);
      timers.add(timer);
    }
  }));
  try {
    assert.deepEqual(await waitForLaunchAccount(runtimeProbe, `ws://127.0.0.1:${server.address().port}`), ready);
    assert.deepEqual(methods, ['initialize', 'initialized', 'account/read']);
  } finally {
    for (const timer of timers) clearTimeout(timer);
    for (const socket of server.clients) socket.terminate();
    await new Promise(resolve => server.close(resolve));
  }
});

test('a transient timeout is retried within the remaining budget before launching', async () => {
  let clock = 0;
  const options = [], logs = [];
  const result = await waitForLaunchAccount(async (url, value) => {
    assert.equal(url, 'ws://127.0.0.1:18791'); options.push(value);
    if (options.length === 1) { clock += value.timeout; throw timeout(); }
    return ready;
  }, 'ws://127.0.0.1:18791', { now: () => clock, sleep: async ms => { clock += ms; }, log: async line => { logs.push(line); } });
  assert.deepEqual(result, ready);
  assert.deepEqual(options, [{ account: true, timeout: 45_000 }, { account: true, timeout: 14_000 }]);
  assert.match(logs[0], /account\/read/);
  assert.match(logs[1], /第 2 次/);
});

test('permanent unresponsiveness has a total deadline and preserves account data', async () => {
  let clock = 0, calls = 0;
  await assert.rejects(waitForLaunchAccount(async (_, options) => {
    clock += options.timeout; calls++; throw timeout();
  }, 'unused', { now: () => clock, sleep: async ms => { clock += ms; } }), /等待 Codex 登录状态超时/);
  assert.equal(clock, 60_000); assert.equal(calls, 2);
});

test('missing login, invalid response, and nontransient errors never bypass the launch gate', async () => {
  for (const value of [{ ready: true, authenticated: false }, {}, new Error('protocol rejected')]) {
    let calls = 0;
    await assert.rejects(waitForLaunchAccount(async () => { calls++; if (value instanceof Error) throw value; return value; }, 'unused'));
    assert.equal(calls, 1);
  }
});

test('protocol errors identify whether connection initialization or account reading timed out', async () => {
  for (const stage of ['initialize', 'account/read']) {
    const server = new WebSocketServer({ host: '127.0.0.1', port: 0 }); await once(server, 'listening');
    server.on('connection', socket => socket.on('message', raw => {
      const request = JSON.parse(raw.toString());
      if (stage === 'account/read' && request.method === 'initialize') socket.send(JSON.stringify({ id: request.id, result: {} }));
    }));
    try {
      await assert.rejects(runtimeProbe(`ws://127.0.0.1:${server.address().port}`, { account: true, timeout: 100 }), error => {
        assert.equal(error.code, 'RUNTIME_PROBE_TIMEOUT'); assert.equal(error.stage, stage); return true;
      });
    } finally {
      for (const socket of server.clients) socket.terminate();
      await new Promise(resolve => server.close(resolve));
    }
  }
});
