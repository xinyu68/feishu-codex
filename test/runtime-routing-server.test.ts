import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { startServer } from '../src/server.js';
import { Store } from '../src/store.js';
import { HermesClient } from '../src/hermes.js';
import { ManagedHermesRuntime } from '../src/hermes-runtime.js';
import type { CodexRuntime } from '../src/types.js';

async function setup(t: test.TestContext, available = true, options: { autoDiscover?: boolean; hermesConfig?: string } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'feishu-runtime-http-'));
  const seed = new Store(dir);
  seed.saveConfig({ enabled: false, defaultWorkspace: dir, appId: 'cli_1234567890abcdef' });
  seed.saveBot('product', { name: '产品经理', appId: 'cli_abcdef1234567890', enabled: false });
  if (options.hermesConfig !== undefined) fs.writeFileSync(path.join(dir, 'hermes-runtime.json'), options.hermesConfig);
  const runtime: CodexRuntime = { async run() { throw new Error('unexpected run'); }, async stop() {}, async release() {}, async close() {},
    async models() { return []; }, async history() { return []; }, async status() { return { available: true }; } };
  const hermes: CodexRuntime = { ...runtime, async status() { return { available }; } };
  const verifications: string[] = [];
  const starts: string[] = [];
  const failApps = new Set<string>();
  const app = await startServer({ port: 0, dataDir: dir, codex: runtime, hermes: options.autoDiscover ? undefined : hermes,
    discovery: { async projects() { return []; }, async threads() { return []; } }, feishu: {
      async verifyCredentials(appId) { verifications.push(appId); },
      createTransport(value) {
        return { async start() { starts.push(value.appId); value.onStatus(failApps.has(value.appId) ? 'error' : 'connected'); },
          async close() { value.onStatus('stopped'); }, async sendText() { return 'om_test'; }, async sendCard() { return 'om_test'; },
          async updateCard() {}, async sendImage() { return 'om_test'; }, async sendFile() { return 'om_test'; }, async startTyping() { return async () => {}; } };
      },
    } });
  t.after(async () => { await app.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${app.port}`;
  const state = await fetch(`${base}/api/state`).then(response => response.json()) as { csrfToken: string };
  const request = (url: string, value: unknown, method: string) => fetch(`${base}${url}`, { method, headers: {
    'Content-Type': 'application/json', 'X-Bridge-Token': state.csrfToken,
  }, body: JSON.stringify(value) });
  const patch = (value: unknown, botId = 'product') => request(`/api/bots/${botId}`, value, 'PATCH');
  const create = (value: unknown) => request('/api/bots', value, 'POST');
  return { app, base, patch, create, request, runtime, hermes, starts, verifications, failApps };
}

test('bot engine API rejects changes before saving any fields', async t => {
  const h = await setup(t);
  assert.equal((await h.patch({ engine: 'unsupported' })).status, 400);
  const before = structuredClone(h.app.store.config);
  const response = await h.patch({ engine: 'hermes', name: 'Must not save', model: 'must-not-inherit', effort: 'high' });
  assert.equal(response.status, 409);
  assert.match(await response.text(), /删除后重新添加/);
  assert.deepEqual(h.app.store.config, before);
  assert.deepEqual(h.verifications, []);
  assert.deepEqual(h.starts, []);
});

test('unavailable Hermes leaves the selected engine and old conversation binding unchanged', async t => {
  const h = await setup(t, false);
  const conversation = h.app.store.conversation('bot:product:oc_test', 'ou_alice');
  conversation.threadId = 'original-codex-thread';
  h.app.store.save();
  const response = await h.patch({ engine: 'hermes' });
  assert.equal(response.status, 409);
  assert.equal(h.app.store.bot('product')!.engine, 'codex');
  assert.equal(conversation.threadId, 'original-codex-thread');
});

for (const engine of ['codex', 'hermes'] as const) {
  test(`creating a ${engine} bot retains its selected engine and establishes one transport`, async t => {
    const h = await setup(t);
    const response = await h.create({ name: '新机器人', engine, appId: 'cli_1122334455667788', appSecret: 'test-secret', model: 'custom-model', effort: 'high' });
    assert.equal(response.status, 201, await response.clone().text());
    const { bot } = await response.json() as any;
    assert.equal(bot.engine, engine);
    assert.equal(bot.connection.status, 'connected');
    assert.equal(bot.model, engine === 'hermes' ? '' : 'custom-model');
    assert.equal(bot.effort, engine === 'hermes' ? '' : 'high');
    if (engine === 'hermes') assert.equal(bot.engineStatus.available, true);
    assert.equal('appSecret' in bot, false);
    assert.deepEqual(h.starts, ['cli_1122334455667788']);
    assert.deepEqual(h.verifications, h.starts);
    assert.equal(h.app.store.bot(bot.id)!.engine, engine);
    assert.equal(h.app.store.bot('default')!.engine, 'codex');
  });
}

test('unavailable Hermes rejects creation before verifying credentials or opening Feishu', async t => {
  const h = await setup(t, false);
  const before = h.app.store.bots();
  const response = await h.create({ name: '不可用', engine: 'hermes', appId: 'cli_1122334455667788', appSecret: 'test-secret' });
  assert.equal(response.status, 503);
  assert.deepEqual(h.app.store.bots(), before);
  assert.deepEqual(h.verifications, []);
  assert.deepEqual(h.starts, []);
  const codex = await h.create({ name: '开发', engine: 'codex', appId: 'cli_1122334455667788', appSecret: 'test-secret' });
  assert.equal(codex.status, 201, 'Hermes availability must not block Codex creation');
});

test('a failed Hermes Feishu connection rolls back the new bot', async t => {
  const h = await setup(t);
  h.failApps.add('cli_1122334455667788');
  const before = h.app.store.bots();
  const response = await h.create({ name: '连接失败', engine: 'hermes', appId: 'cli_1122334455667788', appSecret: 'test-secret' });
  assert.equal(response.status, 503);
  assert.deepEqual(h.app.store.bots(), before);
  assert.deepEqual(new Store(h.app.store.dir).bots(), before);
});

test('existing Hermes bots reject Codex through settings and credentials without losing history', async t => {
  const h = await setup(t);
  const response = await h.create({ name: 'Hermes', engine: 'hermes', appId: 'cli_1122334455667788', appSecret: 'test-secret' });
  assert.equal(response.status, 201);
  const { bot } = await response.json() as any;
  const conversation = h.app.store.conversation('bot:' + bot.id + ':oc_test', 'ou_alice');
  conversation.threadId = 'hermes:saved-session';
  h.app.store.message(conversation.chatId, 'assistant', 'Preserve this native history');
  h.app.store.save();
  const before = structuredClone({ config: h.app.store.config, state: h.app.store.state });
  for (const [suffix, method] of [['', 'PATCH'], ['/credentials', 'POST']]) {
    const rejected = await h.request('/api/bots/' + bot.id + suffix, { engine: 'codex', appId: 'cli_9988776655443322', appSecret: 'new-secret', name: 'Must not save' }, method!);
    assert.equal(rejected.status, 409);
    assert.match(await rejected.text(), /删除后重新添加/);
    assert.deepEqual({ config: h.app.store.config, state: h.app.store.state }, before);
  }
  assert.deepEqual(h.verifications, ['cli_1122334455667788']);
  assert.deepEqual(h.starts, ['cli_1122334455667788']);
  assert.equal(fs.existsSync(path.join(h.app.store.dir, 'engine-migrations')), false);
  assert.equal((await h.patch({ engine: 'hermes', name: '可修改名称' }, bot.id)).status, 200);
  assert.equal((await h.request('/api/bots/' + bot.id, {}, 'DELETE')).status, 200);
  const recreated = await h.create({ name: 'Codex', engine: 'codex', appId: bot.appId, appSecret: 'test-secret' });
  assert.equal(recreated.status, 201);
  const replacement = (await recreated.json() as any).bot;
  assert.notEqual(replacement.id, bot.id);
  assert.equal(replacement.engine, 'codex');
});

test('Hermes status errors preserve bot details, bindings and the explicit notification recipient', async t => {
  const h = await setup(t);
  const target = { chatId: 'bot:product:oc_test', actorId: 'ou_alice', botAppId: h.app.store.bot('product')!.appId };
  h.app.store.saveConfig({ desktopNotificationTarget: target });
  const conversation = h.app.store.conversation(target.chatId, target.actorId);
  conversation.threadId = 'original-codex-thread';
  h.app.store.save();
  h.hermes.status = async () => { throw new Error('Hermes discovery failed'); };
  const response = await h.patch({ engine: 'hermes', name: 'should-not-save' });
  assert.equal(response.status, 409);
  assert.equal(h.app.store.bot('product')!.engine, 'codex');
  assert.equal(h.app.store.bot('product')!.name, '产品经理');
  assert.equal(conversation.threadId, 'original-codex-thread');
  assert.deepEqual(h.app.store.config.desktopNotificationTarget, target);
});

test('legacy configuration and credential routes cannot change an existing engine', async t => {
  const h = await setup(t);
  const target = { chatId: 'oc_test', actorId: 'ou_alice', botAppId: h.app.store.bot('default')!.appId };
  h.app.store.saveConfig({ desktopNotificationTarget: target });
  const before = structuredClone(h.app.store.config);
  for (const [url, method] of [['/api/config', 'PUT'], ['/api/credentials', 'POST'], ['/api/bots/default/credentials', 'POST'], ['/api/bots/default', 'PATCH']]) {
    const response = await h.request(url!, { engine: 'hermes', appId: 'cli_9988776655443322', appSecret: 'new-secret' }, method!);
    assert.equal(response.status, 409, url);
    assert.match(await response.text(), /删除后重新添加/);
    assert.deepEqual(h.app.store.config, before);
  }
  assert.deepEqual(h.verifications, []);
  assert.deepEqual(h.starts, []);
  assert.deepEqual(new Store(h.app.store.dir).config.desktopNotificationTarget, target);
});

test('fresh installs lazily discover Hermes without requiring a runtime configuration file', async t => {
  let checks = 0;
  t.mock.method(HermesClient.prototype, 'status', async () => { checks++; return { available: true }; });
  const h = await setup(t, true, { autoDiscover: true });
  assert.equal(checks, 0, 'Codex-only startup must not discover Hermes');
  assert.equal(fs.existsSync(path.join(h.app.store.dir, 'hermes-runtime.json')), false);
  const response = await h.create({ name: 'Hermes', engine: 'hermes', appId: 'cli_1122334455667788', appSecret: 'test-secret' });
  assert.equal(response.status, 201, await response.clone().text());
  assert.equal(checks, 1);
  assert.equal((await response.json() as any).bot.engine, 'hermes');
});

test('explicit invalid Hermes configuration fails closed for both creation and switching', async t => {
  let checks = 0;
  t.mock.method(HermesClient.prototype, 'status', async () => { checks++; return { available: true }; });
  const h = await setup(t, true, { autoDiscover: true, hermesConfig: '{"type":"desktop","baseUrl":"https://example.com"}' });
  assert.equal((await h.patch({ engine: 'hermes' })).status, 409);
  const response = await h.create({ name: 'Hermes', engine: 'hermes', appId: 'cli_1122334455667788', appSecret: 'test-secret' });
  assert.equal(response.status, 503);
  assert.equal(h.app.store.bots().length, 2);
  assert.equal(h.app.store.bot('product')!.engine, 'codex');
  assert.equal(checks, 0, 'an invalid explicit endpoint cannot fall back to discovery');
  assert.deepEqual(h.verifications, []);
  assert.deepEqual(h.starts, []);
});

test('the engine PATCH refuses active work and leaves its live binding intact', async t => {
  const h = await setup(t);
  h.app.store.saveBot('product', { allowedActors: ['ou_alice'] });
  const conversation = h.app.store.conversation('bot:product:oc_test', 'ou_alice');
  conversation.threadId = 'active-codex-thread';
  h.app.store.save();
  let complete!: () => void;
  let started!: () => void;
  const ready = new Promise<void>(resolve => { started = resolve; });
  const done = new Promise<void>(resolve => { complete = resolve; });
  h.runtime.run = async input => { started(); await done; return { threadId: input.threadId!, text: 'done' }; };
  const turn = h.app.bridge.receive({ id: 'http-active-test', chatId: conversation.chatId, actorId: 'ou_alice', localOnly: true, text: 'keep working' });
  try {
    await ready;
    const response = await h.patch({ engine: 'hermes' });
    assert.equal(response.status, 409);
    assert.equal(h.app.store.bot('product')!.engine, 'codex');
    assert.equal(conversation.threadId, 'active-codex-thread');
    assert.equal(fs.existsSync(path.join(h.app.store.dir, 'engine-migrations')), false);
  } finally { complete(); await turn; }
});

test('an unauthenticated Hermes runtime cannot create or replace a bot', async t => {
  const h = await setup(t);
  h.hermes.status = async () => ({ available: true, authenticated: false });
  assert.equal((await h.patch({ engine: 'hermes' })).status, 409);
  assert.equal((await h.create({ name: 'Hermes', engine: 'hermes', appId: 'cli_1122334455667788', appSecret: 'test-secret' })).status, 503);
  assert.equal(h.app.store.bots().length, 2);
  assert.equal(h.app.store.bot('product')!.engine, 'codex');
  assert.deepEqual(h.verifications, []);
  assert.deepEqual(h.starts, []);
});

test('default Hermes uses the managed runtime and server shutdown owns its lifetime', async t => {
  let starts = 0;
  let stops = 0;
  t.mock.method(ManagedHermesRuntime.prototype, 'ensure', async () => {
    starts++;
    return { baseUrl: 'http://127.0.0.1:1', token: 'test', version: 'test', hermesHome: 'test' };
  });
  t.mock.method(ManagedHermesRuntime.prototype, 'close', async () => { stops++; });
  const h = await setup(t, true, { autoDiscover: true });
  assert.equal(starts, 0, 'Codex-only users do not start Hermes');
  assert.equal((await h.create({ name: 'Hermes', engine: 'hermes', appId: 'cli_1122334455667788', appSecret: 'test-secret' })).status, 201);
  assert.ok(starts > 0, 'the Hermes status path uses the managed backend');
  await h.app.close();
  assert.equal(stops, 1);
});

test('explicit Hermes URLs remain externally managed on server shutdown', async t => {
  let stops = 0;
  t.mock.method(ManagedHermesRuntime.prototype, 'close', async () => { stops++; });
  const h = await setup(t, true, { autoDiscover: true, hermesConfig: '{"type":"desktop","baseUrl":"http://127.0.0.1:1"}' });
  await h.app.close();
  assert.equal(stops, 0);
});
