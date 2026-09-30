import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { startServer } from '../src/server.js';
import { Store } from '../src/store.js';
import type { CodexRunInput, CodexRuntime, RuntimeEvent } from '../src/types.js';

async function fixture(t: test.TestContext, feishu?: NonNullable<Parameters<typeof startServer>[0]['feishu']>) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'feishu-codex-http-'));
  const secret = 'integration-secret-that-must-stay-local';
  const seed = new Store(directory);
  seed.saveConfig({ appId: 'cli_1234567890abcdef', appSecret: secret, enabled: false, defaultWorkspace: directory });
  const runs: CodexRunInput[] = [];
  let closeCount = 0;
  let statusCount = 0;
  const listeners = new Set<(event: RuntimeEvent) => void>();
  const codex: CodexRuntime = {
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    async run(input) {
      runs.push(input);
      input.onThread?.(input.threadId || 'fake-thread');
      return { threadId: input.threadId || 'fake-thread', text: '本机预览回复' };
    },
    async stop() {}, async release() {},
    async close() { closeCount++; },
    async models() { return [{ id: 'fake-model', name: 'Fake model', efforts: ['low'], defaultEffort: 'low' }]; },
    async history() { return []; },
    async status() { statusCount++; return { available: true, authenticated: true, version: 'test-runtime' }; },
  };
  const app = await startServer({ port: 0, dataDir: directory, codex, feishu });
  t.after(async () => {
    await app.close();
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(directory).startsWith('feishu-codex-http-'));
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${app.port}`;
  const stateResponse = await fetch(`${base}/api/state`);
  const state = await stateResponse.json() as { csrfToken: string };
  const request = async (endpoint: string, body: unknown, method = 'POST', extraHeaders: Record<string, string> = {}) => {
    return fetch(`${base}${endpoint}`, {
      method, headers: { 'Content-Type': 'application/json', 'X-Bridge-Token': state.csrfToken, ...extraHeaders },
      body: JSON.stringify(body),
    });
  };
  return { app, directory, base, secret, runs, codex, request, token: state.csrfToken, emitRuntime(event: RuntimeEvent) { for (const listener of listeners) listener(event); }, get closeCount() { return closeCount; }, get statusCount() { return statusCount; } };
}

test('state and config responses mask credentials while reporting the injected runtime', async t => {
  const h = await fixture(t);
  h.app.store.log('warn', `测试日志包含 ${h.secret}`);
  const response = await fetch(`${h.base}/api/state`);
  assert.equal(response.status, 200);
  const text = await response.text();
  assert.equal(text.includes(h.secret), false);
  const state = JSON.parse(text);
  assert.equal('appSecret' in state.config, false);
  assert.equal(state.config.hasSecret, true);
  assert.equal(state.config.enabled, false);
  assert.equal(state.connection.status, 'stopped');
  assert.equal(state.codex.authenticated, true);
  assert.equal(state.codex.version, 'test-runtime');
  assert.equal(h.statusCount, 1);
  assert.ok(state.csrfToken.length >= 32);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.match(response.headers.get('content-security-policy') ?? '', /frame-ancestors 'self'/);
});

test('mutations reject missing or stale CSRF tokens and non-JSON payloads', async t => {
  const h = await fixture(t);
  const missing = await fetch(`${h.base}/api/config`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ progress: false }) });
  assert.equal(missing.status, 403);
  assert.equal((await missing.json() as any).error.length > 0, true);
  const wrong = await h.request('/api/config', { progress: false }, 'PUT', { 'X-Bridge-Token': 'incorrect' });
  assert.equal(wrong.status, 403);
  const contentType = await h.request('/api/config', { progress: false }, 'PUT', { 'Content-Type': 'text/plain' });
  assert.equal(contentType.status, 415);
  assert.equal(h.app.store.config.progress, true);
});

test('foreign origins and rebinding Host headers cannot read or mutate local state', async t => {
  const h = await fixture(t);
  const foreignRead = await fetch(`${h.base}/api/state`, { headers: { Origin: 'https://attacker.example' } });
  assert.equal(foreignRead.status, 403);
  const foreignWrite = await h.request('/api/config', { progress: false }, 'PUT', { Origin: 'https://attacker.example' });
  assert.equal(foreignWrite.status, 403);
  // fetch normalizes Host, so use HTTP directly to exercise rebinding protection.
  const rebindStatus = await new Promise<number | undefined>((resolve, reject) => {
    http.get(`${h.base}/api/state`, { headers: { Host: 'attacker.example' } }, response => {
      response.resume();
      response.on('end', () => resolve(response.statusCode));
    }).on('error', reject);
  });
  assert.equal(rebindStatus, 403);
  const sameOrigin = await h.request('/api/config', { progress: false }, 'PUT', { Origin: h.base });
  assert.equal(sameOrigin.status, 200);
  assert.equal(h.app.store.config.progress, false);
});

test('notification duration settings validate and persist without enabling the listener', async t => {
  const h = await fixture(t);
  for (const patch of [{ desktopNotificationMode: 'unknown' }, { desktopNotificationMode: null }, ...[0, -1, 1.5, 1441, '3', null].map(desktopNotificationMinMinutes => ({ desktopNotificationMinMinutes }))]) {
    assert.equal((await h.request('/api/config', patch, 'PUT')).status, 400);
  }
  const response = await h.request('/api/config', { desktopNotificationMode: 'long', desktopNotificationMinMinutes: 3 }, 'PUT');
  assert.equal(response.status, 200);
  const saved = (await response.json() as any).config;
  assert.equal(saved.desktopNotificationMode, 'long');
  assert.equal(saved.desktopNotificationMinMinutes, 3);
  assert.equal(saved.enabled, false);
  assert.equal(new Store(h.directory).config.desktopNotificationMinMinutes, 3);
});

test('saving blank secrets preserves the existing credential and never enables a listener', async t => {
  const h = await fixture(t);
  const response = await h.request('/api/config', { appSecret: '   ', progress: false, enabled: true }, 'PUT');
  assert.equal(response.status, 200);
  const body = await response.json() as any;
  assert.equal(body.config.hasSecret, true);
  assert.equal('appSecret' in body.config, false);
  assert.equal(h.app.store.config.appSecret, h.secret);
  assert.equal(h.app.store.config.enabled, false);
  assert.equal(JSON.parse(fs.readFileSync(path.join(h.directory, 'config.json'), 'utf8')).appSecret, h.secret);
});

test('credential verification connects once, masks the secret, and respects a manual disconnect', async t => {
  const events: string[] = [];
  const h = await fixture(t, {
    async verifyCredentials(appId) { events.push(`verify:${appId}`); },
    createTransport(options) { return {
      async start() { events.push(`start:${options.appId}`); options.onStatus('connected'); },
      async close() { events.push(`close:${options.appId}`); options.onStatus('stopped'); },
      async sendText() { return ''; }, async sendCard() { return ''; }, async sendImage() { return ''; }, async sendFile() { return ''; },
      async updateCard() {}, async startTyping() { return async () => {}; },
    }; },
  });
  const appId = 'cli_abcdef0123456789';
  const response = await h.request('/api/credentials', { appId, appSecret: 'new-secret' });
  assert.equal(response.status, 200);
  const body = await response.json() as any;
  assert.equal(body.connection.status, 'connected');
  assert.equal(body.config.enabled, true);
  assert.equal(body.config.appId, appId);
  assert.equal('appSecret' in body.config, false);
  assert.deepEqual(events, [`verify:${appId}`, `start:${appId}`]);
  await h.request('/api/connection', { enabled: false });
  await h.request('/api/config', { model: 'other-model' }, 'PUT');
  assert.equal(h.app.store.config.enabled, false);
  assert.deepEqual(events, [`verify:${appId}`, `start:${appId}`, `close:${appId}`]);
});

test('invalid replacement leaves the old listener intact; failed new socket restores it', async t => {
  const events: string[] = [];
  const oldId = 'cli_1234567890abcdef';
  const newId = 'cli_abcdef0123456789';
  const h = await fixture(t, {
    async verifyCredentials(appId, appSecret) { events.push(`verify:${appId}`); if (appSecret === 'invalid') throw new Error('rejected'); },
    createTransport(options) { return {
      async start() { events.push(`start:${options.appId}`); options.onStatus(options.appId === newId ? 'error' : 'connected'); },
      async close() { events.push(`close:${options.appId}`); options.onStatus('stopped'); },
      async sendText() { return ''; }, async sendCard() { return ''; }, async sendImage() { return ''; }, async sendFile() { return ''; },
      async updateCard() {}, async startTyping() { return async () => {}; },
    }; },
  });
  assert.equal((await h.request('/api/connection', { enabled: true })).status, 200);
  const invalid = await h.request('/api/credentials', { appId: newId, appSecret: 'invalid' });
  assert.equal(invalid.status, 503);
  assert.deepEqual(events, [`start:${oldId}`, `verify:${newId}`]);
  assert.equal(h.app.store.config.appId, oldId);
  assert.equal(h.app.store.config.appSecret, h.secret);
  assert.equal((await (await fetch(`${h.base}/api/state`)).json() as any).connection.status, 'connected');

  const socketFailure = await h.request('/api/credentials', { appId: newId, appSecret: 'valid' });
  assert.equal(socketFailure.status, 503);
  assert.deepEqual(events, [`start:${oldId}`, `verify:${newId}`, `verify:${newId}`, `close:${oldId}`, `start:${newId}`, `close:${newId}`, `start:${oldId}`]);
  assert.equal(h.app.store.config.appId, oldId);
  assert.equal(h.app.store.config.appSecret, h.secret);
  assert.equal(h.app.store.config.enabled, true);
  assert.equal((await (await fetch(`${h.base}/api/state`)).json() as any).connection.status, 'connected');
});

test('config and command endpoints validate schemas and reject invalid workspaces', async t => {
  const h = await fixture(t);
  const invalidCases: Array<[string, unknown, string?]> = [
    ['/api/config', { defaultWorkspace: 'relative/path' }, 'PUT'],
    ['/api/config', { defaultWorkspace: path.join(h.directory, 'does-not-exist') }, 'PUT'],
    ['/api/config', { defaultWorkspace: path.join(h.directory, 'config.json') }, 'PUT'],
    ['/api/config', { progress: 'yes' }, 'PUT'],
    ['/api/config', { autoNotifyDesktop: 'yes' }, 'PUT'],
    ['/api/config', { appId: 'wrong' }, 'PUT'],
    ['/api/config', { appSecret: 123 }, 'PUT'],
    ['/api/config', { allowedActors: ['oc_chat'] }, 'PUT'],
    ['/api/config', [], 'PUT'],
    ['/api/config', null, 'PUT'],
    ['/api/actors', { actorId: 'ou_person', allow: 'true' }],
    ['/api/actors', { actorId: 'oc_group', allow: true }],
    ['/api/bind', { chatId: 'local-preview', cwd: 'relative' }],
    ['/api/answer', { id: 'request', decision: 'delete' }],
    ['/api/answer', { id: 'request', answers: [{ answers: ['bad'] }] }],
    ['/api/answer', { id: 'request', answers: { q: { answers: [123] } } }],
    ['/api/connection', { enabled: 'true' }],
  ];
  for (const [endpoint, body, method] of invalidCases) {
    const response = await h.request(endpoint, body, method);
    assert.equal(response.status, 400, `${endpoint}: ${JSON.stringify(body)}`);
    assert.ok((await response.json() as any).error);
  }
  assert.equal(h.app.store.config.defaultWorkspace, h.directory);
  assert.equal(h.runs.length, 0);
});

test('malformed JSON and missing required query arguments return useful client errors', async t => {
  const h = await fixture(t);
  const response = await fetch(`${h.base}/api/config`, { method: 'PUT', headers: { 'Content-Type': 'application/json', 'X-Bridge-Token': h.token }, body: '{broken' });
  assert.equal(response.status, 400);
  assert.match((await response.json() as any).error, /JSON/);
  assert.equal((await fetch(`${h.base}/api/history`)).status, 400);
  assert.equal((await fetch(`${h.base}/api/sessions`)).status, 400);
  assert.equal((await fetch(`${h.base}/api/not-a-route`)).status, 404);
});

test('management preview rejects unknown chats and valid standalone turns retain context', async t => {
  const h = await fixture(t);
  const denied = await h.request('/api/chat', { chatId: 'oc_real_chat', text: '不要发到真实飞书' });
  assert.equal(denied.status, 404);
  assert.equal(h.runs.length, 0);
  const invalid = await h.request('/api/chat', { chatId: 'local-preview', text: 'hello', cwd: 'not-absolute' });
  assert.equal(invalid.status, 400);
  const tooLong = await h.request('/api/chat', { chatId: 'local-preview', text: 'a'.repeat(30_001) });
  assert.equal(tooLong.status, 400);
  const started = await h.request('/api/chat', { chatId: 'local-preview', text: '记住测试编号', cwd: h.directory });
  assert.equal(started.status, 202);
  assert.equal((await started.json() as any).accepted, true);
  for (let count = 0; count < 30 && h.app.bridge.conversations().some(item => item.busy); count++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(h.runs.length, 1);
  assert.equal(h.runs[0]?.cwd, h.directory);
  const next = await h.request('/api/chat', { chatId: 'local-preview', text: '继续' });
  assert.equal(next.status, 202);
  for (let count = 0; count < 30 && h.app.bridge.conversations().some(item => item.busy); count++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(h.runs[1]?.threadId, 'fake-thread');
  const history = await (await fetch(`${h.base}/api/history?chatId=local-preview`)).json() as any;
  assert.ok(history.messages.some((message: any) => message.text === '记住测试编号'));
  assert.ok(history.messages.some((message: any) => message.text === '本机预览回复'));
});

test('management preview shares the authorized Feishu binding without sending to Feishu', async t => {
  const h = await fixture(t);
  h.app.store.authorize('ou_alice', true);
  const current = h.app.store.conversation('oc_shared', 'ou_alice');
  current.threadId = 'existing-feishu-thread';
  const transportCalls: string[] = [];
  h.app.bridge.transport = {
    async start() {}, async close() {},
    async sendText() { transportCalls.push('text'); return 'text-id'; },
    async sendCard() { transportCalls.push('card'); return 'card-id'; },
    async sendImage() { transportCalls.push('image'); return 'image-id'; }, async sendFile() { transportCalls.push('file'); return 'file-id'; },
    async updateCard() { transportCalls.push('update'); },
    async startTyping() { transportCalls.push('typing'); return async () => { transportCalls.push('clear-typing'); }; }
  };
  const preview = await h.request('/api/chat', { chatId: 'oc_shared', text: '从后台继续当前会话', cwd: h.directory, localOnly: false });
  assert.equal(preview.status, 202);
  for (let count = 0; count < 30 && h.app.bridge.conversations().some(item => item.busy); count++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(h.runs[0]?.threadId, 'existing-feishu-thread');
  assert.equal(h.runs[0]?.cwd, h.directory);
  assert.match(h.runs[0]!.prompt, /^【本地预览】仅在管理页回复/);
  assert.deepEqual(transportCalls, []);
  assert.equal(h.app.store.state.conversations['local-preview'], undefined);
  const state = await (await fetch(`${h.base}/api/state`)).json() as any;
  assert.equal(state.conversations.length, 1);
  assert.equal(state.conversations[0].threadId, 'existing-feishu-thread');
  const history = await (await fetch(`${h.base}/api/history?chatId=oc_shared`)).json() as any;
  assert.ok(history.messages.some((item: any) => item.text === '从后台继续当前会话'));
  assert.ok(history.messages.some((item: any) => item.text === '本机预览回复'));

  const project = path.join(h.directory, 'second-project');
  fs.mkdirSync(project);
  assert.equal((await h.request('/api/bind', { chatId: 'oc_shared', cwd: project })).status, 200);
  assert.equal((await h.request('/api/chat', { chatId: 'oc_shared', text: '新项目的第一句', cwd: project })).status, 202);
  for (let count = 0; count < 30 && h.app.bridge.conversations().some(item => item.busy); count++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(h.runs[1]?.cwd, project);
  assert.equal(h.runs[1]?.threadId, undefined);
  assert.equal(h.app.store.state.conversations.oc_shared!.threadId, 'fake-thread');
  assert.equal((await h.request('/api/new', { chatId: 'oc_shared' })).status, 200);
  assert.equal(h.app.store.state.conversations.oc_shared!.threadId, undefined);
  assert.equal(h.app.store.state.conversations.oc_shared!.cwd, project);
  assert.deepEqual(transportCalls, []);
});

test('management preview cannot bypass actor authorization or use a stale project or slash command', async t => {
  const h = await fixture(t);
  const current = h.app.store.conversation('oc_shared', 'ou_alice');
  current.threadId = 'existing-feishu-thread';
  assert.equal((await h.request('/api/chat', { chatId: 'oc_shared', text: '执行', actorId: 'ou_other' })).status, 403);
  h.app.store.authorize('ou_alice', true);
  assert.equal((await h.request('/api/chat', { chatId: 'oc_shared', text: '执行', cwd: os.tmpdir() })).status, 409);
  for (const text of ['/project', '/new', '/stop', '/status']) {
    assert.equal((await h.request('/api/chat', { chatId: 'oc_shared', text })).status, 400);
  }
  assert.equal(h.runs.length, 0);
  assert.equal(current.cwd, h.directory);
  assert.equal(current.threadId, 'existing-feishu-thread');
  assert.equal(h.app.store.state.conversations.oc_unknown, undefined);
});

test('actor authorization and model listing use local state and the injected runtime', async t => {
  const h = await fixture(t);
  h.app.store.pendingActor('ou_alice', 'oc_chat');
  assert.equal((await h.request('/api/actors', { actorId: 'ou_alice', allow: true })).status, 200);
  assert.deepEqual(h.app.store.config.allowedActors, ['ou_alice']);
  assert.equal(h.app.store.state.pendingActors.length, 0);
  assert.equal((await h.request('/api/actors', { actorId: 'ou_alice', allow: true })).status, 200);
  assert.deepEqual(h.app.store.config.allowedActors, ['ou_alice']);
  const models = await (await fetch(`${h.base}/api/models`)).json() as any;
  assert.equal(models.models[0].id, 'fake-model');
  assert.equal((await h.request('/api/actors', { actorId: 'ou_alice', allow: false })).status, 200);
  assert.deepEqual(h.app.store.config.allowedActors, []);
});

test('service lock rejects duplicate instances and clean close releases the lock', async t => {
  const h = await fixture(t);
  assert.equal(fs.existsSync(path.join(h.directory, 'service.lock')), true);
  await assert.rejects(startServer({ port: 0, dataDir: h.directory, codex: h.codex }), /服务已运行/);
  await h.app.close();
  await h.app.close();
  assert.equal(h.closeCount, 1);
  assert.equal(fs.existsSync(path.join(h.directory, 'service.lock')), false);
  assert.equal(h.app.server.listening, false);
});

test('shutdown closes a browser preconnect socket without waiting for an HTTP request', async t => {
  const h = await fixture(t);
  const accepted = new Promise<void>(resolve => h.app.server.once('connection', () => resolve()));
  const socket = net.connect({ host: '127.0.0.1', port: h.app.port });
  const socketClosed = new Promise<void>(resolve => socket.once('close', () => resolve()));
  // A forced server close can surface ECONNRESET before the close event on Windows.
  socket.on('error', () => {});
  await Promise.all([
    accepted,
    new Promise<void>((resolve, reject) => { socket.once('connect', resolve); socket.once('error', reject); }),
  ]);
  const shutdown = h.app.close();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      Promise.all([shutdown, socketClosed]),
      new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error('Shutdown hung on a socket with no HTTP request')), 1000); }),
    ]);
    assert.equal(socket.destroyed, true);
    assert.equal(h.app.server.listening, false);
    assert.equal(fs.existsSync(path.join(h.directory, 'service.lock')), false);
  } finally {
    clearTimeout(timer);
    socket.destroy();
    // Let even a regressed implementation release its listener/lock after failure.
    await shutdown;
  }
});

test('SSE reconnect starts with snapshot invalidation and strips raw runtime payloads', async t => {
  const h = await fixture(t);
  const abort = new AbortController();
  const response = await fetch(`${h.base}/api/events`, { signal: abort.signal });
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type') || '', /text\/event-stream/);
  const reader = response.body!.getReader();
  try {
    const initial = new TextDecoder().decode((await reader.read()).value);
    assert.match(initial, /reconnect/);
    h.emitRuntime({ method: 'item/agentMessage/delta', threadId: 'thread-test', params: { delta: 'not-for-event-stream', secret: h.secret } });
    const next = new TextDecoder().decode((await reader.read()).value);
    assert.match(next, /event: runtime/);
    assert.match(next, /thread-test/);
    assert.equal(next.includes(h.secret), false);
    assert.equal(next.includes('not-for-event-stream'), false);
    await h.app.close();
    assert.equal((await reader.read()).done, true);
  } finally { abort.abort(); reader.releaseLock(); }
});

test('stale binding revisions reject send, bind, new and stop without changing the selected task', async t => {
  const h = await fixture(t);
  await h.request('/api/new', { chatId: 'local-preview', cwd: h.directory });
  const current = h.app.store.state.conversations['local-preview']!;
  const before = current.revision!;
  assert.equal((await h.request('/api/new', { chatId: 'local-preview', revision: before })).status, 200);
  for (const endpoint of ['/api/chat', '/api/bind', '/api/new', '/api/stop']) {
    const response = await h.request(endpoint, { chatId: 'local-preview', revision: before, cwd: h.directory, text: '不能发送到新任务' });
    assert.equal(response.status, 409, endpoint);
  }
  assert.equal(h.runs.length, 0);
  assert.equal(h.app.store.state.conversations['local-preview']!.revision, before + 1);
});

test('compiled static assets are served with correct types while private files remain inaccessible', async t => {
  const h = await fixture(t);
  // Default static resolution works for source tests and the packaged build/server layout.
  const response = await fetch(`${h.base}/`);
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type') || '', /text\/html/);
  for (const resource of ['/package.json', '/.env', '/src/server.ts', '/assets/%2e%2e%5cpackage.json']) {
    assert.equal((await fetch(`${h.base}${resource}`)).status, 404, resource);
  }
});

for (const previousAppId of ['', 'cli_1234567890abcdef']) test(
  previousAppId ? 'successful app replacement retains the newly verified bot identity' : 'first setup retains bot identity without needing a reconnect', async t => {
    const appId = 'cli_abcdef0123456789';
    const identity = { openId: 'ou_new_bot', name: 'Codex' };
    const h = await fixture(t, {
      async verifyCredentials() {},
      createTransport(options) { return {
        async start() { options.onBotIdentity?.(identity); options.onStatus('connected'); },
        async close() { options.onStatus('stopped'); },
        async sendText() { return ''; }, async sendCard() { return ''; }, async sendImage() { return ''; }, async sendFile() { return ''; },
        async updateCard() {}, async startTyping() { return async () => {}; },
      }; },
    });
    h.app.store.saveConfig({ appId: previousAppId, appSecret: previousAppId ? 'old-secret' : '', allowedActors: ['ou_old'], allowedGroups: ['oc_old'] });
    if (previousAppId) h.app.store.rememberBotIdentity('default', { openId: 'ou_old_bot', name: 'Old bot' });
    h.app.store.conversation('oc_old', 'ou_old', undefined, 'group').threadId = 'old-thread';
    const response = await h.request('/api/credentials', { appId, appSecret: 'new-secret' });
    assert.equal(response.status, 200, await response.clone().text());
    assert.deepEqual(h.app.store.botIdentity('default'), { ...identity, appId });
    assert.deepEqual(new Store(h.directory).botIdentity('default'), { ...identity, appId });
    assert.equal(h.app.store.state.conversations.oc_old, undefined);
    assert.deepEqual(h.app.store.config.allowedActors, []);
    assert.deepEqual(h.app.store.config.allowedGroups, []);
  });
