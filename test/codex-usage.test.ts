import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import WebSocket, { WebSocketServer } from 'ws';
import { CodexClient } from '../src/codex.js';
import type { RpcMessage } from '../src/codex-websocket.js';

const chatgpt = { account: { type: 'chatgpt', planType: 'pro', email: 'private@example.com' }, requiresOpenaiAuth: true };

async function fixture(account: unknown = chatgpt, limits: unknown = { rateLimits: null }) {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const requests: RpcMessage[] = [];
  const client = new CodexClient({ websocketUrl: `ws://127.0.0.1:${address.port}`, requestTimeoutMs: 500 });
  const fx = {
    requests, client,
    failMethod: '', disconnectMethod: '',
    async close() {
      await client.close();
      for (const socket of server.clients) socket.terminate();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    },
  };
  server.on('connection', socket => socket.on('message', raw => {
    const message = JSON.parse(raw.toString()) as RpcMessage;
    requests.push(message);
    if (message.method === 'initialized') return;
    if (message.method === fx.disconnectMethod) { socket.terminate(); return; }
    if (message.method === fx.failMethod) {
      socket.send(JSON.stringify({ id: message.id, error: { code: -32000, message: 'quota service unavailable' } }));
      return;
    }
    const result = message.method === 'initialize' ? { userAgent: 'quota-fixture' }
      : message.method === 'account/read' ? account
        : message.method === 'account/rateLimits/read' ? limits : undefined;
    socket.send(JSON.stringify(result === undefined
      ? { id: message.id, error: { code: -32601, message: `Unexpected method ${message.method}` } }
      : { id: message.id, result }));
  }));
  return fx;
}

function assertReadOnly(requests: RpcMessage[], withQuota = true): void {
  assert.deepEqual(requests.map(message => message.method), ['initialize', 'initialized', 'account/read', ...(withQuota ? ['account/rateLimits/read'] : [])]);
  assert.deepEqual(requests.find(message => message.method === 'account/read')?.params, { refreshToken: false });
  if (withQuota) assert.deepEqual(requests.find(message => message.method === 'account/rateLimits/read')?.params, {});
}

test('usage prefers all valid quota buckets and returns only display fields without mutating threads', async () => {
  const fx = await fixture(chatgpt, {
    rateLimits: { limitId: 'legacy', primary: { usedPercent: 99 } },
    rateLimitsByLimitId: {
      codex: { limitId: 'codex', limitName: 'Codex', planType: 'pro', primary: { usedPercent: 12.5, windowDurationMins: 300, resetsAt: 1_800_000_000 }, secondary: { usedPercent: 22, windowDurationMins: 10_080, resetsAt: 1_800_010_000 }, credits: { hasCredits: true, unlimited: false, balance: '13.25', token: 'secret' }, accountId: 'private' },
      fast: { limitName: 'Fast', primary: { usedPercent: 8, windowDurationMins: 300, resetsAt: 1_800_000_000 } },
      malformed: null,
    },
    rateLimitResetCredits: { availableCount: 2, credits: [{ secret: 'private' }] },
    ordinaryUsageAllowed: false, accountId: 'private', accessToken: 'secret',
  });
  try {
    const usage = await fx.client.usage();
    assert.equal(usage.accountType, 'chatgpt');
    assert.equal(usage.planType, 'pro');
    assert.equal(usage.resetCredits, 2);
    assert.equal(usage.ordinaryUsageAllowed, false);
    assert.ok(Number.isFinite(Date.parse(usage.fetchedAt)));
    assert.deepEqual(usage.limits, [
      { id: 'codex', name: 'Codex', planType: 'pro', primary: { usedPercent: 12.5, windowDurationMins: 300, resetsAt: 1_800_000_000 }, secondary: { usedPercent: 22, windowDurationMins: 10_080, resetsAt: 1_800_010_000 }, credits: { hasCredits: true, unlimited: false, balance: '13.25' } },
      { id: 'fast', name: 'Fast', planType: null, primary: { usedPercent: 8, windowDurationMins: 300, resetsAt: 1_800_000_000 }, secondary: null, credits: null },
    ]);
    assert.doesNotMatch(JSON.stringify(usage), /private|secret|email|accountId|Token/);
    assertReadOnly(fx.requests);
  } finally { await fx.close(); }
});

test('usage falls back to legacy quota when multi-bucket data has no valid snapshots', async () => {
  for (const rateLimitsByLimitId of [undefined, null, {}, { bad: null, broken: 'unknown', empty: {} }]) {
    const fx = await fixture(chatgpt, { rateLimits: { limitId: 'old', primary: { usedPercent: 0, windowDurationMins: 300, resetsAt: 0 } }, rateLimitsByLimitId, rateLimitResetCredits: { availableCount: 0 } });
    try {
      const usage = await fx.client.usage();
      assert.deepEqual(usage.limits, [{ id: 'old', name: null, planType: null, primary: { usedPercent: 0, windowDurationMins: 300, resetsAt: 0 }, secondary: null, credits: null }]);
      assert.equal(usage.resetCredits, 0);
      assert.equal(usage.ordinaryUsageAllowed, null);
      assertReadOnly(fx.requests);
    } finally { await fx.close(); }
  }
});

test('missing, null and nonnumeric values remain unknown and never become zero usage', async () => {
  const fx = await fixture(chatgpt, {
    rateLimits: { primary: { usedPercent: null, windowDurationMins: '300' }, secondary: { usedPercent: '0', windowDurationMins: null, resetsAt: null }, credits: { hasCredits: null, unlimited: false, balance: '0' } },
    rateLimitsByLimitId: null, rateLimitResetCredits: { availableCount: null }, ordinaryUsageAllowed: null,
  });
  try {
    const usage = await fx.client.usage();
    assert.deepEqual(usage.limits, [{ id: 'codex', name: null, planType: null, primary: { usedPercent: null, windowDurationMins: null, resetsAt: null }, secondary: { usedPercent: null, windowDurationMins: null, resetsAt: null }, credits: null }]);
    assert.equal(usage.resetCredits, null);
    assert.equal(usage.ordinaryUsageAllowed, null);
  } finally { await fx.close(); }
  const empty = await fixture(chatgpt, { rateLimits: null, rateLimitsByLimitId: null });
  try { assert.deepEqual((await empty.client.usage()).limits, []); }
  finally { await empty.close(); }
});

test('logged-out, API key and Bedrock accounts never call unsupported quota RPCs', async () => {
  for (const account of [null, { type: 'apiKey' }, { type: 'amazonBedrock', usesCodexManagedCredentials: true }]) {
    const fx = await fixture({ account, requiresOpenaiAuth: true });
    try {
      const usage = await fx.client.usage();
      assert.equal(usage.accountType, account?.type ?? 'notLoggedIn');
      assert.equal(usage.planType, null);
      assert.deepEqual(usage.limits, []);
      assert.equal(usage.resetCredits, null);
      assert.equal(usage.ordinaryUsageAllowed, null);
      assertReadOnly(fx.requests, false);
    } finally { await fx.close(); }
  }
});

test('account and quota RPC failures propagate without returning an empty allowance', async () => {
  for (const method of ['account/read', 'account/rateLimits/read']) {
    const fx = await fixture();
    fx.failMethod = method;
    try { await assert.rejects(fx.client.usage(), /quota service unavailable/); }
    finally { await fx.close(); }
  }
  const fx = await fixture();
  fx.disconnectMethod = 'account/rateLimits/read';
  try { await assert.rejects(fx.client.usage(), /连接已断开/); }
  finally { await fx.close(); }
});

test('invalid protocol envelopes and unusable quota snapshots fail explicitly', async () => {
  for (const [account, limits] of [
    [{}, null], [{ account: {} }, null], [chatgpt, null], [chatgpt, {}],
    [chatgpt, { rateLimits: 'invalid' }], [chatgpt, { rateLimitsByLimitId: { codex: {} } }],
  ]) {
    const fx = await fixture(account, limits);
    try { await assert.rejects(fx.client.usage(), /无效|未返回账户类型/); }
    finally { await fx.close(); }
  }
});
